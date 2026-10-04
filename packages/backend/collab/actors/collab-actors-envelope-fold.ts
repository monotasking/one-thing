/**
 * mailbox 折叠信封(docs/design/collab-actor-v3.md §1.2)——v2 `elsewhere` 块的 v3 形态。
 *
 * ## 它是同一件事的第二次实现吗
 *
 * 不是。v2 的 `collab-turn-log.ts` 每回合**现场扫描**:枚举这位同事所在的每一间别的房、
 * load 转录、按时间窗切回合、再渲染。扫描器要自己回答「窗口是哪一段」「哪些房要
 * 扫」「怎么把转录切成回合」三个问题,而这三个答案在 v3 里已经躺在 mailbox 里了
 * —— 寻址到我的事件本来就一封一封地按序进了我的信箱。
 *
 * 所以 v3 不扫描,只**折叠**:两次回合之间进过信箱的、属于别的房的那些事件,
 * 折成几行信封。窗口 = 上次折叠位点到现在(位点记在 agent 账里),不需要"上一条
 * drive 的时刻"这种从历史里反推出来的游标。
 *
 * ## 一条不变量:只有信封,没有正文
 *
 * 这是 §1.3 保密不变量的落点,而且这里把它做成了**结构性**的:折叠条目类型里
 * **压根没有 content 字段**。v2 靠一张参数白名单把正文挡在外面(`IDENTIFYING_KEYS`),
 * 白名单是一道会被绕过的门(加一个工具、加一个参数名就得记得同步);类型里没有
 * 那个字段,则是一道绕不过去的门 —— 「狼人在私聊房里说了什么」不可能出现在群房
 * 的 drive 里,不是因为有人记得过滤,是因为那句话从来没有进过这个数据结构。
 *
 * 卡片标题同理被排除:一张卡叫「给 4 号下毒」本身就是正文。事件说「那间房有张卡
 * 交付了」就够,要看内容就去那间房。
 *
 * ## 三条纪律沿用 v2(逐条对齐,`__tests__/collab-actors-envelope-fold.test.ts` 钉住)
 *
 *  - **是事件,不是状态**。一条事件只在它真的发生的那一刻写一次;折叠过就从缓冲
 *    里取走。v2 初版写成滚动快照,实测同一个事件被写进 drive 最多 23 次。
 *  - **先按房截,再按总量截**。一间吵闹的房不能把另外四间房的事件整段挤掉。
 *  - **截断要说出来**。静默丢弃读起来和「什么都没发生」一模一样。
 *
 * 上限与标签直接复用 `collab-turn-log.ts` 的既有导出 —— 两处各写一个数字,迟早分家,
 * 而分家的形态是「群里的信封比私聊里的多两行」这种没人看得出来的漂移。
 */
import { escapeCollabXmlAttribute, formatCollabMessageTime } from '../collab-projection.js'
import {
  COLLAB_ELSEWHERE_MAX_EVENTS,
  COLLAB_ELSEWHERE_MAX_PER_ROOM,
  COLLAB_ELSEWHERE_TAG,
} from '../collab-turn-log.js'
import type { CollabCardEventKind } from './collab-actors-protocol.js'

/** 每条折叠条目都有的三格:什么时候、哪间房、这条事件的身份键。 */
interface CollabFoldEntryBase {
  at: number
  /** 事件发生在哪间房。`worker` 类没有房(它是自己派出去的手)。 */
  roomId?: string
  /**
   * 幂等键。崩溃后 mailbox 会把未 ack 的那一批原样重投,重投的事件必须折不出
   * 第二条 —— 判据是**事件的身份**,不是它的内容(同一个人在同一分钟说两句话
   * 是两件事,而同一封信重投两次是一件事)。
   */
  key: string
}

/** 别人在那间房对我说过话。**没有正文**,只有「谁、什么时候、几条」。 */
export interface CollabFoldGotEntry extends CollabFoldEntryBase {
  kind: 'got'
  /** 说话的同事。缺席 = 人类。 */
  fromAgentId?: string
  /** 同人同房同窗口合并出来的条数。 */
  count: number
}

