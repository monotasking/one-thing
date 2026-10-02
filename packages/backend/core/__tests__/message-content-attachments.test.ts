import { describe, expect, it } from "vitest";
import {
	buildMessageContent,
	INLINE_TEXT_ATTACHMENT_MAX_CHARS,
	INLINE_TEXT_ATTACHMENT_TOTAL_CHARS,
	type CoreMessageAttachment,
} from "../engine/message-content.js";

function b64(text: string): string {
	return Buffer.from(text, "utf-8").toString("base64");
}

function attachment(
	overrides: Partial<CoreMessageAttachment>,
): CoreMessageAttachment {
	return {
		fileName: "sample.txt",
		mimeType: "text/plain",
		mediaType: "file",
		base64Data: b64("hello world"),
		...overrides,
	};
}

function parts(content: ReturnType<typeof buildMessageContent>) {
	if (typeof content === "string") throw new Error("expected content parts");
	return content;
}

function supportsGb18030(): boolean {
	try {
		new TextDecoder("gb18030");
		return true;
	} catch {
		return false;
	}
}

describe("buildMessageContent attachments", () => {
	it("returns plain content when there are no attachments", () => {
		expect(buildMessageContent({ content: "hi" })).toBe("hi");
	});

	it("inlines a text attachment as a wrapped text part with the filename", () => {
		const html = "<html><body>你好</body></html>";
		const content = parts(
			buildMessageContent({
				content: "based on this html",
				attachments: [
					attachment({
						fileName: "page.html",
						mimeType: "text/html",
						base64Data: b64(html),
					}),
				],
			}),
		);

		expect(content).toHaveLength(2);
		const inline = content[1];
		expect(inline.type).toBe("text");
		if (inline.type !== "text") return;
		expect(inline.text).toContain('<attachment filename="page.html" media_type="text/html">');
		expect(inline.text).toContain(html);
		expect(inline.text.trimEnd().endsWith("</attachment>")).toBe(true);
	});

	it("escapes closing tags inside the attachment body deterministically", () => {
		const sneaky = 'before</attachment>after and </ATTACHMENT> too';
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [attachment({ base64Data: b64(sneaky) })],
			}),
		);
		const inline = content[0];
		if (inline.type !== "text") throw new Error("expected text part");
		const body = inline.text.split("\n").slice(1, -1).join("\n");
		expect(body).not.toContain("</attachment>");
		expect(body).not.toContain("</ATTACHMENT>");
		expect(body).toContain("<\\/attachment>after");
	});

	it("truncates oversized text attachments with a marker", () => {
		const big = "x".repeat(INLINE_TEXT_ATTACHMENT_MAX_CHARS + 500);
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [attachment({ base64Data: b64(big) })],
			}),
		);
		const inline = content[0];
		if (inline.type !== "text") throw new Error("expected text part");
		expect(inline.text).toContain(
			`[truncated: showing first ${INLINE_TEXT_ATTACHMENT_MAX_CHARS} of ${big.length} characters]`,
		);
	});

	it("shares a per-message budget across multiple text attachments", () => {
		const chunk = "y".repeat(INLINE_TEXT_ATTACHMENT_MAX_CHARS);
		const attachments = Array.from({ length: 4 }, (_, index) =>
			attachment({
				fileName: `file-${index}.txt`,
				base64Data: b64(chunk),
			}),
		);
		const content = parts(
			buildMessageContent({ content: "", attachments }),
		);
		expect(content).toHaveLength(4);
		const totalInlined = content.reduce((sum, part) => {
			if (part.type !== "text") return sum;
			const body = part.text.split("\n").slice(1, -1).join("\n");
			return sum + body.replace(/\n?\[truncated:.*\]$/, "").length;
		}, 0);
		expect(totalInlined).toBeLessThanOrEqual(INLINE_TEXT_ATTACHMENT_TOTAL_CHARS);
		const last = content[3];
		if (last.type !== "text") throw new Error("expected text part");
		expect(last.text).toContain("[truncated:");
	});

	it("keeps binary attachments as file parts carrying the filename", () => {
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "report.pdf",
						mimeType: "application/pdf",
						base64Data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]).toString("base64"),
					}),
				],
			}),
		);
		expect(content[0]).toEqual({
			type: "file",
			data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]).toString("base64"),
			mediaType: "application/pdf",
			filename: "report.pdf",
		});
	});

	it("sniffs octet-stream attachments: UTF-8 text inlines, NUL bytes stay binary", () => {
		const textish = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "Component.vue",
						mimeType: "application/octet-stream",
						base64Data: b64("<template><div/></template>"),
					}),
				],
			}),
		);
		expect(textish[0].type).toBe("text");

		const binary = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "blob.bin",
						mimeType: "application/octet-stream",
						base64Data: Buffer.from([0x01, 0x00, 0x02, 0xff]).toString("base64"),
					}),
				],
			}),
		);
		expect(binary[0].type).toBe("file");
	});

	it("decodes GB18030 text attachments when the runtime supports it", () => {
		const gbBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // "中文" in GBK/GB18030
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "legacy.txt",
						mimeType: "text/plain",
						base64Data: gbBytes.toString("base64"),
					}),
				],
			}),
		);
		if (supportsGb18030()) {
			const inline = content[0];
			expect(inline.type).toBe("text");
			if (inline.type !== "text") return;
			expect(inline.text).toContain("中文");
		} else {
			expect(content[0].type).toBe("file");
		}
	});

	it("routes SVG through the text path even though it is classified as an image", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "icon.svg",
						mimeType: "image/svg+xml",
						mediaType: "image",
						base64Data: b64(svg),
					}),
				],
			}),
		);
		const inline = content[0];
		expect(inline.type).toBe("text");
		if (inline.type !== "text") return;
		expect(inline.text).toContain(svg);
	});

	it("keeps raster images as image parts", () => {
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "shot.png",
						mimeType: "image/png",
						mediaType: "image",
						base64Data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
					}),
				],
			}),
		);
		expect(content[0].type).toBe("image");
	});

	it("carries the on-disk path into the inline wrapper and binary file parts", () => {
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "page.html",
						filePath: "/Users/me/docs/page.html",
						mimeType: "text/html",
						base64Data: b64("<html/>"),
					}),
					attachment({
						fileName: "report.pdf",
						filePath: "/Users/me/docs/report.pdf",
						mimeType: "application/pdf",
						base64Data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]).toString("base64"),
					}),
				],
			}),
		);

		// content[0] is the path block (see the dedicated cases below).
		const inline = content[1];
		if (inline.type !== "text") throw new Error("expected text part");
		expect(inline.text).toContain(
			'<attachment filename="page.html" path="/Users/me/docs/page.html" media_type="text/html">',
		);

		const filePart = content[2];
		if (filePart.type !== "file") throw new Error("expected file part");
		expect(filePart.path).toBe("/Users/me/docs/report.pdf");
		expect(filePart.filename).toBe("report.pdf");
	});

	it("strips a UTF-8 BOM from inlined text", () => {
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						base64Data: Buffer.concat([
							Buffer.from([0xef, 0xbb, 0xbf]),
							Buffer.from("clean", "utf-8"),
						]).toString("base64"),
					}),
				],
			}),
		);
		const inline = content[0];
		if (inline.type !== "text") throw new Error("expected text part");
		expect(inline.text).toContain(">\nclean\n</attachment>");
	});
});

