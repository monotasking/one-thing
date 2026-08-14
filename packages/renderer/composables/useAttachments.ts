import { ref } from "vue";
import { shouldAttemptTextDecode } from "@onething/core/engine/attachment-mime";
import { useActiveModelCapabilities } from "@/composables/useActiveModelCapabilities";
import { platformApi } from "@/platform";
import type { MessageAttachment, AttachmentMediaType } from "@/types";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
/**
 * Ceiling across the whole draft. Attachment bytes ride along inside the
 * send-message command as base64, so an unbounded draft is an unbounded IPC
 * payload — ten 9 MB files each pass the per-file check on their own.
 */
const MAX_DRAFT_ATTACHMENT_SIZE = 32 * 1024 * 1024;

/**
 * How the attachment will actually reach the model. When the selected model
 * can't take the bytes natively we don't refuse the file — the engine has two
 * fallbacks, and this records which one applies so the composer can say so.
 *
 * - `native`         — sent as an image/file part (engine: buildMessageContent)
 * - `inline-text`    — decoded and inlined as an <attachment> text block
 * - `path-reference` — only the on-disk path travels; the model is told to
 *                      read it with its file tools (undeliverableAttachmentText)
 */
export type AttachmentDelivery = "native" | "inline-text" | "path-reference";

// Local interface for file preview (extends MessageAttachment with preview)
export interface AttachedFile extends Omit<MessageAttachment, "base64Data"> {
	preview?: string; // Data URL for preview display
	base64Data: string; // Base64 encoded file data
	delivery: AttachmentDelivery;
}

/**
 * Short badge + hover text for a degraded attachment. Returns null for the
 * native route: the common case earns no ornament.
 */
export function describeDelivery(
	delivery: AttachmentDelivery,
): { badge: string; hint: string } | null {
	if (delivery === "inline-text") {
		return {
			badge: "TXT",
			hint: "This model can't take the file directly — its text will be inlined into the message.",
		};
	}
	if (delivery === "path-reference") {
		return {
			badge: "PATH",
			hint: "This model can't take the file directly — it will receive the file path and can open it with its file tools.",
		};
	}
	return null;
}

export interface AttachmentRejection {
	fileName: string;
	reason: "too-large" | "draft-too-large" | "undeliverable" | "read-error";
	message: string;
}

export interface AttachmentOperationResult {
	handled: boolean;
	accepted: AttachedFile[];
	rejected: AttachmentRejection[];
}

export interface UseAttachmentsOptions {
	/**
	 * 这些附件要发到哪个会话。判定"模型认不认图"必须与**发送时实际解析出的**
	 * provider/model 同源 —— 缺省(不传)时退回全局那一档,与从前一致。
	 */
	sessionId?: () => string | undefined;
}