/** 那间房换相了(狼人杀的天黑/天亮)。 */
export interface CollabFoldPhaseEntry extends CollabFoldEntryBase {
  kind: 'phase'
  phase: string
}

/** 那间房的成员动了。**只有计数** —— 谁进谁出要看那间房。 */
export interface CollabFoldMembersEntry extends CollabFoldEntryBase {
  kind: 'members'
  joined: number
  left: number
}

/** 那间房的看板动了。卡号是标识,卡的标题是正文 —— 只带前者。 */
export interface CollabFoldCardEntry extends CollabFoldEntryBase {
  kind: 'card'
  cardId: string
  event: CollabCardEventKind
}

/** 我自己派出去的那双手交回了结果(D4)。 */
export interface CollabFoldWorkerEntry extends CollabFoldEntryBase {
  kind: 'worker'
  cardId: string
  ok: boolean
}

export type CollabFoldEntry =
  | CollabFoldGotEntry
  | CollabFoldPhaseEntry
  | CollabFoldMembersEntry
  | CollabFoldCardEntry
  | CollabFoldWorkerEntry

export interface BuildCollabFoldedEnvelopeOptions {
  entries: readonly CollabFoldEntry[]
  /**
   * 窗口下界 —— 上次折叠位点。进 `since` 属性,让模型读得出「这是哪一段时间
   * 里的事」。缺省/0 = 不渲染这个属性(首轮没有上一次)。
   */
  since?: number
  /** 这一轮在答哪间房 —— 它自己的消息逐字在房间投影里,不该在信封里再出现一遍。 */
  currentRoomId?: string
  /** roomId → 房间名。拿不到就退回「另一间房」(与 v2 同一句兜底)。 */
  resolveRoomLabel?: (roomId: string) => string | undefined
  /** agentId → 「名字#句柄」。拿不到就退回「同事」(与 v2 同一句兜底)。 */
  resolveSpeakerLabel?: (agentId: string) => string | undefined
  /** 缓冲区自己丢过的条数(容量上限)。与渲染时截掉的合并进同一行 `<more>`。 */
  droppedBefore?: number
  maxEvents?: number
  maxPerRoom?: number
}

export const COLLAB_FOLD_ROOM_FALLBACK_LABEL = '另一间房'
export const COLLAB_FOLD_SPEAKER_FALLBACK_LABEL = '同事'
export const COLLAB_FOLD_USER_LABEL = '用户'
/** `worker` 类没有房,渲染时归到这一格 —— 它是「我自己那双手」。 */
export const COLLAB_FOLD_SELF_BUCKET = '\u0000self'

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeCollabXmlAttribute(value)}"` : ''
}

/**
 * 同人同房同窗口的 `got` 合并成一行带 `count`。
 *
 * 不合并的话真机上会出现两三条一模一样的行(信封时间到分钟为止,同一分钟内的
 * 多条渲染完全相同)。`count` 是**事件计数**不是待办数:块本身带 `since`,说的是
 * 「这个窗口里来了 3 条」,一个过去窗口的计数永远不会过期 —— 与被否决的
 * `unread="3"`(状态,会变、会成为一条格式正确的谎话)是两回事。
 *
 * 时刻取**最后**一条:模型要判断的是「多久以前的事」。
 */
export function mergeCollabFoldEntries(entries: readonly CollabFoldEntry[]): CollabFoldEntry[] {
  const merged: CollabFoldEntry[] = []
  const gotIndex = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== 'got') {
      merged.push(entry)
      continue
    }
    const bucket = `${entry.roomId ?? ''}\u0000${entry.fromAgentId ?? ''}`
    const hit = gotIndex.get(bucket)
    if (hit === undefined) {
      gotIndex.set(bucket, merged.length)
      merged.push({ ...entry })
      continue
    }
    const previous = merged[hit] as CollabFoldGotEntry
    merged[hit] = {
      ...previous,
      at: Math.max(previous.at, entry.at),
      count: previous.count + entry.count,
    }
  }
  return merged
}

