import { useMemo } from 'react'
import { create } from 'zustand'
import type { SessionTokenUsageReadout } from '@shared/ipc/sessions'
import type { GetSessionUsageResponse } from '@shared/ipc/usage'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { chatPort } from './chat-port'
import { meterPort } from './meter-port'
import { contextWindowOf, useCurrentModelSelection, useModelsSource } from './models-source'

/**
 * 读数的**真数据源**(D2 波一):context 环与它悬停出来的四行明细,数从这里来。
 *
 * ── 一条铁律,四行都归它管 ──────────────────────────────────────────────
 * **只画真拿得到的数**(Vue 壳 `InputBox.vue:928-934` 的同一条裁定)。
 * 拿不到的那一格是**缺席**,不是 0 也不是「—」编出来的默认值:
 *  - 窗口不知道 → 环画成缺席态(见 `transitions.percent` 的 null 分支);
 *  - 缓存分母为 0(这一轮一次缓存都没读过)→ 整行不画;
 *  - 厂商没报价 → 那一行不出现(报了才多一行,永不替换本地估算);
 *  - 没有会话(首开草稿态)→ 四行全缺席,一个数都不编。
 * 「省了多少钱」这一格在**整仓没有产地**(勘察第 40 条),所以它连同 i18n 里
 * 那半句话一起被删掉了 —— 编一个省钱数字是这张卡上最贵的一句谎。
 *
 * ── 两个产地,一次往返各拿一半 ──────────────────────────────────────────
 *  - `usage.getSession` → tokens ↑↓ 与三种成本;
 *  - `sessions.getTokenUsage` → contextSize / lastInputTokens。
 * 第三个数(模型窗口)在 provider 目录里,归 models-source ——
 * 这里只在拼视图时问它一句(`contextWindowOf`)。
 *
 * ── 刷新时机(三处,不多不少) ──────────────────────────────────────────
 *  1. 会话切换:`open(sessionId)` 拉一次;
 *  2. 账本说这一轮完了(`run/end`)或压缩过了(`session/compacted`):再拉;
 *  3. 悬停开卡:再拉一次(Vue 壳 `InputBox.vue:865-898` 的判例 —— 卡打开的
 *     那一眼要是最新的)。
 * **不订 stream 分片**:读数是每轮结账一次的东西,跟着 delta 走等于每秒几十次
 * 无谓往返。事件订阅是**自己一条**(`chatPort().onSessionEvent` 支持多订阅者),
 * 不去 chat-source 里搭车 —— 折叠器不该长出第二个职责。
 */

/** 一条会话此刻的读数事实。两半各自可缺席 —— 一半失败不该把另一半也抹掉。 */
export interface MeterFacts {
  sessionId: string
  tokens: SessionTokenUsageReadout | null
  usage: GetSessionUsageResponse | null
}

/** 屏幕要的六格。**每一格都可以是 null,null 就是「不知道」。** */
export interface MeterView {
  /** 有没有任何一格拿到了。false = 整张卡与环都是缺席态。 */
  present: boolean
  /** 这一轮送进模型的 token。 */
  contextUsed: number | null
  /** 模型窗口(provider 目录里的 context_length)。 */
  contextMax: number | null
  tokensIn: number | null
  tokensOut: number | null
  /** 本地估算的本会话计费。 */
  costUsd: number | null
  /** 厂商自己报的价(OpenRouter / xAI 才有)。**与上面那格并存,不覆盖**。 */
  providerCostUsd: number | null
  /** 命中率(整数百分比)。分母为 0 = null = 这一行不画。 */
  cacheHitPct: number | null
}

export const EMPTY_VIEW: MeterView = {
  present: false,
  contextUsed: null,
  contextMax: null,
  tokensIn: null,
  tokensOut: null,
  costUsd: null,
  providerCostUsd: null,
  cacheHitPct: null,
}

/* ── 纯判据 ────────────────────────────────────────────────────────────── */

/** 非有限数 / 负数一律读作缺席。**0 是真值** —— 一条没跑过的会话就该说 0。 */
function readCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

/**
 * 这一轮送进去多少 token。产地是两格里**大的那个**:
 * `max(contextSize, lastInputTokens)` —— 与 core 自己的口径逐字相同
 * (`packages/core/engine/context-usage.ts` 的 `providerInputTokens`)。
 * 压缩刚发生时 contextSize 已经落回来了而 lastInputTokens 还是压缩前的那次,
 * 取大的那个才是「模型这一轮真的看见了多少」。
 */
export function contextUsedOf(tokens: SessionTokenUsageReadout | null): number | null {
  if (!tokens) return null
  const size = readCount(tokens.contextSize)
  const last = readCount(tokens.lastInputTokens)
  if (size === null) return last
  if (last === null) return size
  return Math.max(size, last)
}

/**
 * 缓存命中率 = 读缓存的 token / (读缓存 + 真送进去的输入)。
 * 分母为 0(这条会话一次都没读过缓存,也没送过输入)= null = **这一行不画**,
 * 而不是「命中率 0%」—— 那是两件事。
 */
export function cacheHitPctOf(usage: GetSessionUsageResponse | null): number | null {
  const read = readCount(usage?.usage?.cacheReadTokens)
  const input = readCount(usage?.usage?.inputTokens)
  const total = (read ?? 0) + (input ?? 0)
  if (read === null || total <= 0) return null
  return Math.round((read / total) * 100)
}

