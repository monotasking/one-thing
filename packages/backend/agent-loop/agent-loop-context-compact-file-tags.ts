// 上下文压缩的第四步:摘要尾部那两张确定性文件清单(读过 / 改过)的标签格式化、读回、剥离与合并。
// 「哪个工具的哪个参数是路径」的分类表在 `agent-loop-compact-file-lists.ts`;这里只做通用字符串活。

export const COMPACT_READ_FILES_TAG = "read-files";

export const COMPACT_MODIFIED_FILES_TAG = "modified-files";

export interface CoreCompactFileOperations {
	read: string[];
	modified: string[];
}

const compactFileTagRe = (tag: string) =>
	new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "g");

/**
 * C5:确定性文件清单的**格式化**(通用字符串活,归 core);「哪个工具的哪个
 * 参数是路径」的分类表归 app 层 —— core 不识产品工具名。空清单省略对应标签。
 */
export function formatCompactFileOperations(
	operations: CoreCompactFileOperations,
): string {
	const blocks: string[] = [];
	if (operations.read.length > 0) {
		blocks.push(
			`<${COMPACT_READ_FILES_TAG}>\n${operations.read.join("\n")}\n</${COMPACT_READ_FILES_TAG}>`,
		);
	}
	if (operations.modified.length > 0) {
		blocks.push(
			`<${COMPACT_MODIFIED_FILES_TAG}>\n${operations.modified.join("\n")}\n</${COMPACT_MODIFIED_FILES_TAG}>`,
		);
	}
	return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

/** 从一份既有摘要的尾部读回两张清单(UPDATE 模式的并集去重用)。 */
export function extractCompactFileOperations(
	summary: string,
): CoreCompactFileOperations {
	const collect = (tag: string): string[] => {
		const lines: string[] = [];
		for (const match of summary.matchAll(compactFileTagRe(tag))) {
			for (const line of match[1].split("\n")) {
				const entry = line.trim();
				if (entry) lines.push(entry);
			}
		}
		return dedupePreservingOrder(lines);
	};
	return {
		read: collect(COMPACT_READ_FILES_TAG),
		modified: collect(COMPACT_MODIFIED_FILES_TAG),
	};
}

/**
 * 剥掉尾部的两张清单。传给模型的 previousSummary 走这里:清单归代码管,
 * 让模型看见它只会把它改写掉。
 */
export function stripCompactFileOperations(summary: string): string {
	return summary
		.replace(compactFileTagRe(COMPACT_READ_FILES_TAG), "")
		.replace(compactFileTagRe(COMPACT_MODIFIED_FILES_TAG), "")
		.trim();
}

export function mergeCompactFileOperations(
	previous: CoreCompactFileOperations,
	next: CoreCompactFileOperations,
): CoreCompactFileOperations {
	return {
		read: dedupePreservingOrder([...previous.read, ...next.read]),
		modified: dedupePreservingOrder([...previous.modified, ...next.modified]),
	};
}

function dedupePreservingOrder(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}
