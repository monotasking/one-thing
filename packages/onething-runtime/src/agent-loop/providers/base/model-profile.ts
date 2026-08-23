/**
 * `ModelProfile` —— 能力与序列化问的**同一个对象**(设计稿 §2.2 / §3)。
 *
 * P0a 它就是 `resolveOnethingModelCapabilities()` 的一层薄壳:账本怎么说它就
 * 怎么答,不新增判据、不改口径。它承担两件今天分家的事:
 *  1. 喂 `getModelCapabilities()` —— `toAgentModelCapabilities()` 是
 *     `factory.ts` 里 `withPerModelCapabilities` 那段投影的**逐行复刻**;
 *  2. 喂序列化器 —— `allows()` / `supports()` / `reasoningWire` /
 *     `inputModalities` 让 PartCodec、SamplingPolicy、ThinkingWire 不必各自
 *     再去读一遍账本。
 *
 * P2-a 起它是**唯一**的能力源:`factory.ts` 的 `withPerModelCapabilities` 退役,
 * `BaseAgentProvider.getModelCapabilities()` 直接问它,四条 wire 的常量覆盖与
 * 模型名正则一并删除。外来的 provider(宿主经 `registerAgentProviderRuntime`
 * 登记的普通对象,不是 `BaseAgentProvider` 子类)由本文件的
 * `withLedgerModelCapabilities()` 补上同一层投影 —— 同一个函数,不是第二份。
 */
import type {
	AgentCapability,
	AgentInputModality,
	AgentModelCapabilities,
	AgentOutputModality,
	AgentProvider,
} from "@onething/core/agent-loop";
import {
	resolveOnethingModelCapabilities,
	type OnethingCapabilityEntryLike,
	type OnethingCapabilityOverrideLike,
	type OnethingImageOutputServedBy,
	type OnethingReasoningProfile,
	type OnethingReasoningWire,
	type OnethingResolvedModelCapabilities,
} from "../../../providers/model-capability.js";

/**
 * 采样类参数。P0a 账本只记 `temperature` 一项,其余一律 `true`
 * (= 今天的行为:照发)。P0b/P2 往账本加行,这里不加分支。
 */
export type ModelSamplingParam =
	| "temperature"
	| "top_p"
	| "top_k"
	| "frequency_penalty"
	| "presence_penalty";

/** 账本能回答可否的能力名(与 `OnethingResolvedModelCapabilities.source` 的键同源)。 */
export type ModelProfileCapability =
	| "reasoning"
	| "vision"
	| "tools"
	| "imageOutput"
	| "temperature";

export interface ModelProfileLimits {
	contextLength?: number;
	maxOutputTokens?: number;
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

export class ModelProfile {
	constructor(
		readonly providerId: string,
		readonly modelId: string,
		private readonly resolved: OnethingResolvedModelCapabilities,
		readonly limits: ModelProfileLimits = {},
	) {}

	/** 这个参数发出去会不会被端点拒绝。 */
	allows(param: ModelSamplingParam): boolean {
		return param === "temperature" ? this.resolved.temperature : true;
	}

	/**
	 * `'forcedToolUse'` 是这里唯一一条**不在** `source` 表上的能力(账本要么
	 * 有话说,要么没有),所以它单独一条分支:`undefined` = 没话说 = 今天的
	 * 行为(有 tools 即可强制)。`knows()` / `toAgentModelCapabilities()` 仍然
	 * 只认那五条有 source 的,不受影响。
	 */
	supports(capability: ModelProfileCapability | "forcedToolUse"): boolean {
		if (capability === "forcedToolUse") return this.resolved.forcedToolUse ?? true;
		return this.resolved[capability];
	}

	/**
	 * 账本对这一条**有没有话说**。`'default'` = 不知道,provider 自己的声明
	 * 说了算(`toAgentModelCapabilities` 的核心判据)。
	 */
	knows(capability: ModelProfileCapability): boolean {
		return this.resolved.source[capability] !== "default";
	}

	/**
	 * 线型 —— 账本回答,**即使这个模型的 reasoning 是关的**:线协议格式是
	 * 模型家族的属性,不是「这一刻思考开没开」的属性。P2-a 起这是
	 * `HttpAgentProvider.thinkingFor()` 的唯一判据,四条 wire 各自那份
	 * 模型名正则随之退役。
	 */
	get reasoningWire(): OnethingReasoningWire {
		return this.resolved.reasoningWire;
	}

