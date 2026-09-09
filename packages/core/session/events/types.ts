/**
 * 会话事件词表 v2 —— `docs/design/session-event-sourcing-2026-08.md` §9.1/§9.2。
 *
 * 这里是**唯一**的事件形状定义处:S0 之前七类住在
 * `packages/onething-runtime/src/sessions/session-events.ts`,那里 import 了
 * `node:crypto`,renderer 只能靠 shared 层那个契约面的 `export type` 擦除来绕开。现在类型上移到 core(零依赖),runtime 那个文件降为**再导出 +
 * 哈希/检视工具**,盘上格式与既有消费者逐字不变。
 *
 * 四条铁律照旧(原文见 runtime 侧的文件头):只记时刻;执行前记账;记模型当时
 * 看到的世界;追加不截断(读侧遇到不认识的 type 跳过那一行)。
 *
 * v2 在此之上加两条:
 *
 * 1. **surface 是事件的顶层字段,不是投影的猜测**(dsh 判例,§3.1)。
 *    `surfaceOp` + `sourceEventSeqs` 一个机制同时表达 compact / edit-resend /
 *    regenerate / delete / 工具结果剪枝;被遮蔽的事件留在日志里,只是不在
 *    模型可见历史上。
 * 2. **响应正文只有一个来源**:`assistant/chunks` 的 delta fold。
 *    `request/response` 只带 finish/usage/ids + 各 part 的 len/hash,
 *    不存第二份文本 —— 这一条由本文件末尾的类型级门钉住。
 */

import type { Principal } from '../../permission/principal.js'

// ============ 记录外壳 ============

/**
 * surface 操作(§9.1)。
 *
 * - `'append'`:这条事件在模型可见历史的末尾新增一个节点。
 * - `{op:'replace', start, end}`:遮蔽 `[start, end]`(闭区间,按 **eventSeq**)
 *   这一段 surface 节点。替换进去的是本事件自己(如果它是节点类型),否则就是
 *   纯删除(`message/deleted` / `session/cleared`)。
 *
 * `start`/`end` 是 **eventSeq**,不是数组下标 —— 下标会随前面的替换平移,
 * 而 seq 是身份(§7.2 M6:`ChatMessage.seq` 是位置,事件 seq 是身份)。
 */
export type SessionSurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

/**
 * 事件记录(§9.1)。`surfaceOp` / `sourceEventSeqs` 与 seq/time 同级 —— 它们是
 * **账本层**的字段,不属于任何一条事件的业务 data。
 */
export interface SessionEventRecordShape<TType extends string, TData> {
  /** 会话内单调递增,从 1 起。身份,不是位置。 */
  seq: number
  /** Date.now()。只有时刻,没有时长。 */
  time: number
  type: TType
  data: TData
  /** 仅 surface 事件带。 */
  surfaceOp?: SessionSurfaceOp
  /** 因果/遮蔽引用:被这条事件遮蔽或导出它的那些 eventSeq。 */
  sourceEventSeqs?: number[]
}

// ============ Blob 引用 ============

/**
 * 大正文的引用(§9.1)。S0 **只定义类型与判定**,blob 落盘在 S1。
 *
 * 谁必须是 BlobRef:附件的 `base64Data`、超 64KB 的工具结果、图片 part。
 * 判定故意收得紧(三个字段的类型都查):事件行里塞一个
 * `{hash: 'abc'}` 而没有 bytes 的半成品,是 S1 最容易犯的错。
 */
export interface BlobRef {
  hash: string
  bytes: number
  mime?: string
}

export function isBlobRef(value: unknown): value is BlobRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<BlobRef>
  if (typeof ref.hash !== 'string' || ref.hash.length === 0) return false
  if (typeof ref.bytes !== 'number' || !Number.isFinite(ref.bytes) || ref.bytes < 0) return false
  if (ref.mime !== undefined && typeof ref.mime !== 'string') return false
  return true
}

/** 超过这个字节数的工具结果/正文必须走 blob(§9.1)。S0 只是常量,不落盘。 */
export const SESSION_EVENT_BLOB_THRESHOLD_BYTES = 64 * 1024

/** `collectSessionBlobRefHashes` 的下潜上限(事件 data 再深也不该超过这个)。 */
const BLOB_REF_WALK_MAX_DEPTH = 8

/**
 * 一份事件里出现的**全部 blob 引用**(附件 / 工具结果 / 图片 part)。
 *
 * 判据只有一个 —— `isBlobRef`,所以"哪些字节还被引用着"这句话全仓只有一种答法:
 * `sessions:verify` 的引用完整性检查(有引用没文件)与 blob GC 的孤儿判定
 * (有文件没引用)问的是同一张表的两侧,判据分家迟早会分出一边删掉另一边认的
 * 东西。放在 core 是因为它是纯遍历,只依赖 `isBlobRef` 本身。
 */
export function collectSessionBlobRefHashes(
  events: readonly SessionEventRecordShape<string, unknown>[],
): Set<string> {
  const hashes = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > BLOB_REF_WALK_MAX_DEPTH || !value || typeof value !== 'object') return
    if (isBlobRef(value)) {
      hashes.add(value.hash)
      return
    }
    for (const entry of Object.values(value as Record<string, unknown>)) walk(entry, depth + 1)
  }
  for (const event of events) walk(event.data, 0)
  return hashes
}

// ============ 投影用的消息形状(core 本地,不引 shared 的契约) ============

/**
 * 事件里承载的一条消息。
 *
 * 与 shared 层契约里的 `ChatMessage` **结构兼容**但不引用它 —— core 是零依赖层,
 * 而那些契约住在 shared。字段全部可选(除 id/role),因为事件里存的就是
 * 当时那条消息**有什么就是什么**,不补全、不规整。
 */
export interface SessionEventMessage {
  id: string
  role: string
  content?: string
  timestamp?: number
  [key: string]: unknown
}

// ============ 既有七类(形状不变,只加可选 runId) ============

