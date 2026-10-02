/**
 * `FinishReasonMapper` —— 线上的收尾原因翻成契约里的那七个值。
 *
 * P0a 只落 OpenAI 形状,逐字复刻 `openai-compatible.ts` 的 `mapFinishReason`。
 * context-overflow 归到压缩层(替掉 `retry.ts` 的文本正则)是 P2 的事。
 */
import type { AgentFinishReason } from "@onething/backend/core/agent-loop";

export interface FinishReasonMapper {
	map(raw: string | null | undefined): AgentFinishReason;
}

export class OpenAIFinishReasonMapper implements FinishReasonMapper {
	map(reason: string | null | undefined): AgentFinishReason {
		switch (reason) {
			case "stop":
			case "length":
				return reason;
			case "tool_calls":
			case "function_call":
				return "tool_calls";
			case "content_filter":
				return "content_filter";
			default:
				return "unknown";
		}
	}
}

export const openAIFinishReasonMapper: FinishReasonMapper = new OpenAIFinishReasonMapper();

/**
 * 方言那一格(§7.5 同法):收尾原因**在哪**、**叫什么**、流有没有结束标记。
 * 三格都缺 = 线今天的读法(`choices[0].finish_reason`、`openAIFinishReasonMapper`、`[DONE]`)。
 * 今天只有 openai-chat 线读它;唯一的产地是适配表编译器。
 */
export interface DialectFinishShape {
	/** 收尾原因的路径(点号 + 下标)。缺 = 线的默认位置。 */
	reasonPath?: string;
	/** 原值 → 契约值,先查这张表,查不到再走线的默认映射。 */
	reasonMap?: Readonly<Record<string, AgentFinishReason>>;
	/** SSE 的结束标记。缺 = `'[DONE]'`;`null` = 这家不发,靠流关闭收尾。 */
	doneMarker?: string | null;
}

/** 先查方言的表,查不到交给线的默认映射 —— 表只加词,不改默认词的译法。 */
export class TableFinishReasonMapper implements FinishReasonMapper {
	constructor(
		private readonly table: Readonly<Record<string, AgentFinishReason>>,
		private readonly fallback: FinishReasonMapper,
	) {}

	map(reason: string | null | undefined): AgentFinishReason {
		if (typeof reason === "string" && Object.hasOwn(this.table, reason)) {
			return this.table[reason]!;
		}
		return this.fallback.map(reason);
	}
}

/** 方言给了表就包一层,没给就是线的默认映射本身(同一个对象,零开销)。 */
export function finishReasonMapperFor(
	shape: DialectFinishShape | undefined,
	fallback: FinishReasonMapper,
): FinishReasonMapper {
	const table = shape?.reasonMap;
	return table && Object.keys(table).length > 0
		? new TableFinishReasonMapper(table, fallback)
		: fallback;
}
