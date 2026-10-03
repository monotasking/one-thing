/**
 * 「这一型此刻按多少算」的**唯一判据**(`docs/design/provider-settings-rework-2026-09.md` §5.5)。
 *
 * 从前「用户覆盖 > 接口报的 > 未知」这条折叠有三份:后端 `model-registry.ts` 的
 * `getOnethingModelContextLength` / `onethingModelSupportsTools`,壳的
 * `data/models-source.ts`(`contextWindowOf` / `readingsOf`)与 `providers/projection.ts`
 * (`overrideOf` / `capsWithOverride`)。09-10「设了上下文圆环仍 unknown」就是壳那一份
 * 漏读覆盖表 —— 三份判据,漂一份就是一次事故。现在:这里一处算,后端的读者直接调,
 * 壳经 `models.getWithCapabilities` 的每行 `effective` 读结果,自己一格都不折。
 *
 * 三层,逐格独立:
 *  · `'override'` —— 用户在覆盖表里填了(正有限数 / 布尔);
 *  · `'endpoint'` —— 目录条目 `source === 'endpoint'`(那家自己的 `/models` 拉来的),
 *    且这一格接口真报了(数字非 0 / 非缺席);
 *  · `'catalog'`  —— models.dev 条目(`source` 缺席或 `'models.dev'`)说了这一格;
 *  · `'unknown'`  —— 谁都没说。值是 `null`,**不编**:引擎的 128k 上下文兜底只在引擎里
 *    用(第四层),不进这份事实 —— 屏幕要能画出「不知道」。
 *
 * 手填条目(`source: 'manual'`)什么都没说过:`catalogFactsOf` 对它答 undefined,
 * 于是除了覆盖,每一格都是 unknown。接口拉来、但**没报**某项能力的条目(`unreported`,
 * 批 3)那一项同样是 unknown —— 只报了 id 的 `/models` 不是在说「都不支持」。
 *
 * 纯函数,Electron-free,不碰跨进程契约(那一半在 RPC 域里投影)。
 */
import { catalogFactsOf } from "./manual-models.js";
import type {
	OnethingCatalogModelEntry,
	OnethingModelCapabilityEntry,
	OnethingModelCapabilityOverride,
} from "./model-registry.js";

/** 生效事实里的五项能力(与覆盖表、壳的五格同名)。`audio` 不在这里:没有读者。 */
export const ONETHING_EFFECTIVE_CAPABILITY_KEYS = [
	"tools",
	"vision",
	"reasoning",
	"imageOutput",
	"fileInput",
] as const;

export type OnethingEffectiveCapabilityKey =
	(typeof ONETHING_EFFECTIVE_CAPABILITY_KEYS)[number];

/** 一格事实是谁说的。 */
export type OnethingEffectiveFactSource =
	| "override"
	| "endpoint"
	| "catalog"
	| "unknown";

/** 一型上的用户覆盖(已经从三张按模型的表里取出来的那一行)。 */
export interface OnethingModelOverrideFacts {
	contextLength?: number;
	maxOutput?: number;
	capabilities?: OnethingModelCapabilityOverride;
}

export interface OnethingEffectiveModelFacts<TReasoningProfile = unknown> {
	/** null = 不知道。引擎的 128k 兜底**不在这里**。 */
	contextLength: number | null;
	/** null = 不知道(请求里不带 max_tokens)。 */
	maxOutput: number | null;
	/** 每项 null = 不知道。 */
	capabilities: Record<OnethingEffectiveCapabilityKey, boolean | null>;
	/** 思考档位的裁定结果(调用方从能力账本拿来原样放进来);null = 这一型不思考 / 没裁定。 */
	reasoningProfile: TReasoningProfile | null;
	source: {
		contextLength: OnethingEffectiveFactSource;
		maxOutput: OnethingEffectiveFactSource;
		/** 逐项:行上「人说不支持」(划掉)与「目录说不支持」(不画)要分得开。 */
		capabilities: Record<OnethingEffectiveCapabilityKey, OnethingEffectiveFactSource>;
	};
}

export interface EffectiveModelFactsInput<TReasoningProfile = unknown> {
	override?: OnethingModelOverrideFacts;
	/** 目录条目(含手填);缺席 = 目录里没有这一型。 */
	entry?: OnethingCatalogModelEntry | null;
	reasoningProfile?: TReasoningProfile | null;
}

