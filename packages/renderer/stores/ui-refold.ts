/**
 * **ui-refold —— 屏幕上的那份 ≡ 账本折出来的那份**(§17.8 U1-b,裁定走乙)。
 *
 * ## 它比的是什么,以及为什么不是原来那句
 *
 * U1-b 的字面设计是「两个消费者对拍」:同一批 UI 事件,一路喂手写拼装、一路喂
 * core 折叠,比两边。**那句话今天造不出判据**(§17.8.2 勘察):UI 事件流只运
 * `assistant/delta` / `assistant/part-end` 两种,折叠器要的 `run/start` 根本不下发
 * (`projection/reducer.ts:565-566`:run 没开张,chunks 折进去等于零)。硬做就得在
 * renderer 里写一个总线词汇→账本词汇的翻译器 —— 那时两侧的输入都出自 renderer
 * 自己的手,绿了只证明"翻译器与拼装器互相同意"(F11 判据污染)。
 *
 * 所以裁定改成**这一门**:
 *
 *   `canonical(手写拼装的 ChatMessage[])` ≡ `canonical(真账本 → core fold → 物化)`
 *
 * 账本从 `sessionEventsApi.listRaw` 拉回来 —— **全集原词汇,无翻译器**,门不喂自己。
 * (**必须是 `listRaw` 不是 `list`**:后者在出口按老七类再筛一道,是轨迹面板的词汇,
 * 折叠器要的开张事件全被筛掉 —— U1-b 真机首跑那条 `hand:6 / ledger:0` 就是它。)
 * 它证的是终局真正要的那句等式:**屏幕 ≡ 账本**。
 *
 * **接受的代价**(裁定明写):两侧不再共享输入,于是"管子丢了一段"与"拼装器算错"
 * 在这道门里**同色**。故障定位留给 B 落地之后的两消费者对拍(原 U1-b 字面形态)。
 *
 * ## 只在收尾比
 *
 * 流中 renderer 手里没有账本可读(账本是主进程写的),所以**只在收尾**
 * (`stream:complete` / `error` / `aborted` 到达后节流一拍)比一次。流中那一档随 B。
 *
 * ## 采样与体积闸(必做)
 *
 * 拉的是**整份**账本(`sessionEvents.listRaw` 与老 `list` 一样没有分页,留账见
 * §17.5),所以两道闸:
 *
 *  - **采样**:每会话每 `UI_REFOLD_EVERY` 次收尾采一次,**首次必采**(与主进程
 *    `refold.ts` 同款,同一条理由:一条只跑了一轮的会话也该被看一眼);
 *  - **体积闸**:①**拉之前**看手写侧的消息条数(免费),超 `UI_REFOLD_MAX_MESSAGES`
 *    直接跳过并计数;②**拉回来之后**看事件条数与**字节数**,超
 *    `UI_REFOLD_MAX_EVENTS` / `UI_REFOLD_MAX_BYTES` 就把这条会话记成"过大",
 *    **此后永不再采**。第 ② 道是"付一次学费换永久跳过" —— 体积只有拉过才知道,
 *    而 48MB 的账本每次收尾拉一遍是不可接受的。
 *
 *    **字节这一格是真机量出来的,不是拍的**:434 本真账本里,最大那本 50.4MB 却
 *    只有 258 条事件、258 条消息 —— 条数闸(消息 300 / 事件 5000)**两道都拦不住
 *    它**(超事件闸的只有 5/434)。体积与条数不相关,相关的是事件里内联的正文,
 *    所以判据必须落在字节上。称重本身要钱(整份 `JSON.stringify`),于是**每条会话
 *    只称一次**:称过合格就记进 `weighed`,以后不再称。
 *
 * ## overlay 车道不进对拍(§17.8 前置批裁定)
 *
 * 两类东西**按定义**不在消息树上,因此两道门都不比它们:占位型瞬态
 * (`image-loading`:追加即撤,append-only 表达不了)与本地错误卡
 * (`addLocalMessage`:它说的正是"这条没能到达账本")。它们住在
 * `stores/session-overlays.ts` 那条显式车道里。
 *
 * ## 两条具名豁免(各配一只反证)+ 两条已撤
 *
 * 1. **`data-steps` 渲染锚点**(G4):`canonicalChatMessage` 自己就把它丢掉
 *    (`canonical.ts` 的 `isRenderAnchorPart`)。裁定要求"两侧同过 core
 *    `render-anchors` 再比" —— 这里两侧都不做二次合成,因为**同一把尺已经把它
 *    归一了**(纪律 10:判据只有一把尺,不许在尺之外再加一层归一)。反证见测试:
 *    绕开 canonical 直接比,锚点当场把两侧比红。
 * 2. ~~**已结算 `plugin-status`**~~ **豁免已撤(§17.8 前置批,留账 #10 结清)**:
 *    结算态从此有产地(结算那一刻经单门写 `plugin/status`,唯一生产者是后台
 *    子代理指示器),折叠侧把它物化在这一轮正文之后 —— 两侧从此该逐格相等,
 *    比不上就是**真失配**。
 * 3. **`attachments`**(施工中发现,待追认):账本里的附件是 `BlobRef`
 *    (`{hash,bytes,mime}`,§10.1 G8),物化时由**宿主注入的 blob 读取口**换回真身
 *    —— 而 renderer 没有那个口(blob 在主进程的 `sessions/<id>/blobs/`)。于是带
 *    附件的消息两侧必然不同,且那**不是** bug。同样具名排除,反证同款。
 * 4. ~~**`tool-call` 渲染锚点**~~ **已归并进尺子(§17.7 #4,留账 18 结清)**:
 *    canonical 的 G4 从此认两种锚点形状,S 线与 U 线同一把尺,这里不再自己排除。
 *    原文如下:工具行的锚点有**两种形状**,
 *    core 自己把它们并列写在一处(`session/render-anchors.ts:39`
 *    `hasCoreRenderToolAnchor`:`data-steps` 或 `tool-call`)。流式期间手写侧当场
 *    落一个 `tool-call` 块;从账本重放时 `synthesizeCoreToolAnchors` 合成的是
 *    `data-steps`,并且**明文不去冲掉** live 的那一个(同文件 119-120 行,理由是
 *    冲掉会让工具行 remount)。也就是说"live 一种、重放另一种"是**设计**,不是失配
 *    —— 两侧的工具事实(`toolCalls` / `steps`)照比不误,反证就是这一条:把锚点排除
 *    之后,工具剧本两侧逐格相等。
 *    尺子只丢了两者中的一个(`canonical.ts:103` 的 `isRenderAnchorPart` 只认
 *    `data-steps`),因为 S 线的影子是**折 vs 折**,两侧都不会有 live 的 `tool-call`;
 *    ui-refold 是第一个把 live 侧摆上台的门。**是否该由 G4 把 `tool-call` 一并收进去
 *    (改的是 S 线共用的那把尺),挂裁定** —— 在那之前,具名排除在本门内。
 *
 * ## 纪律
 *
 * **永不抛进渲染路径**:所有出口 try/catch 自吞(与 `account-shadow` / `refold`
 * 同款)。门算错了最坏是账记歪,绝不能是聊天挂掉。失配走
 * `getLogger('renderer.ui-refold')` 一行摘要,计数在
 * `window.__onethingUiRefold.stats()`(日志同时进 hub 的环,`window.__onethingLog.dump()`
 * 看得到)。
 */

