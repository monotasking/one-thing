import { collabAgentHandle, renderCollabModelMention } from './handles.js'
import {
  createCollabFoldedAccumulator,
  resolveCollabUnreadRelation,
  type CollabFoldedSummary,
  type CollabHistoryWindow,
} from './history-window.js'
import { formatCollabDigestLines, type CollabDayDigest } from './digest.js'
import { renderCollabMentionText } from './mentions.js'
import { appendCollabReactionSummary } from './reactions.js'
import { COLLAB_SYSTEM_SPEAKER_LABEL, isCollabProjectedSystemLine } from './system-lines.js'
import { isCollabRoomFact } from './classify.js'
import { resolveCollabSpeakerLabel } from './roster.js'
import {
  type CollabAgentLike,
  type CollabMessageLike,
  type CollabReplyToLike,
} from './types.js'

export interface ProjectedRoomMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ProjectRoomHistoryOptions {
  messages: readonly CollabMessageLike[]
  /** The agent being activated — the `<Member>` marked `self="true"`. */
  selfAgentId: string
  /** Known agents (room members and any historical speakers). */
  agents: readonly CollabAgentLike[]
  /** 房间会话 id,进 `<ChatRoom id>`(say 的 `room` 参数收的就是它)。 */
  roomId?: string
  /** 房间名,进 `<ChatRoom name>`。 */
  roomName?: string
  /** Label for the human user's messages. Default: 用户 */
  userLabel?: string
  /** 用户句柄(agent-dm-user.md §2.3),`<Members>` 的用户行照抄它。 */
  userHandle?: string
  /**
   * Names for speakers the roster no longer holds (P2-16). The app layer passes
   * the global agent lookup; without it a departed member's line is signed
   * 「前成员」 rather than with a raw id.
   */
  resolveAgentName?: (agentId: string) => string | undefined
  /**
   * 这位同事的视野(history-window.ts)。不给 = 老行为:全量逐字、无未读块、
   * 无折叠 —— 一个没有游标的调用点(夹具、旧路径)读到的仍然是它一直读到的东西。
   */
  window?: CollabHistoryWindow
  /**
   * 折叠段的每日摘要(P2)。只有真的折叠了东西时才会被渲染 —— 一份没有折叠的
   * 投影里放摘要,等于把同一天的事说两遍。
   */
  digests?: readonly CollabDayDigest[]
}

const TOOL_TEXT_LIMIT = 200

