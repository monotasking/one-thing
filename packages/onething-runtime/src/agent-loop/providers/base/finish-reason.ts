/**
 * `FinishReasonMapper` —— 线上的收尾原因翻成契约里的那七个值。
 *
 * P0a 只落 OpenAI 形状,逐字复刻 `openai-compatible.ts` 的 `mapFinishReason`。
 * context-overflow 归到压缩层(替掉 `retry.ts` 的文本正则)是 P2 的事。
 */
import type { AgentFinishReason } from "@onething/core/agent-loop";

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