import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { materializeChatMessages } from '@onething/core/session/projection/chat-messages'
import { canonicalChatMessage } from '@onething/core/session/projection/canonical'
import { sessionEventsApi } from '@/platform/session-events-client'
// `onSessionBlobLoaded`(正文迟到之后重物化)是 **U2-a 切换那批**的订阅点:
// 今天 fold 只喂门,门在收尾时才物化一次,迟到的正文下一次物化自然带上。
import { createSessionBlobResolver } from '@/stores/session-blobs'
import { overlayLocalMessageIds } from '@/stores/session-overlays'
import { flushFoldTreePush, isFoldTreeEnabled } from '@/stores/fold-tree'
import { getLogger } from '@/services/log'
import type { ChatMessage } from '@/types'

const log = getLogger('renderer.ui-refold')

/** 每会话每 N 次收尾采一次(首次必采)。与主进程 `refold.ts` 同款默认。 */
export const UI_REFOLD_EVERY = 5
/** 拉之前的免费闸:手写侧消息条数超它就不拉。 */
export const UI_REFOLD_MAX_MESSAGES = 300
/** 拉回来之后的学费闸:事件条数超它,这条会话此后永不再采。 */
export const UI_REFOLD_MAX_EVENTS = 5000
/** 同一道学费闸的**字节**那一半(真机量出来的那条 50MB/258 事件的账本走这里)。 */
export const UI_REFOLD_MAX_BYTES = 4_000_000
/**
 * 活账本(B 期新管)漏序之后**重折的节流**:同一条会话最多这么频繁地整份重拉一次。
 *
 * 漏序不补拼(无快照裁定):缺号就把整会话经 `listRaw` 重折一遍。重折要整份拉,
 * 所以必须有节流 —— 一条抖动的连接不该把账本拉成风暴。窗口内再缺号只记一次,
 * 到点合并成一次重折。
 */