export interface SessionEventToolSchema {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface SessionRequestToolsEventData {
  requestIndex: number
  toolsHash: string
  tools: SessionEventToolSchema[]
  runId?: string
}

export interface SessionRequestHeaderEventData {
  requestIndex: number
  provider: string
  model: string
  systemPromptHash: string
  toolsHash: string
  reason: 'initial' | 'change'
  runId?: string
}

export interface SessionRequestStartEventData {
  requestIndex: number
  messageId: string
  runId?: string
}

export interface SessionAssistantFirstTokenEventData {
  requestIndex: number
  messageId: string
  runId?: string
}

export interface SessionToolCallEventData {
  callId: string
  /** 模型给的原始 arguments JSON 串 —— 原样存,包括它写坏的时候。 */
  argumentsRaw: string
  /** provider 给的**原始**工具名。归一后的身份在下面两格。 */
  name: string
  /**
   * A6(§13.1):引擎归一之后的工具 id(`resolveToolIdentity().toolId`)。
   *
   * 消息上那一格是 `toolCall.toolId = resolved.toolId`,而 `name` 是模型写的
   * 那个字符串 —— 两者在别名表命中或 MCP 短名补全时并不相等。投影从前只有
   * `name`,于是装了 MCP 的机器上每条工具卡的身份都对不上。
   *
   * **成对交付**(§10.16):老文件没有这一格,投影退回 `name` = 修复前的行为。
   */
  resolvedToolId?: string
  /**
   * A7(§13.1):引擎归一之后的**显示名**(`resolveToolIdentity().displayName`)。
   *
   * 消息上那一格是 `toolCall.toolName`,而 `steps[].type`(`getStepType`)与
   * `skillUsed`(`detectSkillUsage`)在引擎里读的都是它,不是 provider 原始名。
   * MCP 的完整 id 会被折成**服务器名**,所以少了这一格,投影连 step 的类型都
   * 可能判错。老文件缺席时退回 `name`。
   */
  displayName?: string
  messageId: string
  runId?: string
  /**
   * A11(§13.1):这次调用**不在消息上**(引擎的 `publish:false`)。
   *
   * 呈现层的可见性由引擎那一个判定点决定(`stream-processor.ts` 的 `visible`:
   * 占位卡、`toolCalls.push`、step 三样一起不做),而记录器挂在 agent-loop 的
   * 事件流上,看不见那个决定 —— 于是账本无条件记、投影无条件产出,一次不可见
   * 的补位调用在投影里凭空多出一张卡。可见性经**注入端口**回传给记录器
   * (与 `resolveToolIdentity` 同一条路数),记在这里。
   *
   * **成对交付**(§10.16):老文件没有这一格 = 可见(修复前的事实)。
   * 轨迹与审计**不看它** —— 它们记的是"发生过什么",不是"屏幕上有什么"。
   */
  hidden?: boolean
  /**
   * G3(§10.1):父调用的 callId —— 一次工具调用在另一次调用**内部**发生时才有。
   * 采集点拿得到就填,拿不到就平铺(不猜、不按时间窗配对);投影按它建
   * `childSteps`。
   */
  parentCallId?: string
  /**
   * §13.9:这次调用发生在引擎的**第几个回合**(`state.turnIndex`)。
   *
   * 从前投影按 `run.turnCount`(= 这条 run 到目前为止的**请求**数)推。一次请求
   * 一个回合时两者相等,而外部执行器(Claude Code SDK)一次请求里可以有好几个
   * 回合 —— 那时推出来的号比事实小,而 `steps[].turnIndex` 与"这一轮的 usage 落到
   * 哪几个 step 上"都挂在它身上。
   *
   * **成对交付**(§10.16):老文件没有这一格 → 退回按请求数推(= 修复前的行为)。
   */
  turnIndex?: number
}

/**
 * 工具结果。v2 把正文补上:`result` 是 `{text}` 或 `{blob}`,
 * `resultPreview` **保留**(既有文件只有它,轨迹面板也只读它)。
 */
export interface SessionToolResultEventData {
  callId: string
  isError: boolean
  resultPreview: string
  /** 对应 `tool/call` 事件的 seq。因果显式引用,不靠"就近配对"猜。 */
  sourceSeq?: number
  result?: { text: string } | { blob: BlobRef }
  /**
   * 工具**结构化**结局的 JSON(`ToolCall.result` 的正身)。
   *
   * `result` 是给模型看的那段正文(历史里放的就是它),而工具卡上渲染的是
   * 结构化的那一份 —— `{title, output, metadata}` 里的 metadata 才是 diff
   * hunks / 文件路径 / 命令退出码的所在处。只记正文的话,S2 切读之后每张工具卡
   * 都会退化成一段纯文本,而门却是绿的。
   *
   * 与 `result` 同一条 64KB 线(超过走 blob);工具结局本身就是字符串时不写
   * 这一格(那时两者是同一个东西)。
   */
  resultData?: { text: string } | { blob: BlobRef }
  /**
   * 工具**自报**的标题(`annotate{title}` 的最后一条,§10.12 第 6 类)。
   *
   * 引擎的 step 标题就是它:每一条带标题的 `tool-metadata` 都会
   * `sendStepUpdated({title})` 覆盖一次(`applyAgentLoopToolMetadata`)。
   * 成功的调用里它同时被抄进结局的 `resultData.title`,所以从前只读 resultData
   * 也对得上;**失败的调用没有结局对象**(`{success:false, error}` 里没有 title),
   * 于是账本上那一格凭空消失,投影退回派生标题 —— 真机上 `read` 越界失败的那条
   * 就是这么从 "Reading X.md" 变成 "Tool: read: X.md" 的。
   */
  reportedTitle?: string
  /**
   * edit/write 的**结构化 diff**(`CoreToolCallChangesLike` 的 JSON,§13.17)。
   *
   * changes(diff / hunks / filePath / additions / deletions / *Hash / auditPath)
   * 不可从 `resultData` 派生 —— hunks 活在工具的 `tool-metadata` 里,结局正文
   * 不带。切读之后工具卡的 diff、影子 `run/end` 比对、verify 都要它,所以采集点
   * 独立成一格。采集点抄引擎写消息时的**同一把** `changesFromToolMetadata`,
   * 天然不含 `originalContent`(那一格从不进事件链)。与 `resultData` 同一条
   * 64KB 线(超过走 blob)。**成对交付**:老文件没有这一格 = 物化不 attach,
   * 与修复前逐字相同。
   */
  changes?: { text: string } | { blob: BlobRef }
  /**
   * 这条结局是**收场修复**记下的,不是工具自己报的(§13.8 第一类)。
   *
   * 用户按下停止(或请求最终出错)时,已经派工出去的调用永远等不到
   * `tool-result` 那条流事件 —— 账本上只剩一条 `tool/call`。而引擎那一刻在
   * **消息上**是有话说的:`finalizeLingeringAgentLoopToolWork` 把调用与 step
   * 判成 `cancelled` + 一句话,而 step 上还留着这次执行途中已经写下的结局
   * (工具的 `annotate{metadata}` 或最后一次 partial)与自报标题。采集点因此
   * 挂在**那一个收场点**上,把引擎真的写下的东西记成一条 `tool/result`,
   * 这一格说明它的来路。
   *
   * 投影据此复刻消息侧的四格:状态 `cancelled`、`toolCall` 上**没有**结局对象
   * (那次修复只写 status + error)、`step.result` = 记下的那段正文、
   * `step.error` / `toolCall.error` = 收场那句话(由 run 的收场方式派生,
   * 见 `lingeringToolError`)。
   *
   * **成对交付**(§10.16):老文件没有这一格 —— 那些调用在账本上根本没有
   * `tool/result`,投影照旧走"没等到结局"那一支(占位标题、没有结局正文),
   * 那正是修复前的事实。
   */
  cancelled?: true
  runId?: string
}

/**
 * 工具**自报的结局**(`annotate{title, details}`,F 线 F2-c / §16.9)。
 *
 * 从前这一格在事件账本里**没有产地**:引擎当场把它盖到消息上
 * (`applyAgentLoopToolMetadata` → `step.title` / `step.result`),而记录器只把它
 * 攒在内存表里(`reportedTitleByCallId` / `changesByCallId`),等 `tool/result`
 * 落账时顺带写出去。于是"工具说过话、但这次调用永远等不到结局"的那条路上
 * (§15.6 的退出竞速:`run/end` 与批 9 的取消采集都挂在异步收尾链上,进程先走了)
 * 这两格**永久**丢失 —— full 之下停写 `messages.jsonl` 后就再也折不出来。
 *
 * 所以自报结局拿到自己的产地:**工具每说一次,账本记一次**。它是第一手事实
 * (工具自己说的),不是从收尾结果反推的二次派生(§13.8 裁定的重审见 §16.9)。
 *
 * 折法是**最后一条赢**,与引擎逐字相同(每一条带 title 的 annotate 当场盖掉
 * step 标题;每一条带 metadata 的当场盖掉 step 结局正文)。`tool/result` 一到,
 * 结局正文以它为准(引擎那边也是收尾覆盖);标题两边同源,写的是同一个值。
 *
 * **成对交付**(§10.16):老账本没有这一类事件 → 投影与修复前逐字相同
 * (没等到 `tool/result` 就没有结局正文、标题停在占位)。
 */
export interface SessionToolAnnotateEventData {
  callId: string
  /** 工具自报的标题(`annotate{title}`)。 */
  title?: string
  /**
   * 工具自报的结局正文 —— 引擎的**同一把**判定点折出来的那一份
   * (`resultTextFromToolMetadata`:`metadata.output` 是字符串就用它,
   * 否则整份 metadata 的 JSON)。与 `tool/result.result` 同一条 64KB 线,
   * 超了走 blob(内容寻址,同一份 metadata 说两次只占一份字节)。
   */
  result?: { text: string } | { blob: BlobRef }
  runId?: string
}

export interface SessionToolAuditEventData {
  callId: string
  toolId: string
  /**
   * 谁动的手(K2a',`docs/design/atom-2026-09.md` §10.5)。
   *
   * **可选**,因为它是后加的一格:在此之前写下的每一条 `tool/audit` 都没有它,
   * 而账本是 append-only 的 —— 把它写成必填等于说谎(读旧行时那一格并不存在)。
   * 新写的每一行都带:管线只接受带主体的调用(`Invocation.principal` 必填)。
   */
  principal?: Principal
  effects: string[]
  effectCount: number
  previewTitle?: string
  decision?: 'allow' | 'deny'
  asked?: boolean
  outcome: 'ok' | 'invalid' | 'denied' | 'aborted' | 'failed'
  intercepted?: { action: 'rewrite' | 'block'; by?: string[] }
  messageId?: string
  runId?: string
}

export interface SessionRequestEndUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface SessionRequestEndEventData {
  requestIndex: number
  stopReason?: string
  usage?: SessionRequestEndUsage
  runId?: string
}

// ============ 会话 ============

import type { SessionOriginStamp } from './origin.js'

export interface SessionCreatedEventData {
  sessionId: string
  kind?: string
  agentId?: string
  model?: string
  provider?: string
  workingDirectory?: string
  /**
   * **产地印章**(§17.7 #2+#1):写这条的时候,这个进程认为自己的 store 在哪儿。
   *
   * 形状与理由见 `events/origin.ts`(路径**指纹**不是路径 —— 账本会被拷来拷去、
   * 会被贴进 issue,绝对路径不该进账本)。`sessions:verify` 读每本账第一条
   * `session/created` 的这一格来分栏:指纹对得上 = 本机产物,全规则照旧;对不上 =
   * 跑错 store 的进程 / 拷进来的夹具;**缺席 = 印章之前的存量账,不猜**(纪律 9)。
   */
  origin?: SessionOriginStamp
}

export interface SessionAgentChangedEventData {
  from?: string
  to: string
}

export interface SessionModelChangedEventData {
  from?: string
  to: string
  provider?: string
}

export interface SessionWorkdirChangedEventData {
  from?: string
  to: string
}

/**
 * 压缩。**它自己是一个 surface 节点**(summary 作为历史里的那条 system 消息),
 * 同时带 `surfaceOp: replace` 遮蔽被压掉的那一段。
 *
 * `messageId` 是今天 UI 上那条 compact 标记消息的 id —— 投影要把它复原成
 * `role:'system'` 的派生消息(§9.4 的"注意"),所以 id 必须在事件里。
 */
export interface SessionCompactedEventData {
  summary: string
  messageId: string
  /** 被压掉的消息条数(UI 卡片上显示的那个数)。 */
  compactedMessageCount: number
  /** 切点:压到哪条消息为止。 */
  compactedThroughMessageId?: string
  model?: string
  provider?: string
  /** 失败的压缩也记一条 —— 它在 UI 上是一张红卡,不是"什么都没发生"。 */
  status?: 'completed' | 'failed'
  error?: string
  /**
   * 压完之后**还留在上下文里**的 token 数(§17.7 #15 裁定 2)。
   *
   * 它是压缩写者**当刻亲知的事实**(`computeRetainedContextSizeAfterCompact` 按保留
   * 下来的那几条消息现算),不是二次派生 —— §13.8 的判据("这句话在别处有没有产地")
   * 在这里的答案是:账本上要到**下一次请求**的 `request/response.usage.inputTokens`
   * 才知道,而屏幕上的上下文表此刻就要读它。
   *
   * **append-only 可选格**:老账本缺席 = 折叠维持原状(成对交付,纪律 9)。
   */
  retainedContextSize?: number
}

/** `replaceAll{clear}` / collab 的 MESSAGES_REPLACED(§9.3)。 */
export interface SessionClearedEventData {
  reason: 'clear' | 'replaced'
}

// ============ 用户 / 消息 ============

export interface SessionUserMessageEventData {
  message: SessionEventMessage
}

export interface SessionSystemMessageEventData {
  message: SessionEventMessage
}

export interface SessionUserMessageEditedEventData {
  messageId: string
  message: SessionEventMessage
}

export interface SessionMessageDeletedEventData {
  messageId: string
}

/**
 * 非正文字段的改写(§9.2)。
 *
 * `patch` 里**不许**出现 content/contentParts/reasoning —— 那三样的来源是
 * chunks,不是命令。类型上收不住(patch 是开放记录),所以由投影侧丢弃并在
 * 合同测试里钉住。
 */
export interface SessionMessagePatchedEventData {
  messageId: string
  patch: Record<string, unknown>
  /**
   * 这条补丁是**哪一条命令**写的(§17.7.1 批 2 裁定 2)。
   *
   * `upsertMessage` 命中已有消息时写的是"整条替换"的那一档(`fullBody`),而它
   * 与 `patchMessage` 在**会话账**上的待遇不同:upsert 盖 `updatedAt`,patch 不盖
   * (`core/session/commands.ts` 的两条分支)。两者的事件形状完全同构,所以
   * 事件上必须带一格**调用类别**——它是命令面亲知的事实(§13.8:可以记别人
   * 说的话),而"盖不盖章"这条**策略**住在折叠器一处(`session/account.ts`)。
   *
   * 不另起 `message/replaced` 事件种:形状同构,分种只多一个词汇分支。
   * **成对交付**(§10.16):老账本没有这一格 → 按 `patchMessage` 待遇不盖,
   * 与那些行当年的行为一致。
   */
  via?: 'upsert'
}

export interface SessionMessageImportedEventData {
  message: SessionEventMessage
}

// ============ 执行 ============

export type SessionRunKind =
  | 'send'
  | 'retry'
  | 'edit-resend'
  | 'resume'
  | 'steer'
  | 'follow-up'

export interface SessionRunStartEventData {
  runId: string
  kind: SessionRunKind
  agentId?: string
  /**
   * 触发这次执行的那条事件(通常是 `user/message`)。
   *
   * S1 里它**经常解不出来**:引擎入口拿到的是 messageId,而 id→eventSeq 的索引
   * 要到 S2 才有。所以下面那一格是并列的、不是替补 —— 解得出就填 seq,解不出
   * 就只有 id,两者都没有就说明这次执行不是被某条消息触发的(retry / resume)。
   */
  triggerEventSeq?: number
  triggerMessageId?: string
  assistantMessageId: string
  provider?: string
  model?: string
  /**
   * 助手消息本身的时刻(`ChatMessage.timestamp`)。
   *
   * 事件的 `time` 是**记账时刻**,而助手那条占位消息是在开 run 之前就建好的
   * (引擎先建消息、再进执行入口)。投影把这一格物化成一条消息,时刻必须跟着
   * 消息走 —— 否则每一个 run 的投影都比事实晚几毫秒,而影子断言会把它当成
   * 一次真的不等。缺席时退回 `event.time`(老文件里没有这一格)。
   */
  timestamp?: number
  /**
   * 触发这次执行的那条命令的来源(`ChatMessage.origin`)。
   *
   * 引擎把它**同时**盖在用户消息与助手占位消息上(`core-stream-engine.ts` 的
   * `origin: cmd.origin`),外发路由靠它回到正确的渠道。助手那条不经翻译器
   * (它在 surface 上的那一格就是这条 `run/start`),所以它只能住在这里 ——
   * 从触发消息上"推"是错的:输入被插件改写过时,用户消息那份多一枚
   * `inputTransformed` 戳,而助手那份没有。
   */
  origin?: Record<string, unknown>
  /**
   * 这次 run **接着**哪一次 run 的执行往下跑(§10.12 第 5 类)。
   *
   * "一条 assistant 消息 = 一次 run"(§10.7 口径 1)是投影的前提,而引擎那边的
   * **一次执行**可以跨两条消息:steering 打断时 `response-boundary` 换助手消息、
   * `rotateSessionRun` 换 run,但 agent-loop 的**回合计数器与用量累加器一格都不
   * 重置** —— 新消息的第一段推理是 `turnIndex 2`(所以是 `inline` 落点,不是
   * `top`),整次执行的 usage 最后落在**接手的那条消息**上,被打断的那条一格都
   * 没有。
   *
   * 只有 `rotateSessionRun` 填这一格。没有它,投影只能按"每个 run 从第 1 轮数起"
   * 猜,于是 steering 之后每一条消息的推理落点、turnIndex 与 usage 三样全错
   * (真机第四批 17 行不等的唯一病根)。
   */
  continuesRunId?: string
  /**
   * 助手占位消息上的 `ChatMessage.source`(§13.9,与 A4 的 `agentId` 同一个产地)。
   *
   * `stampCollabAgentId`(`app/stores/sessions.ts`)在 `addMessage` 那一刻同时盖
   * **两**格:`agentId` 与 `source: 'collab-turn'`(room / agent 形态的会话)。
   * A4 只把前一格接进了账本,于是 agent 执行会话每条助手消息在投影里都少一格
   * (真机 `agent-exec-…` 的 `1.source` a=collab-turn b=(absent))。
   *
   * 名字不叫 `source`:`run/start` 上已经有一格 `origin`,而它自己也有一个
   * `origin.source`(入站渠道)—— 那是两件事,一格是"从哪条渠道来的",这格是
   * "这条消息是不是一次协作回合的思考记录"。
   *
   * **成对交付**(§10.16):老文件没有这一格 → 缺席仍是缺席,不猜。
   */
  messageSource?: string
  /**
   * **这次开张顺手创建了那条助手占位消息**(§17.7.1 批 2 裁定 1)。
   *
   * 流式助手占位是命令面**唯一不写事件**的一档(§9.3:它在 surface 上的那一格
   * 就是这条 `run/start`)。可老 reducer 在那次 `appendMessage` 上照样盖了会话账
   * 的三格(`updatedAt` / `lastProvider` / `lastModel`),于是会话账要折出来,
   * 这条 `run/start` 就得说清楚**它是不是那次入库的那一格**。
   *
   * 只有 `openAssistantRun`(与 `store.addMessage` 同一同步段,c4-d)带它;
   * 绕过创建点的那条路(确认后恢复 / 单测直调)在 `executeMessageStream` 里
   * 以 `started:true` 开张的 `run/start` **不带** —— 那条路上没有 `addMessage`,
   * reducer 一格都没盖。写者亲知的事实,不是折叠时"看节点存不存在"的推断
   * (§13.8 的取向)。
   *
   * **成对交付**(§10.16):老账本没有这一格 → 不盖章,与那些行当年的行为一致
   * (它们对应时段的盖章早已物化在 `meta.json` 里)。
   */
  createdAssistantMessage?: boolean
}

export interface SessionRunEndEventData {
  runId: string
  outcome: 'completed' | 'aborted' | 'error' | 'interrupted'
  error?: { name?: string; message: string }
}

// ============ 请求 ============

export interface SessionRequestRecipeEventData {
  runId: string
  requestIndex: number
  systemPromptHash: string
  toolsHash: string
  /** 这次请求发出去的历史,按 surface 节点的 eventSeq + 内容指纹。 */
  messages: Array<{ eventSeq: number; contentHash: string }>
  params?: Record<string, unknown>
}

/** 响应用量。比 `request/end` 的那份多两格(总数与推理 token)。 */
export interface SessionResponseUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /**
   * 批 P-a(§15.3):厂商在响应里报的**本次请求成本**(USD;OpenRouter
   * `usage.cost`、xAI `cost_in_usd_ticks / 1e10`)。引擎把它原样带在
   * `lastTurnUsage` 上写进 `steps[].usage`,所以事件面必须收 —— 少收一格
   * 就是"store 有、投影缺",每个带成本读数的 run 记一条影子失配。
   *
   * 只落 **step** 那一格:消息级 `usage` 是引擎累加器的产物
   * (`agent-loop-executor.ts` 的 `accumulatedUsage`,两个分支都逐字段列名),
   * 它从来不带成本 —— 投影侧的 `addUsage` 照抄这一条。
   */
  providerCostUSD?: number
}

