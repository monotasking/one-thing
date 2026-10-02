/**
 * 「别处发生的事」—— 跨房事件块（collab-agent-view-v3.md §3，V4'）。
 *
 * ## 它修的是什么
 *
 * 一个 agent 每间房一条执行会话，隔离必须保住（私聊内容混进群上下文 = 随时可能
 * 被 say 出去）。代价是**跨房那一维没人承担**，两个方向都缺：
 *
 *  - 我在别的房**做过**什么 —— 2026-08-01 真机，Iris 在群里不记得自己刚在四间
 *    私聊里发过身份牌；
 *  - 别的房有谁**找过**我 —— 同一天，Atlas/Nova/Bram 在群回合被问「收到 dm 了
 *    吗」，三个人全答"没收到"，而牌 17:52 就躺在他们各自的私聊房里。
 *
 * ## 一条纪律：只能是**事件**，不能是**状态**
 *
 * 这块东西写进 `drive`，而 drive 是一条**真实落盘的消息**（`emitDrive` 走
 * `command:send-message`）。v3 V2 之后模型读的是整条执行会话历史，所以**写进
 * drive 的东西会永久留在上下文里，写几次就有几份**。
 *
 * 初版（P5-4）写成了滚动快照——每条 drive 重发一遍「我最近的 5 个回合」。
 * 实测代价：47 条 drive、同一个事件最多被写入 **23 次**、平均 9.3 份副本、
 * 转录里累积 17,270 字符。而这恰好是本文件自己反对过的形状：三组一模一样的
 * `dm ×4` 并排，模型得先判断哪一组是当前这局。
 *
 * 现在是增量：**时间窗 =（上一条 drive，现在]**，每个事件只在它真的发生的那一
 * 刻写一次。同一份数据从 17,270 降到 2,484 字符，而且多数回合整块不输出。
 *
 * 游标不需要新增：**上一条 drive 的时刻本来就在历史里**。附带一条免费的正确性
 * —— 某一轮 abort、模型没读到那份事件块，它仍然落在历史里，下一轮照样读得到。
 *
 * ## 三条不变的纪律
 *
 *  - **不含内容**。工具参数只取标识性的键（白名单），`<got>` 只有信封没有正文。
 *    跨房给内容就是泄密——那正是「合房」被否决的理由，按需版一样不行。
 *  - **是凭据，不是自述**。数据来自真实落库的 `toolCalls` 与房间转录，
 *    不是模型说自己做过什么（W9.1 那条原则的跨房版）。
 *  - **首轮不输出**。这位同事在这间房的第一条 drive 没有"上一条"，窗口为空。
 *    要在那里列出别房的全部历史，就又变回快照了。
 */
import { escapeCollabXmlAttribute, formatCollabMessageTime } from './projection.js'
import { isCollabDriveMessage, isCollabRoomFact } from './classify.js'

/** 事件块的根标签。 */
export const COLLAB_ELSEWHERE_TAG = 'elsewhere'

/**
 * 一块最多列几条事件。
 *
 * 20 是兜底而不是常态：增量形态下典型窗口里只有 0–2 条事件（实测多数回合别房
 * 毫无动静，整块不输出）。它防的是"离开三天回来"那一种尖峰。
 */
export const COLLAB_ELSEWHERE_MAX_EVENTS = 20

/** 单个回合最多列几条调用。超出的折成一句 `<more count="N"/>`。 */
export const COLLAB_ELSEWHERE_MAX_CALLS = 10

/**
 * **每间房**最多列几条事件 —— 单房上限，与总上限分开。
 *
 * 只有总上限的话，一间吵闹的房（比如用户在某个私聊里连发二十条）会把另外四间
 * 房的事件整段挤掉，而被挤掉的恰恰可能是那条要紧的。先按房截、再按总量截，
 * 保证每间有动静的房**至少能说上话**。
 */
export const COLLAB_ELSEWHERE_MAX_PER_ROOM = 6

/**
 * 允许进事件行的参数键 —— **白名单，不是黑名单**。
 *
 * 白名单意味着新工具的新参数默认**不**出现：漏掉一个标识符只是少一点线索，
 * 而漏掉一个黑名单条目就是把正文/密钥/命令泄进之后的每一个回合。顺序即渲染
 * 优先级。
 */
const IDENTIFYING_KEYS: readonly string[] = [
  'action',
  'to',
  'name',
  'file_path',
  'path',
  'taskId',
  'id',
  'room',
]

/** 一个标识符值的上限。句柄与路径都远短于此，更长的一律是正文走错了地方。 */
const VALUE_MAX_CHARS = 60

/** 一条调用最多渲染几个参数。两个足够定位"对谁做了什么"。 */
const ATTRS_PER_CALL = 2

export interface CollabTurnLogToolCall {
  name?: string
  toolName?: string
  toolId?: string
  arguments?: unknown
}