export const UI_REFOLD_LIVE_REFOLD_MS = 3000

export interface UiRefoldStats {
  /** 真的比过几次(`mismatches = 0` 那句话的分母)。 */
  checks: number
  /** 两侧对不上的次数。测试与真机观察窗口都盯它。 */
  mismatches: number
  /** 采样跳过。 */
  skippedSampled: number
  /** 消息条数超闸(拉都没拉)。 */
  skippedTooManyMessages: number
  /** 账本过大(条数或字节),这条会话已被永久跳过。 */
  skippedOversized: number
  /** 账本里一条事件都没有(legacy 会话 / 还没记账)。 */
  skippedNoLedger: number
  /** 出错自吞的次数(门自己坏了,不该影响任何人)。 */
  errors: number
  /** 第二道门:**两消费者对拍**(手写拼装 vs 新管实时折)比过几次。 */
  liveChecks: number
  /** 两消费者对不上的次数。 */
  liveMismatches: number
  /** 新管收到的账本行数(真机上"管子通没通"的读数)。 */
  liveEvents: number
  /** 检出缺号几次(每次都会安排一次重折)。 */
  liveGaps: number
  /** 因缺号 / 中途入场而整份重折了几次。 */
  liveRefolds: number
  /** 新路上跳过的"自比"次数(屏幕就是活折物化的,比它没有信息)。 */
  liveSkippedSelfCompare: number
}

function emptyStats(): UiRefoldStats {
  return {
    checks: 0,
    mismatches: 0,
    skippedSampled: 0,
    skippedTooManyMessages: 0,
    skippedOversized: 0,
    skippedNoLedger: 0,
    errors: 0,
    liveChecks: 0,
    liveMismatches: 0,
    liveEvents: 0,
    liveGaps: 0,
    liveRefolds: 0,
    liveSkippedSelfCompare: 0,
  }
}

const stats = emptyStats()
const settleCounts = new Map<string, number>()
const oversized = new Set<string>()
/** 称过体重且合格的会话 —— 称重本身要钱,一条只称一次。 */
const weighed = new Set<string>()

/** 总闸。主进程的 `ONETHING_SESSION_SHADOW` 在 renderer 里看不见(留账见文档), */
/** 所以这里镜像它的默认值(开),并留一个现场开关给排障用。 */
function isEnabled(): boolean {
  const handle = (globalThis as { __onethingUiRefold?: { enabled?: boolean } }).__onethingUiRefold
  return handle?.enabled !== false
}

/** 这次收尾要采样吗(第 1、1+N、1+2N… 次)。 */
function shouldSample(sessionId: string): boolean {
  const seen = (settleCounts.get(sessionId) ?? 0) + 1
  settleCounts.set(sessionId, seen)
  return (seen - 1) % UI_REFOLD_EVERY === 0
}

