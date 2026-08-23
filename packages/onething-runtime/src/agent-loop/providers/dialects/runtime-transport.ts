/**
 * 运行时配置 → **传输声明**(P2-a)。
 *
 * 这三个函数从 `factory.ts` 搬来。搬家的判据是设计稿 §2.2「能力与序列化同一个
 * 对象回答」:per-model 的能力从此只有 `ModelProfile` 一个来源,factory 里不
 * 再有任何能力逻辑;剩下的这一点点是**传输声明**——「这个端点的这条线材收得下
 * 什么」的默认档,它是配方的事。
 *
 * 谁还在用:
 *  - `deepseek`(注册时按配置里默认模型的元数据算出 transport + 上下文上限,
 *    `provider-factory.test` 钉着静态 `capabilities.maxInputTokens`);
 *  - `custom-*` 两条(用户自建端点没有账本条目,三旋钮就是它的全部)。
 *
 * 读的是**默认模型**那一条:静态 `capabilities` 字段是「这个 provider 大概能
 * 干什么」的一张名片,per-model 的真话由 `getModelCapabilities()` 现算。
 */
import type { AgentCapability, AgentModelCapabilities } from "@onething/core/agent-loop";

/**
 * `AgentProviderRuntimeConfig` 里这三个函数真正会读的那几个字段。故意写成
 * 结构类型而不是 import 那个 interface —— `dialects/` 不该反向依赖
 * `factory.ts`(那边 import 的是每一份配方)。
 */
export interface RuntimeTransportConfig {
	model?: string;
	modelCapabilitiesByModel?: Record<
		string,
		{ tools?: boolean; vision?: boolean; reasoning?: boolean }
	>;
	models?: Record<
		string,
		{
			supportsTools?: boolean;
			supportsVision?: boolean;
			supportsReasoning?: boolean;
			contextLength?: number;
			maxOutputTokens?: number;
		}
	>;
}

export interface RuntimeCapabilityFlags {
	tools: boolean;
	vision: boolean;
	reasoning: boolean;
}

/** override → registry entry → 配方默认档,读的是配置里的默认模型那一条。 */
export function runtimeCapabilityFlags(
	config: RuntimeTransportConfig,
	defaults: RuntimeCapabilityFlags,
): RuntimeCapabilityFlags {
	const model = config.model;
	const override = model ? config.modelCapabilitiesByModel?.[model] : undefined;
	const metadata = model ? config.models?.[model] : undefined;

	return {
		tools: override?.tools ?? metadata?.supportsTools ?? defaults.tools,
		vision: override?.vision ?? metadata?.supportsVision ?? defaults.vision,
		reasoning:
			override?.reasoning ?? metadata?.supportsReasoning ?? defaults.reasoning,
	};
}

/** 三个布尔 → 一份 `AgentModelCapabilities`(数组顺序逐字沿用)。 */
export function capabilitiesFromFlags(
	flags: RuntimeCapabilityFlags,
): AgentModelCapabilities {
	const capabilities: AgentCapability[] = [
		"text-input",
		"text-output",
		"streaming",
	];
	if (flags.tools) capabilities.push("tool-calls", "structured-tool-results");
	if (flags.vision) capabilities.push("vision-input", "file-input");
	if (flags.reasoning) capabilities.push("reasoning");

	return {
		capabilities,
		inputModalities: flags.vision ? ["text", "image", "file"] : ["text"],
		outputModalities: ["text"],
		toolResultModalities:
			flags.tools && flags.vision ? ["text", "image", "file"] : ["text"],
		supportsTools: flags.tools,
		supportsStructuredToolResults: flags.tools,
		supportsReasoning: flags.reasoning,
		supportsStreaming: true,
		// Every wire format behind this factory (OpenAI chat-completions,
		// Responses, Anthropic, Gemini) has a "must call a tool" mode, so a
		// model that has tools at all can be forced into one.
		supportsForcedToolUse: flags.tools,
	};
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

/** 默认模型那一条的上下文/输出上限,进静态 `capabilities`。 */
export function capabilityLimitsFromRuntimeConfig(
	config: RuntimeTransportConfig,
): Pick<AgentModelCapabilities, "maxInputTokens" | "maxOutputTokens"> {
	const metadata = config.model ? config.models?.[config.model] : undefined;
	return {
		maxInputTokens: positiveInteger(metadata?.contextLength),
		maxOutputTokens: positiveInteger(metadata?.maxOutputTokens),
	};
}
