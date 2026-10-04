/**
 * 消息热写端口:core 引擎注入的 store 端口里按消息寻址的那十五只(`updateMessage*` / `addMessage*` /
 * `updateStepsUsageByTurn`)。F4-c c4-d 起它们整批空转,只回答「这条消息在不在」,其中五只顺带做逐格断言或落点守卫。
 *
 * 它们从 `session-store.ts` 原样搬来(大文件拆分批 2,2026-10-04):这一块只读会话表持有器(`session-store-table.ts`)
 * 与活投影,不碰门面里的任何别的函数。入口(`session.ts`)从这里转交它们。
 */
import type {
	ChatMessage,
	ToolCall,
	Step,
	ContentPart,
} from "@shared/ipc.js";
import { eventsHasMessage } from "./session-events-reads.js";
import { hasLiveSessionProjection } from "./session-projection-cache.js";
import { assertContentPartIsCarriable } from './session-content-part-guard.js'
import { assertPortFactIsFolded } from './session-port-fact-assert.js'
import { sessionRepository } from './session-store-table.js'

/**
 * ## F4-c c4-d(§16.27):**15 个热写端口整批空转**
 *
 * 从这一批起,内存 store 的消息数组由**折叠产物**维护(仓库的
 * `refreshMessagesFromProjection` 是全仓唯一的换装点)。于是这些端口往数组里写的
 * 那一笔**没有读者**:下一次 `getSession` 就把它换掉了。留着写不是"保险",是
 * 第二个维护者 —— 而两个维护者正是 c3/c4 一路查下来所有分岔的病根。
 *
 * 每一口的事实在账本上都有产地(§16.23 的 18 端口分类表,A/B/D 三类):
 * 正文与推理是逻辑 delta(c3-a 盖章即折)、工具三口是 `tool/call|result|annotate`、
 * 用量是 `request/response.usage`、技能是 `skill/activated`、错误是 `run/end.error`、
 * 回合上下文是 `context/turn-update`、`isStreaming` 由 `run/start`/`run/end` 开闭推导。
 *
 * **端口本身不删**:它们的签名是 core 引擎注入的 store 端口(P0 §6 冻结),
 * 删签名是一次跨包的接口改动,与本批无关。空转之后它们只回答一个问题 ——
 * **"这条消息在不在"**(RPC 面靠这个布尔回 `success`;`image-stream` 那两处靠它
 * 判"写进去了没有")。
 *
 * `updateMessageStreaming` 一并空转:§16.23 第五节判它"今天翻不得",理由是
 * **恒等门会当场红**(store 摘掉这一格而折叠侧的 run 还没闭)。恒等门 c4 已经
 * 退役(§16.24),而"读改物化"正是那一节写的解除条件 —— 本批两件同批落地。
 */
function portTargetExists(sessionId: string, messageId: string): boolean {
	// 有活投影就问它(O(1),不物化);没有就退回内存 store 那一份 —— 与
	// `materializeSessionMessages` 的边界同源:没有活投影时消息数组仍归仓库。
	// **不主动建活投影**:建表要同步读整份文件,这一口挂在逐 token 的热路径上。
	if (hasLiveSessionProjection(sessionId)) {
		return eventsHasMessage(sessionId, messageId);
	}
	return (
		sessionRepository()
			.getSessionMessages(sessionId)
			?.some((message) => message.id === messageId) ?? false
	);
}

// Update message content (for streaming, does not affect sort order)
export function updateMessageContent(
	sessionId: string,
	messageId: string,
	_newContent: string,
): boolean {
	// **c4-d 起空转**(见 `portTargetExists` 上面那段)。产地 = `assistant/chunks`
	// 的逻辑 delta(c3-a 盖章即折);生图 / 压缩那三条非 provider 正文各有自己的
	// 产地(`assistant/part-end{contentOnly}` / `session/compacted`)。
	return portTargetExists(sessionId, messageId);
}

// Update message reasoning (for streaming, does not affect sort order)
export function updateMessageReasoning(
	sessionId: string,
	messageId: string,
	_reasoning: string,
): boolean {
	// **c4-d 起空转**。产地同 `updateMessageContent`(reasoning kind 的逻辑 delta)。
	return portTargetExists(sessionId, messageId);
}

