/**
 * Built-in Tool: Read
 *
 * Reads file contents with support for:
 * - Offset/limit continuation for large files
 * - Line/byte truncation
 * - Binary file detection
 * - Image preview support
 */

import { z } from "zod";
import { toJsonObject } from "@onething/core";
import { createToolAbortError } from "@onething/core/tools";
import {
	basenamePath,
	dirnamePath,
	extnamePath,
	joinPaths,
	readBinaryFile,
	statPath,
} from "@onething/core/storage";
import { Tool } from "../tool.js";
import { withFileReadAccess } from "../file-mutation-queue.js";
import { classifySensitiveFile } from "../sensitive-files.js";
import { formatSize, utf8Bytes } from "../text-truncation.js";
import {
	checkCoreFileAccess,
	findCoreReadSandboxRootForPath,
	getCoreSandboxBoundary,
	resolveCoreToolPath,
} from "../sandbox.js";

const DEFAULT_LIMIT = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const BINARY_CHECK_BYTES = 8192;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export interface ReadToolAdapters {
	getDefaultWorkingDirectory?(): string | undefined;
	/**
	 * 读沙箱的默认根(笔记目录 + 接入目录 + 下载目录…)。带 `sessionId`(批 B2):
	 * 其中的接入目录是 per-space 的,按**会话归属**解析。
	 */
	getDefaultReadRoots?(sessionId?: string): string[];
}

export interface ReadMetadata {
	path: string;
	lineCount: number;
	offset: number;
	limit: number;
	truncated: boolean;
	isBinary: boolean;
	fileSize: number;
	mimeType?: string;
	truncation?: ReadTruncation;
	sensitive?: boolean;
}

interface ReadTruncation {
	truncated: boolean;
	truncatedBy: "bytes" | "lines" | null;
	outputLines: number;
	totalLines: number;
	maxBytes: number;
	maxLines: number;
	firstLineExceedsLimit?: boolean;
}

interface TruncatedTextResult {
	content: string;
	truncation: ReadTruncation;
}

export const ReadParameters = z.object({
	path: z.string().describe("Path to the file to read (relative or absolute)"),
	offset: z
		.number()
		.optional()
		.describe("Line number to start reading from (1-indexed)"),
	limit: z.number().optional().describe("Maximum number of lines to read"),
});

function isBinaryBuffer(buffer: Buffer): boolean {
	let nonPrintable = 0;
	const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);

	for (let i = 0; i < checkLength; i++) {
		const byte = buffer[i];
		if (byte === 0) return true;
		if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
			nonPrintable++;
		}
	}

	return nonPrintable / checkLength > 0.1;
}

function truncateHead(
	text: string,
	maxLines = DEFAULT_LIMIT,
	maxBytes = DEFAULT_MAX_BYTES,
): TruncatedTextResult {
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const firstLineBytes = utf8Bytes(allLines[0] ?? "");

	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncation: {
				truncated: true,
				truncatedBy: "bytes",
				outputLines: 0,
				totalLines,
				maxBytes,
				maxLines,
				firstLineExceedsLimit: true,
			},
		};
	}

	const selectedLines: string[] = [];
	let selectedBytes = 0;
	let truncatedBy: ReadTruncation["truncatedBy"] = null;

	for (let i = 0; i < allLines.length; i++) {
		if (selectedLines.length >= maxLines) {
			truncatedBy = "lines";
			break;
		}

		const separatorBytes = selectedLines.length > 0 ? 1 : 0;
		const nextBytes = separatorBytes + utf8Bytes(allLines[i]);
		if (selectedBytes + nextBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		selectedLines.push(allLines[i]);
		selectedBytes += nextBytes;
	}

	const outputLines = selectedLines.length;
	return {
		content: selectedLines.join("\n"),
		truncation: {
			truncated: truncatedBy !== null,
			truncatedBy,
			outputLines,
			totalLines,
			maxBytes,
			maxLines,
		},
	};
}

function getExtension(targetPath: string): string {
	return extnamePath(targetPath).toLowerCase();
}

function detectSupportedImageMimeType(buffer: Buffer): string | null {
	if (
		buffer.length >= 3 &&
		buffer[0] === 0xff &&
		buffer[1] === 0xd8 &&
		buffer[2] === 0xff
	) {
		return "image/jpeg";
	}

	if (
		buffer.length >= 8 &&
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47 &&
		buffer[4] === 0x0d &&
		buffer[5] === 0x0a &&
		buffer[6] === 0x1a &&
		buffer[7] === 0x0a
	) {
		return "image/png";
	}

	const header = buffer.subarray(0, 12).toString("ascii");
	if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
		return "image/gif";
	if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
		return "image/webp";

	return null;
}

