/**
 * 一个 agent 看这间房时的**视野**:哪些读过、哪些没读过、哪些老到该折叠。
 *
 * 在此之前投影是无窗口的 —— 每个回合把开房至今的全部消息逐字重放一遍。真机
 * 实测(2026-08-01,cumo 房):325 条 `<message>` / 67,750 字符,其中 65% 来自四天前
 * 那一天,而这一切只为回答一句「收到」。
 *
 * 这里把它切成三段,而切法**必须同时满足两个约束**:
 *
 *  1. **未读永不丢**。一个离开三天的同事,它的未读横跨三天也要逐字给到 ——
 *     折叠掉未读就是真的丢消息,那是这套机制唯一能造成的不可逆伤害。
 *  2. **切点必须稳定**。provider 的前缀缓存按前缀命中(真机:cacheRead 命中率
 *     99.1%,单价是 input 的 1/120),所以"最近 N 条"这种**滑动**窗口是最坏的
 *     写法 —— 每来一条消息前缀整体位移一格,工具定义 + 人设 + 全部历史一起掉出
 *     缓存,发的字更少而账单贵一个数量级。按**天**切则一天之内前缀恒定,一天只
 *     miss 一次。
 *
 * 于是:
 *
 * ```
 *   已读 且 早于切点          → 折叠成一行 <Folded count from to/>
 *   已读 且 在切点之后        → 逐字进 <History>   ← 稳定前缀,全缓存
 *   未读(无论多老)          → 逐字进 <Notification> ← 尾部,每回合变,但很小
 * ```
 *
 * `<Notification>` 放在**尾部**同样是缓存决定的:把未读标记插进 `<History>` 中间
 * 会让插入点之后的一切每回合都变,缓存从那里全废。尾部追加则前缀零改动。
 *
 * 未读**不重复**出现在 `<History>` 里:下一个回合游标前移,它们自然并入历史尾
 * 部,前缀单调增长,缓存照旧命中。
 */
import { isCollabRoomFact } from './classify.js'
import { isCollabDriveMessage, type CollabMessageLike } from './types.js'

/** 一条未读消息与「我」的关系 —— 判定层的结构化抓手,不让模型纯靠语义猜。 */
export type CollabUnreadRelation = 'mentions-you' | 'quotes-you' | 'bystander'

/**
 * 折叠段保留几天(含今天)。1 = 只留今天,0 = 不折叠。
 *
 * 默认 1:真机那间房里"只留今天"把历史从 67,020 砍到 15,754 字符(−76.5%),
 * 而被折叠的都是四天前的开房寒暄与已经交付的卡。
 */
export const COLLAB_DEFAULT_HISTORY_DAYS = 1

/**
 * 折叠线**之前**额外保留的条数 —— 日界悬崖的补丁。
 *
 * 没有它,00:05 时「今天」几乎是空的,昨晚 23:50 还在聊的事情整段消失。而这批
 * 消息全都早于切点、内容不再变化,所以"切点前的最后 K 条"这个集合在一天之内
 * 同样是恒定的,不破坏前缀。
 */
export const COLLAB_DEFAULT_HISTORY_TAIL = 20

/**
 * 未读逐字上限。超出的部分**并入历史**(而不是丢掉)并在 `<Notification>` 上
 * 记一个 `elided` 数:一个离开很久的同事回来时,尾部不该膨胀到把上下文挤爆,
 * 但那些消息仍然看得见,只是不在"新消息"那一格里。
 */
export const COLLAB_DEFAULT_UNREAD_MAX = 50

export interface CollabHistoryWindowOptions {
  /** 房间的全部消息,时间序。 */
  messages: readonly CollabMessageLike[]
  /** 这位同事上次读到哪一条(游标)。缺省 = 从没读过 → 全部算已读,见下。 */
  seenMessageId?: string
  /**
   * 读者自己。**它自己说的话永远不算未读** —— 那是它写的,不是它错过的。
   *
   * 真机复盘(2026-08-01):不排除的话,一个 agent 回合结束后自己的 say 落在游标
   * 之后,下一轮就会在「你没读过的」里读到自己刚说的那句,还带一个 `rel`。
   * 那句话该在 `<History>` 里(逐字原样,W14b),不该在新消息那一格。
   */
  selfAgentId?: string
  /** 折叠切点从这个时刻往回算。调用方传 `Date.now()`;测试注入。 */
  now: number
  historyDays?: number
  historyTailCount?: number
  unreadMax?: number
}

export interface CollabFoldedSummary {
  count: number
  /** `YYYY-MM-DD`,折叠段的首末日期。 */
  from: string
  to: string
  /** 折叠段覆盖到的每一天,升序。P2 的每日摘要按它取。 */
  days: string[]
}

