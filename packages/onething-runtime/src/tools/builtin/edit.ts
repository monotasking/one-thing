/**
 * Edit Tool
 *
 * Performs exact, targeted text replacements in files.
 */

import { z } from "zod";
import { createTwoFilesPatch } from "diff";
import type { JsonObjectProperty } from "@onething/core";
import {
	coreDiffHunksToJson,
	createToolAbortError,
	type CoreDiffHunk,
} from "@onething/core/tools";
import { basenamePath, writeTextFileAsync } from "@onething/core/storage";
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
	editFailureError,
	prepareExactEditPreview,
	type ExactEdit,
} from "../edit-engine.js";
import { trimDiff, truncateDiffForDisplay } from "../replacers.js";
import {
	countLineChanges,
	readTextFileSnapshot,
	type TextFileSnapshot,
} from "../file-snapshot.js";
import { recordFileMutationAudit } from "../file-mutation-audit.js";

const MAX_REVALIDATION_ATTEMPTS = 5;
const LARGE_DELETION_MIN_LINES = 6;
const LARGE_DELETION_RATIO = 5;

export interface EditToolAdapters {
	getDefaultWorkingDirectory?(): string | undefined;
	getFileMutationsDir(): string;
	/** 用户配置的「接入目录」= 额外的可写沙箱根;缺席 = 现状不变。 */
	/** 见 WriteToolAdapters:per-space,按**会话归属**取(批 B2)。 */
	getConnectedDirectories?(sessionId?: string): string[];
}

export interface EditMetadata {
	path: string;
	diff: string;
	additions: number;
	deletions: number;
	originalContentHash?: string;
	[key: string]: JsonObjectProperty;
}

interface EditPlan {
	snapshot: TextFileSnapshot;
	contentNew: string;
	diff: string;
	hunks: CoreDiffHunk[];
	additions: number;
	deletions: number;
	originalContentHash: string;
}

interface EditRisk {
	requiresExplicitPermission: boolean;
	kind?: "large_deletion";
	reason?: string;
}

const ReplaceEditParameters = z.object({
	oldText: z
		.string()
		.describe(
			"Exact text for one targeted replacement. It must be unique in the original file unless replaceAll is set, and must not overlap with any other edits[].oldText in the same call.",
		),
	newText: z.string().describe("Replacement text for this targeted edit."),
	replaceAll: z
		.boolean()
		.optional()
		.describe(
			"Replace every occurrence of oldText instead of requiring it to be unique. Use this for repeated identical blocks; prefer a longer unique oldText when you mean to change only one site.",
		),
});

export const EditParameters = z.object({
	path: z.string().describe("Path to the file to edit (relative or absolute)"),
	edits: z
		.array(ReplaceEditParameters)
		.min(1)
		.describe(
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		),
});

function resolveEditPath(
	filePath: string,
	workingDirectory: string | undefined,
	adapters: EditToolAdapters,
): string {
	return resolveCoreToolPath(filePath, {
		workingDirectory,
		defaultWorkingDirectory: adapters.getDefaultWorkingDirectory?.(),
	});
}

function buildEditPlan(
	resolvedPath: string,
	edits: ExactEdit[],
	snapshot: TextFileSnapshot,
): EditPlan {
	if (!snapshot.exists) {
		throw editFailureError(
			`Edit failed: file not found: ${basenamePath(resolvedPath)}`,
			`File not found: ${resolvedPath}`,
		);
	}

	// The engine already produces "short reason + detail"; re-wrapping it here
	// only duplicated the path and buried the actionable line.
	const preview = prepareExactEditPreview(
		snapshot.content,
		edits,
		resolvedPath,
	);

	const diff = createTwoFilesPatch(
		resolvedPath,
		resolvedPath,
		preview.baseContent,
		preview.newContent,
	);
	const { additions, deletions } = countLineChanges(
		preview.baseContent,
		preview.newContent,
	);

	return {
		snapshot,
		contentNew: preview.finalContent,
		diff: trimDiff(diff),
		hunks: trimDiffHunks(
			computeDiffHunks(resolvedPath, preview.baseContent, preview.newContent),
		),
		additions,
		deletions,
		originalContentHash: snapshot.hash,
	};
}