function supportedImageMimeType(
	targetPath: string,
	buffer: Buffer,
): string | null {
	return (
		detectSupportedImageMimeType(buffer) ??
		IMAGE_MIME_BY_EXTENSION[getExtension(targetPath)] ??
		null
	);
}

function isPdfFile(targetPath: string): boolean {
	return getExtension(targetPath) === ".pdf";
}

function resolveReadPath(
	filePath: string,
	workingDirectory: string | undefined,
	adapters: ReadToolAdapters,
): string {
	return resolveCoreToolPath(filePath, {
		workingDirectory,
		defaultWorkingDirectory: adapters.getDefaultWorkingDirectory?.(),
	});
}

export function createReadTool(
	adapters: ReadToolAdapters = {},
): Tool.Info<typeof ReadParameters, ReadMetadata> {
	return Tool.define<typeof ReadParameters, ReadMetadata>("read", {
		name: "Read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_LIMIT} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		category: "builtin",
		enabled: true,
		autoExecute: true,
		permissionGuard: "sandboxed",
		executionMode: "parallel",
		renderKind: "file",

		parameters: ReadParameters,

		async analyze(args, ctx) {
			const defaultWorkingDirectory = adapters.getDefaultWorkingDirectory?.();
			const resolvedPath = resolveReadPath(
				args.path,
				ctx.workingDirectory,
				adapters,
			);
			const boundary = getCoreSandboxBoundary({
				workingDirectory: ctx.workingDirectory,
				defaultWorkingDirectory,
			});
			const matchedRoot = findCoreReadSandboxRootForPath(resolvedPath, {
				workingDirectory: ctx.workingDirectory,
				workingDirectoryRoots: ctx.workingDirectoryRoots,
				defaultWorkingDirectory,
				defaultReadRoots: adapters.getDefaultReadRoots?.(ctx.sessionId),
			});
			const sensitivity = classifySensitiveFile(resolvedPath);
			const effects = [];
			if (!matchedRoot) {
				effects.push({
					kind: "external_directory" as const,
					resources: [joinPaths(dirnamePath(resolvedPath), "*")],
					barrier: true,
					external: true,
					metadata: {
						path: resolvedPath,
						boundary,
						operation: "Read file",
						targetType: "file",
					},
				});
			}
			effects.push({
				kind: sensitivity.sensitive
					? ("sensitive_file_read" as const)
					: ("read" as const),
				resources: [resolvedPath],
				barrier: sensitivity.sensitive,
				sensitive: sensitivity.sensitive,
				metadata: sensitivity.sensitive
					? {
							path: resolvedPath,
							category: sensitivity.category,
							reason: sensitivity.reason,
						}
					: { path: resolvedPath },
			});
			return {
				effects,
				preview: {
					title: sensitivity.sensitive
						? `Read sensitive file: ${basenamePath(resolvedPath)}`
						: `Read ${basenamePath(resolvedPath)}`,
					path: resolvedPath,
				},
			};
		},

		async execute(args, ctx) {
			const { offset = 1, limit } = args;

			const throwIfAborted = () => {
				if (ctx.abortSignal?.aborted) throw createToolAbortError();
			};
			throwIfAborted();

			const defaultWorkingDirectory = adapters.getDefaultWorkingDirectory?.();
			const resolvedPath = await checkCoreFileAccess(
				args.path,
				ctx,
				"Read file",
				{
					targetType: "file",
					defaultWorkingDirectory,
				},
			);
			throwIfAborted();

			const sensitivity = classifySensitiveFile(resolvedPath);

			ctx.updateResult?.({
				content: [{ type: "text", text: `Reading ${resolvedPath}...` }],
				details: { phase: "reading", path: resolvedPath, offset, limit },
			});

			ctx.metadata({
				title: `Reading ${basenamePath(resolvedPath)}`,
				metadata: {
					path: resolvedPath,
					lineCount: 0,
					offset,
					limit,
					truncated: false,
					isBinary: false,
					fileSize: 0,
					sensitive: sensitivity.sensitive,
				},
			});

			// Shared lock: wait out any in-flight edit/write on this path so the
			// read observes post-mutation bytes.
			const stats = await withFileReadAccess(resolvedPath, () =>
				statPath(resolvedPath),
			);
			if (!stats) {
				throw new Error(`File not found: ${resolvedPath}`);
			}

			throwIfAborted();

			if (stats.isDirectory()) {
				throw new Error(
					`Path is a directory, not a file: ${resolvedPath}. Use ls command via Bash tool to list directory contents.`,
				);
			}

			if (isPdfFile(resolvedPath)) {
				ctx.updateResult?.({
					content: [{ type: "file", path: resolvedPath }],
					details: toJsonObject({
						phase: "ready",
						path: resolvedPath,
						fileSize: stats.size,
						isBinary: true,
					}),
				});
				return {
					title: `PDF: ${basenamePath(resolvedPath)}`,
					output: `[PDF file: ${resolvedPath}]\nSize: ${stats.size} bytes\nThis is a PDF file. Use a PDF viewer to read its contents.`,
					metadata: {
						path: resolvedPath,
						lineCount: 0,
						offset: 0,
						limit: 0,
						truncated: false,
						isBinary: true,
						fileSize: stats.size,
					},
					attachments: [
						{
							type: "file" as const,
							path: resolvedPath,
						},
					],
				};
			}

			const buffer = await withFileReadAccess(resolvedPath, () =>
				readBinaryFile(resolvedPath),
			);
			throwIfAborted();

			const imageMimeType = supportedImageMimeType(resolvedPath, buffer);
			if (imageMimeType) {
				const imageData = buffer.toString("base64");
				const output = `[Image file: ${resolvedPath}]\nSize: ${stats.size} bytes\nMIME type: ${imageMimeType}\nThis image was attached for vision-capable models. Content cannot be displayed as text.`;
				const metadata: ReadMetadata = {
					path: resolvedPath,
					lineCount: 0,
					offset: 0,
					limit: 0,
					truncated: false,
					isBinary: true,
					fileSize: stats.size,
					mimeType: imageMimeType,
				};

				ctx.updateResult?.({
					content: [
						{ type: "text", text: output },
						{
							type: "image",
							path: resolvedPath,
							data: imageData,
							mimeType: imageMimeType,
						},
					],
					details: toJsonObject({ phase: "ready", ...metadata }),
				});
				return {
					title: `Image: ${basenamePath(resolvedPath)}`,
					output,
					metadata,
					attachments: [
						{
							type: "image" as const,
							path: resolvedPath,
							content: imageData,
							mimeType: imageMimeType,
						},
					],
				};
			}

			if (isBinaryBuffer(buffer)) {
				ctx.updateResult?.({
					content: [{ type: "file", path: resolvedPath }],
					details: toJsonObject({
						phase: "ready",
						path: resolvedPath,
						fileSize: stats.size,
						isBinary: true,
					}),
				});
				return {
					title: `Binary: ${basenamePath(resolvedPath)}`,
					output: `[Binary file: ${resolvedPath}]\nSize: ${stats.size} bytes\nThis appears to be a binary file. Content cannot be displayed as text.`,
					metadata: {
						path: resolvedPath,
						lineCount: 0,
						offset: 0,
						limit: 0,
						truncated: false,
						isBinary: true,
						fileSize: stats.size,
					},
				};
			}

			const content = buffer.toString("utf-8");

			const allLines = content.split("\n");
			const totalLines = allLines.length;

			const startIndex = Math.max(0, offset - 1);
			if (startIndex >= totalLines) {
				throw new Error(
					`Offset ${offset} is beyond end of file (${totalLines} lines total)`,
				);
			}

			const endIndex =
				limit !== undefined
					? Math.min(totalLines, startIndex + limit)
					: totalLines;
			const selectedText = allLines.slice(startIndex, endIndex).join("\n");
			const userLimitedLines =
				limit !== undefined ? endIndex - startIndex : undefined;
			const truncatedResult = truncateHead(selectedText);
			const { truncation } = truncatedResult;
			const startLineDisplay = startIndex + 1;
			let output = truncatedResult.content;
			let outputLineCount = truncation.outputLines;

			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(utf8Bytes(allLines[startIndex] ?? ""));
				output = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				if (truncation.truncatedBy === "lines") {
					output += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					output += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
			} else if (
				userLimitedLines !== undefined &&
				startIndex + userLimitedLines < totalLines
			) {
				const remaining = totalLines - (startIndex + userLimitedLines);
				const nextOffset = startIndex + userLimitedLines + 1;
				output += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			}

			if (totalLines === 1 && allLines[0] === "") {
				output = `[Empty file: ${resolvedPath}]`;
				outputLineCount = 0;
			}

			const metadata: ReadMetadata = {
				path: resolvedPath,
				lineCount: outputLineCount,
				offset,
				limit: limit ?? DEFAULT_LIMIT,
				truncated:
					truncation.truncated ||
					(userLimitedLines !== undefined &&
						startIndex + userLimitedLines < totalLines),
				truncation,
				isBinary: false,
				fileSize: stats.size,
			};

			ctx.updateResult?.({
				content: [{ type: "text", text: output }],
				details: toJsonObject({ phase: "ready", ...metadata }),
			});

			return {
				title: `${basenamePath(resolvedPath)} (${outputLineCount} lines)`,
				output,
				metadata,
			};
		},

		formatValidationError(error) {
			const issues = error.issues.map(
				(issue) => `- ${issue.path.join(".")}: ${issue.message}`,
			);
			return `Invalid read parameters:\n${issues.join("\n")}\n\nUsage: read({ path: string, offset?: number, limit?: number }). The path field is required.`;
		},
	});
}