/** 正有限数才算数。0 / 负数 / 非数 = 这一格没填。 */
function positive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

/** 「这一型收得下附件」在目录里的两种说法(与壳 `capsOf` 同一张表)。 */
const FILE_INPUT_MODALITIES = ["pdf", "file"];

function entryCapabilityOf(
	entry: OnethingModelCapabilityEntry,
	key: OnethingEffectiveCapabilityKey,
): boolean {
	switch (key) {
		case "tools":
			return entry.supportsTools === true;
		case "vision":
			return entry.supportsVision === true;
		case "reasoning":
			return entry.supportsReasoning === true;
		case "imageOutput":
			return entry.supportsImageOutput === true;
		case "fileInput":
			return (entry.inputModalities ?? []).some((modality) =>
				FILE_INPUT_MODALITIES.includes(modality.toLowerCase()),
			);
	}
}

/** 条目自己的出处:接口拉来的 = endpoint,其余(models.dev)= catalog。 */
function entrySourceOf(entry: OnethingModelCapabilityEntry): "endpoint" | "catalog" {
	return entry.source === "endpoint" ? "endpoint" : "catalog";
}

/**
 * 从一家 provider 的配置里取出这一型的覆盖(三张按模型的表)。数字只认正有限数,
 * 能力只认布尔 —— 与引擎读它们的地方同一把尺。
 */
export function onethingModelOverrideFactsOf(
	config:
		| {
				contextLengthByModel?: Record<string, number>;
				maxOutputByModel?: Record<string, number>;
				modelCapabilitiesByModel?: Record<string, OnethingModelCapabilityOverride>;
		  }
		| undefined,
	modelId: string,
): OnethingModelOverrideFacts {
	const contextLength = positive(config?.contextLengthByModel?.[modelId]);
	const maxOutput = positive(config?.maxOutputByModel?.[modelId]);
	const capabilities = config?.modelCapabilitiesByModel?.[modelId];
	return {
		...(contextLength !== null ? { contextLength } : {}),
		...(maxOutput !== null ? { maxOutput: Math.floor(maxOutput) } : {}),
		...(capabilities ? { capabilities } : {}),
	};
}

export function effectiveModelFactsOf<TReasoningProfile = unknown>(
	input: EffectiveModelFactsInput<TReasoningProfile>,
): OnethingEffectiveModelFacts<TReasoningProfile> {
	const facts = catalogFactsOf(input.entry ?? undefined);
	const override = input.override ?? {};

	const numberFact = (
		overridden: number | undefined,
		reported: number | undefined,
	): { value: number | null; source: OnethingEffectiveFactSource } => {
		const fromOverride = positive(overridden);
		if (fromOverride !== null) return { value: fromOverride, source: "override" };
		const fromEntry = facts ? positive(reported) : null;
		if (fromEntry !== null && facts) return { value: fromEntry, source: entrySourceOf(facts) };
		return { value: null, source: "unknown" };
	};

	const context = numberFact(override.contextLength, facts?.contextLength);
	const maxOutput = numberFact(override.maxOutput, facts?.maxOutputTokens);

	const capabilities = {} as Record<OnethingEffectiveCapabilityKey, boolean | null>;
	const capabilitySources = {} as Record<
		OnethingEffectiveCapabilityKey,
		OnethingEffectiveFactSource
	>;
	for (const key of ONETHING_EFFECTIVE_CAPABILITY_KEYS) {
		const forced = override.capabilities?.[key];
		if (typeof forced === "boolean") {
			capabilities[key] = forced;
			capabilitySources[key] = "override";
		} else if (facts && !facts.unreported?.includes(key)) {
			capabilities[key] = entryCapabilityOf(facts, key);
			capabilitySources[key] = entrySourceOf(facts);
		} else {
			// 没有条目,或接口没报这一项(批 3 直连拉目录):不知道,不是「不支持」。
			capabilities[key] = null;
			capabilitySources[key] = "unknown";
		}
	}

	return {
		contextLength: context.value,
		maxOutput: maxOutput.value,
		capabilities,
		reasoningProfile: input.reasoningProfile ?? null,
		source: {
			contextLength: context.source,
			maxOutput: maxOutput.source,
			capabilities: capabilitySources,
		},
	};
}
