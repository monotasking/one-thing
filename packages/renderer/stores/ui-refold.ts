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
 * ## 四条具名豁免(各配一只反证)
 *
 * 1. **`data-steps` 渲染锚点**(G4):`canonicalChatMessage` 自己就把它丢掉
 *    (`canonical.ts` 的 `isRenderAnchorPart`)。裁定要求"两侧同过 core
 *    `render-anchors` 再比" —— 这里两侧都不做二次合成,因为**同一把尺已经把它
 *    归一了**(纪律 10:判据只有一把尺,不许在尺之外再加一层归一)。反证见测试:
 *    绕开 canonical 直接比,锚点当场把两侧比红。
 * 2. **已结算 `plugin-status`**:`isEphemeralContentPart` 只认**未结算**那一条
 *    (`durationMs === undefined`),结算之后它要参与比较 —— 而它**写侧零生产者**
 *    (§17.7.2 四-2:`plugin/status` 只有词表条目,没有任何采集点)。账本里永远
 *    没有它,手写侧永远有它。**具名排除,指针挂留账 #10;#10 补完即撤。**
 * 3. **`attachments`**(施工中发现,待追认):账本里的附件是 `BlobRef`
 *    (`{hash,bytes,mime}`,§10.1 G8),物化时由**宿主注入的 blob 读取口**换回真身
 *    —— 而 renderer 没有那个口(blob 在主进程的 `sessions/<id>/blobs/`)。于是带
 *    附件的消息两侧必然不同,且那**不是** bug。同样具名排除,反证同款。
 * 4. **`tool-call` 渲染锚点**(施工中发现,待追认):工具行的锚点有**两种形状**,
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
 * 拿掉四条具名豁免里**尺子管不到**的那三条(见文件头)。
 *
 * `data-steps` 不在这里 —— `canonicalChatMessage` 自己就丢它,再拿掉一次就是在
 * 尺子之外加了第二层归一(纪律 10)。
 */
function stripNamedExemptions(message: ChatMessage): AnyRecord {
  const { attachments: _attachments, ...rest } = message as unknown as AnyRecord
  const parts = (rest.contentParts as AnyRecord[] | undefined)?.filter(part => !(
    (part?.type === 'plugin-status' && part?.durationMs !== undefined)
    // 工具渲染锚点的**第二种形状**(见文件头豁免 4)。
    || part?.type === 'tool-call'
  ))
  if (parts) rest.contentParts = parts
  return rest
}

function canonicalSide(messages: readonly ChatMessage[]): unknown[] {
  return messages.map(message => canonicalChatMessage(stripNamedExemptions(message)))
}

/** 一段账本 → core 折叠 → 物化(与主进程走的是同一台 reducer、同一个物化口)。 */
export function foldLedgerMessages(events: readonly unknown[]): ChatMessage[] {
  let state = createSessionProjectionState()
  for (const event of events) state = reduceSessionProjection(state, event as never)
  return materializeChatMessages(state).messages as unknown as ChatMessage[]
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
): UiRefoldComparison {
  const ledger = canonicalSide(foldLedgerMessages(ledgerEvents))
  const hand = canonicalSide(handMessages)
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
    if (oversized.has(sessionId)) {
      stats.skippedOversized += 1
      return
    }
    if (!shouldSample(sessionId)) {
      stats.skippedSampled += 1
      return
    }
    setTimeout(() => {
      void runUiRefold(sessionId, readMessages)
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

async function runUiRefold(
  sessionId: string,
  readMessages: (sessionId: string) => readonly ChatMessage[],
): Promise<void> {
  try {
    const handMessages = readMessages(sessionId)
    if (handMessages.length === 0) return
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

    const result = compareUiRefold(handMessages, events as unknown[])
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
