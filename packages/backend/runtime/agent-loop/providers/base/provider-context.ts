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

/**
 * `BaseProviderContext` —— **每个** provider 都有的那三样(P1-d1)。
 *
 * 拆出来是因为 `ProviderContext` 对非 HTTP 的 provider 太重:acp /
 * external-agents 没有 base URL、没有 `fetchImpl`(它们的传输是一个子进程 /
 * 一条 SDK 会话),更没有可以落盘的请求体。让它们为了继承 `BaseAgentProvider`
 * 去编一个假的 `fetchImpl`,就是让类型说谎。
 *
 * `profiles` 在这里是**可选**的:自述能力的 provider(`capabilitiesAreSelfDeclared`)
 * 压根不该问账本 —— 账本对一个它没见过的模型没有真话可说,猜一个就正好是
 * `supportsTools: false` 那一类 bug。给不出解析器时,能力就是传输声明本身。
 */
export interface BaseProviderContext {
	readonly providerId: string;
	readonly logger: Logger;
	/** 不给 = 不查账本,能力即传输声明(自述能力的 provider 就是这样)。 */
	readonly profiles?: ModelProfileResolver;
}

/**
 * 一张已经落进媒体库的图(`readImageBase64` 的返回值)。
 *
 * `base64` 是**裸载荷**,不带 `data:` 头 —— 线协议自己决定包成什么
 * (gemini 包成 `inlineData: { mimeType, data }`)。
 */
export interface ProviderMediaImage {
	readonly base64: string;
	readonly mediaType: string;
}

/**
 * **只读**媒体端口(P4-2,设计稿 §5.2 Gemini 行)。
 *
 * 多轮改图要求把上一条 model 回复里的**生成图**原样放回 `contents`,而消息上
 * 留下的只有一段 markdown(`![Generated Image|mediaId:<id>](media://<id>.png)`)
 * —— 字节在媒体库里。runtime 的 provider 只声明这个接口,实现由装配层注入
 * (`packages/backend/wiring/agent-loop/providers/media-reader.ts`),于是
 * provider 不必认识媒体库的路径解析、也不会顺着它拖进任何宿主依赖。
 *
 * 只读、只按 id 取、找不到就 `undefined`(**不抛**):回放不到一张历史图是
 * 「少一块上下文」,不是「这一回合失败」。
 */
export interface ProviderMediaReader {
	readImageBase64(mediaId: string): Promise<ProviderMediaImage | undefined>;
}

/** HTTP provider 的运行环境:在三样之上再加传输与落盘。 */
export interface ProviderContext extends BaseProviderContext {
	/** 已经解析过的 base URL(`baseUrl || defaultBaseUrl`),末尾斜杠可有可无。 */
	readonly baseUrl: string;
	readonly fetchImpl: typeof globalThis.fetch;
	/** 不给 = 不落盘(诊断模式关闭时就是这样)。 */
	readonly dumper?: RequestDumper;
	/** HTTP 这一支必有账本解析器 —— 收窄回必填。 */
	readonly profiles: ModelProfileResolver;
	readonly timeouts?: ProviderTimeouts;
	/**
	 * 不给 = 不回放历史生成图(直接 `new GeminiWire` 的测试、以及任何没接
	 * 媒体库的宿主就是这样)。缺席是**静默降级**,不是错误。
	 */
	readonly media?: ProviderMediaReader;
}