function getEditRisk(plan: EditPlan): EditRisk {
	if (
		plan.deletions >= LARGE_DELETION_MIN_LINES ||
		plan.deletions >= plan.additions * LARGE_DELETION_RATIO
	) {
		return {
			requiresExplicitPermission: true,
			kind: "large_deletion",
			reason: `Edit removes ${plan.deletions} lines and adds ${plan.additions} lines.`,
		};
	}

	return { requiresExplicitPermission: false };
}

/** Guideline the edit tool brings into `Tool Guidelines:` when it is on the surface. */
export const EDIT_TOOL_PROMPT = {
	guidelines: ["使用edit来修改文件，禁止使用bash工具来修改文件"],
} as const satisfies Tool.Info["prompt"];

export function createEditTool(
	adapters: EditToolAdapters,
): Tool.Info<typeof EditParameters, EditMetadata> {
	return Tool.define<typeof EditParameters, EditMetadata>("edit", {
		name: "Edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file, unless that edit sets replaceAll: true to replace all of its occurrences. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.\n\nReading the file first with the read tool is recommended so each oldText matches the file's current content, but it is not required.",
		category: "builtin",
		enabled: true,
		autoExecute: false,
		permissionGuard: "permission-gated",
		executionMode: "sequential",
		renderKind: "diff",
		prompt: EDIT_TOOL_PROMPT,

		parameters: EditParameters,

		async analyze(args, ctx) {
			const defaultWorkingDirectory = adapters.getDefaultWorkingDirectory?.();
			const resolvedPath = resolveEditPath(
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
			const plan = buildEditPlan(
				resolvedPath,
				args.edits,
				await readTextFileSnapshot(resolvedPath),
			);
			const risk = getEditRisk(plan);
			return {
				effects: [
					{
						kind: risk.requiresExplicitPermission
							? ("file_destructive_edit" as const)
							: ("file_edit" as const),
						resources: [filePermissionPattern(resolvedPath)],
						barrier: true,
						external: !matchedRoot,
						metadata: {
							path: resolvedPath,
							additions: plan.additions,
							deletions: plan.deletions,
							originalContentHash: plan.originalContentHash,
							risk: risk.kind,
							riskReason: risk.reason,
							isExternal: !matchedRoot,
							boundary: matchedRoot ? undefined : boundary,
						},
					},
				],
				preview: {
					title: `Edit ${basenamePath(resolvedPath)}`,
					path: resolvedPath,
					diff: plan.diff,
					additions: plan.additions,
					deletions: plan.deletions,
				},
			};
		},

		async execute(args, ctx) {
			const { path: inputPath, edits } = args;
			const resolvedPath = resolveEditPath(
				inputPath,
				ctx.workingDirectory,
				adapters,
			);

			ctx.updateResult?.({
				content: [
					{ type: "text", text: `Preparing edit for ${resolvedPath}...` },
				],
				details: {
					phase: "preparing",
					path: resolvedPath,
					replacements: edits.length,
				},
			});

			ctx.metadata({
				title: `Editing ${basenamePath(resolvedPath)}`,
				metadata: {
					path: resolvedPath,
					diff: "",
					additions: 0,
					deletions: 0,
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
					const emitPlanMetadata = (plan: EditPlan) => {
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
								additions: plan.additions,
								deletions: plan.deletions,
								replacements: edits.length,
							},
						});
						ctx.metadata({
							title: `Editing ${basenamePath(resolvedPath)}`,
							metadata: {
								path: resolvedPath,
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
						(effect) =>
							effect.kind === "file_edit" ||
							effect.kind === "file_destructive_edit",
					);
					const policyOriginalHash =
						policyEffect?.metadata?.originalContentHash;
					const policyDiff = ctx.approvedAnalysis?.preview?.diff;

					const snapshot = await readTextFileSnapshot(resolvedPath);
					throwIfAborted();

					let approvedPlan = buildEditPlan(resolvedPath, edits, snapshot);
					throwIfAborted();

					if (
						typeof policyOriginalHash === "string" &&
						approvedPlan.originalContentHash !== policyOriginalHash
					) {
						if (policyDiff && approvedPlan.diff !== policyDiff) {
							emitPlanMetadata(approvedPlan);
							throw editFailureError(
								`Edit failed: file changed after approval in ${basenamePath(resolvedPath)}.`,
								`${resolvedPath} was modified between permission approval and execution. Re-read the file and retry with its current content as oldText.`,
							);
						}
					}

					emitPlanMetadata(approvedPlan);

					let revalidationAttempts = 0;
					while (true) {
						const latestSnapshot = await readTextFileSnapshot(resolvedPath);
						throwIfAborted();
						if (latestSnapshot.hash === approvedPlan.originalContentHash) {
							await writeTextFileAsync(resolvedPath, approvedPlan.contentNew);
							throwIfAborted();
							break;
						}

						revalidationAttempts++;
						if (revalidationAttempts > MAX_REVALIDATION_ATTEMPTS) {
							throw editFailureError(
								`Edit failed: file keeps changing in ${basenamePath(resolvedPath)}.`,
								`${resolvedPath} was modified too many times during the edit. Re-read it to get the latest content, then retry.`,
							);
						}

						let revalidatedPlan: EditPlan;
						try {
							revalidatedPlan = buildEditPlan(
								resolvedPath,
								edits,
								latestSnapshot,
							);
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							// One line of approval context, then the engine's own short-reason +
							// detail text — no third wrapper around it.
							throw editFailureError(
								`Edit failed: file changed after approval in ${basenamePath(resolvedPath)}.`,
								message,
							);
						}

						if (revalidatedPlan.diff !== approvedPlan.diff) {
							emitPlanMetadata(revalidatedPlan);
							throw editFailureError(
								`Edit failed: file changed after approval in ${basenamePath(resolvedPath)}, retry needed.`,
								`File changed after permission approval and the resulting edit diff changed: ${resolvedPath}. Please retry the edit.`,
							);
						}
						approvedPlan = revalidatedPlan;
					}

					const contentOld = approvedPlan.snapshot.content;
					const audit = await recordFileMutationAudit({
						auditDir: adapters.getFileMutationsDir(),
						sessionId: ctx.sessionId,
						messageId: ctx.messageId,
						toolCallId: ctx.toolCallId,
						operation: "edit",
						path: resolvedPath,
						beforeExists: true,
						beforeContent: contentOld,
						afterContent: approvedPlan.contentNew,
						diff: approvedPlan.diff,
						metadata: {
							additions: approvedPlan.additions,
							deletions: approvedPlan.deletions,
							replacements: edits.length,
						},
					});
					const displayDiff = truncateDiffForDisplay(approvedPlan.diff);
					const displayDiffHunks = coreDiffHunksToJson(
						truncateDiffHunksForDisplay(approvedPlan.hunks),
					);
					ctx.metadata({
						metadata: {
							path: resolvedPath,
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

					const output = `Successfully edited ${resolvedPath} (${edits.length} replacement${edits.length === 1 ? "" : "s"})`;
					ctx.updateResult?.({
						content: [
							{ type: "text", text: output },
							{ type: "file", path: resolvedPath },
						],
						details: {
							phase: "ready",
							path: resolvedPath,
							diff: displayDiff,
							additions: approvedPlan.additions,
							deletions: approvedPlan.deletions,
							replacements: edits.length,
							auditId: audit.id,
							auditPath: audit.path,
						},
					});

					return {
						title: `Edited ${basenamePath(resolvedPath)}`,
						output,
						metadata: {
							path: resolvedPath,
							diff: displayDiff,
							diffHunks: displayDiffHunks,
							additions: approvedPlan.additions,
							deletions: approvedPlan.deletions,
							originalContentHash: approvedPlan.originalContentHash,
							auditId: audit.id,
							auditPath: audit.path,
							afterContentHash: audit.afterHash,
						},
					};
				}
			});
		},

		formatValidationError(error) {
			const issues = error.issues.map(
				(issue) => `- ${issue.path.join(".")}: ${issue.message}`,
			);
			return `Invalid edit parameters:\n${issues.join("\n")}`;
		},
	});
}