	/**
	 * 账本对「能不能强制首调用」有没有话说。`undefined` = 没话说,
	 * provider 自己的传输声明说了算(今天的行为:有 tools 即可强制)。
	 */
	get forcedToolUse(): boolean | undefined {
		return this.resolved.forcedToolUse;
	}

	get reasoningProfile(): OnethingReasoningProfile | undefined {
		return this.resolved.reasoningProfile;
	}

	/** 账本自己的模态视图(不含 provider 的传输声明,那要走 `toAgentModelCapabilities`)。 */
	get inputModalities(): AgentInputModality[] {
		return this.resolved.vision ? ["text", "image", "file"] : ["text"];
	}

	get toolResultModalities(): AgentInputModality[] {
		return this.resolved.tools && this.resolved.vision
			? ["text", "image", "file"]
			: ["text"];
	}

	get outputModalities(): AgentOutputModality[] {
		return this.resolved.imageOutput ? ["text", "image"] : ["text"];
	}

	/**
	 * 图像输出的**两个问题合一**(设计稿 §3 / §11):`supported` = 能不能出图,
	 * `servedBy` = 谁来出 —— 回合内的原生工具(`'in-loop'`)还是专用生图端点
	 * (`'dedicated-api'`)。生图路由判据(`onethingModelSupportsImageGeneration`)
	 * 问的是后者;设置页的徽标问的是前者。`servedBy: undefined` = 账本没话说。
	 */
	get imageOutput(): {
		supported: boolean;
		servedBy?: OnethingImageOutputServedBy;
	} {
		const servedBy = this.resolved.imageOutputServedBy;
		return {
			supported: this.resolved.imageOutput,
			...(servedBy ? { servedBy } : {}),
		};
	}

	/** 原始裁定,给需要看 source 的调用方(诊断/测试)。 */
	get verdict(): OnethingResolvedModelCapabilities {
		return this.resolved;
	}

	/**
	 * 账本覆盖层投影 —— 能力合一之后的**唯一**一份。
	 *
	 * `base` 是 provider 自己的传输声明(模态、结构化工具结果),账本只翻它
	 * 回答得了的那几个布尔与对应的 capability 标签;`'default'` 一律不动。
	 */
	toAgentModelCapabilities(base: AgentModelCapabilities): AgentModelCapabilities {
		const resolved = this.resolved;
		const capabilities = new Set<AgentCapability>(base.capabilities);
		const inputModalities = new Set(base.inputModalities);
		const outputModalities = new Set(base.outputModalities);

		const ledgerKnows = (capability: ModelProfileCapability): boolean =>
			resolved.source[capability] !== "default";
		const setTags = (enabled: boolean, tags: AgentCapability[]): void => {
			for (const tag of tags) {
				if (enabled) capabilities.add(tag);
				else capabilities.delete(tag);
			}
		};

		const reasoning = ledgerKnows("reasoning")
			? resolved.reasoning
			: base.supportsReasoning === true || base.capabilities.includes("reasoning");
		const tools = ledgerKnows("tools") ? resolved.tools : base.supportsTools !== false;
		if (ledgerKnows("reasoning")) setTags(reasoning, ["reasoning"]);
		if (ledgerKnows("tools")) setTags(tools, ["tool-calls", "structured-tool-results"]);
		if (ledgerKnows("vision")) {
			setTags(resolved.vision, ["vision-input", "file-input"]);
			if (resolved.vision) {
				inputModalities.add("image");
				inputModalities.add("file");
			} else {
				inputModalities.delete("image");
				inputModalities.delete("file");
			}
		}
		if (ledgerKnows("imageOutput")) {
			setTags(resolved.imageOutput, ["image-output"]);
			if (resolved.imageOutput) outputModalities.add("image");
			else outputModalities.delete("image");
		}

		return {
			...base,
			capabilities: [...capabilities],
			inputModalities: [...inputModalities],
			outputModalities: [...outputModalities],
			supportsTools: tools,
			supportsStructuredToolResults: tools
				? base.supportsStructuredToolResults !== false
				: false,
			// 账本 per-model 的裁定优先(Fable/Mythos 恒思考 ⇒ 不可强制);
			// 没有裁定就是今天的行为:有 tools 即可强制。
			supportsForcedToolUse: tools
				? resolved.forcedToolUse ?? base.supportsForcedToolUse === true
				: false,
			supportsReasoning: reasoning,
			maxInputTokens:
				positiveInteger(this.limits.contextLength) ?? base.maxInputTokens,
			maxOutputTokens:
				positiveInteger(this.limits.maxOutputTokens) ?? base.maxOutputTokens,
		};
	}
}

export interface ModelProfileResolver {
	resolve(providerId: string, model: string): Promise<ModelProfile>;
	/**
	 * 静态 `capabilities` 字段用的默认档(= 配置里那个默认模型)。给不出来就
	 * 返回 undefined,基类退回 provider 自己的传输声明 —— 与今天
	 * `buildCapabilities(options)` 的口径一致。
	 */
	defaultProfile?(providerId: string): ModelProfile | undefined;
}

/**
 * `AgentProviderRuntimeConfig` 里 `ModelProfile` 真正会读的那几个字段。
 * 故意写成结构类型而不是 import 那个 interface:`base/` 不该反向依赖
 * `factory.ts`(那边 import 的是每一家 provider)。二者的可赋值性由
 * `__tests__/architecture.test.ts` 里的编译期断言守着。
 */
export interface LedgerModelProfileConfig {
	/** 默认模型 —— 静态 capabilities 投影用的那一个。 */
	model?: string;
	apiType?: "openai" | "anthropic";
	modelCapabilitiesByModel?: Record<string, OnethingCapabilityOverrideLike>;
	models?: Record<string, OnethingCapabilityEntryLike & ModelProfileLimits>;
}

export class LedgerModelProfileResolver implements ModelProfileResolver {
	constructor(private readonly config: LedgerModelProfileConfig = {}) {}

