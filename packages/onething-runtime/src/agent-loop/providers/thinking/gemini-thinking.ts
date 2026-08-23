/**
 * gemini 线上的两条思考线型 —— `gemini.ts` 退役前 `geminiThinkingConfig()` 的
 * **逐字搬运**(P1-b 是纯搬运,门是 `__tests__/wire-snapshots/gemini` 的 11 份
 * 快照,**禁 `-u`**)。
 *
 * 一句话分工:Gemini 3+ 收 `thinkingConfig.thinkingLevel`(档位名),2.5 收
 * `thinkingConfig.thinkingBudget`(数值预算)。**判据是模型名里有没有 `2.5`**
 * —— 与账本 `geminiProfile()` 的 `wire` 字段同一条谓词,但今天的
 * `gemini.ts` 问的是模型名而不是账本,所以这里也问模型名
 * (`GeminiWire.thinkingFor()` 覆盖了基类那条按 `profile.reasoningWire` 选的
 * 默认路径,理由写在那里)。
 *
 * 两条线型共有的三条现状:
 *  - **默认动态思考是 Gemini 自己的默认**,所以 `thinking` 没说话时整段不发;
 *  - 开着时才带 `includeThoughts: true`;
 *  - 「关」在这条线上是**降到最低档**而不是真关:2.5 flash 能把预算设成 0,
 *    2.5 pro 落到 `minimal` 的预算,3.x 落到该模型接受的最低档位。
 */
import type { AgentTurnRequest } from "@onething/core/agent-loop";
import {
	ONETHING_GEMINI_THINKING_BUDGETS,
	onethingGeminiThinkingLevels,
} from "../../../providers/model-capability.js";
import type {
	RequestBodyBuilder,
	ThinkingWire,
	TurnContext,
} from "../base/index.js";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface GeminiThinkingConfig {
	includeThoughts?: boolean;
	/** Gemini 3+ knob. */
	thinkingLevel?: GeminiThinkingLevel;
	/** Gemini 2.5 knob: token budget, 0 = off (flash only), -1 = dynamic. */
	thinkingBudget?: number;
}

const GEMINI_LEVEL_ORDER = ["minimal", "low", "medium", "high"] as const;

/** `thinkingConfig` 在请求体里的落点 —— 两条线型共用一条路径。 */
export const GEMINI_THINKING_CONFIG_PATH = "generationConfig.thinkingConfig";

/**
 * Clamp the abstract effort onto a level the model actually accepts
 * (gemini-3-pro only takes low/high; flash-lite-image only minimal/high):
 * prefer the requested level, else the closest supported one below it, else
 * the lowest supported.
 */
export function geminiThinkingLevel(
	effort: AgentTurnRequest["reasoningEffort"],
	model: string,
): GeminiThinkingLevel {
	const supported = onethingGeminiThinkingLevels(model);
	const requested =
		effort === "minimal" || effort === "low" || effort === "medium"
			? effort
			: "high";
	if (supported.includes(requested)) return requested;
	const requestedIndex = GEMINI_LEVEL_ORDER.indexOf(requested);
	for (let index = requestedIndex - 1; index >= 0; index--) {
		if (supported.includes(GEMINI_LEVEL_ORDER[index]!)) {
			return GEMINI_LEVEL_ORDER[index]!;
		}
	}
	return supported[0] ?? "high";
}

/** `isGemini25Model` 逐字:模型名里出现 `2.5` 就是那一代。 */
export function isGemini25Model(model: string): boolean {
	return model.toLowerCase().includes("2.5");
}

/** 两条线型的公共壳:算出 config 就写进去,算不出就什么都不发。 */
abstract class GeminiThinkingWire implements ThinkingWire {
	abstract readonly id: string;

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		const config = this.config(turn);
		if (config) builder.set(GEMINI_THINKING_CONFIG_PATH, config);
	}

	protected abstract config(turn: TurnContext): GeminiThinkingConfig | undefined;

	protected level(turn: TurnContext): GeminiThinkingLevel {
		return geminiThinkingLevel(turn.request.reasoningEffort, turn.model);
	}
}

/** Gemini 3+:档位名。「关」= 该模型接受的最低档(3.x 关不掉思考)。 */
export class GeminiLevelThinkingWire extends GeminiThinkingWire {
	readonly id = "gemini-level";

	protected config(turn: TurnContext): GeminiThinkingConfig | undefined {
		if (turn.request.thinking === "enabled") {
			return { includeThoughts: true, thinkingLevel: this.level(turn) };
		}
		if (turn.request.thinking === "disabled") {
			// The lowest level this model accepts stands in for "off" (Gemini 3
			// cannot fully disable thinking).
			return {
				thinkingLevel: onethingGeminiThinkingLevels(turn.model)[0] ?? "low",
			};
		}
		return undefined;
	}
}

/** Gemini 2.5:数值预算。只有 flash 档能把预算真的设成 0。 */
export class GeminiBudgetThinkingWire extends GeminiThinkingWire {
	readonly id = "gemini-budget";

	protected config(turn: TurnContext): GeminiThinkingConfig | undefined {
		if (turn.request.thinking === "enabled") {
			return {
				includeThoughts: true,
				thinkingBudget: ONETHING_GEMINI_THINKING_BUDGETS[this.level(turn)],
			};
		}
		if (turn.request.thinking === "disabled") {
			return turn.model.toLowerCase().includes("flash")
				? { thinkingBudget: 0 }
				: { thinkingBudget: ONETHING_GEMINI_THINKING_BUDGETS.minimal };
		}
		return undefined;
	}
}

export const geminiLevelThinkingWire = new GeminiLevelThinkingWire();
export const geminiBudgetThinkingWire = new GeminiBudgetThinkingWire();

/** 这条 wire 上可能出现的线型 —— 走哪条由 `GeminiWire.thinkingFor()` 选。 */
export const GEMINI_THINKING_WIRES: ThinkingWire[] = [
	geminiLevelThinkingWire,
	geminiBudgetThinkingWire,
];
