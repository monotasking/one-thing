/**
 * Built-in Tool: Write
 *
 * Creates or completely overwrites a file. The implementation favors mechanical
 * reliability: preview before permission, hash revalidation after permission,
 * and file-level mutation serialization for the final read/approve/write plan.
 */

import { z } from "zod";
import { createTwoFilesPatch } from "diff";
import type { JsonObjectProperty } from "@onething/core";
import {
	coreDiffHunksToJson,
	createToolAbortError,
	type CoreDiffHunk,
} from "@onething/core/tools";
import {
	basenamePath,
	dirnamePath,
	ensureDirAsync,
	writeTextFileAsync,
} from "@onething/core/storage";
import { Tool } from "../tool.js";
import { filePermissionPattern } from "../permission-effects.js";
import { withFileMutationQueue } from "../file-mutation-queue.js";
import {
	computeDiffHunks,
	trimDiffHunks,
	truncateDiffHunksForDisplay,
} from "../diff-hunks.js";
import {
	findCoreSandboxRootForPath,
	getCoreSandboxBoundary,
	resolveCoreToolPath,
} from "../sandbox.js";
import {
	countLineChanges,
	readTextFileSnapshot,
	type TextFileSnapshot,
} from "../file-snapshot.js";
import { recordFileMutationAudit } from "../file-mutation-audit.js";
import { trimDiff, truncateDiffForDisplay } from "../replacers.js";

const MAX_REVALIDATION_ATTEMPTS = 5;

export interface WriteToolAdapters {
	getDefaultWorkingDirectory?(): string | undefined;
	getFileMutationsDir(): string;
	/**
	 * 用户配置的「接入目录」= 额外的可写沙箱根;缺席 = 现状不变。
	 *
	 * 带 `sessionId`(批 B2):接入目录是 per-space 的,而「哪个 space」由**会话
	 * 归属**决定,不是宿主的当前空间 —— 调用方一律把 `ctx.sessionId` 递进来。
	 */
	getConnectedDirectories?(sessionId?: string): string[];
}

export interface WriteResultMetadata {
	phase?: "preparing" | "preview" | "ready";
	path?: string;
	bytesWritten?: number;
	lineCount?: number;
	created?: boolean;
	diff?: string;
	additions?: number;
	deletions?: number;
	originalContentHash?: string;
	auditId?: string;
	auditPath?: string;
	afterContentHash?: string;
	[key: string]: JsonObjectProperty;
}

export interface WriteMetadata extends WriteResultMetadata {
	path: string;
	bytesWritten: number;
	lineCount: number;
	created: boolean;
	diff?: string;
	additions?: number;
	deletions?: number;
	originalContentHash?: string;
	[key: string]: JsonObjectProperty;
}

interface WritePlan {
	snapshot: TextFileSnapshot;
	bytesWritten: number;
	lineCount: number;
	created: boolean;
	diff: string;
	hunks: CoreDiffHunk[];
	additions: number;
	deletions: number;
	originalContentHash: string;
}

export const WriteParameters = z.object({
	path: z.string().describe("Path to the file to write (relative or absolute)"),
	content: z.string().describe("Content to write to the file"),
});

function resolveWritePath(
	filePath: string,
	workingDirectory: string | undefined,
	adapters: WriteToolAdapters,
): string {
	return resolveCoreToolPath(filePath, {
		workingDirectory,
		defaultWorkingDirectory: adapters.getDefaultWorkingDirectory?.(),
	});
}

function buildWritePlan(
	resolvedPath: string,
	content: string,
	bytesWritten: number,
	lineCount: number,
	snapshot: TextFileSnapshot,
): WritePlan {
	// trimDiff matches the edit tool so both diff views share the same density.
	const diff = trimDiff(
		createTwoFilesPatch(resolvedPath, resolvedPath, snapshot.content, content),
	);
	const { additions, deletions } = countLineChanges(snapshot.content, content);

	return {
		snapshot,
		bytesWritten,
		lineCount,
		created: !snapshot.exists,
		diff,
		hunks: trimDiffHunks(
			computeDiffHunks(resolvedPath, snapshot.content, content),
		),
		additions,
		deletions,
		originalContentHash: snapshot.hash,
	};
}

/** Guideline the write tool brings into `Tool Guidelines:` when it is on the surface. */
export const WRITE_TOOL_PROMPT = {
	guidelines: ["使用write来重写或创建文件"],
} as const satisfies Tool.Info["prompt"];

