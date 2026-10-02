/**
 * `openai-effort` —— OpenAI o 系 / gpt-5 的思考旋钮:只有一个 effort 字段
 * (chat 通路拼在顶层 `reasoning_effort`,Responses 通路拼在
 * `reasoning: { effort }`;两条线共用这一份判据)。
 *
 * ## 合法档位是**按模型**的,唯一来源是账本(拍板 #14)
 *
 * 官方 `/docs/guides/reasoning` 逐字:「Supported values are model-dependent
 * and can include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
 * `max`.」—— 所以 wire **不再持有一张四档硬表**,它问
 * `turn.profile.reasoningProfile.efforts`(账本按官方模型页给的那张表,见
 * `providers/model-capability.ts` 的 `ONETHING_OPENAI_EFFORTS` 抬头)。
 *
 * 钳法:**在表里就原样发**;不在就沿档位阶梯**先向下**找最近的合法档
 * (`max` → `xhigh` → `high`),向下没有再向上(`minimal` 对 5.1+ 那些没有
 * `minimal` 的模型退成 `low`)。账本说不出话(自定义端点、copilot 那类没有
 * profile 的模型)就退回换线之前的四档表 —— 行为逐字不变。
 *
 * **关得掉与关不掉也是按模型分的**(P3-3):gpt-5.1 起这条线多一个
 * `reasoning_effort: 'none'` 档 —— 那是这一家唯一的「别想」开关(它始终没有
 * `thinking` 参数)。判据同样只有账本:`efforts` 里有没有 `'none'`。没有
 * (o 系列、gpt-5.0)就保持今天的行为:`disabled` 什么都不发。
 * wire 自己不认模型名。
 *
 * `'none'` 不是一个可选的思考强度,它是思考的缺席 —— 所以它只回答 `disabled`
 * 那一问,`enabled` 一路的钳位永远钳不到它。
 */
import type { RequestBodyBuilder, TurnContext } from "../base/index.js";
import { OpenAIChatThinkingWire } from "./openai-chat-thinking-wire.js";

/** 官方那七个值里去掉 `'none'` 之后的**强度阶梯**,从弱到强。 */
export const OPENAI_REASONING_EFFORT_LADDER = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type OpenAIReasoningEffort =
	(typeof OPENAI_REASONING_EFFORT_LADDER)[number];

/**
 * 账本没话说时的兜底表 —— 就是 P4-9 之前这条 wire 写死的那四档,所以
 * 「没有 profile 的模型」在换法之后字节不变。
 */
const OPENAI_FALLBACK_EFFORTS: readonly OpenAIReasoningEffort[] = [
	"minimal",
	"low",
	"medium",
	"high",
];

function isLadderRung(value: string | undefined): value is OpenAIReasoningEffort {
	return (OPENAI_REASONING_EFFORT_LADDER as readonly string[]).includes(
		value ?? "",
	);
}

/** 这个模型的合法强度档 —— 账本的 `efforts` 去掉 `'none'`(它不是强度)。 */
function allowedEfforts(
	efforts: readonly string[] | undefined,
): readonly OpenAIReasoningEffort[] {
	const rungs = (efforts ?? []).filter(isLadderRung);
	return rungs.length > 0 ? rungs : OPENAI_FALLBACK_EFFORTS;
}

/**
 * 请求的 effort → 这个模型收得下的那一档。`efforts` 不给 = 账本没话说 = 四档
 * 兜底表(见文件头)。`undefined`(用户没选)按 `'high'` 算 —— 与 P4-9 之前
 * 逐字相同。
 */
export function clampOpenAIReasoningEffort(
	effort: string | undefined,
	efforts?: readonly string[],
): OpenAIReasoningEffort {
	const table = allowedEfforts(efforts);
	const requested: OpenAIReasoningEffort = isLadderRung(effort) ? effort : "high";
	if (table.includes(requested)) return requested;

	const index = OPENAI_REASONING_EFFORT_LADDER.indexOf(requested);
	// 先向下退(max → xhigh → high …):宁可少想,不要 400。
	for (let i = index - 1; i >= 0; i -= 1) {
		const candidate = OPENAI_REASONING_EFFORT_LADDER[i]!;
		if (table.includes(candidate)) return candidate;
	}
	// 向下没有了才向上(`minimal` 对不含它的模型 ⇒ `low`)。
	for (let i = index + 1; i < OPENAI_REASONING_EFFORT_LADDER.length; i += 1) {
		const candidate = OPENAI_REASONING_EFFORT_LADDER[i]!;
		if (table.includes(candidate)) return candidate;
	}
	return "high";
}

/** 这一回合的模型收哪些档 —— 账本说了算(`undefined` = 没话说)。 */
export function openAIReasoningEffortsFor(
	turn: TurnContext,
): readonly string[] | undefined {
	return turn.profile.reasoningProfile?.efforts;
}

/** 这个模型收不收 `reasoning_effort: 'none'` —— 账本说了算。 */
export function openAIAcceptsNoneEffort(turn: TurnContext): boolean {
	return turn.profile.reasoningProfile?.efforts.includes("none") ?? false;
}

export class OpenAIEffortWire extends OpenAIChatThinkingWire {
	readonly id = "openai-effort";

	encode(turn: TurnContext, builder: RequestBodyBuilder): void {
		if (turn.request.thinking === "disabled") {
			if (openAIAcceptsNoneEffort(turn)) builder.set("reasoning_effort", "none");
			return;
		}
		if (turn.request.thinking !== "enabled") return;
		builder.set(
			"reasoning_effort",
			clampOpenAIReasoningEffort(
				turn.request.reasoningEffort,
				openAIReasoningEffortsFor(turn),
			),
		);
	}
}

export const openAIEffortWire = new OpenAIEffortWire();