// ============ 判据 ============

type AnyRecord = Record<string, unknown>

/**
 * 拿掉具名豁免里**尺子管不到**的那一条(附件),外加 overlay 车道那一格
 * (`image-loading`)—— 见文件头。
 *
 * `data-steps` 不在这里 —— `canonicalChatMessage` 自己就丢它,再拿掉一次就是在
 * 尺子之外加了第二层归一(纪律 10)。
 */
function stripNamedExemptions(message: ChatMessage): AnyRecord {
  const { attachments: _attachments, ...rest } = message as unknown as AnyRecord
  const parts = (rest.contentParts as AnyRecord[] | undefined)?.filter(part => !(
    // **overlay 车道**(§17.8 前置批):占位型瞬态不是消息树的一部分,账本上
    // 按定义没有它(追加即撤)。这不是豁免一格事实,是车道划分。
    part?.type === 'image-loading'
  ))
  if (parts) rest.contentParts = parts
  return rest
}

/**
 * 对外的归一口(U2-a 的新旧路对拍用它)—— **同一把尺**,不许有第二份。
 */
export function canonicalizeTreeForCompare(
  messages: readonly ChatMessage[],
  sessionId?: string,
): unknown[] {
  return canonicalSide(messages, sessionId)
}

/**
 * `sessionId` 给的是 **overlay 车道**的地址:本地错误卡(`addLocalMessage`)是
 * 渲染层自己的东西 —— 它说的正是"这条消息没能到达账本",所以账本上永远没有它。
 * 摘掉它不是豁免一格事实,是**它不在被比的那棵树上**。
 */
function canonicalSide(
  messages: readonly ChatMessage[],
  sessionId?: string,
): unknown[] {
  const localIds = sessionId ? overlayLocalMessageIds(sessionId) : undefined
  const tree = localIds?.size
    ? messages.filter(message => !localIds.has(message.id))
    : messages
  return tree.map(message => canonicalChatMessage(stripNamedExemptions(message)))
}

/**
 * 一段账本 → core 折叠 → 物化(与主进程走的是同一台 reducer、同一个物化口)。
 *
 * `sessionId` 给的是 **blob 解析器**的地址(U2-a0):超 64KB 的正文在账本里只有
 * `BlobRef`,换回真身要读主进程的 `blobs/` 目录。不给 sessionId 就没有解析器,
 * 那一格照实留引用(`onMissing:'keep'`)—— 判据测试喂夹具时走的正是这一档。
 */
export function foldLedgerMessages(
  events: readonly unknown[],
  sessionId?: string,
): ChatMessage[] {
  let state = createSessionProjectionState()
  for (const event of events) state = reduceSessionProjection(state, event as never)
  return materializeChatMessages(
    state,
    sessionId ? { resolveBlob: createSessionBlobResolver(sessionId) } : {},
  ).messages as unknown as ChatMessage[]
}

/**
 * ============ 新管:活账本折叠(B 期,§17.8)============
 *
 * U1-b 的**字面形态**在这里复活:同一批事实喂两个消费者 —— 手写拼装管道、
 * core 折叠器 —— 然后对拍。B 期之前它造不出来(UI 事件流没有折叠器要的词汇,
 * 硬做就得在 renderer 里写翻译器 = 门喂自己);现在推送面直接下发**账本原词汇**
 * (`session:ledger-event`),两侧的输入终于同源而且都不出自渲染层的手。
 *
 * 与"收尾拉 `listRaw` 对拍"是**互补**的两道:
 *
 *  - 拉 `listRaw`:屏幕 ≡ **耐久账本**(证的是落盘那份对);
 *  - 活折对拍:  屏幕 ≡ **推送面实时喂出来的那份**(证的是管子那份对)。
 *
 * 两道同时绿,才叫"管子没丢段、拼装器也没算错" —— 这正是 U1-b 当初被迫接受的
 * 那个"同色代价"的解药。
 */