export function createWriteTool(
	adapters: WriteToolAdapters,
): Tool.Info<typeof WriteParameters, WriteMetadata> {
	return Tool.define<typeof WriteParameters, WriteMetadata>("write", {
		name: "Write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		category: "builtin",
		enabled: true,
		autoExecute: false,
		permissionGuard: "permission-gated",
		executionMode: "sequential",
		renderKind: "diff",
		prompt: WRITE_TOOL_PROMPT,

		parameters: WriteParameters,

		async analyze(args, ctx) {
			const defaultWorkingDirectory = adapters.getDefaultWorkingDirectory?.();
			const resolvedPath = resolveWritePath(
				args.path,
				ctx.workingDirectory,
				adapters,
			);
			const boundary = getCoreSandboxBoundary({
				workingDirectory: ctx.workingDirectory,
				defaultWorkingDirectory,
			});
			const matchedRoot = findCoreSandboxRootForPath(resolvedPath, {
				workingDirectory: ctx.workingDirectory,
				workingDirectoryRoots: ctx.workingDirectoryRoots,
				connectedDirectories: adapters.getConnectedDirectories?.(ctx.sessionId),
				defaultWorkingDirectory,
			});
			const bytesWritten = Buffer.byteLength(args.content, "utf-8");
			const lineCount = args.content.split("\n").length;
			const plan = buildWritePlan(
				resolvedPath,
				args.content,
				bytesWritten,
				lineCount,
				await readTextFileSnapshot(resolvedPath),
			);

			return {
				effects: [
					{
						kind: "file_write" as const,
						resources: [filePermissionPattern(resolvedPath)],
						barrier: true,
						external: !matchedRoot,
						metadata: {
							path: resolvedPath,
							created: plan.created,
							additions: plan.additions,
							deletions: plan.deletions,
							originalContentHash: plan.originalContentHash,
							isExternal: !matchedRoot,
							boundary: matchedRoot ? undefined : boundary,
						},
					},
				],
				preview: {
					title: `${plan.created ? "Create" : "Overwrite"} ${basenamePath(resolvedPath)}`,
					path: resolvedPath,
					diff: plan.diff,
					additions: plan.additions,
					deletions: plan.deletions,
				},
			};
		},

		async execute(args, ctx) {
			const { path: inputPath, content } = args;
			const resolvedPath = resolveWritePath(
				inputPath,
				ctx.workingDirectory,
				adapters,
			);
			const bytesWritten = Buffer.byteLength(content, "utf-8");
			const lineCount = content.split("\n").length;

			ctx.updateResult?.({
				content: [
					{ type: "text", text: `Preparing write to ${resolvedPath}...` },
				],
				details: {
					phase: "preparing",
					path: resolvedPath,
					bytesWritten,
					lineCount,
				},
			});

			ctx.metadata({
				title: basenamePath(resolvedPath),
				metadata: {
					path: resolvedPath,
					bytesWritten,
					lineCount,
				},
			});

			await ctx.beforeSideEffect?.();

			const throwIfAborted = () => {
				if (ctx.abortSignal?.aborted) throw createToolAbortError();
			};
			throwIfAborted();

			return await withFileMutationQueue(resolvedPath, async () => {
				throwIfAborted();

				{
					const emitPlanMetadata = (plan: WritePlan) => {
						const displayDiff = truncateDiffForDisplay(plan.diff);
						ctx.updateResult?.({
							content: [
								{
									type: "text",
									text: displayDiff || `Preparing ${resolvedPath}`,
								},
							],
							details: {
								phase: "preview",
								path: resolvedPath,
								bytesWritten,
								lineCount,
								created: plan.created,
								additions: plan.additions,
								deletions: plan.deletions,
							},
						});
						ctx.metadata({
							title: basenamePath(resolvedPath),
							metadata: {
								path: resolvedPath,
								bytesWritten,
								lineCount,
								created: plan.created,
								diff: displayDiff,
								diffHunks: coreDiffHunksToJson(
									truncateDiffHunksForDisplay(plan.hunks),
								),
								additions: plan.additions,
								deletions: plan.deletions,
								originalContentHash: plan.originalContentHash,
							},
						});
					};

					const policyEffect = ctx.approvedAnalysis?.effects.find(
						(effect) => effect.kind === "file_write",
					);
					const policyOriginalHash =
						policyEffect?.metadata?.originalContentHash;
					const policyDiff = ctx.approvedAnalysis?.preview?.diff;

					const approvedPlan = buildWritePlan(
						resolvedPath,
						content,
						bytesWritten,
						lineCount,
						await readTextFileSnapshot(resolvedPath),
					);
					throwIfAborted();

					if (
						typeof policyOriginalHash === "string" &&
						approvedPlan.originalContentHash !== policyOriginalHash
					) {
						if (policyDiff && approvedPlan.diff !== policyDiff) {
							emitPlanMetadata(approvedPlan);
							throw new Error(
								`File changed after permission approval and the resulting write diff changed: ${resolvedPath}. Please retry the write.`,
							);
						}
					}

					emitPlanMetadata(approvedPlan);

					let revalidationAttempts = 0;
					while (true) {
						const latestSnapshot = await readTextFileSnapshot(resolvedPath);
						throwIfAborted();
						if (latestSnapshot.hash === approvedPlan.originalContentHash) {
							break;
						}

						revalidationAttempts++;
						if (revalidationAttempts > MAX_REVALIDATION_ATTEMPTS) {
							throw new Error(
								`File changed repeatedly after write approval: ${resolvedPath}. Please retry the write.`,
							);
						}

						const revalidatedPlan = buildWritePlan(
							resolvedPath,
							content,
							bytesWritten,
							lineCount,
							latestSnapshot,
						);
						emitPlanMetadata(revalidatedPlan);
						throw new Error(
							`File changed after permission approval and the resulting write diff changed: ${resolvedPath}. Please retry the write.`,
						);
					}

					const parentDir = dirnamePath(resolvedPath);
					await ensureDirAsync(parentDir);
					throwIfAborted();

					await writeTextFileAsync(resolvedPath, content);
					throwIfAborted();

					const audit = await recordFileMutationAudit({
						auditDir: adapters.getFileMutationsDir(),
						sessionId: ctx.sessionId,
						messageId: ctx.messageId,
						toolCallId: ctx.toolCallId,
						operation: approvedPlan.created
							? "write_create"
							: "write_overwrite",
						path: resolvedPath,
						beforeExists: approvedPlan.snapshot.exists,
						beforeContent: approvedPlan.snapshot.content,
						afterContent: content,
						diff: approvedPlan.diff,
						metadata: {
							bytesWritten,
							lineCount,
							additions: approvedPlan.additions,
							deletions: approvedPlan.deletions,
						},
					});

					const displayDiff = truncateDiffForDisplay(approvedPlan.diff);
					const displayDiffHunks = coreDiffHunksToJson(
						truncateDiffHunksForDisplay(approvedPlan.hunks),
					);
					ctx.metadata({
						metadata: {
							path: resolvedPath,
							bytesWritten,
							lineCount,
							created: approvedPlan.created,
							diff: displayDiff,
							diffHunks: displayDiffHunks,
							additions: approvedPlan.additions,
							deletions: approvedPlan.deletions,
							originalContentHash: approvedPlan.originalContentHash,
							auditId: audit.id,
							auditPath: audit.path,
							afterContentHash: audit.afterHash,
						},
					});

					const metadata: WriteMetadata = {
						path: resolvedPath,
						bytesWritten,
						lineCount,
						created: approvedPlan.created,
						diff: displayDiff,
						diffHunks: displayDiffHunks,
						additions: approvedPlan.additions,
						deletions: approvedPlan.deletions,
						originalContentHash: approvedPlan.originalContentHash,
						auditId: audit.id,
						auditPath: audit.path,
						afterContentHash: audit.afterHash,
					};

					const output = `Successfully wrote ${content.length} bytes to ${inputPath}`;
					ctx.updateResult?.({
						content: [
							{ type: "text", text: output },
							{ type: "file", path: resolvedPath },
						],
						details: { phase: "ready", ...metadata },
					});

					return {
						title: basenamePath(resolvedPath),
						output,
						metadata,
						attachments: [{ type: "file" as const, path: resolvedPath }],
					};
				}
			});
		},

		formatValidationError(error) {
			const issues = error.issues.map(
				(issue) => `- ${issue.path.join(".")}: ${issue.message}`,
			);
			return `Invalid write parameters:\n${issues.join("\n")}`;
		},
	});
}