export interface CollabHistoryWindow {
  /** 下标 → 该条折叠(不进 `<History>`)。 */
  folded: ReadonlySet<number>
  /** 下标 → 该条进 `<Notification>`(且**不**进 `<History>`)。 */
  unread: ReadonlySet<number>
  /** 因为超过 `unreadMax` 而退回历史的未读条数。 */
  unreadElided: number
  /** 游标那条消息的时间戳 —— 渲染 `<Notification seen_until>` 用。 */
  seenAt?: number
  /**
   * 这一次用的折叠切点;`undefined` = 这间房不折叠(`historyDays=0`)。
   *
   * 导出它是为了让下游**不必自己再算一遍**(P5-2)。此前历史工具与摘要
   * 各自调 `collabFoldCutTimestamp` 再各自判"早于切点",于是三处判定漂移成三个
   * 答案;而"这间房到底折不折叠"还是空结果三态文案的判据 —— 那句话答错的代价
   * 是模型给出带确定性的否定。
   */
  cut?: number
}

/**
 * 折叠计数器。
 *
 * 计数由**投影**来做而不是由规划器做,因为两者数的不是同一个东西:规划器看的是
 * 房间的原始消息列表(含 drive、thinking record、pass —— 这些本来就进不了投影),
 * 而 `<Folded count>` 要回答的是「模型少看到了几条**话**」。让规划器数会得到一个
 * 偏大的数和一段偏早的日期范围,而这一行的全部价值就是那个数是准的。
 *
 * 两个投影(纯 spec 与 app 适配器)共用它 —— 只改一边 = 测试全绿而真机没变。
 */
export function createCollabFoldedAccumulator(): {
  note(timestamp?: number): void
  summary(): CollabFoldedSummary | undefined
} {
  let count = 0
  let first: number | undefined
  let last: number | undefined
  const days = new Set<string>()
  return {
    note(timestamp) {
      count += 1
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return
      if (first === undefined) first = timestamp
      last = timestamp
      const day = formatDay(timestamp)
      if (day) days.add(day)
    },
    summary() {
      if (count === 0) return undefined
      return { count, from: formatDay(first), to: formatDay(last), days: [...days].sort() }
    },
  }
}

const DAY_MS = 86_400_000

/** 本地时区的当日零点 —— 与 `formatCollabMessageTime` 同口径(用户的时间)。 */
function startOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 折叠切点。早于它的**已读**消息才有资格被折叠。
 *
 * 导出是因为摘要那侧(P2)要算"哪几天进了折叠段"——两处各算一遍迟早会差一天,
 * 而差一天的后果是:摘要覆盖的日子和真正被折掉的日子对不上,模型读到一段
 * 关于它明明能看见的那天的复述。`historyDays <= 0` = 不折叠,返回 undefined。
 */
export function collabFoldCutTimestamp(
  now: number,
  historyDays: number = COLLAB_DEFAULT_HISTORY_DAYS,
): number | undefined {
  const days = normalizeCount(historyDays, COLLAB_DEFAULT_HISTORY_DAYS)
  if (days <= 0) return undefined
  return startOfLocalDay(now) - (days - 1) * DAY_MS
}

