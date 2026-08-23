/**
 * `TurnContext` —— 一回合的全部可变量(设计稿 §3)。
 *
 * **所有 hook 只接收它,不碰 this**;provider 实例因此没有可写字段,可以跨
 * 回合、跨凭据复用(§3.1「实例无状态」,架构测试守)。
 */
import type { AgentMessage, AgentTurnRequest } from "@onething/core/agent-loop";
import type { Logger } from "./provider-context.js";
import type { ModelProfile } from "./model-profile.js";
import type { RequestBodyBuilder } from "./request-body-builder.js";
import { ProviderWarning, type ProviderWarningKind } from "./warnings.js";

/**
 * 本回合能往哪儿、以什么身份发**副**请求(P4-6)。
 *
 * 主请求由模板方法自己发;副请求(Kimi 的「先上传再抽取」)是策略发的,而策略
 * 拿不到 `ProviderContext` —— 它们是无状态的、登记在配方上的对象,凭据要到
 * 构造 provider 时才绑上。于是把「同一套凭据、同一个 `fetchImpl`、同一个
 * base URL」折成这一个只读端口挂在回合上:策略照旧只收 `turn`,而且**不可能**
 * 用到与主请求不同的身份。
 *
 * 不给 = 这个回合没有副请求通道(直接 `new TurnContext(...)` 的测试就是这样),
 * 策略要自己处理缺席 —— 缺席是降级,不是错误。
 */
export interface TurnTransport {
	/** 已解析的 base URL(末尾无斜杠)。 */
	readonly baseUrl: string;
	readonly fetchImpl: typeof globalThis.fetch;
	/** 本回合的认证头 —— 与主请求同一套(晚绑定,每次现拿)。 */
	headers(): Promise<Record<string, string>>;
}

export class TurnContext {
	/** 字段只读,数组本身可 push —— 收集 warning 的唯一去处。 */
	readonly warnings: ProviderWarning[] = [];

	/**
	 * 回合级标记 —— codec 在序列化时留一个词,方言的 `extraBody` 读它决定请求体
	 * 上还要不要多长出什么(OpenRouter:本回合真投递了 PDF 才发 `plugins`
	 * `file-parser`)。分工不变:**请求体只在 builder 里长出来**,由策略 /
	 * `extraBody` 写,codec 一个字段都不直接写。
	 *
	 * 顺序上成立:模板方法先 `buildBody`(消息序列化 → 标记落下),再调
	 * `extraBody`(读标记)。
	 */
	readonly notes = new Set<string>();

	/**
	 * `AttachmentChannel` 换过之后的那一份。**私有**:外面只看得见
	 * `messages` 这一个只读视图,写入只有 `replaceMessages()` 一条路。
	 */
	private preparedMessages?: AgentMessage[];

	constructor(
		readonly request: AgentTurnRequest,
		readonly profile: ModelProfile,
		readonly builder: RequestBodyBuilder,
		readonly logger: Logger,
		/** 副请求通道(P4-6)。不给 = 这个回合发不了副请求。 */
		readonly transport?: TurnTransport,
	) {}

	/**
	 * 本回合真正要序列化的消息。默认就是 `request.messages`;附件通道
	 * (`AttachmentChannel`)跑过之后是它换过的那一份。
	 *
	 * **`request.messages` 本体永远不动** —— 那是上游的历史。
	 */
	get messages(): AgentMessage[] {
		return this.preparedMessages ?? this.request.messages;
	}

	/** 附件通道的唯一写入口(§3.1:可变量只从一处进)。 */
	replaceMessages(messages: AgentMessage[]): void {
		this.preparedMessages = messages;
	}

	get model(): string {
		return this.request.model;
	}

	get turn(): number {
		return this.request.turn;
	}

	/** 留痕,不静默。返回那条 warning,方便调用方顺手拿去当文本。 */
	warn(
		kind: ProviderWarningKind,
		detail: string,
		fields?: Readonly<Record<string, unknown>>,
	): ProviderWarning {
		const warning = new ProviderWarning(kind, detail, fields);
		this.warnings.push(warning);
		return warning;
	}
}