export interface SessionRequestResponseEventData {
  runId: string
  requestIndex: number
  messageId: string
  providerResponseId?: string
  responseModel?: string
  finishReason?: string
  usage?: SessionResponseUsage
  /** 各 part 的**指纹**,不是正文。正文唯一来源是 `assistant/chunks`。 */
  parts?: Array<{ partIndex: number; kind: SessionAssistantPartKind; len: number; hash?: string }>
  toolCallIds?: string[]
  /**
   * §13.9:上面那份 `usage` 被引擎记到**哪个回合**的 step 上。
   *
   * 引擎那一行是 `updateStepsUsageByTurn(state.turnIndex, plan.lastTurnUsage)` ——
   * 在 finish chunk 上、**推进回合号之前**跑的。普通 provider 上它就是这次请求
   * 的回合号(投影从前按 `requestIndex` 推,答案相同);外部执行器那条路上,
   * 带 usage 的那条 finish 是**最后**一条(轮分界那几条不带 usage),于是用量落
   * 在最后一个回合上,而第一个回合的工具 step **一格 usage 都没有** ——
   * 真机 `web-14d8bc3f` 的 `1.steps.0.usage` a=(absent) b={…}。
   *
   * **成对交付**(§10.16):老文件没有这一格 → 退回按 `requestIndex` 推。
   */
  usageTurnIndex?: number
}

