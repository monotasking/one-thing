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
	/**
	 * U4(2026-09-08):压缩**开始那一刻**的 provider 输入读数(tokens)。
	 *
	 * 只有 `completed` 带它,而且必须在开始处取一次存住 —— 压缩结束时会话上那格
	 * `contextSize` 已经被改写成压完之后的数,那时再读就是把「后」当成「前」。
	 * 壳上那句「701k → 96k」的前半截只有这里说得出来:压完的读数账本上有,
	 * 压之前的读数**这一刻之后就没人记得了**。可选、旧标记没有,照常渲染。
	 */
	contextSizeBefore?: number;
	/**
	 * 压完之后模型还看得见的上下文读数(`computeRetainedContextSizeAfterCompact`),
	 * 与 `contextSizeBefore` 对称:壳上那句「701k → 96k」的后半截。账本事件
	 * `session/compacted` 也带同一个数,标记上再写一份是为了折痕不必回账本对。
	 * 只有 `completed` 带它;可选,旧标记没有。
	 */
	retainedContextSize?: number;
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
	contextSizeBefore?: number;
	retainedContextSize?: number;
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
	if (typeof input.contextSizeBefore === "number" && input.contextSizeBefore > 0) {
		content.contextSizeBefore = input.contextSizeBefore;
	}
	if (typeof input.retainedContextSize === "number" && input.retainedContextSize > 0) {
		content.retainedContextSize = input.retainedContextSize;
	}
	return JSON.stringify(content);
}