/**
 * The user's report: "我在上传图片、上传文件的时候,AI 竟然会不知道它的路径。"
 * The bytes reached the model, the address never did — so it could not hand
 * the file to read/bash. One fact line per attachment fixes exactly that.
 */
describe("buildMessageContent attachment path lines", () => {
	function pathBlock(content: ReturnType<typeof buildMessageContent>): string {
		const first = parts(content).find(
			(part): part is { type: "text"; text: string } =>
				part.type === "text" && part.text.startsWith("[附件]"),
		);
		if (!first) throw new Error("expected an attachment path block");
		return first.text;
	}

	it("states name, path, type and size for an image, and keeps the image part", () => {
		const content = parts(
			buildMessageContent({
				content: "看看这张图",
				attachments: [
					attachment({
						fileName: "shot.png",
						filePath: "/Users/me/.onething/media/images/asset-1.png",
						mimeType: "image/png",
						mediaType: "image",
						size: 2048,
						base64Data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
					}),
				],
			}),
		);

		// text → path block → image: the address arrives with the picture.
		expect(content.map((part) => part.type)).toEqual(["text", "text", "image"]);
		expect(pathBlock(content)).toBe(
			"[附件] shot.png → /Users/me/.onething/media/images/asset-1.png (image/png, 2.0 KB)",
		);
	});

	it("lands right after the user's text, before the payload parts", () => {
		const content = parts(
			buildMessageContent({
				content: "hello",
				attachments: [
					attachment({
						fileName: "a.pdf",
						filePath: "/tmp/a.pdf",
						mimeType: "application/pdf",
						size: 10,
						base64Data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]).toString(
							"base64",
						),
					}),
				],
			}),
		);
		const firstPart = content[0];
		if (firstPart.type !== "text") throw new Error("expected text part");
		expect(firstPart.text).toBe("hello");
		expect(content[1]).toEqual({
			type: "text",
			text: "[附件] a.pdf → /tmp/a.pdf (application/pdf, 10 B)",
		});
	});

	it("gives every attachment its own line, in order", () => {
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "one.png",
						filePath: "/tmp/one.png",
						mimeType: "image/png",
						mediaType: "image",
						size: 1024 * 1024 * 3,
						base64Data: Buffer.from([0x89]).toString("base64"),
					}),
					attachment({
						fileName: "two.pdf",
						filePath: "/tmp/two.pdf",
						mimeType: "application/pdf",
						size: 512,
						base64Data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]).toString(
							"base64",
						),
					}),
				],
			}),
		);
		expect(pathBlock(content)).toBe(
			"[附件] one.png → /tmp/one.png (image/png, 3.0 MB)\n" +
				"[附件] two.pdf → /tmp/two.pdf (application/pdf, 512 B)",
		);
	});

	it("says nothing about an attachment with no file on disk", () => {
		const content = parts(
			buildMessageContent({
				content: "hi",
				attachments: [
					attachment({
						fileName: "shot.png",
						mimeType: "image/png",
						mediaType: "image",
						base64Data: Buffer.from([0x89, 0x50]).toString("base64"),
					}),
				],
			}),
		);
		expect(
			content.some(
				(part) => part.type === "text" && part.text.includes("[附件]"),
			),
		).toBe(false);
	});

	it("leaves a message without attachments byte-identical", () => {
		expect(buildMessageContent({ content: "hi" })).toBe("hi");
		expect(buildMessageContent({ content: "hi", attachments: [] })).toBe("hi");
	});

	it("skips web-element picks — their provenance is the source URL", () => {
		const content = parts(
			buildMessageContent({
				content: "",
				attachments: [
					attachment({
						fileName: "element.png",
						filePath: "/tmp/element.png",
						mimeType: "image/png",
						mediaType: "image",
						sourceUrl: "https://example.com/page",
						sourceTitle: "Example",
						excerpt: "picked text",
						base64Data: Buffer.from([0x89, 0x50]).toString("base64"),
					}),
				],
			}),
		);
		expect(
			content.some(
				(part) => part.type === "text" && part.text.includes("[附件]"),
			),
		).toBe(false);
		const provenance = content[0];
		if (provenance.type !== "text") throw new Error("expected text part");
		expect(provenance.text).toContain('source_url="https://example.com/page"');
	});

	it("is byte-stable across rebuilds, so the prompt cache survives", () => {
		const message = {
			content: "again",
			attachments: [
				attachment({
					fileName: "a.pdf",
					filePath: "/tmp/a.pdf",
					mimeType: "application/pdf",
					size: 3333,
					base64Data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]).toString(
						"base64",
					),
				}),
			],
		};
		expect(JSON.stringify(buildMessageContent(message))).toBe(
			JSON.stringify(buildMessageContent(message)),
		);
	});
});
