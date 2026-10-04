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
	ProviderMediaImage,
	ProviderMediaReader,
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
	type TransportFileDelivery,
	type ModelProfileResolver,
	type ModelSamplingParam,
} from "./provider-base-model-profile.js";

export { TurnContext, type TurnTransport } from "./provider-base-turn-context.js";
export type { AttachmentChannel } from "./provider-base-attachment-channel.js";
export { RequestBodyBuilder } from "./provider-base-request-body-builder.js";
export { getPath, parsePath } from "./provider-base-path.js";
export { ProviderWarning, type ProviderWarningKind } from "./provider-base-warnings.js";

export {
	delivered,
	isPdfMediaType,
	undeliverable,
	Undeliverable,
	type PartCodec,
	type PartDelivery,
	type UndeliverablePartLike,
	type UndeliverableReason,
} from "./provider-base-part-codec.js";

export {
	noThinkingWire,
	NoThinkingWire,
	thinkingWires,
	ThinkingWireRegistry,
	type ThinkingWire,
} from "./provider-base-thinking-wire.js";

export {
	PathUsageNormalizer,
	UsageBuckets,
	type UsageDerivation,
	type UsageField,
	type UsageFieldReader,
	type UsageNormalizer,
	type UsagePath,
	type UsagePathTable,
} from "./provider-base-usage.js";

export { noCachePolicy, NoCachePolicy, type CachePolicy } from "./provider-base-cache-policy.js";

export {
	BearerApiKeyAuth,
	expandHeaderTemplates,
	HeaderApiKeyAuth,
	ResolveAuth,
	type AuthStrategy,
	type AuthStrategyOptions,
	type ResolvedAuthMaterial,
} from "./provider-base-auth-strategy.js";

export {
	openAIToolChoicePolicy,
	OpenAIToolChoicePolicy,
	type ToolChoicePolicy,
} from "./provider-base-tool-choice-policy.js";

export {
	noSamplingPolicy,
	NoSamplingPolicy,
	openAISamplingPolicy,
	OpenAISamplingPolicy,
	type SamplingPolicy,
} from "./provider-base-sampling-policy.js";

export {
	DefaultErrorMapper,
	isProviderHttpError,
	ProviderHttpError,
	type ErrorMapper,
	type ProviderHttpErrorInit,
} from "./provider-base-errors.js";

export {
	finishReasonMapperFor,
	openAIFinishReasonMapper,
	OpenAIFinishReasonMapper,
	TableFinishReasonMapper,
	type DialectFinishShape,
	type FinishReasonMapper,
} from "./provider-base-finish-reason.js";

export {
	LEGACY_FUNCTION_CALL_CODEC,
	OPENAI_TOOL_CALLS_CODEC,
	pathToolCallsCodec,
	ToolCallAccumulator,
	type ToolCallCodec,
	type ToolCallFragment,
} from "./provider-base-tool-call-codec.js";

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
} from "./provider-base-dialect.js";

export { BaseAgentProvider } from "./provider-base-agent.js";
export { HttpAgentProvider, type RawTurnFinish } from "./provider-base-http-agent.js";