export interface SessionRequestErrorEventData {
  runId: string
  requestIndex: number
  error: { name?: string; message: string; status?: number }
  willRetry: boolean
  attempt: number
}

// ============ 助手 ============

/**
 * 助手输出的分段种类。
 *
 * `provider-data`(A1,§13.1)是**引擎自己就在产的那一格**:Claude 的 thinking
 * 签名块、codex 的加密推理都由 `applyAgentLoopProviderDataWithAdapters` 落成
 * `contentParts` 里的 `{type:'provider-data', providerData, turnIndex}`。它同时
 * 是一条**分段边界** —— `appendOrderedPart` 只合并相邻同类,一段 provider-data
 * 夹在两段正文之间就把它们切成两格。词汇里没有它的时候,采集点把两段正文攒成
 * 一段,投影因此永远比事实少一格。
 *
 * 它没有 delta(`assistant/chunks` 里不会出现这个 kind):载荷是一个结构化对象,
 * 一次到齐,所以只有 `assistant/part-end` 那一条带 `providerData`。
 */
export type SessionAssistantPartKind = 'text' | 'reasoning' | 'tool-input' | 'image' | 'provider-data'

/** 有 delta 的那几种 —— `assistant/chunks` 只认它们。 */
export type SessionAssistantDeltaPartKind = Exclude<SessionAssistantPartKind, 'image' | 'provider-data'>

