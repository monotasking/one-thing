/**
 * `openrouter-reasoning` —— OpenRouter 统一的 `reasoning: {}` 对象:
 * 开 = `{effort}`(不给档位默认 `high`),关 = `{enabled:false}`。
 *
 * `encode()` 逐字复刻 `openai-compatible.ts` 的 `'openrouter-reasoning'` 分支。
 *
 * **`reasoning_details[]` 的解码也在这里**(P3-4,设计稿 §5.1「思维链字段/回传」
 * 行 / §12):同一条线型的编码 / 解码 / 回传归一个对象(`ThinkingWire` 的抬头)。
 * 文字增量那半边仍由基类的 `decode()` 读(`delta.reasoning_content ??
 * delta.reasoning`,后者是前者的别名),这里多出来的是**结构化的那一半** ——
 * 上游把思维链切成带 `type` / `id` / `index` / `format` 的项,OpenRouter 要求
 * 多轮/工具调用时**原样、连续、按原顺序**送回去。所以这里一个字段都不解释、
 * 一个字段都不丢:整项原封不动装进一条 `provider-data` 事件,回传那一侧
 * (`OpenAIChatPartCodec.assistant`)再原样拼回 `reasoning_details`。
 *
 * 事件形状与 codex 的 `encrypted-reasoning` 对齐:一条 `provider-data` 在消息上
 * 落一格 `{type:'provider-data', providerData, turnIndex}`(非 codex 走 core 的
 * 缺省计划),历史重建再把那一格摊回 `AgentMessage.providerData[]`。
 */
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import type {
	AgentJsonObject,
	AgentJsonValue,
} from "@onething/core/agent-loop";
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

/** 这条 `provider-data` 的 `type` —— 落点与回传两侧共用同一个字面量。 */
export const OPENROUTER_REASONING_DETAILS_TYPE = "reasoning-details";

/** 一块里读到的 `reasoning_details[]` 项(原样,不解释任何字段)。 */
function reasoningDetailItems(value: unknown): AgentJsonObject[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is AgentJsonObject =>
			typeof item === "object" && item !== null && !Array.isArray(item),
	);
}

/**
 * 一块 → 0 或 1 条 `provider-data` 事件。
 *
 * 两种落点都认:流式 `delta.reasoning_details[]` 与被折进流里的非流式
 * `message.reasoning_details[]`(与 `images[]` 同一条判例)。**一块里的多项
 * 合成一条事件**,数组顺序原样 —— 顺序是行为,OpenRouter 明说不可改。
 */
export function decodeOpenRouterReasoningDetails(
	chunk: unknown,
	turn: TurnContext,
): AgentTurnStreamEvent[] {
	if (!chunk || typeof chunk !== "object") return [];
	const choice = (chunk as { choices?: unknown[] }).choices?.[0] as
		| {
				delta?: { reasoning_details?: unknown };
				message?: { reasoning_details?: unknown };
		  }
		| undefined;
	if (!choice) return [];

	const details: AgentJsonValue[] = [
		...reasoningDetailItems(choice.delta?.reasoning_details),
		...reasoningDetailItems(choice.message?.reasoning_details),
	];
	if (details.length === 0) return [];

	return [
		{
			type: "provider-data",
			turn: turn.turn,
			providerData: {
				provider: "openrouter",
				type: OPENROUTER_REASONING_DETAILS_TYPE,
				details,
			},
		},
	];
}

export class OpenRouterReasoningWire extends OpenAIChatThinkingWire {
	readonly id = "openrouter-reasoning";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { thinking, reasoningEffort } = turn.request;
		if (thinking === "enabled") {
			builder.set("reasoning", { effort: reasoningEffort ?? "high" });
			return;
		}
		if (thinking === "disabled") builder.set("reasoning", { enabled: false });
	}

	/** 结构化那一半 —— 方言把它接在 codec 的 `decodeExtras` 上。 */
	decodeDetails(chunk: unknown, turn: TurnContext): AgentTurnStreamEvent[] {
		return decodeOpenRouterReasoningDetails(chunk, turn);
	}
}

export const openRouterReasoningWire = new OpenRouterReasoningWire();