interface LiveFold {
  state: ReturnType<typeof createSessionProjectionState>
  /** 已折进去的最后一条 seq。0 = 还没起底。 */
  lastSeq: number
  /** 起底/重折还没完成时,新到的行一律丢掉(重折读的整份账本里本来就有它们)。 */
  pending: boolean
  /** 上次重折的时刻(节流)。 */
  lastRefoldAt: number
  /** 已排了一次重折(窗口内再缺号不再排第二次)。 */
  refoldScheduled: boolean
}

const liveFolds = new Map<string, LiveFold>()

function newLiveFold(): LiveFold {
  return {
    state: createSessionProjectionState(),
    lastSeq: 0,
    pending: true,
    lastRefoldAt: 0,
    refoldScheduled: false,
  }
}

/**
 * 新管来了一条账本行。
 *
 * 三种情况:
 *  - **接得上**(`seq === lastSeq + 1`):当场折进去,零拷贝零节流 —— 账本行本身
 *    就是打包过的(`assistant/chunks` 一行一段 delta),不需要第二套合批。
 *  - **旧行**(`seq <= lastSeq`):重折之后追上来的回声,丢掉(幂等)。
 *  - **缺号 / 中途入场**:**不补拼**(无快照裁定),整会话经 `listRaw` 重折,
 *    节流见 `UI_REFOLD_LIVE_REFOLD_MS`。
 */
export function feedUiRefoldLedgerEvent(sessionId: string, record: unknown): void {
  try {
    if (!isEnabled()) return
    const seq = (record as { seq?: unknown })?.seq
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return
    stats.liveEvents += 1

    let fold = liveFolds.get(sessionId)
    if (!fold) {
      fold = newLiveFold()
      liveFolds.set(sessionId, fold)
      // 中途入场(页面开在会话中间)= 天然缺号:seq 1 之外的第一条一律先重折。
      if (seq !== 1) {
        scheduleLiveRefold(sessionId, fold)
        return
      }
      fold.pending = false
    }

    if (fold.pending) return
    if (seq <= fold.lastSeq) return
    if (seq !== fold.lastSeq + 1) {
      stats.liveGaps += 1
      scheduleLiveRefold(sessionId, fold)
      return
    }

    fold.state = reduceSessionProjection(fold.state, record as never)
    fold.lastSeq = seq
  } catch (error) {
    stats.errors += 1
    log.debug('ui-refold live feed failed', { sessionId }, error)
  }
}

/**
 * 把活折**追到这份账本的末尾**(门在比之前用它对齐时刻)。
 *
 * 只折 `seq > lastSeq` 的那几条 —— 已经折过的天然幂等地跳过,不重折整份。
 */
function catchUpLiveFold(sessionId: string, events: readonly unknown[]): void {
  const fold = liveFolds.get(sessionId)
  if (!fold || fold.pending) return
  for (const event of events) {
    const seq = (event as { seq?: number }).seq
    if (typeof seq !== 'number' || seq <= fold.lastSeq) continue
    fold.state = reduceSessionProjection(fold.state, event as never)
    fold.lastSeq = seq
  }
}

/** 缺号之后的整份重折 —— 节流,窗口内合并成一次。 */
function scheduleLiveRefold(sessionId: string, fold: LiveFold): void {
  fold.pending = true
  if (fold.refoldScheduled) return
  fold.refoldScheduled = true
  const wait = Math.max(0, fold.lastRefoldAt + UI_REFOLD_LIVE_REFOLD_MS - Date.now())
  setTimeout(() => {
    void runLiveRefold(sessionId)
  }, wait)
}

async function runLiveRefold(sessionId: string): Promise<void> {
  const fold = liveFolds.get(sessionId)
  if (!fold) return
  fold.refoldScheduled = false
  fold.lastRefoldAt = Date.now()
  try {
    const { events } = await sessionEventsApi.listRaw({ sessionId })
    let state = createSessionProjectionState()
    let lastSeq = 0
    for (const event of events ?? []) {
      state = reduceSessionProjection(state, event as never)
      const seq = (event as { seq?: number }).seq
      if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq
    }
    fold.state = state
    fold.lastSeq = lastSeq
    fold.pending = false
    stats.liveRefolds += 1
    // 起底/重折完成 = 屏幕那棵树此刻才有底,马上推一次(新路上会话打开走的
    // 正是这条路;不推的话打开会话是空白 —— 排队那一次发生在起底之前)。
    flushFoldTreePush(sessionId)
  } catch (error) {
    // 重折失败:保持 pending,下一条缺号会再排一次(节流仍然生效)。
    stats.errors += 1
    log.debug('ui-refold live refold failed', { sessionId }, error)
  }
}

