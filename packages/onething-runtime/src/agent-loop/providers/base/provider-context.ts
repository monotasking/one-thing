/**
 * `ProviderContext` —— provider 实例的**只读**运行环境。
 *
 * 设计稿 `docs/design/provider-oop-2026-08.md` §4:装配层
 * (`packages/backend/provider-binding/{bound-fetch,request-dump,ai-settings-compose}`)
 * 负责组装它并注入;runtime 的基类只声明接口,不反向依赖 backend。
 *
 * 这里的每个字段都是**依赖**,不是状态:provider 实例本身没有可写字段,
 * 每回合的可变量一律活在 `TurnContext` 里(§3.1「实例无状态」)。
 */
import type { getLogger } from "../../../logging/index.js";
import type { AgentProviderRequestDumper } from "../request-dump.js";
import type { ModelProfileResolver } from "./model-profile.js";

/** 产品层日志门面交出来的 logger 类型(不从 core 直接拿,免得两处漂移)。 */
export type Logger = ReturnType<typeof getLogger>;

/** 请求体落盘器。名字沿用今天的 `AgentProviderRequestDumper`,形状零改动。 */
export type RequestDumper = AgentProviderRequestDumper;

/**
 * 两个超时都是**可选**的:不给 = 不限(今天的行为)。
 * - `firstByteMs`:发出请求到响应头到达之间的上限。
 * - `idleMs`:流开始之后两个数据块之间的上限。
 */
export interface ProviderTimeouts {
	readonly firstByteMs?: number;
	readonly idleMs?: number;
}

export interface ProviderContext {
	readonly providerId: string;
	/** 已经解析过的 base URL(`baseUrl || defaultBaseUrl`),末尾斜杠可有可无。 */
	readonly baseUrl: string;
	readonly fetchImpl: typeof globalThis.fetch;
	/** 不给 = 不落盘(诊断模式关闭时就是这样)。 */
	readonly dumper?: RequestDumper;
	readonly logger: Logger;
	readonly profiles: ModelProfileResolver;
	readonly timeouts?: ProviderTimeouts;
}