/**
 * 一批 delta(§9.2 助手行)。**一行就是一个事件** —— dsh 那边打包行要在逻辑层
 * 展开成 N 个事件(它有 `events[i].seq === i` 的连续契约),我们不需要:
 * 一条 delta 的身份 = `(eventSeq, index)`。
 *
 * `dt[i]` 是相对 `time0` 的毫秒,`text[i]` 是那一条 delta 的原文,两个数组等长。
 */
export interface SessionAssistantChunksEventData {
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: SessionAssistantDeltaPartKind
  toolCallId?: string
  /**
   * `tool-input` part 的工具名(provider 的 `tool-call-start` 那一格)。
   *
   * 有它才说得出"参数流到一半被打断"的那次调用**是谁**:`tool/call` 永远不会
   * 来,而引擎的占位卡从第一帧起就带着名字(§10.14 第 7 类)。
   */
  toolName?: string
  time0: number
  dt: number[]
  text: string[]
  /**
   * §13.9:开这一段时引擎的回合号(`state.turnIndex`)。理由见
   * `SessionAssistantPartEndEventData.turnIndex`。
   */
  turnIndex?: number
}

export interface SessionAssistantPartEndEventData {
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: SessionAssistantPartKind
  len: number
  hash?: string
  toolCallId?: string
  /** 同 `assistant/chunks`:`tool-input` part 的工具名。 */
  toolName?: string
  /** 图片 part:正文在 blob 里,事件行只有引用。 */
  blob?: BlobRef
  /**
   * R-b(§13.6):这一格是引擎**直接落到消息上**的,不是模型某一轮的产出。
   *
   * 今天唯一的产地是生图那条特化流:正文(一段带 data URL 的 markdown)一写
   * 就落在消息上,既没有 `turn-end`(所以不受"这一轮收齐了吗"那道闸管),
   * 也没有回合号(消息上那一格就没有 `turnIndex`,投影不许凭空补一个)。
   *
   * **成对交付**(§10.16):老文件没有这一格 = 照旧按闸判、照旧派生 turnIndex。
   */
  synthetic?: boolean
  /**
   * 这段正文只落在 `message.content` 上,引擎**没有**给它建 contentPart
   * (§13.8 第二类)。
   *
   * 产地是生图的**失败分支**:成功那条路写两格(`updateMessageContent` +
   * `addMessageContentPart`),失败那条路只写 `content`(一句"图片生成失败:
   * …")。两条路都要进账本 —— 不然投影那条消息的正文整段缺席 —— 但形状不同,
   * 所以由这一格说清楚:`content` 的 fold 收它,`contentParts` 不收它。
   *
   * **成对交付**(§10.16):老文件没有这一格 = 照旧两格都产出(修复前写进
   * 账本的合成正文只有生图成功那一种,它本来就有 contentPart)。
   */
  contentOnly?: boolean
  /**
   * `provider-data` part 的载荷(A1,§13.1)。
   *
   * 与工具结局同一条 64KB 线:小的进事件行(`{text}` = 那个对象的 JSON),
   * 大的走 blob。真机上这一格的分布是 p50 1.2KB / p99 12KB / max 37KB
   * (410 个会话的实测),所以 blob 那一支是**上限保护**,不是常态。
   *
   * 为什么不是"正文的第二个来源":它不是模型说的话,是 provider 让我们
   * **原样带回**的一块不透明数据(思考签名 / 加密推理)。`assistant/chunks`
   * 承载不了它(没有 delta,也不该被 fold 成文本)。
   */
  providerData?: { text: string } | { blob: BlobRef }
  /**
   * §13.9:开这一段时引擎的回合号(`state.turnIndex`)。
   *
   * `contentParts[].turnIndex` 就是它 —— 引擎在**消费 chunk 的那一刻**盖的章
   * (`applyAgentLoopTextChunkWithAdapters` 的 `turnIndex: state.turnIndex`)。
   * 投影从前只能按 `requestIndex` 推,而**外部执行器**(Claude Code SDK 连接器)
   * 一次请求里会发好几条 `finish(tool_calls)` 当轮分界:引擎的回合号跟着涨,
   * 账本上的 `requestIndex` 一动不动,于是工具之后那几段正文的回合号全部少 1
   * (真机 `web-14d8bc3f` 的 `1.contentParts.*.turnIndex` a=2 b=1)。
   *
   * 回合号决定的不只是这一格:`turnIndex !== 1` 是"开头那段推理算不算 top"的判据,
   * 而模型历史按它把一条消息拆成 assistant/tool 交替段(`buildHistoryMessages`)。
   *
   * **成对交付**(§10.16):老文件没有这一格 → 退回按 `requestIndex` 推
   * (= 修复前的行为,普通 provider 上两者恒等)。
   */
  turnIndex?: number
}

