/**
 * 压缩标记消息的**正文形状与序列化** —— 零依赖叶子(§17.8 U1-a)。
 *
 * 这几样从前住在 `context-compact.ts` 里,而那个文件为了压缩**算法**要
 * `./history.js`,history 又要 `../agent-loop/tool-names.js`,那一件带
 * `node:crypto` —— 于是投影侧的 `session/projection/chat-messages.ts`(它只要
 * 这一个序列化函数,§13.10 M3:压缩卡正文必须与引擎写出去的那条**逐字节同源**,
 * 不许手抄一份 JSON)被整条算法链拖进了 node 闭包。
 *
 * 拆出来的是**形状 + 一次 `JSON.stringify`**,与压缩怎么算没有关系。
 * `context-compact.ts` 原样再导出它们,所有既有 import 一字未改。
 */

export type CoreContextCompactStatus = "compacting" | "completed" | "failed";

export interface CoreContextCompactProgress {
	chunk: number;
	totalChunks: number;
}

export interface CoreContextCompactContent {
	type: "context-compact";
	status: CoreContextCompactStatus;
	summary: string;
	compactedMessageCount: number;
	error?: string;
	/**
	 * P0(2026-08-14):标记消息不再插进历史中部,而是**追加到会话末尾** ——
	 * 展示位置从此是「压缩发生的时间点」。切点因而必须写进内容:这是「压到
	 * 哪一条为止」的唯一凭据。字段可选、位置任意 —— 旧会话中部的历史标记
	 * 没有它,照常渲染,无需迁移。
	 */
	compactedThroughMessageId?: string;
	/**
	 * P3:多块摘要的进度(每块完成后刷一次 marker)。单块压缩不写,不多发事件。
	 */
	progress?: CoreContextCompactProgress;
}

export interface CoreContextCompactMessage {
	id: string;
	role: "system";
	content: string;
	timestamp: number;
}

export function buildContextCompactContent(input: {
	status: CoreContextCompactStatus;
	compactedMessageCount: number;
	summary?: string;
	error?: string;
	compactedThroughMessageId?: string;
	progress?: CoreContextCompactProgress;
}): string {
	const content: CoreContextCompactContent = {
		type: "context-compact",
		status: input.status,
		summary: input.summary ?? "",
		compactedMessageCount: input.compactedMessageCount,
	};
	if (input.error) {
		content.error = input.error;
	}
	if (input.compactedThroughMessageId) {
		content.compactedThroughMessageId = input.compactedThroughMessageId;
	}
	if (input.progress) {
		content.progress = input.progress;
	}
	return JSON.stringify(content);
}
