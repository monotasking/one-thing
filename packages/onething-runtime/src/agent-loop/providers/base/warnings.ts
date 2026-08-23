/**
 * `ProviderWarning` —— **被丢弃的设置也要留痕**(设计稿 §2.4)。
 *
 * 不只内容块:Kimi 固定 temperature、Zhipu 把 `required` 降成 `auto`、
 * Grok 禁 penalty —— 统统走这一个对象,不再静默。
 *
 * 可见文案只在 `toText()` 一处(§3.1「值对象与不变量」)。
 *
 * P0a 只是把通道立起来:`TurnContext.warnings` 收集,暂时没有消费者
 * (core 的 `finish` 事件加 `warnings?` 是 §8 的契约增量,P0b 才动)。
 */
export type ProviderWarningKind =
	/** 请求里带了、线协议/模型不收,于是没发出去(Kimi 固定 temperature)。 */
	| "setting-dropped"
	/** 发出去了但被夹到了合法区间(effort xhigh → high)。 */
	| "setting-clamped"
	/** 某个内容块进不了请求体,只能留成可见文本(见 `Undeliverable`)。 */
	| "part-undeliverable"
	/** `required` 降成 `auto`(Zhipu / Kimi-K2)。 */
	| "tool-choice-downgraded"
	/** 思考意图这条线协议表达不了,整段没发。 */
	| "thinking-unsupported"
	/** 响应里没有 usage 那块,账本这一回合是空的。 */
	| "usage-missing"
	/**
	 * 工具调用的 `arguments` 增量在该 index 已被判 done **之后**才到
	 * (openai-chat 的 index 切换判据遇上不按 index 顺序发的网关)。
	 * 那些字符对模型已经无效 —— 留痕,不静默。
	 */
	| "tool-call-interleaved";

export class ProviderWarning {
	constructor(
		readonly kind: ProviderWarningKind,
		readonly detail: string,
		readonly fields?: Readonly<Record<string, unknown>>,
	) {}

	/** 唯一的可见文案出口。 */
	toText(): string {
		return `[${this.kind}] ${this.detail}`;
	}

	toJSON(): {
		kind: ProviderWarningKind;
		detail: string;
		fields?: Readonly<Record<string, unknown>>;
	} {
		return {
			kind: this.kind,
			detail: this.detail,
			...(this.fields ? { fields: this.fields } : {}),
		};
	}
}