	async resolve(providerId: string, model: string): Promise<ModelProfile> {
		return this.resolveSync(providerId, model);
	}

	/** 同步档:静态 capabilities 与测试要用,`resolve()` 只是它的 Promise 皮。 */
	resolveSync(providerId: string, model: string): ModelProfile {
		const entry = this.config.models?.[model];
		const resolved = resolveOnethingModelCapabilities({
			providerId,
			modelId: model,
			customApiType: this.config.apiType,
			override: this.config.modelCapabilitiesByModel?.[model],
			registryEntry: entry,
		});
		return new ModelProfile(providerId, model, resolved, {
			contextLength: entry?.contextLength,
			maxOutputTokens: entry?.maxOutputTokens,
		});
	}

	defaultProfile(providerId: string): ModelProfile | undefined {
		return this.config.model
			? this.resolveSync(providerId, this.config.model)
			: undefined;
	}
}

/**
 * 给**外来** provider 补上账本投影。
 *
 * `BaseAgentProvider` 的子类自己就问 `ModelProfile`,不需要这一层;宿主经
 * `registerAgentProviderRuntime()` 登记的普通对象(以及自述能力之外的插件
 * provider)没有那条路,于是由工厂在外面盖一层 —— 盖的是**同一个**
 * `toAgentModelCapabilities`,不是第二份投影逻辑。
 *
 * **不是 `{...provider}`**:类实例的成员在原型上,展开运算符搬不走
 * `streamTurn`。逐个转交是唯一不依赖「provider 恰好是对象字面量」的写法。
 */
export function withLedgerModelCapabilities(
	provider: AgentProvider,
	providerId: string,
	profiles: ModelProfileResolver,
): AgentProvider {
	const resolveBase = async (model: string): Promise<AgentModelCapabilities> =>
		(await provider.getModelCapabilities?.(model)) ??
		provider.capabilities ?? {
			capabilities: ["text-input", "text-output"],
			inputModalities: ["text"],
			outputModalities: ["text"],
		};

	return {
		id: provider.id,
		...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
		...(provider.capabilitiesAreSelfDeclared === undefined
			? {}
			: { capabilitiesAreSelfDeclared: provider.capabilitiesAreSelfDeclared }),
		...(provider.streamTurn
			? {
					streamTurn: (request: Parameters<NonNullable<AgentProvider["streamTurn"]>>[0]) =>
						provider.streamTurn!(request),
				}
			: {}),
		...(provider.runTurn
			? {
					runTurn: (request: Parameters<NonNullable<AgentProvider["runTurn"]>>[0]) =>
						provider.runTurn!(request),
				}
			: {}),
		getModelCapabilities: async (model: string) => {
			const base = await resolveBase(model);
			const profile = await profiles.resolve(providerId, model);
			return profile.toAgentModelCapabilities(base);
		},
	};
}
