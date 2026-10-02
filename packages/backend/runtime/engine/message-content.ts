import {
	isTextLikeMimeType,
	normalizeMimeType,
	shouldAttemptTextDecode,
} from "./attachment-mime.js";
import type { JsonObject, JsonValue } from "@shared/json.js";

export type CoreAIMessageContent =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image"; image: string; mediaType?: string }
			| {
					type: "file";
					data: string;
					mediaType: string;
					filename?: string;
					path?: string;
			  }
			| { type: "audio"; audio: string; mediaType?: string }
			| { type: "video"; video: string; mediaType?: string }
	  >;

export interface CoreMessageAttachment {
	fileName?: string;
	/**
	 * Absolute on-disk path of a real file holding these bytes. Dropped/picked
	 * files arrive with the user's own path; pasted files get the media
	 * library's stored copy backfilled at ingest time (see
	 * MediaLibraryService.ingestMessageAttachments), so every attachment that
	 * carried bytes ends up addressable by the model's file tools.
	 */
	filePath?: string;
	mimeType: string;
	size?: number;
	mediaType: string;
	base64Data?: string;
	/** Web-element provenance (embedded-browser pick); emitted as an <attachment> text part. */
	sourceUrl?: string;
	sourceTitle?: string;
	excerpt?: string;
}

export interface CoreMessageContentSource {
	content: string;
	attachments?: CoreMessageAttachment[];
}

export interface BuildMessageContentOptions {
	onImageAttachment?: (input: {
		mimeType: string;
		base64Length: number;
		dataUrlPrefix: string;
	}) => void;
}

/**
 * Format messages for logging without full base64 data.
 */
export function formatMessagesForLog(messages: JsonObject[]): JsonObject[] {
	return messages.map((message) => {
		const content = message.content;
		if (Array.isArray(content)) {
			return {
				...message,
				content: content.map((part): JsonValue => {
					if (!part || typeof part !== "object" || Array.isArray(part))
						return part;
					if (part.type === "image" && typeof part.image === "string") {
						const imgStr = part.image;
						return {
							...part,
							image: imgStr.substring(0, 50) + `... (${imgStr.length} chars)`,
						};
					}
					return part;
				}),
			};
		}
		return message;
	});
}

/**
 * Per-attachment / per-message ceilings for inlined text attachments. The
 * inlined text is re-sent with every turn's history rebuild, so the caps bound
 * worst-case context growth; prompt caching absorbs the repeat cost because
 * the rendered block is byte-stable across rebuilds.
 */
export const INLINE_TEXT_ATTACHMENT_MAX_CHARS = 64_000;
export const INLINE_TEXT_ATTACHMENT_TOTAL_CHARS = 192_000;