/** 这条会话有活折了吗(起底完成 = 可以拿它当屏幕上那棵树的底)。 */
export function hasUiRefoldLiveFold(sessionId: string): boolean {
  const fold = liveFolds.get(sessionId)
  return Boolean(fold && !fold.pending && fold.lastSeq > 0)
}

/**
 * 起底(U2-a):会话被打开时把整份账本折一遍。**幂等**:已经有活折就什么都不做,
 * 正在起底也不重复排队 —— 复用缺号那条重折路,只是理由不同。
 */
export function ensureUiRefoldLiveFold(sessionId: string): void {
  if (!sessionId) return
  const fold = liveFolds.get(sessionId)
  if (fold && !fold.pending) return
  if (fold) {
    scheduleLiveRefold(sessionId, fold)
    return
  }
  const created = newLiveFold()
  liveFolds.set(sessionId, created)
  scheduleLiveRefold(sessionId, created)
}

/** 屏幕那棵树的底(U2-a 的取数口)。还没起底 = `undefined`。 */
export function getUiRefoldLiveMessages(sessionId: string): ChatMessage[] | undefined {
  return liveMessages(sessionId)
}

/**
 * 这条会话此刻有没有在跑的 run(U2-a 的**等待指示**由它派生,而不是靠流里那格
 * 瞬态 part —— 瞬态是 overlay 车道的东西,run 态是账本的事实)。
 */
export function getUiRefoldActiveRun(
  sessionId: string,
): { runId: string; messageId: string } | undefined {
  const fold = liveFolds.get(sessionId)
  if (!fold || fold.pending) return undefined
  return materializeChatMessages(fold.state).activeRun
}

/** 这条会话的活折此刻物化成什么样(还没起底时是 `undefined`)。 */
function liveMessages(sessionId: string): ChatMessage[] | undefined {
  const fold = liveFolds.get(sessionId)
  if (!fold || fold.pending || fold.lastSeq === 0) return undefined
  return materializeChatMessages(fold.state, {
    resolveBlob: createSessionBlobResolver(sessionId),
  }).messages as unknown as ChatMessage[]
}

/** 会话没了就把它的活折一起丢掉(测试与会话删除都用得上)。 */
export function forgetUiRefoldLiveFold(sessionId: string): void {
  liveFolds.delete(sessionId)
}

export interface UiRefoldDiffEntry {
  path: string
  a?: string
  b?: string
}

const DIFF_MAX_ENTRIES = 12
const DIFF_VALUE_CHARS = 120

function short(value: unknown): string {
  if (value === undefined) return '(absent)'
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) return '(absent)'
  return text.length > DIFF_VALUE_CHARS ? `${text.slice(0, DIFF_VALUE_CHARS)}…(${text.length})` : text
}

function isPlainRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 字段级深比较:**先比再记**(相等是热路径上最常见的结局)。 */
function collectDiff(a: unknown, b: unknown, at: string, out: UiRefoldDiffEntry[]): boolean {
  if (out.length >= DIFF_MAX_ENTRIES) return false
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    let equal = a.length === b.length
    if (!equal) out.push({ path: `${at}.length`, a: short(a.length), b: short(b.length) })
    const max = Math.min(a.length, b.length)
    for (let index = 0; index < max; index++) {
      if (!collectDiff(a[index], b[index], `${at}.${index}`, out)) equal = false
    }
    return equal
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    let equal = true
    for (const key of keys) {
      if (!collectDiff(a[key], b[key], at ? `${at}.${key}` : key, out)) equal = false
    }
    return equal
  }
  out.push({ path: at || '(root)', a: short(a), b: short(b) })
  return false
}