/** 金额:非有限数读作缺席;**0 是真值**(真的没花钱和不知道花没花是两件事)。 */
function readMoney(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * 事实 → 屏幕形状。`windowTokens` 由调用方从 models-source 问来(那是它的产地)。
 * `facts` 为 null(没有会话 / 还没拉过)= 整张卡缺席。
 */
export function meterViewOf(facts: MeterFacts | null, windowTokens: number | null): MeterView {
  if (!facts) return EMPTY_VIEW
  const usage = facts.usage
  const view: MeterView = {
    present: facts.tokens !== null || usage !== null,
    contextUsed: contextUsedOf(facts.tokens),
    contextMax: windowTokens !== null && windowTokens > 0 ? windowTokens : null,
    tokensIn: readCount(usage?.usage?.inputTokens),
    tokensOut: readCount(usage?.usage?.outputTokens),
    costUsd: readMoney(usage?.apiCostUSD),
    // 厂商报价只在**报了且大于 0** 时出现(Vue 壳 InputBox.vue:973-976 的同一条)。
    providerCostUsd: (readMoney(usage?.providerCostUSD) ?? 0) > 0
      ? readMoney(usage?.providerCostUSD)
      : null,
    cacheHitPct: cacheHitPctOf(usage),
  }
  return view
}

/** 账本里哪些行意味着「读数变了」。窄名单:每多一条都是一次多余的往返。 */
const REFRESH_ON = new Set(['run/end', 'session/compacted'])

/**
 * 这条推送是不是「读数变了」的信号。两道判断缺一不可:
 * 外层必须是**账本活事件**(别的推送里的 `record` 不是账本行),
 * 里层的行类型必须在那份窄名单上。
 */
export function isMeterInvalidation(event: { type?: string; record?: unknown } | null): boolean {
  if (event?.type !== SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT) return false
  const type = (event.record as { type?: string } | null)?.type
  return typeof type === 'string' && REFRESH_ON.has(type)
}

/* ── store ────────────────────────────────────────────────────────────── */

export type MeterStatus = 'idle' | 'loading' | 'ready'

export interface MeterSourceState {
  /** 当前会话;空串 = 没有会话(草稿态)。 */
  sessionId: string
  status: MeterStatus
  /** 手上这份读数**属于哪条会话** —— 换会话时靠它挡住陈值。 */
  facts: MeterFacts | null

  /** 换会话(null / 空串 = 没有会话):订上事件并拉一次。幂等。 */
  open: (sessionId: string | null) => Promise<void>
  /** 重新拉一次(悬停开卡与失效信号共用)。没有会话时是恒等。 */
  refresh: () => Promise<void>
  /** 测试用:回到干净态并退订。 */
  reset: () => void
}

export const useMeterSource = create<MeterSourceState>()((set, get) => {
  let unsubscribe: (() => void) | undefined
  /** 竞速令牌:换会话之后回来的那一份不许落地。 */
  let token = 0

  function onEvent(envelope: SessionEventEnvelope): void {
    if (envelope.sessionId !== get().sessionId) return
    // 账本活事件骑在 session:event 上;别的推送(流分片、状态)这里一概不看。
    if (!isMeterInvalidation(envelope.event as { type?: string; record?: unknown })) return
    void get().refresh()
  }

  async function fetchFacts(sessionId: string, mine: number): Promise<void> {
    const port = await meterPort()
    // 两口各兜各的:计费账本挂了不该把 context 那一格也变成不知道。
    const [usage, tokens] = await Promise.all([
      port.getSessionUsage(sessionId).catch(() => null),
      port
        .getTokenUsage(sessionId)
        .then((response) => (response.success ? (response.usage ?? null) : null))
        .catch(() => null),
    ])
    if (token !== mine || get().sessionId !== sessionId) return
    set({ status: 'ready', facts: { sessionId, tokens, usage } })
  }

  return {
    sessionId: '',
    status: 'idle',
    facts: null,

    open: async (sessionId) => {
      const next = sessionId ?? ''
      if (get().sessionId === next && get().status !== 'idle') return
      const mine = (token += 1)
      set({ sessionId: next, status: next ? 'loading' : 'idle', facts: null })
      if (!next) {
        unsubscribe?.()
        unsubscribe = undefined
        return
      }
      const port = await chatPort()
      await port.ready()
      if (token !== mine) return
      // 先订上再拉:拉的那一刻起的 run/end 不能漏(与 chat-source 同一条理由)。
      unsubscribe?.()
      unsubscribe = port.onSessionEvent(onEvent)
      await fetchFacts(next, mine)
    },

    refresh: async () => {
      const sessionId = get().sessionId
      if (!sessionId) return
      await fetchFacts(sessionId, (token += 1))
    },

    reset: () => {
      unsubscribe?.()
      unsubscribe = undefined
      token += 1
      set({ sessionId: '', status: 'idle', facts: null })
    },
  }
})

/* ── 组件侧 ────────────────────────────────────────────────────────────── */

/**
 * 屏幕上的六格 —— 环与明细卡共用这一个读法。
 *
 * 窗口那一格在这里才与 models-source 合流:读数不缓存窗口(缓存就会陈),
 * 每次现问一句目录。手上这份读数不属于当前会话时**当没有** ——
 * 换会话那一瞬间旧数还在 store 里,画出来就是别人的账。
 */
export function useMeterView(): MeterView {
  const facts = useMeterSource((st) => st.facts)
  const sessionId = useMeterSource((st) => st.sessionId)
  const catalog = useModelsSource((st) => st.catalog)
  // 会话 id 取**读数自己开着的那条** —— 它由 open() 跟着当前会话走,所以与总览
  // 同源;就地再读一次总览 store 只会多一条会漂的读法。
  const selection = useCurrentModelSelection(sessionId)
  return useMemo(() => {
    const mine = facts && facts.sessionId === sessionId ? facts : null
    return meterViewOf(mine, contextWindowOf(catalog, selection))
  }, [facts, sessionId, catalog, selection])
}
