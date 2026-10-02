/**
 * Browser-safe leaf module: MIME classification for message attachments.
 *
 * Both ends of the attachment pipeline need the same answer to "will this
 * attachment survive as inlined text?" — the renderer uses it to decide whether
 * a file is still deliverable to a model that lacks image/file input, and
 * ./message-content.ts uses it to decide whether to actually inline the bytes.
 * Keeping one implementation means the composer can never promise a delivery
 * the engine won't honor.
 *
 * No node deps and no imports from the engine barrel — the renderer bundles
 * this directly (see the alias ordering note in electron.vite.config.ts).
 */

const TEXT_LIKE_EXACT_MIME_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/sql",
	"application/javascript",
	"application/x-javascript",
	"application/typescript",
	"application/x-typescript",
	"application/x-sh",
	"application/xhtml+xml",
	"application/x-ipynb+json",
	"image/svg+xml",
]);

export function normalizeMimeType(mimeType: string): string {
	return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

export function isTextLikeMimeType(mimeType: string): boolean {
	if (!mimeType) return false;
	if (mimeType.startsWith("text/")) return true;
	if (TEXT_LIKE_EXACT_MIME_TYPES.has(mimeType)) return true;
	return /\+(json|xml|yaml)$/.test(mimeType);
}

export function shouldAttemptTextDecode(mimeType: string): boolean {
	// Browsers report an empty type for extensions they don't know (.vue, .ts,
	// …) and the renderer normalizes that to octet-stream — sniff those too.
	return (
		isTextLikeMimeType(mimeType) ||
		mimeType === "application/octet-stream" ||
		mimeType === ""
	);
}