export interface UiRefoldComparison {
  match: boolean
  diff: UiRefoldDiffEntry[]
  handCount: number
  ledgerCount: number
}

/**
 * **纯判据**(测试直接吃它):手写拼装 vs 账本折,两侧都过同一把尺。
 *
 * `a` 侧 = 真相(账本折出来的),`b` 侧 = 验证器(屏幕上那份)—— 与 F0 之后
 * 全线的方向标记一致。
 */
export function compareUiRefold(
  handMessages: readonly ChatMessage[],
  ledgerEvents: readonly unknown[],
  sessionId?: string,
): UiRefoldComparison {
  const ledger = canonicalSide(foldLedgerMessages(ledgerEvents, sessionId))
  const hand = canonicalSide(handMessages, sessionId)
  const diff: UiRefoldDiffEntry[] = []
  const match = collectDiff(ledger, hand, '', diff)
  return { match, diff, handCount: handMessages.length, ledgerCount: ledger.length }
}

// ============ 挂点 ============

/**
 * 收尾之后采一次样。**同步段里只做判定**(便宜),真比对丢进宏任务 —— 不占
 * 收尾路径,也让 store 先把这一轮落定。
 */
export function scheduleUiRefold(
  sessionId: string,
  readMessages: (sessionId: string) => readonly ChatMessage[],
): void {
  try {
    if (!isEnabled()) return
    // 采样只管**拉账本**那一道(它要整份传输)。**两消费者对拍不采样** ——
    // 活折就在内存里,比一次只有物化 + 逐格比,没有传输那一笔。
    const alreadyOversized = oversized.has(sessionId)
    const sampled = shouldSample(sessionId)
    if (alreadyOversized) stats.skippedOversized += 1
    else if (!sampled) stats.skippedSampled += 1
    const pull = sampled && !alreadyOversized
    setTimeout(() => {
      void runUiRefold(sessionId, readMessages, pull)
    }, 0)
  } catch (error) {
    stats.errors += 1
    log.debug('ui-refold scheduling failed', { sessionId }, error)
  }
}

function markOversized(sessionId: string, why: Record<string, number>): void {
  oversized.add(sessionId)
  stats.skippedOversized += 1
  log.debug('ui-refold: ledger too large, session skipped from now on', { sessionId, ...why })
}