export interface CollabTurnLogMessageLike {
  /** 必填，与 `CollabMessageLike` 同形 —— drive 判定要读它，给不出就没有边界。 */
  role: string
  content?: string
  timestamp?: number
  agentId?: string
  source?: string
  origin?: { source?: string }
  toolCalls?: readonly CollabTurnLogToolCall[]
}

export interface CollabElsewhereSource {
  /** 那间房叫什么 —— 进 `room` 属性。群名或「Iris ⇄ Bram」这类私聊名。 */
  roomLabel: string
  /** 这个 agent 在那间房的**执行会话**转录。没被驱动过就是空数组。 */
  execMessages?: readonly CollabTurnLogMessageLike[]
  /** 那间房**自己**的转录 —— `<got>` 从这里来。 */
  roomMessages?: readonly CollabTurnLogMessageLike[]
}

export interface BuildCollabElsewhereOptions {
  sources: readonly CollabElsewhereSource[]
  /** 时间窗下界（**不含**）：上一条 drive 的时刻。缺省/0 = 首轮，返回 `''`。 */
  since?: number
  /** 时间窗上界（含）：现在。 */
  until: number
  /** 谁在读 —— 它自己说的话不算「有人找我」。 */
  selfAgentId?: string
  /** agentId → 「名字#句柄」。拿不到就退回「同事」。 */
  resolveSpeakerLabel?: (agentId: string) => string | undefined
  maxEvents?: number
  maxPerRoom?: number
}

interface ElsewhereEvent {
  at: number
  line: string
}

function toolNameOf(call: CollabTurnLogToolCall): string {
  return call.toolName || call.name || call.toolId || 'tool'
}

function identifyingAttrs(call: CollabTurnLogToolCall): string {
  const args = call.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const record = args as Record<string, unknown>
  const parts: string[] = []
  for (const key of IDENTIFYING_KEYS) {
    if (parts.length >= ATTRS_PER_CALL) break
    const value = record[key]
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const text = String(value).trim()
    if (!text) continue
    const clipped = text.length > VALUE_MAX_CHARS ? `${text.slice(0, VALUE_MAX_CHARS)}…` : text
    parts.push(` ${key}="${escapeCollabXmlAttribute(clipped)}"`)
  }
  return parts.join('')
}

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeCollabXmlAttribute(value)}"` : ''
}

/**
 * 一个回合的事件行。
 *
 * **一次调用都没有也照样出一行**（`silent="yes"`）。初版在这里返回 `''`，于是
 * 「我被拉进那间私聊房、看完没说话」整轮消失 —— 而那正是收件人用来说"我看过了"
 * 的那条事实。
 */
function renderTurn(
  roomLabel: string,
  at: number,
  calls: readonly CollabTurnLogToolCall[],
): string {
  const head = `${attr('room', roomLabel)}${attr('at', formatCollabMessageTime(at))}`
  const lines: string[] = []
  let saidCount = 0
  for (const call of calls) {
    const tool = toolNameOf(call)
    // say 折成一个计数：一个回合发三条消息是三次调用，但"我说了三句"是一件事，
    // 而说了**什么**在那间房的转录里逐字都有。
    if (tool === 'say') {
      saidCount += 1
      continue
    }
    if (lines.length >= COLLAB_ELSEWHERE_MAX_CALLS) continue
    lines.push(`  <${tool}${identifyingAttrs(call)}/>`)
  }
  const dropped = calls.filter(call => toolNameOf(call) !== 'say').length - lines.length
  if (dropped > 0) lines.push(`  <more count="${dropped}"/>`)
  if (saidCount > 0) lines.push(`  <say count="${saidCount}"/>`)

  if (lines.length === 0) return `<turn${head} silent="yes"/>`
  return [`<turn${head}>`, ...lines, '</turn>'].join('\n')
}

/**
 * 把执行会话的转录切成回合，只留时间窗内的。
 *
 * 边界是 **drive**：协调器每驱动一次就写一条，两条 drive 之间发生的一切属于
 * 同一个回合。转录里还会有别的 user 消息（中途来消息会把 `<message>` 直接注进这一
 * 轮），它们不是边界 —— 那是同一个回合里读到的东西，不是新回合。
 *
 * **不排除最后一个回合。** 初版排除了，因为那时它扫的是"当前这间房"（最后一个
 * 回合就是正在跑的这一轮）。这里扫的全是**别的**房，别处最近那一轮恰恰是最该
 * 看见的；而一间刚被第一次 dm 的房只有一个回合，排除它等于整间房消失。
 */
function turnEventsOf(
  source: CollabElsewhereSource,
  since: number,
  until: number,
): ElsewhereEvent[] {
  const events: ElsewhereEvent[] = []
  let at: number | undefined
  let calls: CollabTurnLogToolCall[] = []

  const flush = (): void => {
    if (at === undefined) return
    // 窗口之外的回合不报：它要么在更早的 drive 里报过，要么还没发生。
    if (at > since && at <= until) {
      events.push({ at, line: renderTurn(source.roomLabel, at, calls) })
    }
    at = undefined
    calls = []
  }

  for (const message of source.execMessages ?? []) {
    if (message.role === 'user' && isCollabDriveMessage(message)) {
      flush()
      at = typeof message.timestamp === 'number' ? message.timestamp : undefined
      continue
    }
    if (at === undefined || !message.toolCalls?.length) continue
    calls.push(...message.toolCalls)
  }
  flush()
  return events
}