function formatDay(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 这条未读是冲着我来的吗。
 *
 * `mentions` 是 W14a 的 id 化结果,所以点名判定不受改名影响;引用则要回房里
 * 查被引的那条是谁说的 —— `ChatMessageReplyTo` 是快照,只存了 `authorLabel`
 * (改名后会对不上),而 id 永远对得上。
 */
export function resolveCollabUnreadRelation(
  message: CollabMessageLike,
  selfAgentId: string | undefined,
  authorOfMessageId?: (messageId: string) => string | undefined,
): CollabUnreadRelation {
  if (!selfAgentId) return 'bystander'
  if (message.mentions?.some(mention => mention.agentId === selfAgentId)) return 'mentions-you'
  const quoted = message.replyTo?.messageId
  if (quoted && authorOfMessageId?.(quoted) === selfAgentId) return 'quotes-you'
  return 'bystander'
}

/**
 * 切窗口。**只做计算,不渲染** —— 标签与转义归 projection.ts,那里是唯一知道
 * `<message>` 长什么样的地方。
 *
 * 游标缺省(这位同事在这间房的第一个回合)时**不产生任何未读**:它从没读过,
 * 整段历史就是它的上下文,把 325 条标成"新消息"是荒谬的。
 */
export function planCollabHistoryWindow(
  options: CollabHistoryWindowOptions,
): CollabHistoryWindow {
  const { messages } = options
  const historyDays = normalizeCount(options.historyDays, COLLAB_DEFAULT_HISTORY_DAYS)
  const historyTailCount = normalizeCount(options.historyTailCount, COLLAB_DEFAULT_HISTORY_TAIL)
  const unreadMax = normalizeCount(options.unreadMax, COLLAB_DEFAULT_UNREAD_MAX)

  const folded = new Set<number>()
  const unread = new Set<number>()

  // 游标定位。找不到(消息被删/旧数据)= 当作没读过 —— 保守方向是"不产生未读",
  // 与从未读过同一条路径,绝不会因为一个失效 id 把整段历史标成新消息。
  const seenIndex = options.seenMessageId
    ? messages.findIndex(message => message.id === options.seenMessageId)
    : -1
  const seenAt = seenIndex >= 0 ? messages[seenIndex]?.timestamp : undefined

  // ── 未读 ──────────────────────────────────────────────────────────────
  // 只有游标真的落在某条上,后面的才算新消息。
  let unreadElided = 0
  if (seenIndex >= 0) {
    const candidates: number[] = []
    for (let index = seenIndex + 1; index < messages.length; index++) {
      const message = messages[index]
      // 自己说的话不是"我错过的",drive 更是机械行(投影里本来就没有它)——
      // 两者都直接落回历史,也不占未读上限的名额。
      if (options.selfAgentId && message?.agentId === options.selfAgentId) continue
      if (isCollabDriveMessage(message)) continue
      candidates.push(index)
    }
    // 超额的是**较早**那些:留下最新的 unreadMax 条,其余退回历史。
    const overflow = Math.max(0, candidates.length - unreadMax)
    unreadElided = overflow
    for (const index of candidates.slice(overflow)) unread.add(index)
  }

  // ── 折叠 ──────────────────────────────────────────────────────────────
  // 0 = 关闭(与 budgets 那一套「0 = 关掉这道闸」同约定)。
  const cut = collabFoldCutTimestamp(options.now, historyDays)
  if (cut !== undefined) {
    // 候选 = 早于切点、且**不是未读**的。未读永不折叠,这是第 1 条约束。
    const candidates: number[] = []
    for (let index = 0; index < messages.length; index++) {
      if (unread.has(index)) continue
      const timestamp = messages[index]?.timestamp
      if (typeof timestamp !== 'number' || timestamp >= cut) continue
      candidates.push(index)
    }
    // 切点前的最后 K 条留着(日界悬崖)。这批消息不再变化,所以这个集合在一天
    // 之内恒定 —— 前缀因此稳定。
    const keepFrom = Math.max(0, candidates.length - historyTailCount)
    for (const index of candidates.slice(0, keepFrom)) folded.add(index)
  }

  return {
    folded,
    unread,
    unreadElided,
    ...(seenAt !== undefined ? { seenAt } : {}),
    ...(cut !== undefined ? { cut } : {}),
  }
}

/**
 * 折叠段里**模型本来看得见的那些**(P5-2)—— 折叠侧两个消费者的共用入口。
 *
 * `window.folded` 是下标集合,里面混着 drive、thinking record、运营系统行 ——
 * 这些本来就进不了投影,所以它们"被折叠"是个无意义的说法。真正被折掉的是这里
 * 返回的这些:**折叠集合 ∩ 房间事实 ∩ 有正文**。
 *
 * 每日摘要拿它当输入,drive 的折叠日期行拿它数天数。两家共用一个函数,是
 * §2 那个缺口(摘要丢掉卡片流转记录)唯一的结构性解法:判定只有一处,漂移
 * 就没有发生的地方。
 *
 * **检索不在这里**:`history` 工具查的是整份转录,不是折叠段(它 2026-08-02
 * 取代 `room_history` 时一并去掉了那条限制)。
 *
 * 正文为空的在这里就滤掉:两个消费者都要把它渲染成一行 `<message>`,没有正文就
 * 没有东西可给。投影那侧不同(assistant 的 toolCalls 能撑起正文),所以那条
 * 判断留在投影里 —— 理由见 `isCollabRoomFact` 的注释。
 */
export function collectCollabFoldedFacts<T extends CollabMessageLike>(
  messages: readonly T[],
  window: Pick<CollabHistoryWindow, 'folded'>,
): T[] {
  const facts: T[] = []
  for (const [index, message] of messages.entries()) {
    if (!window.folded.has(index)) continue
    if (!message.content) continue
    if (!isCollabRoomFact(message)) continue
    facts.push(message)
  }
  return facts
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}