function renderEntry(
  entry: CollabFoldEntry,
  options: BuildCollabFoldedEnvelopeOptions,
): string {
  const roomLabel = entry.roomId
    ? options.resolveRoomLabel?.(entry.roomId) || COLLAB_FOLD_ROOM_FALLBACK_LABEL
    : undefined
  const head = `${attr('room', roomLabel)}${attr('at', formatCollabMessageTime(entry.at))}`
  switch (entry.kind) {
    case 'got': {
      const from = entry.fromAgentId
        ? options.resolveSpeakerLabel?.(entry.fromAgentId) || COLLAB_FOLD_SPEAKER_FALLBACK_LABEL
        : COLLAB_FOLD_USER_LABEL
      return `<got${head}${attr('from', from)}${entry.count > 1 ? ` count="${entry.count}"` : ''}/>`
    }
    case 'phase':
      return `<phase${head}${attr('to', entry.phase)}/>`
    case 'members':
      return `<members${head}${entry.joined ? ` joined="${entry.joined}"` : ''}`
        + `${entry.left ? ` left="${entry.left}"` : ''}/>`
    case 'card':
      return `<card${head}${attr('id', entry.cardId)}${attr('event', entry.event)}/>`
    case 'worker':
      return `<worker${head}${attr('card', entry.cardId)} ok="${entry.ok ? 'yes' : 'no'}"/>`
    default:
      return assertNeverFoldEntry(entry)
  }
}

function assertNeverFoldEntry(entry: never): never {
  throw new Error(`[collab-fold] unhandled entry: ${JSON.stringify(entry)}`)
}

/**
 * 折出信封块。
 *
 * 返回 `''` 的三种情况都正确:窗口里别处什么都没发生、只有当前这间房的事、
 * 上限被配成 0。空块是噪声 —— 这个仓库在 `<where_you_are>` 三份逐字副本上吃过
 * 一次亏,模板套话正是被滑过去的那种文字。
 */
export function buildCollabFoldedEnvelope(options: BuildCollabFoldedEnvelopeOptions): string {
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? COLLAB_ELSEWHERE_MAX_EVENTS))
  if (maxEvents === 0) return ''
  const perRoom = Math.max(1, Math.floor(options.maxPerRoom ?? COLLAB_ELSEWHERE_MAX_PER_ROOM))

  // 当前这间房先滤掉:它的消息在房间投影里逐字都有,信封里再来一行只会让模型
  // 以为那是**另一件**事。
  const scoped = options.entries.filter(entry => !entry.roomId || entry.roomId !== options.currentRoomId)
  const merged = mergeCollabFoldEntries(scoped)

  let dropped = Math.max(0, Math.floor(options.droppedBefore ?? 0))

  // 先按房截(见 COLLAB_ELSEWHERE_MAX_PER_ROOM 的理由),再按总量截。
  const byRoom = new Map<string, CollabFoldEntry[]>()
  for (const entry of merged) {
    const bucket = entry.roomId ?? COLLAB_FOLD_SELF_BUCKET
    const list = byRoom.get(bucket) ?? []
    list.push(entry)
    byRoom.set(bucket, list)
  }
  const kept: CollabFoldEntry[] = []
  for (const list of byRoom.values()) {
    list.sort((a, b) => a.at - b.at)
    dropped += Math.max(0, list.length - perRoom)
    kept.push(...list.slice(-perRoom))
  }
  if (kept.length === 0 && dropped === 0) return ''

  kept.sort((a, b) => a.at - b.at)
  const shown = kept.slice(-maxEvents)
  dropped += kept.length - shown.length
  if (shown.length === 0 && dropped === 0) return ''

  return [
    `<${COLLAB_ELSEWHERE_TAG}${attr('since', formatCollabMessageTime(options.since ?? 0))}>`,
    ...(dropped > 0 ? [`<more count="${dropped}"/>`] : []),
    ...shown.map(entry => renderEntry(entry, options)),
    `</${COLLAB_ELSEWHERE_TAG}>`,
  ].join('\n')
}