// Update message streaming status (does not affect sort order)
export function updateMessageStreaming(
	sessionId: string,
	messageId: string,
	_isStreaming: boolean,
): boolean {
	// **c4-d 起空转**。`isStreaming` 由 run 开闭推导(`chat-messages.ts` 的
	// `...(node.ended ? {} : { isStreaming: true })`),不是一格独立事实 ——
	// c4-b 的钥匙② 已经把最后一个把它当寻址索引的消费者(停止按钮)换掉了。
	return portTargetExists(sessionId, messageId);
}

/**
 * Update message usage (does not affect sort order).
 *
 * **A 类端口**(§16.23 分类表 #15):这一格的事实早就在流上 ——
 * `request/response.usage` 逐轮落账,投影 reducer 求和折进 `node.usage`
 * (`reducer.ts:529`)。这里写的是**同一个事实的第二个落点**(活 run 写手视图
 * 上那一条),F4-c c4 给它挂上逐格断言:两侧此刻不等 = 事实与写路分岔,
 * 当场记一行(口径与边界全文见 `session-port-fact-assert.ts`)。
 */
export function updateMessageUsage(
	sessionId: string,
	messageId: string,
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	},
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'usage', usage);
	// **c4-d 起空转**(断言留任:它比的是"端口手里的事实 ≡ 折叠值")。
	return portTargetExists(sessionId, messageId);
}

// Update message tool calls (does not affect sort order)
export function updateMessageToolCalls(
	sessionId: string,
	messageId: string,
	_toolCalls: ToolCall[],
): boolean {
	// **c4-d 起空转**。产地 = `tool/call` / `tool/result` / `tool/annotate`;
	// 参数流是 `tool-input` kind 的 delta 段。
	return portTargetExists(sessionId, messageId);
}

// Update message content parts (does not affect sort order)
export function updateMessageContentParts(
	sessionId: string,
	messageId: string,
	_contentParts: ChatMessage["contentParts"],
): boolean {
	// **c4-d 起空转**。产地 = `assistant/part-end` + parts 物化。
	return portTargetExists(sessionId, messageId);
}

// Add a single content part to message (does not affect sort order)
export function addMessageContentPart(
	sessionId: string,
	messageId: string,
	part: ContentPart,
): boolean {
	// §13.6 第 9 条:这一格在事件账本上有落点吗?开发/测试期当场抛,生产期 warn。
	// 引擎的 `persistTurnContentParts` 走的是这条路(不是命令面),所以守卫必须
	// 也站在这里 —— 两个调用点,一个判定函数。
	assertContentPartIsCarriable(sessionId, part)
	// **c4-d 起空转**(守卫留任:它问的是"这一格在账本上有没有落点")。
	return portTargetExists(sessionId, messageId);
}

/**
 * Update message thinking time —— **F4-c c4 起空转**(§16.24,用户裁定
 * "thinkingTime 取投影值")。
 *
 * 这一格从来不是引擎的事实,是**渲染层的回写**:`MessageList.vue` 算完那段
 * "思考了几秒"再经 `chat` 域写回来(全仓唯一的生产写者)。而账本上它早就有
 * 产地 —— 投影的 `deriveThinkingTime` 从 `assistant/chunks` 的时刻算出同一个数
 * (`chat-messages.ts`),判据侧 `canonicalChatMessage` 更是把它列进
 * `ALWAYS_DROPPED_KEYS`:两条推导谁也没在对账,写回来的那一份只是覆盖了一个
 * 本来就折得出来的值。
 *
 * 于是这一口的实现只剩"这条消息在不在"—— RPC 面靠这个布尔回 `success`,渲染层
 * 一行没改。**不再写 store,也不再产生 `message/patched`**:一格由 fold 推导的
 * 派生态,多一个产地就是多一次分岔的机会(§16.23 第五节钉的同族判例)。
 *
 * 端口本身留着而不是删掉:`chatRouter.updateMessageThinkingTime` 是 `@shared/ipc`
 * 上的契约,删它是一次传输面改动,与本批无关。
 */