/**
 * G5(§10.1):技能被激活。今天它是一条**流事件**(`skill:activated`,
 * `core/engine/event-only-emitter.ts`),只在内存里活到 renderer 把
 * `message.skillUsed` 写上为止 —— 重载后那一格从消息字段里读回来,而事件账本
 * 上没有任何痕迹。这里给它一条自己的账:`skillUsed` 因此是派生的,不是补丁。
 */
export interface SessionSkillActivatedEventData {
  runId?: string
  messageId: string
  skill: string
}

// ============ 权限 / 交互 ============

export interface SessionPermissionAskedEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  toolName?: string
}

export interface SessionPermissionAnsweredEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  approved: boolean
  scope?: string
  reason?: string
}

export interface SessionInteractionAskedEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  kind?: string
}

export interface SessionInteractionAnsweredEventData {
  requestId: string
  runId?: string
  toolCallId?: string
  /** 决定,不是正文:自由文本答复走 `answerText`,长答复走 blob(S1)。 */
  answer?: string
  cancelled?: boolean
}

// ============ 上下文 / 插件 ============

/** 取代 `ChatMessage.turnContext` 字段(§9.2)。 */
export interface SessionContextTurnUpdateEventData {
  /** 这次尾块挂在哪条(最新的)用户消息上。 */
  messageId: string
  set?: Record<string, string>
  removed?: string[]
}

export interface SessionPluginStatusEventData {
  pluginId: string
  id: string
  label: string
  cleared?: boolean
  runId?: string
  startedAt?: number
  durationMs?: number
}

// ============ 联合 ============

