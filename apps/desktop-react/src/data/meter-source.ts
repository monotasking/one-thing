import { useMemo } from 'react'
import { create } from 'zustand'
import type { SessionTokenUsageReadout } from '@shared/ipc/sessions'
import type { GetSessionUsageResponse } from '@shared/ipc/usage'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { createQueryFamily, useQuery } from './kernel'
import { chatPort } from './chat-port'
import { meterPort } from './meter-port'
import { useCurrentModelSelection, useModelWindow } from './models-source'

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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(09-01 用户令,施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 * 这不是一个组件,是一条**模块级的活线**,所以「宿主」这一栏答的是「谁在看」。
 *
 *  · 挂载    —— 模块被 import 的那一刻只建了一族空 query,**零往返、零订阅**;
 *  · 首载    —— `open(sessionId)`:等传输面 ready → 订上 `onSessionEvent` →
 *                `ensure()` 拉一次。先订后拉,不是随手排的:拉的那一刻起的
 *                `run/end` 不能漏(与 chat-source 同一条理由);
 *  · 换宿主  —— 换会话就是这条线唯一的一次「换宿主」:`open(next)` 退掉旧订阅、
 *                订上新的、`ensure()` 新那一格。**旧那一格的数留在它自己的格里**
 *                (键控),既不会串到新会话头上,回去时也还在;
 *  · 草稿态  —— `open(null)`:退订、不拉、不发一发请求。屏幕上是缺席态;
 *  · 卸载    —— `reset()`:退订 + 全族归零。HMR dispose 复用的就是它
 *                (模块级副作用必须配 dispose —— 那条法的起因是 chat-source 那一案)。
 *
 * ── ② UI 生命状态(屏幕上看得见的那几档)────────────────────────────────
 *  · empty    —— 没有会话 / 两口都没答上话 → `present:false` → 环画点线、
 *                卡上一行「还没有读数」。**一个数都不编**;
 *  · loading  —— 只有**首载**算(`phase === 'initial'` 且 `inflight`)。重拉期间
 *                旧读数**留在屏上**(律②),环不会闪回缺席态;
 *  · ready    —— 有过一次答案就永远是它,重拉不退回去;
 *  · error    —— **这条线没有 error 档**,而且是刻意的:两口各自 `.catch(() => null)`,
 *                一半失败落成那一格的「不知道」(缺席态),整发永不 reject。
 *                这与 kernel 的「错误与旧数据并存」是**两种观点**:kernel 那条说的是
 *                「拉不到时把上一份留在屏上,并把原话并陈」,而这里说的是
 *                「读数天生是两半,一半拿到了就该画一半」。取现状不改口径 ——
 *                改成抛出会让「账本挂了」把 context 那一格也一起抹成不知道,
 *                那正是这个文件从第一天起就在防的事(见下面 fetcher 里那句);
 *  · 超量     —— 不适用:这条线的答案是**六个标量**,没有可以变长的表。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * 这一层**自己没有控件**,交互态归它的两个消费者:
 *  · rest/hover/focus —— `ContextRing`(悬停 / 聚焦开卡,同一对入口);
 *  · pending          —— 刻意**不画**:读数的重拉是后台对账,给环加一圈转圈
 *                        正是律②要防的那种「刷新了就闪一下」;
 *  · disabled         —— 无。没有会话时环画缺席态,但仍可悬停(卡上说实话)。
 * ══════════════════════════════════════════════════════════════════════════
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

/* ── 取数:一族 query,键 = sessionId ────────────────────────────────────── */

/**
 * 读数的取数口。**键就是会话 id** —— 从前那套「竞速令牌 + `facts.sessionId ===
 * sessionId` 陈值门」两件事,在键控缓存里是同一件事的两个说法:一发回得再晚,
 * 它也只落进自己那一格,谁也串不到谁头上。两件手写的东西因此一起退役。
 *
 * 一条判据留在这里,因为它是**这一口的事实**,不是 kernel 的:
 * **两口各兜各的,整发永不 reject**。计费账本挂了不该把 context 那一格也变成
 * 不知道 —— 所以两个 `.catch(() => null)` 各兜各的,合出来的 facts 里
 * 「这一半没答上话」被表达成那一格是 null(缺席态),而不是整格失败。
 *
 * 这与 kernel 手册里「错误与旧数据并存」**是两种观点**,取现状不改口径:
 * kernel 那条答的是「拉不到的时候屏幕上留什么」,这里答的是「一发里有两半、
 * 其中一半拿到了算不算数」。抛出去会让整发进 error 档、两半一起退回上一份,
 * 那正是这个文件第一天就在防的事(既有用例「一半失败不该把另一半也抹掉」
 * 钉的就是它)。
 */
export const meterQuery = createQueryFamily<MeterFacts>('meter.facts', async (ctx) => {
  const port = await meterPort()
  const [usage, tokens] = await Promise.all([
    port.getSessionUsage(ctx.key).catch(() => null),
    port
      .getTokenUsage(ctx.key)
      .then((response) => (response.success ? (response.usage ?? null) : null))
      .catch(() => null),
  ])
  return { sessionId: ctx.key, tokens, usage }
})

/* ── store:只剩「开着哪一条」与那条订阅 ────────────────────────────────── */

export interface MeterSourceState {
  /** 当前会话;空串 = 没有会话(草稿态)。 */
  sessionId: string

  /** 换会话(null / 空串 = 没有会话):订上事件并拉一次。幂等。 */
  open: (sessionId: string | null) => Promise<void>
  /** 重新拉一次(悬停开卡用)。没有会话时是恒等。 */
  refresh: () => Promise<void>
  /** 测试用:回到干净态并退订。 */
  reset: () => void
}

/** 订阅现在订在哪一条上。`undefined` = 一条都没订过。 */
let wiredFor: string | undefined
let unsubscribe: (() => void) | undefined

export const useMeterSource = create<MeterSourceState>()((set, get) => {
  /**
   * 账本推送 → 标脏那一格。
   *
   * **按事件自己说的那条会话标脏,不按「当前开着哪一条」筛**。这不是放宽,
   * 是把两件事各归各位:
   *  · 那一格**有人在看**(环与卡都订着当前这条)→ `invalidate()` 后台补拉、
   *    **不清屏**,与从前「收到 run/end 就 refresh」逐字同效;
   *  · 那一格**没人看**(别人家的会话)→ 只留一个脏标记,**一发请求都不发**,
   *    与从前「别人家的事件不理会」在往返次数上逐字相同。
   *
   * 多出来的那一点是:回到那条会话时 `ensure()` 会因为脏而重拉。这一格是
   * 键控缓存**必须**补上的:不补的话,在 s2 期间 s1 又跑完一轮,回到 s1 会
   * 拿一份陈的读数画在环上,直到下一次悬停才纠正 —— 从前那套每次换会话都
   * 清空重拉,没有这个洞。所以这不是加功能,是把迁移会带出来的洞堵上。
   */
  function onEvent(envelope: SessionEventEnvelope): void {
    // 账本活事件骑在 session:event 上;别的推送(流分片、状态)这里一概不看。
    if (!isMeterInvalidation(envelope.event as { type?: string; record?: unknown })) return
    if (!envelope.sessionId) return
    meterQuery.get(envelope.sessionId).invalidate()
  }

  return {
    sessionId: '',

    open: async (sessionId) => {
      const next = sessionId ?? ''
      if (get().sessionId === next && wiredFor === next) return
      set({ sessionId: next })
      if (!next) {
        unsubscribe?.()
        unsubscribe = undefined
        wiredFor = ''
        return
      }
      const port = await chatPort()
      await port.ready()
      // 等 ready 的这一段里又换了一条:这一发作废,那一条自己会把线接上。
      if (get().sessionId !== next) return
      // 先订上再拉:拉的那一刻起的 run/end 不能漏(与 chat-source 同一条理由)。
      unsubscribe?.()
      unsubscribe = port.onSessionEvent(onEvent)
      wiredFor = next
      await meterQuery.get(next).ensure()
    },

    refresh: async () => {
      const sessionId = get().sessionId
      if (!sessionId) return
      // 悬停开卡那一眼要是最新的 —— 所以是 refetch(force),不是 ensure。
      await meterQuery.get(sessionId).refetch()
    },

    reset: () => {
      unsubscribe?.()
      unsubscribe = undefined
      wiredFor = undefined
      meterQuery.reset()
      set({ sessionId: '' })
    },
  }
})

/**
 * **HMR 退役**(09-01 立法,起因是 chat-source 那一案:热更之后旧模块的模块级
 * 副作用没死,两个实例同时活着各自推屏)。
 *
 * 这个文件的模块级副作用有三样:账本订阅 `unsubscribe`、它订在哪一条的记号
 * `wiredFor`、以及那一族 `meterQuery`(每一格自带监听表)。三样的寿命都是
 * 「这个模块实例」—— 不退役,旧实例的账本订阅会继续往没人看的格子里灌数。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`),不写第二套。它自身幂等;
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useMeterSource.getState().reset()
  })
}

/* ── 组件侧 ────────────────────────────────────────────────────────────── */

/**
 * 屏幕上的六格 —— 环与明细卡共用这一个读法。
 *
 * 窗口那一格在这里才与 models-source 合流:读数不缓存窗口(缓存就会陈),
 * 每次现问一句目录。
 *
 * **陈值门已经退役**:从前这里有一句 `facts.sessionId === sessionId ? facts : null`
 * ——「手上这份读数不属于当前会话时当没有」。迁到键控 query 之后,这条判据成了
 * 缓存的形状本身:`meterQuery.get(sessionId)` 交出来的**只可能是**那一条会话的
 * 那一格,一句手写的门只会变成第二份真相。
 *
 * 没有会话(空串)时也照样取一格 —— hook 不能有条件地调。那一格永远没人
 * `ensure()` / `refetch()`,所以它恒是空的:`data` 为 undefined → 整份缺席态。
 */
export function useMeterView(): MeterView {
  const sessionId = useMeterSource((st) => st.sessionId)
  const facts = useQuery(meterQuery.get(sessionId)).data ?? null
  // 会话 id 取**读数自己开着的那条** —— 它由 open() 跟着当前会话走,所以与总览
  // 同源;就地再读一次总览 store 只会多一条会漂的读法。
  const selection = useCurrentModelSelection(sessionId)
  /*
   * 窗口那一格由 models-source 现问(判据仍是它的 `contextWindowOf`)。
   * 批 7b 起目录是一族键控 query,所以这里订的只有**当前这一家**那一格 ——
   * 从前订的是整张 `catalog` 表,别人家的目录到了也要让环重渲一次。
   */
  const windowTokens = useModelWindow(selection)
  return useMemo(() => meterViewOf(facts, windowTokens), [facts, windowTokens])
}