export function useAttachments(options: UseAttachmentsOptions = {}) {
	const attachedFiles = ref<AttachedFile[]>([]);
	const isProcessing = ref(false);

	// 能力判定收口到与发送同源的那一条链(useActiveModelCapabilities):
	// 从前这里读的是全局 `settings.ai.provider`,而实际发送走会话置顶 / agent
	// 绑定 —— 会话钉了别的模型时两边就分叉,附件按错的模型降级。
	const { supportsVision, supportsFiles } = useActiveModelCapabilities(
		options.sessionId ?? (() => undefined),
	);
	const currentModelSupportsVision = supportsVision;
	const currentModelSupportsFiles = supportsFiles;

	function getMediaType(mimeType: string): AttachmentMediaType {
		if (mimeType.startsWith("image/")) return "image";
		if (mimeType.startsWith("audio/")) return "audio";
		if (mimeType.startsWith("video/")) return "video";
		if (
			mimeType === "application/pdf" ||
			mimeType.includes("document") ||
			mimeType.includes("word")
		)
			return "document";
		return "file";
	}

	// Files accepted earlier in the current batch aren't in `attachedFiles` yet
	// (they're appended once the batch settles), so the draft ceiling has to
	// count them explicitly or a single multi-file drop could blow past it.
	let inFlightBytes = 0;

	function draftBytes(): number {
		return (
			attachedFiles.value.reduce((total, f) => total + (f.size || 0), 0) +
			inFlightBytes
		);
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	function readFileAsBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				const base64 = result.split(",")[1];
				resolve(base64);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	function createImagePreview(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	function getImageDimensions(
		dataUrl: string,
	): Promise<{ width: number; height: number }> {
		return new Promise((resolve) => {
			const img = new Image();
			img.onload = () => resolve({ width: img.width, height: img.height });
			img.onerror = () => resolve({ width: 0, height: 0 });
			img.src = dataUrl;
		});
	}

	async function buildAttachedFile(
		file: File,
		filePath: string,
		delivery: AttachmentDelivery,
	): Promise<AttachedFile> {
		const id = `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const mimeType = file.type || "application/octet-stream";
		const mediaType = getMediaType(mimeType);
		const base64Data = await readFileAsBase64(file);

		const attachedFile: AttachedFile = {
			id,
			fileName: file.name || "clipboard-file",
			...(filePath ? { filePath } : {}),
			mimeType,
			size: file.size,
			mediaType,
			base64Data,
			delivery,
		};

		if (mediaType === "image") {
			attachedFile.preview = await createImagePreview(file);
			const dimensions = await getImageDimensions(attachedFile.preview);
			attachedFile.width = dimensions.width;
			attachedFile.height = dimensions.height;
		}

		return attachedFile;
	}

	/** On-disk path for dropped/picked files; "" for pasted files and web. */
	function resolveFilePath(file: File): string {
		try {
			return platformApi.getPathForFile(file) || "";
		} catch {
			return "";
		}
	}

	/**
	 * Pick the delivery route for a file the current model can't take natively.
	 * Refusing outright would be wrong — the engine can still get most files to
	 * the model, just not as bytes. Only a binary with no path on disk is
	 * genuinely undeliverable, and that combination means a pasted blob.
	 */
	function resolveDelivery(
		mimeType: string,
		mediaType: AttachmentMediaType,
		filePath: string,
	): AttachmentDelivery | null {
		const nativelySupported =
			mediaType === "image"
				? currentModelSupportsVision.value
				: currentModelSupportsFiles.value;
		if (nativelySupported) return "native";
		if (shouldAttemptTextDecode(mimeType)) return "inline-text";
		if (filePath) return "path-reference";
		return null;
	}

	async function processFile(file: File): Promise<AttachedFile> {
		const fileName = file.name || "clipboard-file";
		const mimeType = file.type || "application/octet-stream";
		const mediaType = getMediaType(mimeType);

		if (file.size > MAX_ATTACHMENT_SIZE) {
			throw {
				fileName,
				reason: "too-large",
				message: `${fileName} is too large. Maximum size is ${formatBytes(MAX_ATTACHMENT_SIZE)}.`,
			} satisfies AttachmentRejection;
		}

		if (draftBytes() + file.size > MAX_DRAFT_ATTACHMENT_SIZE) {
			throw {
				fileName,
				reason: "draft-too-large",
				message: `Attachments exceed ${formatBytes(MAX_DRAFT_ATTACHMENT_SIZE)} for one message. Send some first, or remove a file.`,
			} satisfies AttachmentRejection;
		}

		const filePath = resolveFilePath(file);
		const delivery = resolveDelivery(mimeType, mediaType, filePath);
		if (!delivery) {
			throw {
				fileName,
				reason: "undeliverable",
				message: `The current model can't read ${mediaType === "image" ? "images" : "this file type"}, and there's no file on disk to point it at.`,
			} satisfies AttachmentRejection;
		}

		return buildAttachedFile(file, filePath, delivery);
	}

	async function processFiles(
		files: File[],
	): Promise<AttachmentOperationResult> {
		const accepted: AttachedFile[] = [];
		const rejected: AttachmentRejection[] = [];

		if (files.length === 0) {
			return { handled: false, accepted, rejected };
		}

		isProcessing.value = true;
		inFlightBytes = 0;
		try {
			for (const file of files) {
				try {
					accepted.push(await processFile(file));
					inFlightBytes += file.size;
				} catch (error) {
					if (error && typeof error === "object" && "reason" in error) {
						rejected.push(error as AttachmentRejection);
					} else {
						rejected.push({
							fileName: file.name || "clipboard-file",
							reason: "read-error",
							message: `Failed to read ${file.name || "clipboard file"}.`,
						});
					}
				}
			}
		} finally {
			isProcessing.value = false;
			inFlightBytes = 0;
		}

		if (accepted.length > 0) {
			attachedFiles.value = [...attachedFiles.value, ...accepted];
		}

		return { handled: true, accepted, rejected };
	}

	function clipboardFiles(event: ClipboardEvent): File[] {
		const data = event.clipboardData;
		if (!data) return [];

		const files = new Map<string, File>();
		const add = (file: File | null) => {
			if (!file) return;
			const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
			files.set(key, file);
		};

		for (const file of Array.from(data.files ?? [])) {
			add(file);
		}

		for (const item of Array.from(data.items ?? [])) {
			if (item.kind === "file" || item.type.startsWith("image/")) {
				add(item.getAsFile());
			}
		}

		return Array.from(files.values());
	}

	function attachmentFromMessageAttachment(
		attachment: MessageAttachment,
	): AttachedFile {
		const filePath = attachment.filePath || "";
		const attachedFile: AttachedFile = {
			id: attachment.id,
			fileName: attachment.fileName,
			...(filePath ? { filePath } : {}),
			mimeType: attachment.mimeType,
			size: attachment.size,
			mediaType: attachment.mediaType,
			base64Data: attachment.base64Data || "",
			width: attachment.width,
			height: attachment.height,
			url: attachment.url,
			// Web-element provenance (embedded-browser pick) — carried through so a
			// restored draft keeps its source URL + excerpt.
			...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
			...(attachment.sourceTitle ? { sourceTitle: attachment.sourceTitle } : {}),
			...(attachment.excerpt ? { excerpt: attachment.excerpt } : {}),
			// Recomputed rather than stored: the user may have switched models
			// since the draft was saved, which changes the honest answer.
			delivery:
				resolveDelivery(attachment.mimeType, attachment.mediaType, filePath) ??
				"path-reference",
		};

		if (attachment.mediaType === "image" && attachment.base64Data) {
			attachedFile.preview = `data:${attachment.mimeType};base64,${attachment.base64Data}`;
		}

		attachedFiles.value = [...attachedFiles.value, attachedFile];
		return attachedFile;
	}

	async function handlePaste(
		event: ClipboardEvent,
	): Promise<AttachmentOperationResult> {
		const files = clipboardFiles(event);
		if (files.length === 0) {
			return { handled: false, accepted: [], rejected: [] };
		}

		event.preventDefault();
		return processFiles(files);
	}

	function restoreAttachments(attachments?: MessageAttachment[]) {
		attachedFiles.value = [];
		for (const attachment of attachments ?? []) {
			attachmentFromMessageAttachment(attachment);
		}
	}

	function removeAttachment(id: string) {
		attachedFiles.value = attachedFiles.value.filter((f) => f.id !== id);
	}

	function clearAttachments() {
		attachedFiles.value = [];
	}

	/** Convert attached files to MessageAttachment format (without preview) */
	function toMessageAttachments(): MessageAttachment[] | undefined {
		if (attachedFiles.value.length === 0) return undefined;
		return attachedFiles.value.map((f) => ({
			id: f.id,
			fileName: f.fileName,
			// Carries the engine's last-resort fallback: when a provider can't
			// deliver the bytes it tells the model to read this path with its
			// file tools (undeliverableAttachmentText). Dropping it here is what
			// made that fallback dead code.
			...(f.filePath ? { filePath: f.filePath } : {}),
			mimeType: f.mimeType,
			size: f.size,
			mediaType: f.mediaType,
			base64Data: f.base64Data,
			width: f.width,
			height: f.height,
			// Web-element provenance rides along to the engine (buildMessageContent
			// emits the <attachment source_url title>excerpt</attachment> text part).
			...(f.sourceUrl ? { sourceUrl: f.sourceUrl } : {}),
			...(f.sourceTitle ? { sourceTitle: f.sourceTitle } : {}),
			...(f.excerpt ? { excerpt: f.excerpt } : {}),
		}));
	}

	return {
		attachedFiles,
		isProcessing,
		handlePaste,
		processFiles,
		restoreAttachments,
		removeAttachment,
		clearAttachments,
		toMessageAttachments,
		/** Append one attachment from a plain MessageAttachment (no File/drag). */
		attachmentFromMessageAttachment,
	};
}