function base64ToBytes(base64: string): Uint8Array | null {
	try {
		const binary = atob(base64.replace(/\s+/g, ""));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** Shared with the `@path` mention inliner in ./file-mentions.ts. */
export function decodeTextBytes(bytes: Uint8Array): string | null {
	const probeLength = Math.min(bytes.length, 8192);
	for (let i = 0; i < probeLength; i++) {
		if (bytes[i] === 0) return null;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		// Plain-text files from Chinese environments are frequently GB18030/GBK.
	}
	try {
		return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Shared with the `@path` mention inliner in ./file-mentions.ts. */
export function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeAttachmentBody(text: string): string {
	// The closing tag is the only sequence that could break out of the wrapper.
	// The replacement must be deterministic: history rebuilds have to produce
	// byte-identical content or the prompt cache is invalidated every turn.
	return text.replace(/<\/attachment/gi, "<\\/attachment");
}

/**
 * Provenance tag for a web-element pick (embedded browser): the source URL/title
 * plus the element's text excerpt. Emitted as its own text part so it survives
 * when the image part is dropped for a non-vision model. Null when the
 * attachment carries no web provenance (an ordinary file/image upload).
 */
function webElementAttachmentTag(attachment: CoreMessageAttachment): string | null {
	if (!attachment.sourceUrl && !attachment.excerpt) return null;
	return (
		`<attachment source_url="${escapeXmlAttribute(attachment.sourceUrl ?? "")}"` +
		` title="${escapeXmlAttribute(attachment.sourceTitle ?? "")}">\n` +
		`${escapeAttachmentBody(attachment.excerpt ?? "")}\n` +
		`</attachment>`
	);
}

/**
 * Human-readable size, deterministic by construction: history rebuilds must
 * produce byte-identical content or the prompt cache dies every turn.
 */
function formatAttachmentSize(size?: number): string | null {
	if (typeof size !== "number" || !Number.isFinite(size) || size < 0)
		return null;
	if (size < 1024) return `${Math.round(size)} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One fact line per attachment that exists as a real file on disk:
 *
 *   [附件] report.pdf → /Users/me/docs/report.pdf (application/pdf, 1.2 MB)
 *
 * The user's complaint this answers is literal — the model was handed image
 * and file bytes with no way to name where they live, so it could not reach
 * them with read/bash. Original name and path are both given: the model quotes
 * the name back to the user and operates on the path.
 *
 * This is a SUPPLEMENT, never a replacement — the image/file/inline-text parts
 * below are untouched, so a vision model still sees the picture.
 *
 * Web-element picks (embedded-browser) are skipped: their provenance is the
 * source URL, already emitted by webElementAttachmentTag, and the stored
 * screenshot path answers no question the user asked.
 */
function attachmentPathLines(
	attachments: CoreMessageAttachment[],
): string | null {
	const lines: string[] = [];
	for (const attachment of attachments) {
		if (!attachment.filePath) continue;
		if (attachment.sourceUrl || attachment.excerpt) continue;
		const name = attachment.fileName || "attachment";
		const meta = [attachment.mimeType, formatAttachmentSize(attachment.size)]
			.filter((value): value is string => Boolean(value))
			.join(", ");
		lines.push(
			`[附件] ${name} → ${attachment.filePath}${meta ? ` (${meta})` : ""}`,
		);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

interface InlineTextAttachment {
	text: string;
	consumedChars: number;
}

function tryInlineTextAttachment(
	attachment: CoreMessageAttachment,
	remainingBudgetChars: number,
): InlineTextAttachment | null {
	if (!attachment.base64Data) return null;
	const mimeType = normalizeMimeType(attachment.mimeType);
	if (!shouldAttemptTextDecode(mimeType)) return null;

	const bytes = base64ToBytes(attachment.base64Data);
	if (!bytes) return null;
	const decoded = decodeTextBytes(bytes);
	if (decoded == null) return null;

	const text = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
	const cap = Math.min(
		INLINE_TEXT_ATTACHMENT_MAX_CHARS,
		Math.max(0, remainingBudgetChars),
	);
	const body = text.length > cap ? text.slice(0, cap) : text;
	const truncationNote =
		text.length > body.length
			? `\n[truncated: showing first ${body.length} of ${text.length} characters]`
			: "";

	const filename = attachment.fileName || "attachment";
	// The path lets the model operate on the original file with its tools
	// (read/edit/bash) instead of only seeing this snapshot.
	const pathAttribute = attachment.filePath
		? ` path="${escapeXmlAttribute(attachment.filePath)}"`
		: "";
	const rendered =
		`<attachment filename="${escapeXmlAttribute(filename)}"${pathAttribute} media_type="${escapeXmlAttribute(attachment.mimeType)}">\n` +
		`${escapeAttachmentBody(body)}${truncationNote}\n` +
		`</attachment>`;

	return { text: rendered, consumedChars: body.length };
}

/**
 * Convert a message with attachments to provider-facing multimodal content.
 *
 * Text-like attachments are decoded and inlined as text parts (the shape every
 * provider understands — OpenAI has no text-file part type, and Anthropic's
 * native form for plain text is also textual). Binary attachments stay as file
 * parts, now carrying the filename that provider payloads (e.g. Codex
 * input_file) require.
 */
export function buildMessageContent(
	message: CoreMessageContentSource,
	options: BuildMessageContentOptions = {},
): CoreAIMessageContent {
	if (!message.attachments || message.attachments.length === 0) {
		return message.content;
	}

	const contentParts: Exclude<CoreAIMessageContent, string> = [];

	if (message.content) {
		contentParts.push({ type: "text", text: message.content });
	}

	// Immediately after the user's own text, before the payload parts: the
	// model reads "here is what I attached and where it lives" as one thought.
	const pathLines = attachmentPathLines(message.attachments);
	if (pathLines) {
		contentParts.push({ type: "text", text: pathLines });
	}

	let inlineBudgetChars = INLINE_TEXT_ATTACHMENT_TOTAL_CHARS;

	for (const attachment of message.attachments) {
		if (!attachment.base64Data) {
			// A web-element pick whose screenshot failed still delivers its excerpt.
			const webTag = webElementAttachmentTag(attachment);
			if (webTag) contentParts.push({ type: "text", text: webTag });
			continue;
		}
		const mimeType = normalizeMimeType(attachment.mimeType);

		// SVG is classified as an image upstream, but providers reject SVG image
		// payloads — its useful form is the markup itself, so route it through
		// the text-inline path below.
		if (attachment.mediaType === "image" && mimeType !== "image/svg+xml") {
			const dataUrl = `data:${attachment.mimeType};base64,${attachment.base64Data}`;
			// Web-element pick (embedded browser): emit provenance + text excerpt as
			// its OWN text part, before the image. A non-vision model drops the image
			// part but keeps this text — so it still gets the source URL + excerpt.
			const webTag = webElementAttachmentTag(attachment);
			if (webTag) contentParts.push({ type: "text", text: webTag });
			options.onImageAttachment?.({
				mimeType: attachment.mimeType,
				base64Length: attachment.base64Data.length,
				dataUrlPrefix: dataUrl.substring(0, 50) + "...",
			});
			contentParts.push({
				type: "image",
				image: dataUrl,
			});
			continue;
		}

		if (attachment.mediaType === "audio") {
			const dataUrl = `data:${attachment.mimeType};base64,${attachment.base64Data}`;
			contentParts.push({
				type: "audio",
				audio: dataUrl,
			});
			continue;
		}

		if (attachment.mediaType === "video") {
			const dataUrl = `data:${attachment.mimeType};base64,${attachment.base64Data}`;
			contentParts.push({
				type: "video",
				video: dataUrl,
			});
			continue;
		}

		const inline = tryInlineTextAttachment(attachment, inlineBudgetChars);
		if (inline) {
			contentParts.push({ type: "text", text: inline.text });
			inlineBudgetChars -= inline.consumedChars;
			continue;
		}

		contentParts.push({
			type: "file",
			data: attachment.base64Data,
			mediaType: attachment.mimeType,
			filename: attachment.fileName,
			...(attachment.filePath ? { path: attachment.filePath } : {}),
		});
	}

	return contentParts.length > 0 ? contentParts : message.content;
}

/**
 * Extract text from provider-facing message content.
 */
export function getTextFromContent(content: CoreAIMessageContent): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text",
			)
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}