/** Utility model calls do not create chat messages or consume assistant request indices. */
export interface SessionAuxiliaryModelIntentData {
  actionId: string
  purpose: 'title' | 'compact-chunk' | 'compact-merge' | 'toc'
  provider: string
  model: string
  input: { text: string } | { blob: BlobRef }
  params?: Record<string, unknown>
}
export interface SessionAuxiliaryModelResultData {
  actionId: string
  outcome: 'completed' | 'error'
  outputHash?: string
  outputBytes?: number
  error?: { name?: string; message: string }
}
export type SessionAuxiliaryModelIntentEvent = SessionEventRecordShape<'auxiliary-model/intent', SessionAuxiliaryModelIntentData>
export type SessionAuxiliaryModelResultEvent = SessionEventRecordShape<'auxiliary-model/result', SessionAuxiliaryModelResultData>

/** External actions keep their complete wire payload in the session's durable blob closure. */
export interface SessionExternalExecutionData {
  executionId: string
  actionId: string
  parentActionId?: string
  kind: 'model' | 'tool'
  phase: 'before' | 'after'
  payloadHash: string
  payload: { text: string } | { blob: BlobRef }
}
export type SessionExternalExecutionEvent = SessionEventRecordShape<'external/execution', SessionExternalExecutionData>

export type SessionRequestToolsEvent = SessionEventRecordShape<'request/tools', SessionRequestToolsEventData>
export type SessionRequestHeaderEvent = SessionEventRecordShape<'request/header', SessionRequestHeaderEventData>
export type SessionRequestStartEvent = SessionEventRecordShape<'request/start', SessionRequestStartEventData>
export type SessionAssistantFirstTokenEvent = SessionEventRecordShape<'assistant/first-token', SessionAssistantFirstTokenEventData>
export type SessionToolCallEvent = SessionEventRecordShape<'tool/call', SessionToolCallEventData>
export type SessionToolResultEvent = SessionEventRecordShape<'tool/result', SessionToolResultEventData>
export type SessionToolAnnotateEvent = SessionEventRecordShape<'tool/annotate', SessionToolAnnotateEventData>
export type SessionToolAuditEvent = SessionEventRecordShape<'tool/audit', SessionToolAuditEventData>
export type SessionRequestEndEvent = SessionEventRecordShape<'request/end', SessionRequestEndEventData>

export type SessionCreatedEvent = SessionEventRecordShape<'session/created', SessionCreatedEventData>
export type SessionAgentChangedEvent = SessionEventRecordShape<'session/agent-changed', SessionAgentChangedEventData>
export type SessionModelChangedEvent = SessionEventRecordShape<'session/model-changed', SessionModelChangedEventData>
export type SessionWorkdirChangedEvent = SessionEventRecordShape<'session/workdir-changed', SessionWorkdirChangedEventData>
export type SessionCompactedEvent = SessionEventRecordShape<'session/compacted', SessionCompactedEventData>
export type SessionClearedEvent = SessionEventRecordShape<'session/cleared', SessionClearedEventData>

export type SessionUserMessageEvent = SessionEventRecordShape<'user/message', SessionUserMessageEventData>
export type SessionSystemMessageEvent = SessionEventRecordShape<'system/message', SessionSystemMessageEventData>
export type SessionUserMessageEditedEvent = SessionEventRecordShape<'user/message-edited', SessionUserMessageEditedEventData>
export type SessionMessageDeletedEvent = SessionEventRecordShape<'message/deleted', SessionMessageDeletedEventData>
export type SessionMessagePatchedEvent = SessionEventRecordShape<'message/patched', SessionMessagePatchedEventData>
export type SessionMessageImportedEvent = SessionEventRecordShape<'message/imported', SessionMessageImportedEventData>

export type SessionRunStartEvent = SessionEventRecordShape<'run/start', SessionRunStartEventData>
export type SessionRunEndEvent = SessionEventRecordShape<'run/end', SessionRunEndEventData>

export type SessionRequestRecipeEvent = SessionEventRecordShape<'request/recipe', SessionRequestRecipeEventData>
export type SessionRequestResponseEvent = SessionEventRecordShape<'request/response', SessionRequestResponseEventData>
export type SessionRequestErrorEvent = SessionEventRecordShape<'request/error', SessionRequestErrorEventData>

export type SessionAssistantChunksEvent = SessionEventRecordShape<'assistant/chunks', SessionAssistantChunksEventData>
export type SessionAssistantPartEndEvent = SessionEventRecordShape<'assistant/part-end', SessionAssistantPartEndEventData>
export type SessionSkillActivatedEvent = SessionEventRecordShape<'skill/activated', SessionSkillActivatedEventData>

export type SessionPermissionAskedEvent = SessionEventRecordShape<'permission/asked', SessionPermissionAskedEventData>
export type SessionPermissionAnsweredEvent = SessionEventRecordShape<'permission/answered', SessionPermissionAnsweredEventData>
export type SessionInteractionAskedEvent = SessionEventRecordShape<'interaction/asked', SessionInteractionAskedEventData>
export type SessionInteractionAnsweredEvent = SessionEventRecordShape<'interaction/answered', SessionInteractionAnsweredEventData>

export type SessionContextTurnUpdateEvent = SessionEventRecordShape<'context/turn-update', SessionContextTurnUpdateEventData>
export type SessionPluginStatusEvent = SessionEventRecordShape<'plugin/status', SessionPluginStatusEventData>

/** E0 的七类 —— 盘上已有的文件只含这些,读侧永远要认得它们。 */
export type SessionLegacyEventRecord =
  | SessionRequestToolsEvent
  | SessionRequestHeaderEvent
  | SessionRequestStartEvent
  | SessionAssistantFirstTokenEvent
  | SessionToolCallEvent
  | SessionToolResultEvent
  | SessionToolAuditEvent
  | SessionRequestEndEvent