/** 整份称重。称不动(循环引用之类)就当"过大" —— 门宁可少比,不可拖住页面。 */
function approximateBytes(events: readonly unknown[]): number {
  try {
    return JSON.stringify(events)?.length ?? Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * 第二道门:**两消费者对拍**。
 *
 * 一侧是手写拼装管道(屏幕上那份),另一侧是新管实时喂出来的 core 折叠。判据、
 * 豁免、方向标记与另一道完全一致(同一把尺,纪律 10)——差别只在"账本从哪来":
 * 一个是耐久文件,一个是推送面。
 */
function compareAgainstLiveFold(
  sessionId: string,
  handMessages: readonly ChatMessage[],
): void {
  // **U2-a 之后这道门退化为自比**:屏幕上那棵树本身就是活折物化出来的
  // (`fold-tree.ts`),再拿它跟活折比等于"自己跟自己相等",恒绿而无信息。
  // 所以新路上**停掉**这一道;另一道(收尾拉 `listRaw` 对拍耐久账本)反向留任,
  // 它现在守的正是转正后的新路。旧路(开关翻回)上它照旧是那道两消费者对拍。
  if (isFoldTreeEnabled()) {
    stats.liveSkippedSelfCompare += 1
    return
  }
  const live = liveMessages(sessionId)
  if (!live) return
  const ledger = canonicalSide(live, sessionId)
  const hand = canonicalSide(handMessages, sessionId)
  const diff: UiRefoldDiffEntry[] = []
  const match = collectDiff(ledger, hand, '', diff)
  stats.liveChecks += 1
  if (match) return
  stats.liveMismatches += 1
  log.warn('ui-refold live mismatch', {
    sessionId,
    hand: handMessages.length,
    live: live.length,
    diff,
  })
}

async function runUiRefold(
  sessionId: string,
  readMessages: (sessionId: string) => readonly ChatMessage[],
  pull: boolean,
): Promise<void> {
  try {
    const handMessages = readMessages(sessionId)
    if (handMessages.length === 0) return
    // 第一道:**两消费者对拍**(手写拼装 vs 新管实时折)。不拉账本,所以不采样;
    // 只受消息条数闸约束(比一次的成本与条数成正比)。
    if (handMessages.length <= UI_REFOLD_MAX_MESSAGES) {
      compareAgainstLiveFold(sessionId, handMessages)
    }
    if (!pull) return
    if (handMessages.length > UI_REFOLD_MAX_MESSAGES) {
      // 免费闸:拉都不拉(消息条数与账本体积强相关)。
      stats.skippedTooManyMessages += 1
      return
    }

    // **全集原词汇**(`listRaw`,不是 `list`):`list` 在出口按老七类再筛一道,
    // 折叠器要的开张事件全被筛掉,真机上折出来恒为空树 —— U1-b 首跑真机那条
    // `hand:6 / ledger:0` 就是它(诊断见 `docs/audit/web-lane-sse-diagnosis-2026-08-28.md`)。
    const { events } = await sessionEventsApi.listRaw({ sessionId })
    if (!events || events.length === 0) {
      stats.skippedNoLedger += 1
      return
    }
    if (events.length > UI_REFOLD_MAX_EVENTS) {
      // 学费闸:体积只有拉过才知道 —— 付一次,此后永久跳过这条会话。
      markOversized(sessionId, { events: events.length })
      return
    }
    if (!weighed.has(sessionId)) {
      // 称一次体重(条数不代表体积,见文件头)。合格的记下来,以后不再称。
      const bytes = approximateBytes(events)
      if (bytes > UI_REFOLD_MAX_BYTES) {
        markOversized(sessionId, { bytes })
        return
      }
      weighed.add(sessionId)
    }

    // 新路上屏幕是**按帧推**的,而这里刚从盘上读回了此刻的全份账本 —— 先把活折
    // 追到文件那一刻、把屏幕强推一次,再比。不这样的话比到的是"上一帧的屏幕"对
    // "此刻的文件",最后那一两格(usage / isStreaming)会被记成失配,而它其实只是
    // 一帧的时差。
    let compared = handMessages
    if (isFoldTreeEnabled()) {
      catchUpLiveFold(sessionId, events as unknown[])
      flushFoldTreePush(sessionId)
      compared = readMessages(sessionId)
    }
    const result = compareUiRefold(compared, events as unknown[], sessionId)
    stats.checks += 1
    if (result.match) return

    stats.mismatches += 1
    log.warn('ui-refold mismatch', {
      sessionId,
      hand: result.handCount,
      ledger: result.ledgerCount,
      diff: result.diff,
    })
  } catch (error) {
    // 纪律:永不抛进渲染路径。
    stats.errors += 1
    log.debug('ui-refold check failed', { sessionId }, error)
  }
}

/** 现场:`window.__onethingUiRefold.stats()`(日志同时进 hub 的环)。 */
export function getUiRefoldStats(): UiRefoldStats {
  return { ...stats }
}

/** 仅测试:忘掉采样计数、过大名单与读数。 */
export function resetUiRefold(): void {
  settleCounts.clear()
  oversized.clear()
  weighed.clear()
  liveFolds.clear()
  Object.assign(stats, emptyStats())
}

/** 装现场把手(`initializeIPCHub` 调一次)。 */
export function installUiRefoldHandle(): void {
  try {
    const target = globalThis as {
      __onethingUiRefold?: { enabled?: boolean; stats: () => UiRefoldStats }
    }
    const existing = target.__onethingUiRefold
    target.__onethingUiRefold = {
      ...(existing?.enabled !== undefined ? { enabled: existing.enabled } : {}),
      stats: getUiRefoldStats,
    }
  } catch {
    // 现场把手装不上不影响门本身。
  }
}