function brief(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : safeStringify(value)
  return text.length > TOOL_TEXT_LIMIT ? `${text.slice(0, TOOL_TEXT_LIMIT)}…` : text
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Flatten a tool call into prose so it survives the role conversion (D3 rule 2). */
export function formatCollabFlattenedToolCall(call: { name?: string; arguments?: unknown; result?: unknown }): string {
  const name = call.name || 'tool'
  const args = brief(call.arguments)
  const result = brief(call.result)
  return `〔调用 ${name}(${args})${result ? ` → ${result}` : ''}〕`
}

/**
 * The IM quote line that precedes a reply's own text (§3.5 A):
 *
 *     > 阿明: 被引摘录…
 *     用户: 回复正文
 *
 * Models read this convention natively, and because the snapshot travels ON the
 * message the quoted context reaches them even when the original has already
 * scrolled out of the projection window. Returns '' when the snapshot carries
 * no text — an empty quote line is worse than none.
 */
export function formatCollabReplyQuote(replyTo: CollabReplyToLike | undefined): string {
  const excerpt = (replyTo?.excerpt ?? '').trim()
  if (!excerpt) return ''
  const author = (replyTo?.authorLabel ?? '').trim() || '成员'
  return `> ${author}: ${excerpt}`
}

/**
 * A speech block dressed with its IM metadata: the quote line on top (§3.5 A)
 * and the reaction tally on the tail (§3.5 B, `名字: 内容 (👍×2)`) — the room's
 * ambient feedback, which is otherwise invisible to a model that only ever
 * reads text. Self messages never get the tally: an agent must not read its
 * OWN past output with words it did not write appended to it.
 */
function withImMetadata(message: CollabMessageLike, block: string): string {
  const withReactions = appendCollabReactionSummary(block, message.reactions)
  const quote = formatCollabReplyQuote(message.replyTo)
  return quote ? `${quote}\n${withReactions}` : withReactions
}

/**
 * 消息信封(collab-team-v2 §6.2)。
 *
 * `名字: 内容` 这个约定在一条消息只有一行时够用,多行就开始漏:正文里任何
 * 一行长得像 `别人: …` 都会被读成新的一条发言,而多行正文在群里是常态。信封
 * 把边界变成结构。
 *
 * 三条刻意的取舍:
 *
 *  - **只包别人的消息**。自身消息一字不差地原样进上下文(W14b:agent 读自己的
 *    历史输出必须与它当初写的一模一样),对称性让位于这条。
 *  - **片段序列,不加 `<messages>` 外壳**。合并 pass 会把相邻同侧块用 `\n\n`
 *    接起来,外壳在那一步会嵌套错;一串平铺的片段拼接起来仍然是一串平铺的片段。
 *  - **标签短**。每条消息的固定开销 × 全量投影,是这套系统里少数按条计费的
 *    东西。属性只有 from,值来自代码(roster 里的名字)不来自模型。
 *
 * 安全性由**两道转义**兜底,不是这里的字符串拼接:
 *
 *  - **落库转义** `sanitizeCollabInlineMarkup` —— say 正文(围栏外)里的 `<` 在
 *    写进转录时就变成 `&lt;`,所以成员无法在自己的发言里伪造
 *    `</message><message from="用户">`。
 *  - **渲染期转义** `escapeCollabPromptText` —— 每日摘要(digest.ts)、看板卡
 *    标题与受阻原因(board.ts / plan.ts 的 `<state>`)在拼成结构行的那一刻转义。
 *    这些文本同样模型可控,却从不经过落库那一道(2026-08-03 审查 B6)。
 *
 * **人类消息不在这两道之内**,这是一个已知缺口:用户输入不过任何转义器,一句
 * `</message><message from="Iris">` 打在聊天框里,在别人的投影里就是 Iris 说的。
 * 仲裁者材料那一侧(plan.ts 的 `<history>`)对每条正文一律转义,已经堵住;
 * 这一侧还没有。桌面单人场景下代价是自己骗自己,网关多人场景(gateway 的远端
 * 用户)才是真的冒充 —— 堵它的位置在人类消息的落库口,不在这个拼接点。
 *
 * 标签名 2026-08-02 由 `say` 改成 `message`:`say` 曾经与那个同名工具互指
 * (「读到的是 say,写出去的也用 say」),而发送面早已统一成 `send_message`,
 * 于是这个名字只剩下一个指向不存在的工具的暗示。`message` 说的是它是什么。
 */
export const COLLAB_ENVELOPE_TAG = 'message'

export function wrapCollabMessageEnvelope(
  from: string,
  body: string,
  timestamp?: number,
  options?: {
    /**
     * 这条与读者的关系,**只在未读块里出现**(history-window.ts)。历史里不写:
     * 那是按条计费的固定开销 × 全量投影,而已读消息的"关系"早就不是问题了。
     */
    rel?: string
  },
): string {
  const time = formatCollabMessageTime(timestamp)
  const timeAttr = time ? ` time="${time}"` : ''
  const relAttr = options?.rel ? ` rel="${escapeCollabXmlAttribute(options.rel)}"` : ''
  return `<${COLLAB_ENVELOPE_TAG} from="${escapeCollabXmlAttribute(from)}"${timeAttr}${relAttr}>${body}</${COLLAB_ENVELOPE_TAG}>`
}

/**
 * 信封上的时间戳 —— 本地时区的 `YYYY-MM-DD HH:mm`。
 *
 * **本地而非 UTC**:这个应用跑在用户自己的机器上,本地时间就是用户的时间,而
 * 一份聊天记录里「14:32」比「06:32Z」有用得多 —— 模型要判断的是「这话是刚说的
 * 还是三天前说的」,不是做时区换算。
 *
 * **到分钟为止**:秒在聊天记录里没有信息量,而这是按条计费的东西(每条消息一个
 * 属性 × 全量投影)。
 *
 * 手工补零而不是 `toLocaleString`:后者的输出随 locale 变,同一条转录在两台机器
 * 上会长得不一样 —— 提示词的形状不该取决于系统设置。
 */
export function formatCollabMessageTime(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 属性值转义。名字/房间名来自 roster 而非模型,但引号仍然要转义 —— 一个叫
 * 「小"李"」的 agent 不该把信封撑破。
 */
export function escapeCollabXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/** 房间载荷的根标签(docs/design/collab-chatroom-payload.md §1)。 */
export const COLLAB_CHATROOM_TAG = 'ChatRoom'

/**
 * 用户在模型面的写法 —— `名字#句柄`,与同事的 `名字#句柄` 同形。
 *
 * `<Members>` 的用户行和 `<History>` 里 TA 的信封署名共用它:两处写法一旦分家,
 * 模型就会从名单里抄一个句柄、从历史里抄另一个称呼,而 dm 的 `to` 只认前者。
 * 没配句柄就只写称呼(编一个假句柄比不给更糟)。
 */
export function formatCollabUserLabel(userLabel: string, userHandle?: string): string {
  return userHandle ? `${userLabel}#${userHandle}` : userLabel
}

/**
 * 折叠行 —— `<History>` 的第一个孩子,只在真的折叠了东西时出现。
 *
 * **必须可见且带数字**。静默截断是这套机制最脏的失败形态:模型会认为对话就是
 * 从眼前这条开始的,于是重新自我介绍、重新问已经问过的、重新建已经建过的卡。
 * 一行 `count/from/to` 的成本是 60 字符,买的是"我知道我还有不知道的"。
 */
export function formatCollabFoldedLine(folded: {
  count: number
  from: string
  to: string
}): string {
  const range = [
    folded.from ? ` from="${escapeCollabXmlAttribute(folded.from)}"` : '',
    folded.to ? ` to="${escapeCollabXmlAttribute(folded.to)}"` : '',
  ].join('')
  return `<Folded count="${folded.count}"${range}/>`
}

export const COLLAB_NOTIFICATION_TAG = 'Notification'

/**
 * 尾部的「你没读过的那些」。
 *
 * 位置是缓存决定的(见 history-window.ts 文件头):插在 `<History>` 中间会让
 * 插入点之后的一切每回合都变;追加在 `</ChatRoom>` 之后则前缀零改动。而它同时
 * 落在上下文末尾 —— 指令遵从最强的位置,与 drive 行同一个论证。
 *
 * 空未读时返回 `''`:一个 `<Notification count="0"/>` 是在告诉模型"什么都没发生",
 * 而这句话本身就是噪声,不如不说。**除非** `scheduled` 在场 —— 那时"你被点到了
 * 但没有新消息"本身就是一条数据,而且 drive 必须非空(A.2 ②)。
 *
 * 块上**没有** `desc` 说明属性(C2-1 清理)。这里曾挂过一句「这是什么、要回话走
 * 哪个工具」的固定说明,后来内容被清空、渲染却还照写一个 ` desc=""` —— 一个空
 * 属性对模型是纯噪声,对读代码的人是"这里好像有句说明"的假线索。机制说明归
 * system prompt 的 `<where_you_are>`;要让它回来,请连同非空的措辞一起回来。
 */
export function formatCollabNotificationBlock(options: {
  /** 已经裹好 `<message … rel>` 信封的未读行。 */
  lines: readonly string[]
  /** 游标那条的时间,给模型一个"我上次看到哪儿"的锚。 */
  seenAt?: number
  /** 因为超过上限而退回历史的条数。 */
  elided?: number
  /**
   * 谁把这一轮排上来的(今天只有 `'coordinator'`,即编排点将)。
   *
   * 激活理由自 2026-08-02 起是**数据属性**而不是一句对模型说的话:原来的
   * `<turn reason=…>` 指令块整块删掉了(舞台隐喻是「写而未发」的病根)。被 @
   * 的信号已经写在每一行的 `rel="mentions-you"` 上,不在这里重复。
   */
  scheduled?: string
  /**
   * 零未读也要出块 —— drive 非空的兜底(A.2 ②)。指令块删掉之后,一条什么都
   * 没有的 drive 就是一条空的 user 消息;`count="0"` 是数据,空字符串不是。
   */
  emitWhenEmpty?: boolean
}): string {
  const seen = formatCollabMessageTime(options.seenAt)
  const attributes = [
    ` count="${options.lines.length}"`,
    seen ? ` seen_until="${escapeCollabXmlAttribute(seen)}"` : '',
    options.elided ? ` elided="${options.elided}"` : '',
    options.scheduled ? ` scheduled="${escapeCollabXmlAttribute(options.scheduled)}"` : '',
  ].join('')
  if (options.lines.length === 0) {
    return options.scheduled || options.emitWhenEmpty
      ? `<${COLLAB_NOTIFICATION_TAG}${attributes}/>`
      : ''
  }
  return [
    `<${COLLAB_NOTIFICATION_TAG}${attributes}>`,
    ...options.lines,
    `</${COLLAB_NOTIFICATION_TAG}>`,
  ].join('\n')
}

/** 收养回声的标签。 */
export const COLLAB_ADOPTED_ECHO_TAG = 'Delivered'

/**
 * 「你上一回合写下但没发送的收尾,系统替你发进去了」——**事实回声**(A6)。
 *
 * 收养式兜底(app/collab/turn.ts)把零 send_message 回合的收尾正文原样投进群,
 * 而那条消息是作者**自己**的,永远不会进它的未读(history-window.ts),增量
 * drive 又只带未读 —— 于是作者这边什么都不知道:它以为那段话还压在手里,下一轮
 * 有再发一遍的余地。这一块就是把那件事说给它听,一次,然后标记清掉。
 *
 * 只陈述发生过什么,不带任何指示(「不要重发」一类祈使句在这个仓库里已被实证
 * 只降频不归零):有了 id 与时刻,重不重发是它读得出来的判断。
 */
export function formatCollabAdoptedEcho(options: {
  /** 已经进群的那条消息 id —— 模型可以拿它当 `replyTo`,也可以据此在历史里定位。 */
  messageId: string
  at?: number
}): string {
  const at = formatCollabMessageTime(options.at)
  const attributes = [
    ` id="${escapeCollabXmlAttribute(options.messageId)}"`,
    at ? ` at="${escapeCollabXmlAttribute(at)}"` : '',
  ].join('')
  return [
    `<${COLLAB_ADOPTED_ECHO_TAG}${attributes}>`,
    'Your last turn ended with a finished reply written at your desk and no send.'
    + ' The system delivered that text to the chat for you — those words are already there, under your name.',
    `</${COLLAB_ADOPTED_ECHO_TAG}>`,
  ].join('\n')
}

export interface BuildCollabChatRoomPayloadOptions {
  /**
   * 房间会话 id。`say` 的 `room` 参数收的就是它 —— 不给,那个参数对模型来说
   * 就是个按不到的按钮(工具描述里写着一个它填不出值的字段,比不写更糟)。
   */
  roomId?: string
  /** 房间名。没有就不写 name 属性 —— 编一个「未命名」出来只是噪声。 */
  roomName?: string
  /** 房间成员,**含自己**;顺序即渲染顺序。 */
  members: readonly CollabAgentLike[]
  /** 谁在读这份快照:它那一行标 `self="true"`。 */
  selfAgentId?: string
  userLabel: string
  userHandle?: string
  /** `<History>` 的每一行,各自已经裹好 `<message from>` 信封。 */
  history: readonly string[]
  /** `<History>` 的第一行(折叠说明);空串 = 没折叠。 */
  foldedLine?: string
  /**
   * 折叠段的每日摘要(P2),紧跟折叠行。空数组 = 还没生成/生成为空/功能关掉 ——
   * 这一块任何时候都不该假装自己知道被折掉了什么。
   */
  digestLines?: readonly string[]
  /** `</ChatRoom>` 之后追加的未读块;空串 = 没有未读。 */
  newMessagesBlock?: string
}

/** 一个 `<Member/>` 自闭合元素;空属性一律省略,不写 `role=""` 这种噪声。 */
function formatCollabMemberElement(
  attributes: ReadonlyArray<readonly [string, string | undefined]>,
): string {
  const rendered = attributes
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => ` ${key}="${escapeCollabXmlAttribute(value)}"`)
    .join('')
  return `<Member${rendered}/>`
}

/**
 * 一间房 → 一块 `<ChatRoom>`(docs/design/collab-chatroom-payload.md)。
 *
 * 这个形状要治的是**上下文里有 assistant 轮**这件事本身:旧投影把房间摊成一串
 * 假的多轮对话(别人是 user 轮、自己过去的发言是 assistant 轮),那个形状在教
 * 模型「你正在对话,你的输出就是你的回复」——而它在后台会话里,输出没人看得见,
 * 只有 say 出得去。塌成一条 user 消息之后,上下文里一个 assistant 轮都没有,
 * 也就没有「该你接话」的槽位:要产生任何效果只能调工具。这是结构层的堵,不是
 * 措辞层的提醒。
 *
 * `<Members>` **含自己并标 `self="true"`**:旧的花名册刻意不列自己(紧跟 persona
 * 后面,列自己是废话),而在一份房间快照里,它是模型认出 `<History>` 里哪几条
 * 是自己说的唯一线索。
 *
 * 成员是**结构化的 `<Member/>` 元素**而不是一行 `- 小李#aaaa(产品经理)`:名字、
 * 句柄、职位各占一个属性,模型不必再从一行文本里把它们剥出来。`name` 与 `handle`
 * 拼起来就是它要写进正文的 `@名字#句柄`,`<History>` 的 `from` 也是同一个拼法 ——
 * 三处同源,是「照抄即可」这条纪律在新形状下的样子。
 */
export function buildCollabChatRoomPayload(
  options: BuildCollabChatRoomPayloadOptions,
): string {
  const rootAttributes = [
    options.roomId ? ` id="${escapeCollabXmlAttribute(options.roomId)}"` : '',
    options.roomName ? ` name="${escapeCollabXmlAttribute(options.roomName)}"` : '',
  ].join('')
  // 用户的 role 是「用户」—— 它占同事的「职位」那一格(agent-dm-user.md §2.3)。
  // 用户不是 memberAgentIds 里的成员,但 TA 在这个场子里,而 dm 认得出这个写法。
  const memberElements = [
    formatCollabMemberElement([
      ['name', options.userLabel],
      ['handle', options.userHandle],
      ['role', '用户'],
    ]),
    ...options.members.map(member =>
      formatCollabMemberElement([
        ['name', member.name],
        // 句柄是从 id **派生**的短形式,不是 id 本身 —— 一串完整的
        // `agent-0739d3ab-c1e2…` 在提示词里是个谜题(collab-agent-handle.md)。
        ['handle', member.id ? collabAgentHandle(member.id) : undefined],
        ['role', member.title],
        // 一句话职责:模型判断「这件事该指派给谁」时唯一的依据。没有就不写。
        ['description', member.description],
        ['self', member.id && member.id === options.selfAgentId ? 'true' : undefined],
      ]),
    ),
  ]
  return [
    `<${COLLAB_CHATROOM_TAG}${rootAttributes}>`,
    '<Members>',
    ...memberElements,
    '</Members>',
    '<History>',
    ...(options.foldedLine ? [options.foldedLine] : []),
    ...(options.foldedLine ? (options.digestLines ?? []) : []),
    ...options.history,
    '</History>',
    `</${COLLAB_CHATROOM_TAG}>`,
    // 未读块在**房外**:`<ChatRoom>` 是这间房的快照,而"哪些我没读过"是读者
    // 自己的状态,不是房间的属性。放进去会让两个不同性质的事实共用一个容器。
    ...(options.newMessagesBlock ? ['', options.newMessagesBlock] : []),
  ].join('\n')
}

// IM-relay style「名字: 内容」(v3) — titles live in the room note, not on every
// line; the bracketed script style read as a simulation transcript. The label
// rule itself is shared with the willingness window (P2-16), so a departed
// member is signed the same way in both.

// 相邻同侧行的合并(R4 的 `mergeCollabProjectedRows`)已于 C2-1 删除。
// 它留下来的理由是「执行会话那一支还要用它」,而 W18 之后执行会话走的是普通
// 会话那条路(message-helpers.ts 的 `return messages`),再没有人调过它 ——
// 生产零消费者,只剩它自己的单测在证明它自己还活着。真需要合并相邻同侧行时
// 从 git 历史里取回来,比留一个没人跑的分支便宜。

/**
 * Project a room transcript into the activated agent's view — **one `user`
 * message** carrying a `<ChatRoom>` snapshot(docs/design/collab-chatroom-payload.md)。
 * 房间侧不再有任何 assistant 轮,理由见 buildCollabChatRoomPayload 的注释。
 *
 * 五类消息(D3)在 `<History>` 里的去处:
 *  1. self assistant messages          → `<message from="自己的名字#句柄">`,正文
 *     **逐字原样**(W14b):不重绘 @、不加引用行、不加表情统计。挂在旧转录自身
 *     消息上的 toolCalls 拍平进正文 —— 丢掉它们就是在造孤儿 tool_result。
 *  2. other agents' assistant messages → 同样的信封;tool calls flattened;
 *     tool companions never emitted
 *  3. real user messages               → `<message from="用户#句柄">`
 *  4. coordinator drive messages       → excluded (collapseSupersededGoalDrives rationale)
 *  5. MARKED collab system lines       → `<message from="系统">`(W9.1):
 *     task lifecycle and membership changes are FACTS about the room, and an
 *     agent that cannot see them can only believe what other agents claim.
 *     Unmarked system lines (budget / chain gate / queue / permission
 *     reminders) stay display-only — machine bookkeeping, not room facts.
 * Pass turns and W14b thinking records are excluded. Display-only roles
 * (error/unmarked system) are skipped.
 *
 * W14a: every RELAYED block has its `@名字` repainted from the message's
 * mentions[] against the CURRENT roster, so a renamed member is addressed by
 * the name it goes by now. Self messages are exempt — the agent reads its own
 * words exactly as it wrote them.
 *
 * 一条 `<History>` 都没有 → 返回空数组,而不是一块空快照:没有房间内容时凭空
 * 塞一个壳进上下文,只是让模型多读一遍它已经知道的花名册。
 *
 * 方向(C2-1 纠正,此前这段注释把它写反了):**下面这个纯层 walk 就是生产实现**。
 * 它经 `buildCollabDriveRoomContext` 喂给 app/collab/turn.ts —— W18 之后每一个被
 * 驱动的房回合都跑在执行会话里,而房间内容是跟着 drive 走这条路进去的。
 *
 * app/engine/stream/message-helpers.ts 的 `projectRoomMessagesForModel` 是**遗留
 * 适配器**:它只在 `kind === 'room'` 的会话直接进流式时才醒过来,而 W18 之后
 * ingress 把房内用户消息挡在流式之外,只剩 pre-W18 的旧房转录理论上够得着它。
 * 那一支已冻结,不接新特性;这里改了规则不必去同步它(反过来也一样)。
 * 两侧仍共用同一个载荷 builder,`room-projection.test.ts` 有一条逐字对拍钉住它们
 * 走到 builder 之前的那一段。
 */
function walkCollabRoomProjection(options: ProjectRoomHistoryOptions): {
  history: string[]
  unreadLines: string[]
  foldedSummary: CollabFoldedSummary | undefined
  userLabel: string
} {
  const userLabel = options.userLabel ?? '用户'
  const history: string[] = []
  const unreadLines: string[] = []
  const window = options.window
  const folded = createCollabFoldedAccumulator()
  /** 引用关系要按 id 回查作者 —— replyTo 快照只存了改名后会失效的 authorLabel。 */
  const authorOf = (messageId: string): string | undefined =>
    options.messages.find(entry => entry.id === messageId)?.agentId

  /**
   * 一条已经渲染好的行的去处:折叠掉、进未读块、或者进历史。三条路互斥,所以
   * 每条消息在模型眼里**只出现一次** —— 未读不在 `<History>` 里重复一遍,下一个
   * 回合游标前移,它自然并入历史尾部,前缀单调增长。
   */
  const record = (index: number, message: CollabMessageLike, line: string): void => {
    if (window?.folded.has(index)) {
      folded.note(message.timestamp)
      return
    }
    if (window?.unread.has(index)) {
      unreadLines.push(line)
      return
    }
    history.push(line)
  }

  for (const [index, message] of options.messages.entries()) {
    /**
     * 这条进不进任何人的视野,只由这一个判定说了算(P5-2)。
     *
     * 此前这里是四道各自的 if(role / drive / pass / thinking),而**同一套规则**
     * 在每日摘要与 `room_history` 各写了一遍、且都写歪了:两处都把 MARKED 系统行
     * 丢掉,于是一条卡片流转记录在投影里是事实、在摘要里不存在、在工具里查不到。
     * 判定收进 `isCollabRoomFact` 之后,这种漂移不再有发生的地方。
     */
    if (!isCollabRoomFact(message)) continue
    /** 未读行才带 `rel`;历史里不带(按条计费的固定开销)。 */
    const relOf = (): { rel?: string } => {
      if (!window?.unread.has(index)) return {}
      return { rel: resolveCollabUnreadRelation(message, options.selfAgentId, authorOf) }
    }
    if (isCollabProjectedSystemLine(message)) {
      // 系统行也进信封:它和别人的发言一样是"别人说的话",边界问题一模一样
      // (一条受阻说明可以很长、可以带换行)。
      if (message.content) {
        record(index, message, wrapCollabMessageEnvelope(COLLAB_SYSTEM_SPEAKER_LABEL, message.content, message.timestamp, relOf()))
      }
      continue
    }
    // role / drive / pass / thinking 四道判断都归 `isCollabRoomFact` 了(上面那段)。
    // W14b 的那条仍然成立,只是搬了家:thinking record 不是发言,它不进**任何人**的
    // 投影,作者自己也不例外 —— 它说过的话就在旁边的 say 消息里,再放一遍会让整间房
    // 读起来像什么都说了两遍。
    if (message.role === 'assistant') {
      const label = resolveCollabSpeakerLabel(message.agentId, options.agents, options.resolveAgentName)
      const flattened = (message.toolCalls ?? []).map(formatCollabFlattenedToolCall)

      if (message.agentId && message.agentId === options.selfAgentId) {
        // W14b 铁律换了个容器,没有松动:正文逐字原样,一个字都不加工。
        const own = [message.content, ...flattened].filter(Boolean).join('\n')
        if (own) record(index, message, wrapCollabMessageEnvelope(label, own, message.timestamp, relOf()))
        continue
      }

      const spoken = renderCollabMentionText(message.content, message.mentions, options.agents, {
        renderHit: renderCollabModelMention,
      })
      const body = [spoken, ...flattened].filter(Boolean).join('\n')
      if (!body) continue
      // 说话人搬进信封的 from 属性,正文里不再重复一遍名字(§6.2:标签短)。
      record(index, message, wrapCollabMessageEnvelope(label, withImMetadata(message, body), message.timestamp, relOf()))
      continue
    }

    // Real user message
    if (!message.content) continue
    // 署名带句柄(§1 的样例):`名字#句柄`,与同事行同形 —— agent 能从历史里
    // 直接照抄一个 `dm to:` 用得上的 token。
    record(index, message, wrapCollabMessageEnvelope(
      formatCollabUserLabel(userLabel, options.userHandle),
      withImMetadata(
        message,
        renderCollabMentionText(message.content, message.mentions, options.agents, {
          renderHit: renderCollabModelMention,
        }),
      ),
      message.timestamp,
      relOf(),
    ))
  }

  return { history, unreadLines, foldedSummary: folded.summary(), userLabel }
}

/**
 * drive 要携带的房间内容(v3 V1,collab-agent-view-v3.md §2)。
 *
 * v3 之前:房间内容每个回合**重新投影一遍**,拼成一条临时快照,执行会话自己的
 * 历史整份丢弃。v3 之后:房间内容**跟着 drive 写进执行会话一次**,那条 drive 是
 * 一条真实消息、会落盘、之后的每一轮都在历史里读得到。
 *
 * 两种形态,靠有没有游标区分:
 *
 *  - **首轮铺底**(这位同事在这间房还没跑过回合,游标缺席):带整段可见历史,
 *    含折叠行与每日摘要 —— 它需要知道自己接手的是一间聊了多久的房。
 *  - **增量**(有游标):**只带未读**。更早的消息在更早的 drive 里已经写进历史了,
 *    再带一遍就是把刚删掉的那种重复投影换个地方长回来。
 *
 * 不包 `<ChatRoom>` 壳:那层壳的存在理由是"整间房塌成一条 user 消息"，而这里
 * 每条消息本来就在自己的信封里,再套一层只是每轮多付一份固定开销。房名与花名册
 * 归 system prompt(v3 §6 决定 2)。
 *
 * 返回 `''` = 没有任何新东西要告诉它(增量形态下很常见:被任务事件驱动、
 * 或者上一轮刚读完)。调用方据此决定 drive 里放不放这一段。
 */
export function buildCollabDriveRoomContext(options: ProjectRoomHistoryOptions & {
  /** 有游标 = 增量;缺席 = 首轮铺底。与 `options.window` 的游标是同一个来源。 */
  bootstrap: boolean
  digests?: readonly CollabDayDigest[]
  /**
   * 编排点将的标记(`'coordinator'`)。给了它,零未读也会发一个自闭合的
   * `<Notification count="0" … scheduled="coordinator"/>` —— drive 非空是硬要求
   * (指令块删掉之后,空 drive 就是一条什么都没有的消息),而"被点到了但没有新
   * 消息"本身是一条真实的数据。
   */
  scheduled?: string
}): string {
  const { history, unreadLines, foldedSummary } = walkCollabRoomProjection(options)
  const window = options.window
  const newMessagesOptions = {
    ...(window?.seenAt !== undefined ? { seenAt: window.seenAt } : {}),
    ...(window?.unreadElided ? { elided: window.unreadElided } : {}),
    ...(options.scheduled ? { scheduled: options.scheduled } : {}),
  }

  if (!options.bootstrap) {
    // 增量:未读之外一个字都不带。`elided` 仍然要说 —— 它是"你还有更早的没读到"
    // 这个事实,静默吞掉它就是静默丢消息(`<Folded>` 那行注释同一个论证)。
    return formatCollabNotificationBlock({ lines: unreadLines, ...newMessagesOptions })
  }

  const lines: string[] = []
  if (foldedSummary) {
    lines.push(formatCollabFoldedLine(foldedSummary))
    lines.push(...formatCollabDigestLines(options.digests ?? []))
  }
  lines.push(...history)
  const newMessages = formatCollabNotificationBlock({
    lines: unreadLines,
    ...newMessagesOptions,
  })
  if (newMessages) lines.push(newMessages)
  return lines.filter(Boolean).join('\n')
}

/**
 * 整间房塌成一条 `user` 消息的那个形态 —— **可执行的 spec 入口**(C2-1 定性)。
 *
 * 生产驱动走的是 `buildCollabDriveRoomContext`(不包 `<ChatRoom>` 壳),所以这个
 * 函数今天没有生产调用点;它活着是因为 walk 内核那五类消息的取舍、信封署名、
 * @ 重绘、引用行与表情统计,全部由它承载断言(collab/__tests__ 六个文件),而
 * `room-projection.test.ts` 那条逐字对拍还要用它当遗留适配器的对照面 —— 删掉它
 * 等于把这段共享内核的覆盖一起删掉。**不要**给它接新特性:要改的是 walk。
 */
export function projectRoomHistory(options: ProjectRoomHistoryOptions): ProjectedRoomMessage[] {
  const { history, unreadLines, foldedSummary, userLabel } = walkCollabRoomProjection(options)
  const window = options.window

  // 历史空 + 未读空 → 什么都不投。只有未读时仍然要投:那正是"我离开期间群里
  // 说了话"这一种最需要被读到的形态。
  if (history.length === 0 && unreadLines.length === 0) return []
  return [{
    role: 'user',
    content: buildCollabChatRoomPayload({
      ...(options.roomId ? { roomId: options.roomId } : {}),
      ...(options.roomName ? { roomName: options.roomName } : {}),
      members: options.agents,
      selfAgentId: options.selfAgentId,
      userLabel,
      ...(options.userHandle ? { userHandle: options.userHandle } : {}),
      history,
      ...(foldedSummary
        ? {
            foldedLine: formatCollabFoldedLine(foldedSummary),
            digestLines: formatCollabDigestLines(options.digests ?? []),
          }
        : {}),
      newMessagesBlock: formatCollabNotificationBlock({
        lines: unreadLines,
        ...(window?.seenAt !== undefined ? { seenAt: window.seenAt } : {}),
        ...(window?.unreadElided ? { elided: window.unreadElided } : {}),
      }),
    }),
  }]
}
