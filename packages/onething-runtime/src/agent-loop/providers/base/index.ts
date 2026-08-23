/**
 * `base/` 桶 —— Provider 面向对象重建的骨架(设计稿
 * `docs/design/provider-oop-2026-08.md`,P0a)。
 *
 * 这一层只有契约与模板:Wire 决定管线,Dialect 是一份类型化的组合配方。
 * P0a 不搬任何一家 provider —— 迁移是下一步。
 */
export type {
	BaseProviderContext,
	Logger,
	ProviderContext,
	ProviderTimeouts,
	RequestDumper,
} from "./provider-context.js";

export {
	LedgerModelProfileResolver,
	ModelProfile,
	withLedgerModelCapabilities,
	type LedgerModelProfileConfig,
	type ModelProfileCapability,
	type ModelProfileLimits,
	type ModelProfileResolver,
	type ModelSamplingParam,
} from "./model-profile.js";

export { TurnContext } from "./turn-context.js";
export { RequestBodyBuilder } from "./request-body-builder.js";
export { ProviderWarning, type ProviderWarningKind } from "./warnings.js";

export {
	delivered,
	undeliverable,
	Undeliverable,
	type PartCodec,
	type PartDelivery,
	type UndeliverablePartLike,
	type UndeliverableReason,
} from "./part-codec.js";

export {
	noThinkingWire,
	NoThinkingWire,
	thinkingWires,
	ThinkingWireRegistry,
	type ThinkingWire,
} from "./thinking-wire.js";

export {
	PathUsageNormalizer,
	UsageBuckets,
	type UsageDerivation,
	type UsageField,
	type UsageFieldReader,
	type UsageNormalizer,
	type UsagePath,
	type UsagePathTable,
} from "./usage.js";

export { noCachePolicy, NoCachePolicy, type CachePolicy } from "./cache-policy.js";

export {
	BearerApiKeyAuth,
	HeaderApiKeyAuth,
	ResolveAuth,
	type AuthStrategy,
	type AuthStrategyOptions,
	type ResolvedAuthMaterial,
} from "./auth-strategy.js";

export {
	openAIToolChoicePolicy,
	OpenAIToolChoicePolicy,
	type ToolChoicePolicy,
} from "./tool-choice-policy.js";

export {
	noSamplingPolicy,
	NoSamplingPolicy,
	openAISamplingPolicy,
	OpenAISamplingPolicy,
	type SamplingPolicy,
} from "./sampling-policy.js";

export {
	DefaultErrorMapper,
	isProviderHttpError,
	ProviderHttpError,
	type ErrorMapper,
	type ProviderHttpErrorInit,
} from "./errors.js";

export {
	openAIFinishReasonMapper,
	OpenAIFinishReasonMapper,
	type FinishReasonMapper,
} from "./finish-reason.js";

export {
	getDialect,
	listDialects,
	registerDialect,
	type Dialect,
	type DialectEndpoint,
	type DialectRequestShape,
	type DialectThinkingConfig,
	type DialectThinkingIntent,
	type WireId,
} from "./dialect.js";

export { BaseAgentProvider } from "./base-agent-provider.js";
export { HttpAgentProvider, type RawTurnFinish } from "./http-agent-provider.js";