export type SessionLogEventRecord =
  | SessionLegacyEventRecord
  | SessionAuxiliaryModelIntentEvent
  | SessionAuxiliaryModelResultEvent
  | SessionExternalExecutionEvent
  | SessionCreatedEvent
  | SessionAgentChangedEvent
  | SessionModelChangedEvent
  | SessionWorkdirChangedEvent
  | SessionCompactedEvent
  | SessionClearedEvent
  | SessionUserMessageEvent
  | SessionSystemMessageEvent
  | SessionUserMessageEditedEvent
  | SessionMessageDeletedEvent
  | SessionMessagePatchedEvent
  | SessionMessageImportedEvent
  | SessionRunStartEvent
  | SessionRunEndEvent
  | SessionRequestRecipeEvent
  | SessionRequestResponseEvent
  | SessionRequestErrorEvent
  | SessionAssistantChunksEvent
  | SessionAssistantPartEndEvent
  | SessionSkillActivatedEvent
  | SessionPermissionAskedEvent
  | SessionPermissionAnsweredEvent
  | SessionInteractionAskedEvent
  | SessionInteractionAnsweredEvent
  | SessionContextTurnUpdateEvent
  | SessionPluginStatusEvent
  | SessionToolAnnotateEvent

export type SessionLogEventType = SessionLogEventRecord['type']

export type SessionLogEventDataFor<TType extends SessionLogEventType> =
  Extract<SessionLogEventRecord, { type: TType }>['data']

/** 七类的 type 元组 —— 盘上老文件的全集,顺序即当年的定义顺序。 */
export const SESSION_LEGACY_EVENT_TYPES = [
  'request/tools',
  'request/header',
  'request/start',
  'assistant/first-token',
  'tool/call',
  'tool/result',
  'tool/audit',
  'request/end',
] as const satisfies readonly SessionLegacyEventRecord['type'][]

/**
 * v2 全集。**加一个类型 = 加一行 + 过下面的双向穷尽守卫**,
 * 与 `COLLAB_SCHEDULER_LOG_TABLE_IS_EXHAUSTIVE` 同一套纪律。
 */
export const SESSION_LOG_EVENT_TYPES = [
  ...SESSION_LEGACY_EVENT_TYPES,
  'auxiliary-model/intent',
  'auxiliary-model/result',
  'external/execution',
  'session/created',
  'session/agent-changed',
  'session/model-changed',
  'session/workdir-changed',
  'session/compacted',
  'session/cleared',
  'user/message',
  'system/message',
  'user/message-edited',
  'message/deleted',
  'message/patched',
  'message/imported',
  'run/start',
  'run/end',
  'request/recipe',
  'request/response',
  'request/error',
  'assistant/chunks',
  'assistant/part-end',
  'skill/activated',
  'permission/asked',
  'permission/answered',
  'interaction/asked',
  'interaction/answered',
  'context/turn-update',
  'plugin/status',
  'tool/annotate',
] as const satisfies readonly SessionLogEventType[]

/** 双向穷尽守卫:表里少一个 → 红;表里多一个(打错字)→ 红。 */
type SessionEventTableMissing = Exclude<SessionLogEventType, (typeof SESSION_LOG_EVENT_TYPES)[number]>
type SessionEventTableStray = Exclude<(typeof SESSION_LOG_EVENT_TYPES)[number], SessionLogEventType>
export const SESSION_LOG_EVENT_TABLE_IS_EXHAUSTIVE: [SessionEventTableMissing] extends [never]
  ? [SessionEventTableStray] extends [never]
    ? true
    : never
  : never = true

// ============ 类型级门:正文只住在四个地方 ============

/**
 * **响应正文永远不进 surface 事件的 data**(§9.2 助手行的那句"不再存第二份文本")。
 *
 * 允许携带整条消息正文的只有四类:`user/message`、`system/message`、
 * `user/message-edited`、`message/imported` —— 它们记的是**人写的东西**,
 * 那本来就是一条完整消息。模型说的话只有一个来源:`assistant/chunks` 的 fold。
 *
 * 门的形状:在"surface 事件减去这四类"的联合上做分配式 `keyof`,与一张禁用
 * 字段名表求交。哪天有人往 `run/start` 上加 `content`、往 `request/response`
 * 上加回 `text`,这一行当场红 —— 而那种重复在测试里很难看见(账写得出来、
 * 读得回来,只是同一段话存了两份,§7.2 M2 的三处重复正是这么来的)。
 */
type SessionSurfaceEventRecord = Extract<
  SessionLogEventRecord,
  { type: 'user/message' | 'system/message' | 'user/message-edited' | 'message/imported'
    | 'message/deleted' | 'session/compacted' | 'session/cleared' | 'run/start' | 'tool/result' }
>
type SessionBodyBearingEventType =
  | 'user/message'
  | 'system/message'
  | 'user/message-edited'
  | 'message/imported'
type SessionBodylessSurfaceEvent = Exclude<
  SessionSurfaceEventRecord,
  { type: SessionBodyBearingEventType }
>
type SessionEventAllKeys<T> = T extends unknown ? keyof T : never
type SessionEventForbiddenBodyKey =
  | 'message'
  | 'messages'
  | 'content'
  | 'contentParts'
  | 'reasoning'
type SessionEventLeakedBodyKey = Extract<
  SessionEventAllKeys<SessionBodylessSurfaceEvent['data']>,
  SessionEventForbiddenBodyKey
>
export const SESSION_SURFACE_EVENTS_CARRY_NO_MESSAGE_BODY: [SessionEventLeakedBodyKey] extends [never]
  ? true
  : never = true

// ============ surface 分类表 ============

/**
 * 哪些类型会在 surface 上**成为一个节点**(模型可见历史里的一格)。
 *
 * `message/deleted` / `session/cleared` 带 replace op 但不是节点(纯遮蔽);
 * `tool/result` 是节点但**不单独物化**成一条历史消息 —— 它折进所属 run 的那条
 * assistant 消息里(今天 `buildHistoryMessages` 就是 assistant+tool 成对发的)。
 * 它在 surface 上占一格,是为了将来"工具结果剪枝"能用同一个 replace 机制表达。
 */
export const SESSION_SURFACE_NODE_TYPES = [
  'user/message',
  'system/message',
  'user/message-edited',
  'message/imported',
  'run/start',
  'tool/result',
  'session/compacted',
] as const

export type SessionSurfaceNodeType = (typeof SESSION_SURFACE_NODE_TYPES)[number]

export function isSessionSurfaceNodeType(type: string): type is SessionSurfaceNodeType {
  return (SESSION_SURFACE_NODE_TYPES as readonly string[]).includes(type)
}