/**
 * 别人在那间房对我说的话 —— `<got>`。
 *
 * **只有信封，没有正文。** 这是原 V4「红点」的正确形态：红点是状态（撤不回来、
 * 每轮重申），而"某时某人在某房说过话"是事件（说一次，永远为真）。
 *
 * 判定复用 `isCollabRoomFact`：drive、thinking record、运营系统行都不算"有人
 * 找我"。自己说的话当然也不算。
 */
function gotEventsOf(
  source: CollabElsewhereSource,
  since: number,
  until: number,
  selfAgentId: string | undefined,
  resolveSpeakerLabel: ((agentId: string) => string | undefined) | undefined,
): ElsewhereEvent[] {
  /**
   * 同一个人在同一间房、同一个窗口里连发几条 → **合成一行带 count**。
   *
   * 不合并的话真机上会出现两三条一模一样的行(信封时间到分钟为止,同一分钟内的
   * 多条渲染完全相同)。实测 Bram 那 36 条 drive 里出现过 ×3。
   *
   * `count` 在这里是**事件计数**不是待办数:块本身带 `since`,说的是"这个窗口里
   * 来了 3 条",一个过去窗口的计数永远不会过期 —— 与被否决的 `unread="3"`
   * (状态,会变、会成为一条格式正确的谎话)是两回事。
   */
  const byPeer = new Map<string, { at: number; from: string; count: number }>()
  for (const message of source.roomMessages ?? []) {
    const at = message.timestamp
    if (typeof at !== 'number' || at <= since || at > until) continue
    if (selfAgentId && message.agentId === selfAgentId) continue
    // 正文为空的不算「有人找我」——判据本身不看正文（那是各消费方自己的事，
    // 见 `isCollabRoomFact` 的注释），所以这一条在这里补。
    if (!message.content) continue
    if (!isCollabRoomFact({ ...message, content: message.content })) continue
    const from = message.agentId
      ? resolveSpeakerLabel?.(message.agentId) || '同事'
      : '用户'
    const hit = byPeer.get(from)
    // 时刻取**最后**一条:模型要判断的是"多久以前的事"。
    if (hit) { hit.count += 1; hit.at = at } else byPeer.set(from, { at, from, count: 1 })
  }
  return [...byPeer.values()].map(entry => ({
    at: entry.at,
    line: `<got${attr('room', source.roomLabel)}${attr('at', formatCollabMessageTime(entry.at))}`
      + `${attr('from', entry.from)}${entry.count > 1 ? ` count="${entry.count}"` : ''}/>`,
  }))
}

/**
 * 渲染事件块。
 *
 * 返回 `''` 的三种情况都正确：首轮（没有上一条 drive）、窗口内别处什么都没发生、
 * 压根没有别的房。空块是噪声——这个仓库在 `<where_you_are>` 三份逐字副本上吃过
 * 一次亏，模板套话正是被滑过去的那种文字。
 */
export function buildCollabElsewhere(options: BuildCollabElsewhereOptions): string {
  const since = options.since ?? 0
  // 首轮：没有上一条 drive，窗口无从谈起。列出别房的全部历史就又变回快照了。
  if (!since) return ''
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? COLLAB_ELSEWHERE_MAX_EVENTS))
  if (maxEvents === 0) return ''

  const perRoom = Math.max(1, Math.floor(options.maxPerRoom ?? COLLAB_ELSEWHERE_MAX_PER_ROOM))
  let dropped = 0
  const events: ElsewhereEvent[] = []
  for (const source of options.sources) {
    const mine = [
      ...turnEventsOf(source, since, options.until),
      ...gotEventsOf(source, since, options.until, options.selfAgentId, options.resolveSpeakerLabel),
    ].sort((a, b) => a.at - b.at)
    // 先按房截:一间吵闹的房不能把别的房整段挤掉(见 COLLAB_ELSEWHERE_MAX_PER_ROOM)。
    dropped += Math.max(0, mine.length - perRoom)
    events.push(...mine.slice(-perRoom))
  }
  if (events.length === 0) return ''

  events.sort((a, b) => a.at - b.at)
  const kept = events.slice(-maxEvents)
  dropped += events.length - kept.length

  return [
    `<${COLLAB_ELSEWHERE_TAG}${attr('since', formatCollabMessageTime(since))}>`,
    // 截断要说出来：静默丢弃读起来和"什么都没发生"一模一样。
    ...(dropped > 0 ? [`<more count="${dropped}"/>`] : []),
    ...kept.map(event => event.line),
    `</${COLLAB_ELSEWHERE_TAG}>`,
  ].join('\n')
}