export function updateMessageThinkingTime(
	sessionId: string,
	messageId: string,
	_thinkingTime: number,
): boolean {
	return (
		sessionRepository()
			.getSessionMessages(sessionId)
			?.some((message) => message.id === messageId) ?? false
	);
}

/**
 * Update message skill used (does not affect sort order).
 *
 * **A 类端口**(§16.23 分类表 #9):产地是 `skill/activated`,折叠落点
 * `run.skillUsed`(`reducer.ts:694`)。挂逐格断言,理由同 `updateMessageUsage`。
 */
export function updateMessageSkill(
	sessionId: string,
	messageId: string,
	skillUsed: string,
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'skillUsed', skillUsed);
	// **c4-d 起空转**(断言留任)。
	return portTargetExists(sessionId, messageId);
}

/**
 * Update message error details (for API errors during streaming).
 *
 * **A 类端口**(§16.23 分类表 #10):产地是 `run/end.error`,折叠落点
 * `run.errorDetails`(`reducer.ts:513`)。挂逐格断言,理由同 `updateMessageUsage`。
 */
export function updateMessageError(
	sessionId: string,
	messageId: string,
	errorDetails: string,
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'errorDetails', errorDetails);
	// **c4-d 起空转**(断言留任)。
	return portTargetExists(sessionId, messageId);
}

/*
 * `updateMessageReactions` / `updateMessageReplyTo` / `updateMessageMentions`
 * —— **已删除**(F4-c c4,§16.24)。
 *
 * 三条 IM 元数据写路(W8 表情 / W13.2 引用快照 / W14a @身份)早在 P0.2 就整体迁到
 * 命令面的 `patchMessage` 上了(`collab/` 那三处协调器);c3-a 的 18 端口
 * 全量分类(§16.23 第二节)量明它们**生产上一次都不调**,只剩三只测试的 mock 还
 * 认得这三个名字——而那三只测试的注释白纸黑字写着"迁移前这条写走
 * `store.updateMessageXxx`;命令面上它是一次普通 patch"。
 *
 * 删除是纯减法:不需要任何新产地(命令面的 `message/patched` 就是它们的产地),
 * 也不改变任何一条 IM 写路的行为。
 */

/**
 * Persist the turn-context delta on a user message (prompt-channels
 * 2026-08-18). Written once per turn by `SessionTurnContext`; does not affect
 * sort order.
 *
 * **A 类端口**(§16.23 分类表 #14):产地是 `context/turn-update`,折叠落点
 * `node.turnContext`(`reducer.ts:684`)。挂逐格断言,理由同 `updateMessageUsage`。
 */
export function updateMessageTurnContext(
	sessionId: string,
	messageId: string,
	turnContext: NonNullable<ChatMessage["turnContext"]>,
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'turnContext', turnContext);
	// **c4-d 起空转**(断言留任)。
	return portTargetExists(sessionId, messageId);
}

// Add a step to a message (does not affect sort order)
export function addMessageStep(
	sessionId: string,
	messageId: string,
	_step: Step,
): boolean {
	// **c4-d 起空转**。产地 = `tool/call` → `materializeSteps`。
	return portTargetExists(sessionId, messageId);
}

// Update a step in a message (does not affect sort order)
// Searches recursively in childSteps
export function updateMessageStep(
	sessionId: string,
	messageId: string,
	_stepId: string,
	_updates: Partial<Step>,
): boolean {
	// **c4-d 起空转**。产地 = `tool/call` / `tool/result` / `tool/annotate`。
	return portTargetExists(sessionId, messageId);
}

export function updateMessageSteps(
	sessionId: string,
	messageId: string,
	_steps: Step[] | undefined,
): boolean {
	// **c4-d 起空转**。产地同 `updateMessageStep`。
	return portTargetExists(sessionId, messageId);
}

// Update usage for all steps in a specific turn (does not affect sort order)
export function updateStepsUsageByTurn(
	sessionId: string,
	messageId: string,
	_turnIndex: number,
	_usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	},
): string[] {
	// **c4-d 起空转**。产地 = `request/response.usageTurnIndex` → `run.usageByTurn`
	// → `steps[].usage`(§13.9)。返回值(改到了哪几个 step)全仓零消费者。
	void sessionId;
	void messageId;
	return [];
}
