/**
 * `kimi` —— 开放平台(按量,国内/海外)。对照 `factory.ts`:
 * `defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL` /`supportsReasoning:true` /
 * `includeAssistantReasoning:true` / `reasoningStyle:'thinking-type'`;
 * 没有 `supportsVision`(Kimi 的图片输入今天不声明)。
 *
 * 真正的地址由 `resolveOnethingKimiBaseUrl()` 在注册处算好后传进来 ——
 * 选错不是报错而是**多扣钱**,所以那一步留在 factory,配方只给缺省。
 */
import { ONETHING_KIMI_DEFAULT_BASE_URL } from "../../../providers/kimi.js";
import type {
	DialectThinkingConfig,
	DialectThinkingIntent,
	RequestBodyBuilder,
	SamplingPolicy,
	TurnContext,
	UsageFieldReader,
	UsagePathTable,
} from "../base/index.js";
import { thinkingTypeWire } from "../thinking/index.js";
import { kimiFileExtractChannel } from "./kimi-attachments.js";
import { openAIChatUsage, openAIChatUsageTable } from "../wires/index.js";
import {
	defineOpenAIChatDialect,
	openAIChatTransportCapabilities,
	promptCacheKeyExtraBody,
} from "./recipe.js";

/**
 * Kimi 把缓存命中报在 usage 的**顶层** `cached_tokens`,不在
 * `prompt_tokens_details` 里(开放平台与 Code Plan 同形状)。研究里对
 * 「顶层 `cached_tokens` 是不是 `prompt_tokens` 的子集」标了疑 —— 这里按
 * **子集**处理(与所有其它家一致:`uncached = prompt − cached`),
 * `wires/__tests__/usage-tables.test.ts` 的固定样本把这条口径钉住;
 * 真机样本若证伪,改的是这一行,不是投影。
 */
function kimiCacheRead(_raw: unknown, read: UsageFieldReader): number | undefined {
	return read("cached_tokens") ?? read(["prompt_tokens_details", "cached_tokens"]);
}

export const KIMI_USAGE_TABLE: UsagePathTable = openAIChatUsageTable({
	cacheRead: kimiCacheRead,
	uncachedInput: (raw, read) =>
		(read("prompt_tokens") ?? 0) - (kimiCacheRead(raw, read) ?? 0),
});

// Kimi thinking-model families (https://platform.kimi.com/docs/guide/use-kimi-k2-thinking-model):
// - kimi-k3: always thinks; configured via OpenAI-compatible reasoning_effort ("max" is
//   the only accepted value); thinking.type is not supported.
// - kimi-k2.7-code (+ -highspeed) and kimi-k2-thinking: always think; the thinking
//   param must not be sent to disable them, so send nothing.
// - kimi-k2.5 / kimi-k2.6: thinking on by default, toggleable via thinking.type.
function isKimiAlwaysThinkingModel(model: string): boolean {
	return model.includes("code") || model.includes("thinking");
}

/**
 * 「用户意图 → thinking/effort」的 Kimi 家规 —— 从 `thinking-options.ts` 那句
 * `ctx.providerId === 'kimi'` 的分支搬来,逐字。搬家的判据:家规是方言的,
 * 不是那个通用函数的;`kimi-code` 跑的是同一套模型,所以两份配方共用它。
 */
export function kimiThinkingIntent(
	config: DialectThinkingConfig,
	model: string,
): DialectThinkingIntent {
	const lower = model.toLowerCase();
	if (lower.startsWith("kimi-k3")) {
		// K3 always reasons server-side; the toggle only controls whether we
		// explicitly declare the (sole) "max" effort.
		if (config.thinkingByModel?.[model] === false) return {};
		return { reasoningEffort: "max" };
	}
	if (isKimiAlwaysThinkingModel(lower)) return {};
	const enabled = config.thinkingByModel?.[model];
	if (enabled === false) return { thinking: "disabled" };
	if (enabled === true) return { thinking: "enabled" };
	return {};
}

/**
 * Kimi 的采样家规 —— **一律不发 `temperature`**(设计稿 §5.1)。
 *
 * Kimi 的每个模型都把 temperature 钉在一个固定值上,请求里带别的值不是被忽略
 * 而是被 API **拒绝**(400)。所以这里与思考开关无关:开着关着都不发。
 *
 * 与 `OpenAISamplingPolicy` 的差别只有这一条判据 —— 那边是「思考开着才不发」,
 * 这边是「这一家从来不收」。丢掉的设置照例留一条 warning:warning 是旁路元
 * 数据,请求体的字节与「什么都不做」完全相同。
 */
export class KimiSamplingPolicy implements SamplingPolicy {
	apply(turn: TurnContext, _builder: RequestBodyBuilder): void {
		const { temperature } = turn.request;
		if (temperature === undefined) return;
		turn.warn(
			"setting-dropped",
			"Kimi pins temperature to a fixed per-model value and rejects any other value, so it is never sent",
			{ temperature },
		);
	}
}

export const kimiSamplingPolicy: SamplingPolicy = new KimiSamplingPolicy();

export const KIMI_DIALECT = defineOpenAIChatDialect({
	id: "kimi",
	defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL,
	reasoning: thinkingTypeWire,
	includeAssistantReasoning: true,
	usage: openAIChatUsage(KIMI_USAGE_TABLE),
	sampling: kimiSamplingPolicy,
	thinkingIntent: kimiThinkingIntent,
	extraBody: promptCacheKeyExtraBody,
	// 文件走**旁路**(P4-6):chat-completions 上没有 `file` 内容块,附件在序列化
	// 之前就被 `KimiFileExtractChannel` 换成一条 `role:'system'` 的抽取文本。
	// `file: true` 是「这条线收得下文件」,`fileViaExtraction` 是「靠什么收」——
	// 后者让账本的 `fileInput` 没有否决权(models.dev 给 Kimi 的 `modalities.input`
	// 只有 text/image,让它说了算的话文件永远进不来,而模型其实只会见到文本)。
	attachments: kimiFileExtractChannel,
	fileViaExtraction: true,
	transport: openAIChatTransportCapabilities({ reasoning: true, file: true }),
});
