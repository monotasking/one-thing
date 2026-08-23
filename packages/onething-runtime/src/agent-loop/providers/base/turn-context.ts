/**
 * `TurnContext` —— 一回合的全部可变量(设计稿 §3)。
 *
 * **所有 hook 只接收它,不碰 this**;provider 实例因此没有可写字段,可以跨
 * 回合、跨凭据复用(§3.1「实例无状态」,架构测试守)。
 */
import type { AgentTurnRequest } from "@onething/core/agent-loop";
import type { Logger } from "./provider-context.js";
import type { ModelProfile } from "./model-profile.js";
import type { RequestBodyBuilder } from "./request-body-builder.js";
import { ProviderWarning, type ProviderWarningKind } from "./warnings.js";

export class TurnContext {
	/** 字段只读,数组本身可 push —— 收集 warning 的唯一去处。 */
	readonly warnings: ProviderWarning[] = [];

	constructor(
		readonly request: AgentTurnRequest,
		readonly profile: ModelProfile,
		readonly builder: RequestBodyBuilder,
		readonly logger: Logger,
	) {}

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
