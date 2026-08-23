/**
 * `AttachmentChannel` —— **附件在序列化之前先换一次**(设计稿 §10,P4-6)。
 *
 * 有些端点收文件不靠线协议的内容块,而靠一条**旁路**:先把字节 POST 到它自己
 * 的文件接口,再把抽取出来的文本放进 prompt(Kimi 的
 * `/v1/files` + `purpose=file-extract`)。那既不是 codec 的事(codec 是同步的、
 * 只认块),也不是 `extraBody` 的事(它长的是请求体字段,不是消息),所以它是
 * 一条**自己的策略**:在 wire 序列化消息**之前**跑一次,把某些块换成别的块。
 *
 * 两条纪律,和这一层其它策略一样:
 *  - **实例无状态**:回合级的量全在 `TurnContext`(副请求要的传输在
 *    `TurnContext.transport`,与主请求同一套凭据、同一个 `fetchImpl`);
 *  - **不改 `request.messages` 本体**:那是上游的历史,provider 不该动它。
 *    产出一份替换后的数组交给 `TurnContext.replaceMessages()`,codec 读
 *    `turn.messages`。
 *
 * 失败不抛:一个附件没抽出来是「少一块上下文」,不是「这一回合失败」——
 * 那一块原样留在消息里,codec 会把它落成可见的 `Undeliverable` 文本,同时
 * `turn.warn('attachment-extract-failed', …)` 留痕(§2.4:不静默)。
 */
import type { AgentContentPart } from "@onething/core/agent-loop";
import type { TurnContext } from "./turn-context.js";

export interface AttachmentChannel {
	/**
	 * 这一块归这条通道管吗。
	 *
	 * 它不只是 `prepare()` 的内部判据 —— **投递契约的门读它**
	 * (`base/__tests__/delivery-invariant.test.ts`):声明了 `file` 模态却
	 * 由通道投递的那一格,判官是通道而不是 codec(codec 永远见不到那一块,
	 * 它在序列化之前就被换掉了)。
	 */
	handles(part: AgentContentPart): boolean;

	/**
	 * 在 `buildBody` 序列化消息**之前**跑一次。要换东西就调
	 * `turn.replaceMessages()`;没什么可换就什么都不做(零副请求)。
	 */
	prepare(turn: TurnContext): Promise<void>;
}
