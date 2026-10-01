/**
 * 交互协议的**线上形状**(docs/design/claude-code-integration-v2.md §4)。
 *
 * 纯类型模块,零 import、零运行时代码 —— 渲染层与 shared 的 IPC 契约层都直接
 * `import type` 到这里,不能让它们顺带拖进 `node:crypto`(registry.ts 才是实现)。
 *
 * ## 为什么不复用 Permission
 *
 * Permission 的语义是「允许 / 拒绝一个动作」,返回值是四选一的 `once/session/
 * workdir/reject`;提问的语义是「从 N 个选项里选,或者自己写一句」,返回的是**结构化
 * 答案**。把两者合并会把生命周期(一次性 vs 可授权留存)、UI(审批条 vs 选项卡)、
 * 超时策略(拒绝 vs 空答)三样东西绑死在一个类型上 —— 正是这个仓库反复吃亏的
 * 「合并两个边界」。
 *
 * ## 形状为什么长这样
 *
 * 照 Agent SDK 的 `AskUserQuestionInput/Output`(`sdk-tools.d.ts:847-900 / 3395+`)
 * 设计,让 E4 的映射零损耗:SDK 的 `questions[].{question,header,options[].{label,
 * description,preview},multiSelect}` 在这里逐字对得上。两处**刻意的不同**:
 *
 * 1. SDK 的 answer 是 `Record<header, string>` —— 用 header 当键,多选靠字符串拼接。
 *    我们用 `questionId` 当键、`selected: string[]` 承多选:header 是给人看的短标签
 *    (SDK 自己都写「max 12 chars」),拿它当主键,两题撞名就静默串答案。
 * 2. `allowFreeText` 在 SDK 侧是隐含的(「There should be no 'Other' option, that
 *    will be provided automatically」)。我们显式声明:宿主工具将来也要用这个协议,
 *    而「只能选、不许写」是一个真实需求。
 */

/** 谁在提问。`external-agent` = SDK 自带的交互工具;`host-tool` = 我们自己的工具。 */
export type InteractionOrigin = 'external-agent' | 'host-tool'

export interface InteractionOption {
  /** 选项正文(用户点的那一行)。同时也是答案里 `selected` 的取值。 */
  label: string
  description?: string
  /** 聚焦这个选项时展开的对照内容(mockup / 代码片段)。 */
  preview?: string
}

export interface InteractionQuestion {
  /** 答案表的主键。不用 header —— 它是给人看的短标签,会撞名。 */
  id: string
  /** 短标签(chip),SDK 侧建议 12 字以内。 */
  header?: string
  question: string
  multiSelect?: boolean
  options: InteractionOption[]
  /** 允许「其他」自由输入。 */
  allowFreeText?: boolean
}

export interface InteractionRequest {
  id: string
  sessionId: string
  /** 发起这次提问的工具调用。卡片按它归位(与 permission 的 callId 同一条纪律)。 */
  toolCallId?: string
  /**
   * 提问发生在**哪条消息**上。归位的第二档 —— 与审批卡的 `messageId` 同一条纪律
   * (`app/permission/message-anchor.ts`)。
   *
   * 为什么两个键都要:`toolCallId` 是精确落点,但它**未必存在于渲染侧的消息上** ——
   * 后台子代理的调用带 `parent_tool_use_id`,连接器按既有约定不为它另起工具卡;
   * 流式期间那次调用也可能还没落进消息。只认 `toolCallId` 的渲染侧于是只剩会话
   * 末尾一条路,而末尾正是「新消息出现的地方」——用户读到的就是「我答完之后冒出
   * 一条消息」。带上消息锚,那一格退化成「贴在那条消息之后」,位置略偏,但**不再
   * 长得像一条新消息**,也不会在那次调用迟落地时从末尾跳回原位。
   */
  messageId?: string
  origin: InteractionOrigin
  questions: InteractionQuestion[]
  /**
   * 硬性 deadline(绝对时间戳),**必有**——原则 4「每一条等待都有 deadline」。
   * registry 自己挂表到点结算,不依赖 UI 在场,也不依赖调用方记得设超时。
   */
  deadlineAt: number
  createdAt: number
  /**
   * 提问发往哪条通道。respond 的 channel 必须与它相等,否则拒收
   * (照搬 Permission 的通道亲和:`packages/core/permission/index.ts:263-269`)。
   */
  targetChannel?: string
}

/**
 * 一次提问的收场方式。四种都是**正常返回**,没有一种走 throw ——
 * 原则 3「需要人回答的事,要么有一等落点,要么当场拒绝」:调用方必须把每一种收场
 * 都翻译成模型看得懂的工具结果,而异常路径会诱使调用方让它冒泡成一次挂起或红错。
 */
export type InteractionOutcome = 'answered' | 'declined' | 'timeout' | 'aborted'

export interface InteractionQuestionAnswer {
  /** 选中的选项 label(单选也是数组,免得下游为两种形状写两条分支)。 */
  selected: string[]
  /** 「其他」里写的那句。 */
  freeText?: string
}

export interface InteractionAnswer {
  /** 对应的 `InteractionRequest.id`。 */
  id: string
  /** 逐题答案,键是 `InteractionQuestion.id`。非 answered 的收场是空表。 */
  answers: Record<string, InteractionQuestionAnswer>
  outcome: InteractionOutcome
  /** 非 answered 收场的可读理由 —— 直接进工具结果给模型看。 */
  reason?: string
}

/** `Interaction.ask()` 的入参:id / createdAt / targetChannel 由 registry 自己盖。 */
export interface InteractionAskInput {
  sessionId: string
  origin: InteractionOrigin
  questions: InteractionQuestion[]
  toolCallId?: string
  /** 归位的第二档消息锚(见 `InteractionRequest.messageId`)。 */
  messageId?: string
  /** 绝对 deadline。与 timeoutMs 二选一,给了它就以它为准。 */
  deadlineAt?: number
  /** 相对超时。都不给则落到 `DEFAULT_INTERACTION_TIMEOUT_MS`。 */
  timeoutMs?: number
}
