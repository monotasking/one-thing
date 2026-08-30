/**
 * 性能探针 —— **只订阅浏览器已经在测的东西,自己一帧都不轮询**。
 *
 * 两个 PerformanceObserver + 一个手工打点口,三类读数:
 *  · `long-animation-frame`(LoAF)—— 超过 50ms 的帧。它比老的 `longtask` 强在
 *    **带归因**:`scripts[]` 里有每段脚本的 invoker(哪个事件回调 / 哪个 rAF)、
 *    来源 URL 与自身耗时,所以「哪一帧卡了」能直接读成「谁卡的」;
 *  · `event`(Event Timing)—— 从用户按下到那次交互画完的端到端时长,
 *    `durationThreshold` 卡在 40ms(见 perf-budget),低于它的不进环;
 *  · `span` —— 代码里显式圈出来的一段(`perfSpan`)。前两路回答「哪一帧卡了」,
 *    这一路回答「我怀疑的那段函数到底花了多少」,两者在同一个环里按时间排在一起。
 *
 * ── 为什么不做 rAF 轮询 ────────────────────────────────────────────────
 * rAF 轮询要**每帧跑一次自己的回调**才能量出帧间隔:它自己就是主线程上的负载,
 * 量的东西被量具改变了(而且它在页面空闲时照样烧电)。LoAF 是浏览器在渲染管线
 * 内部记的,零额外主线程开销,还比 rAF 多出归因信息。所以这里只有订阅,没有循环。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 归因要全,不要「摘要」(08-30 可观测性批)────────────────────────────
 * 从前一帧只留最重的三段脚本、每段只有 invoker 与 ms。真到排障时那三段常常是
 * `TimerHandler:setTimeout` 这类**说了等于没说**的名字 —— 谁挂的这个 timer、
 * 它在哪个文件哪一行,一个字都没有。所以现在:
 *  ① scripts **全量收**,每段带 `invokerType` / `fn`(sourceFunctionName)/
 *     `at`(sourceURL + 字符位置);
 *  ② 把 LoAF 自带的**渲染阶段拆分**收进来(renderMs / styleAndLayoutMs),
 *     一眼分清「脚本慢」还是「排版慢」;
 *  ③ 交互条目补现场:`target`(点的是哪个元素)+ 输入延迟 / 处理 / 上屏三段拆分。
 * 旧字段(`scripts[].invoker` / `.ms` / `blockingMs`)**一个都没动** ——
 * `scripts/gate-perf.mjs` 正读着它们,新信息一律加新字段。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 落点与日志中枢同构:一份 200 条的环 + 一个 `window.__perf`。
 * 超预算的那些**同时**记进日志环(ns `perf.*`)并走 notify(silent) 进通知中心,
 * detail 是**完整现场文本**而不是一句 ms —— 点开那条通知就够排障,不必先复现。
 */
import { PERF_BUDGET } from '../perf-budget'
import { record } from './log'
import { notify } from './notify'
import { t } from '../i18n'

export type PerfKind = 'longFrame' | 'interaction' | 'span'

/** LoAF 的一段脚本归因。前两个字段是与 gate-perf 的**向后兼容面**,不许改名。 */
export type PerfScript = {
  /** 谁触发的 —— 事件回调名 / 'requestAnimationFrame' / classic-script 等。 */
  invoker: string
  /** 这一段自己花了多少毫秒。 */
  ms: number
  /** 脚本来源(有就带上,跨域时浏览器会给空串)。 */
  source?: string
  /** invoker 的门类:'user-callback' / 'event-listener' / 'resolve-promise' …… */
  invokerType?: string
  /** sourceFunctionName —— 真正在跑的那个函数名。 */
  fn?: string
  /**
   * 源位置。规范给的是 `sourceCharPosition`(**字符偏移**,不是行:列),
   * 所以这里如实拼成 `sourceURL:<charPos>` —— dev 下 sourceURL 是可读源路径,
   * 拿这个偏移在编辑器里跳过去就是那一行。给不出偏移(-1)时只留 URL。
   */
  at?: string
}

export type PerfEntry = {
  ts: number
  kind: PerfKind
  /** longFrame = 整帧时长;interaction = 端到端时长;span = 那段函数的耗时。 */
  ms: number
  /** longFrame 无名('frame');interaction 是事件名;span 是打点名。 */
  name: string
  /** 只有 longFrame 有:那一帧的阻塞时长(blockingDuration)。 */
  blockingMs?: number
  /** 只有 longFrame 有:**全量**脚本归因,按自身耗时降序。 */
  scripts?: PerfScript[]
  /** 只有 longFrame 有:renderStart → 帧尾,即这一帧花在渲染上的总时长。 */
  renderMs?: number
  /** 只有 longFrame 有:styleAndLayoutStart → 帧尾。renderMs 减它 = 画之前那半。 */
  styleAndLayoutMs?: number
  /** 只有 interaction 有:事件目标的一句人话描述(见 describeTarget)。 */
  target?: string
  /** 只有 interaction 有:同一次交互的分组号(INP 按它归并)。 */
  interactionId?: number
  /** 只有 interaction 有:按下 → 开始处理。大 = 主线程当时被别人占着。 */
  inputDelayMs?: number
  /** 只有 interaction 有:处理这次事件的回调自己花了多久。 */
  processingMs?: number
  /** 只有 interaction 有:回调结束 → 上屏。大 = 排版/绘制慢,不是脚本慢。 */
  presentationMs?: number
}

export const PERF_RING_CAPACITY = 200

/**
 * `perfSpan` 进环的门槛。低于它的一律不记 —— 打点埋在热路径上(每帧一次的
 * markdown 重解析就是),不设门槛环会被自己的读数冲干净,长帧反而看不到了。
 * 8ms ≈ 60fps 一帧预算的一半:一段函数吃掉半帧,已经值得看一眼。
 */
export const PERF_SPAN_MIN_MS = 8

/** HUD / 通知里源位置那一行的最大长度 —— 再长就把面板撑爆。 */
const TARGET_TEXT_MAX = 48

const ring: PerfEntry[] = []
let observers: PerformanceObserver[] = []

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** 超预算的判据。span 与 longFrame 同线:一段函数吃掉一整帧,就是一帧的事。 */
function limitFor(kind: PerfKind): number {
  return kind === 'interaction' ? PERF_BUDGET.interactionP95Ms : PERF_BUDGET.longFrameMs
}

function titleFor(entry: PerfEntry, ms: number): string {
  if (entry.kind === 'longFrame') return t('perf.longFrame', { ms })
  if (entry.kind === 'span') return t('perf.span', { name: entry.name, ms })
  return t('perf.slowEvent', { name: entry.name, ms })
}

function push(entry: PerfEntry): void {
  ring.push(entry)
  if (ring.length > PERF_RING_CAPACITY) ring.splice(0, ring.length - PERF_RING_CAPACITY)
  listeners.forEach((fn) => fn(entry))
  // 超预算的同时进日志环:排障的人只 dump 一次就能看到「崩之前卡过没有」。
  if (entry.ms > limitFor(entry.kind)) {
    const ms = Math.round(entry.ms)
    record('warn', `perf.${entry.kind}`, `${ms}ms`, [entry])
    /*
     * 超预算走 **silent**:它进通知中心存档,但一个字都不弹。
     *
     * 这是命运表里 silent 那一档存在的全部理由 —— 卡了一帧是「排障要看的事」,
     * 不是「用户该被打断的事」;真弹起来,一次卡顿会连着弹十几条,那本身就是新的卡顿源。
     * dev HUD(dev/PerfHud)一个字不动:它是仪表,读的是同一份环,与通知无关。
     *
     * detail 是**完整现场**(formatPerfDetail):各段脚本的 invoker + 源位置 + ms、
     * 渲染阶段拆分 / 交互三段拆分。中心里点开那条通知就是现场,不用复现。
     */
    notify({
      level: 'silent',
      source: `perf.${entry.kind}`,
      title: titleFor(entry, ms),
      detail: formatPerfDetail(entry),
    })
  }
}

type Listener = (entry: PerfEntry) => void
const listeners = new Set<Listener>()

/** 订阅新读数(HUD 用)。返回退订函数。 */
export function subscribePerf(fn: Listener): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function dumpPerf(): PerfEntry[] {
  return ring.slice()
}

/** 只给测试用。 */
export function __resetPerfForTests(): void {
  ring.length = 0
}

/** 只给测试用:不起观察者也能走一遍 push 那条路(记环 + 超预算的两个出口)。 */
export function __pushPerfForTests(entry: PerfEntry): void {
  push(entry)
}

/* ── LoAF ────────────────────────────────────────────────────────────────── */

type LoafScript = PerformanceEntry & {
  invoker?: string
  invokerType?: string
  sourceURL?: string
  sourceFunctionName?: string
  sourceCharPosition?: number
}

type LoafEntry = PerformanceEntry & {
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: PerformanceEntry[]
}

/**
 * LoAF 条目里的那些脚本 → **全量**归因,按自身耗时降序。
 *
 * 「认得出多少收多少」:每个字段各自缺席各自不出现,不造假、不填 'unknown' 之外的东西。
 * 排序保留是因为读的人总是从最重的那段看起 —— 但**一条都不丢**,
 * 因为真正说明问题的常常不是最长那段,而是第三段里那个眼熟的文件名。
 */
export function collectScripts(scripts: readonly PerformanceEntry[] | undefined): PerfScript[] {
  if (!scripts?.length) return []
  return scripts
    .map((raw) => {
      const s = raw as LoafScript
      const url = s.sourceURL || undefined
      const pos = typeof s.sourceCharPosition === 'number' && s.sourceCharPosition >= 0
        ? s.sourceCharPosition
        : undefined
      return {
        invoker: s.invoker || s.invokerType || s.name || 'unknown',
        ms: Math.round(s.duration),
        source: url,
        invokerType: s.invokerType || undefined,
        fn: s.sourceFunctionName || undefined,
        at: url ? (pos === undefined ? url : `${url}:${pos}`) : undefined,
      }
    })
    .sort((a, b) => b.ms - a.ms)
}

/**
 * LoAF 自带的渲染阶段拆分。
 *
 * 一帧的时间轴:`startTime` →(脚本跑着)→ `renderStart` →(样式/布局之前的渲染步骤)
 * → `styleAndLayoutStart` → 帧尾(`startTime + duration`)。所以两段都是**到帧尾**为止,
 * `renderMs - styleAndLayoutMs` 就是「排版之前那半」。
 * 浏览器没报某个起点(给 0 或缺席)时那一段缺席 —— 不拿 0 冒充「零耗时」。
 */
export function loafPhases(entry: LoafEntry): { renderMs?: number; styleAndLayoutMs?: number } {
  const end = entry.startTime + entry.duration
  const at = (start: number | undefined) =>
    typeof start === 'number' && start > 0 && start <= end ? Math.round(end - start) : undefined
  return { renderMs: at(entry.renderStart), styleAndLayoutMs: at(entry.styleAndLayoutStart) }
}

/* ── Event Timing ────────────────────────────────────────────────────────── */

type EventEntry = PerformanceEntry & {
  processingStart?: number
  processingEnd?: number
  interactionId?: number
  target?: EventTarget | null
}

/**
 * 一次交互的三段拆分 —— **这三个数决定往哪儿看**:
 *  · inputDelay 大 → 按下的那一刻主线程被**别人**占着(去看长帧的归因);
 *  · processing 大 → 是**这个回调自己**慢(去看 perfSpan);
 *  · presentation 大 → 脚本早跑完了,慢在**排版/绘制**(去看 styleAndLayoutMs)。
 * 浏览器没给 processingStart/End(理论上不会,但别信)时整组缺席。
 */
export function eventPhases(entry: EventEntry): {
  inputDelayMs?: number
  processingMs?: number
  presentationMs?: number
} {
  const { processingStart, processingEnd } = entry
  if (typeof processingStart !== 'number' || typeof processingEnd !== 'number') return {}
  const end = entry.startTime + entry.duration
  return {
    inputDelayMs: Math.round(Math.max(0, processingStart - entry.startTime)),
    processingMs: Math.round(Math.max(0, processingEnd - processingStart)),
    presentationMs: Math.round(Math.max(0, end - processingEnd)),
  }
}

function truncate(text: string, max = TARGET_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * 事件目标 → 一句人话。**排障时「哪个元素」比「哪个事件」有用得多**:
 * 「click 96ms」谁都不知道点的是什么,「button[data-testid="dock-tile-sessions"] click 96ms」
 * 当场就能复现。
 *
 * 三选一,按可复现性排序:testid(门与测试就是拿它定位的)> aria-label(人读得懂)
 * > 截断的可见文字(总比只有标签名强)。三个都没有就只给标签名。
 */
export function describeTarget(node: unknown): string | undefined {
  const el = node as Element | null | undefined
  if (!el || typeof el !== 'object') return undefined
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : undefined
  if (!tag) return undefined
  const attr = (name: string) =>
    typeof el.getAttribute === 'function' ? el.getAttribute(name) : null
  const testId = attr('data-testid')
  if (testId) return `${tag}[data-testid="${truncate(testId)}"]`
  const label = attr('aria-label')
  if (label) return `${tag}[aria-label="${truncate(label)}"]`
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text ? `${tag} "${truncate(text)}"` : tag
}

/* ── 现场文本 ────────────────────────────────────────────────────────────── */

/**
 * 一条读数 → 通知中心里那段 mono 文本。**这就是「不用复现」的那份现场**。
 *
 * 它是给人读的,不是给机器解析的(机器那份是 `window.__perf.dump()` 的对象),
 * 所以不做 JSON:一行一个事实,缺席的字段整行不出现。
 */
export function formatPerfDetail(entry: PerfEntry): string {
  const lines: string[] = []
  const ms = Math.round(entry.ms)

  if (entry.kind === 'longFrame') {
    const head = [`frame ${ms}ms`]
    if (entry.blockingMs !== undefined) head.push(`blocking ${entry.blockingMs}ms`)
    if (entry.renderMs !== undefined) head.push(`render ${entry.renderMs}ms`)
    if (entry.styleAndLayoutMs !== undefined) {
      head.push(`style+layout ${entry.styleAndLayoutMs}ms`)
    }
    lines.push(head.join(' · '))
    const scripts = entry.scripts ?? []
    if (scripts.length === 0) {
      lines.push('(浏览器没给脚本归因 —— 跨域脚本或整帧不是脚本引起的)')
    } else {
      scripts.forEach((script, i) => {
        const parts = [`${i + 1}. ${script.invoker} ${script.ms}ms`]
        if (script.invokerType && script.invokerType !== script.invoker) {
          parts.push(`(${script.invokerType})`)
        }
        if (script.fn) parts.push(`fn=${script.fn}`)
        if (script.at) parts.push(`@ ${script.at}`)
        lines.push(parts.join(' '))
      })
    }
    return lines.join('\n')
  }

  if (entry.kind === 'span') return `span ${entry.name} ${ms}ms`

  lines.push(`${entry.name} ${ms}ms`)
  if (entry.target) lines.push(`target ${entry.target}`)
  if (entry.interactionId) lines.push(`interactionId ${entry.interactionId}`)
  if (entry.inputDelayMs !== undefined) {
    lines.push(
      `input delay ${entry.inputDelayMs}ms · processing ${entry.processingMs}ms`
        + ` · presentation ${entry.presentationMs}ms`,
    )
  }
  return lines.join('\n')
}

/* ── 打点 ────────────────────────────────────────────────────────────────── */

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

function settleSpan(name: string, started: number): void {
  const ms = nowMs() - started
  if (ms < PERF_SPAN_MIN_MS) return
  push({ ts: Date.now(), kind: 'span', ms: Math.round(ms * 10) / 10, name })
}

/**
 * 圈一段代码量它多久。**同步与 async 两用**:`fn` 返回 thenable 就等它落定再收表,
 * 否则当场收 —— 调用处因此不需要为「这个函数是不是 async」分两种写法。
 *
 * 抛了也收表(finally / rejection 两路都走到):一段**抛出来的**慢函数照样是慢函数,
 * 而排障时它往往正是要找的那个。
 *
 * 埋点是**一行调用**,不改被埋函数的结构 —— 埋点一旦要求重构,就没人愿意埋了。
 */
export function perfSpan<T>(name: string, fn: () => T): T {
  const started = nowMs()
  let deferred = false
  try {
    const out = fn()
    if (isThenable(out)) {
      deferred = true
      return out.then(
        (value) => {
          settleSpan(name, started)
          return value
        },
        (error: unknown) => {
          settleSpan(name, started)
          throw error
        },
      ) as T
    }
    return out
  } finally {
    if (!deferred) settleSpan(name, started)
  }
}

/**
 * 打一个时间点。两个去处:
 *  ① 环里一条 ms=0 的 span —— 于是「这条长帧发生在哪个动作之后」在 dump 里一目了然;
 *  ② `performance.mark` —— gate-perf 录 trace 时带着 `blink.user_timing` 分类,
 *     所以这个标记会直接出现在 DevTools 的 Performance 面板时间轴上。
 *
 * 用它而不是 perfSpan 的场合:**代价不在调用那一刻发生**的动作(派发一个 store
 * 更新,真正的开销落在随后那一帧的 React 渲染里)。那种地方 perfSpan 只会量到
 * 一个 0.1ms 的假读数,而一个标记恰好告诉你「后面那帧是这个动作引起的」。
 */
export function perfMark(name: string): void {
  push({ ts: Date.now(), kind: 'span', ms: 0, name })
  try {
    performance.mark?.(name)
  } catch {
    // mark 名冲突 / 环境没有 —— 少一个时间轴标记,不该拖垮应用。
  }
}

/* ── 聚合 ────────────────────────────────────────────────────────────────── */

export interface PerfReportRow {
  kind: PerfKind
  name: string
  count: number
  p50: number
  p95: number
  max: number
}

/** 最近邻百分位。`sorted` 升序。 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * 按 (kind, name) 聚成一张表:count / p50 / p95 / max,按 max 降序。
 *
 * 单条读数回答「刚才那一下」,这张表回答「一直以来谁最贵」—— 两个问题,
 * 同一份环。默认聚整个环;传 entries 可以只聚一段(测试与将来的区间报告)。
 */
export function perfReport(entries: readonly PerfEntry[] = ring): PerfReportRow[] {
  const buckets = new Map<string, { kind: PerfKind; name: string; values: number[] }>()
  for (const entry of entries) {
    const key = `${entry.kind}\u0000${entry.name}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { kind: entry.kind, name: entry.name, values: [] }
      buckets.set(key, bucket)
    }
    bucket.values.push(entry.ms)
  }
  return [...buckets.values()]
    .map(({ kind, name, values }) => {
      const sorted = [...values].sort((a, b) => a - b)
      return {
        kind,
        name,
        count: sorted.length,
        p50: round1(percentile(sorted, 50)),
        p95: round1(percentile(sorted, 95)),
        max: round1(sorted[sorted.length - 1]),
      }
    })
    .sort((a, b) => b.max - a.max)
}

/* ── 观察者 ──────────────────────────────────────────────────────────────── */

/** 这个浏览器认不认某种 entryType。认不出就整条跳过,不抛。 */
function supports(type: string): boolean {
  const types = (PerformanceObserver as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes
  return Array.isArray(types) ? types.includes(type) : false
}

function observe(type: string, init: PerformanceObserverInit, handle: (e: PerformanceEntry) => void): void {
  if (!supports(type)) return
  try {
    const observer = new PerformanceObserver((list) => list.getEntries().forEach(handle))
    observer.observe(init)
    observers.push(observer)
  } catch {
    // 认得类型却起不来(某些嵌入环境)—— 少一路读数,不该拖垮应用。
  }
}

let started = false

/**
 * 装探针。幂等 —— 重复调用不叠观察者。返回卸载函数(测试与 HMR 用)。
 * 环境不支持 PerformanceObserver(jsdom 就是)时整步跳过,返回一个空卸载。
 */
export function startPerfProbe(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => undefined
  if (started) return stopPerfProbe
  started = true

  observe('long-animation-frame', { type: 'long-animation-frame', buffered: true }, (entry) => {
    const loaf = entry as LoafEntry
    push({
      ts: Date.now(),
      kind: 'longFrame',
      ms: Math.round(entry.duration),
      name: 'frame',
      blockingMs: Math.round(loaf.blockingDuration ?? 0),
      scripts: collectScripts(loaf.scripts),
      ...loafPhases(loaf),
    })
  })

  observe(
    'event',
    {
      type: 'event',
      buffered: true,
      durationThreshold: PERF_BUDGET.eventDurationThresholdMs,
    } as PerformanceObserverInit,
    (entry) => {
      const event = entry as EventEntry
      push({
        ts: Date.now(),
        kind: 'interaction',
        ms: Math.round(entry.duration),
        name: entry.name,
        target: describeTarget(event.target),
        interactionId: event.interactionId || undefined,
        ...eventPhases(event),
      })
    },
  )

  return stopPerfProbe
}

export function stopPerfProbe(): void {
  observers.forEach((o) => o.disconnect())
  observers = []
  started = false
}

declare global {
  interface Window {
    __perf?: {
      dump: () => PerfEntry[]
      report: () => PerfReportRow[]
    }
  }
}

export function installPerfDumpHook(): void {
  if (typeof window === 'undefined') return
  window.__perf = { dump: dumpPerf, report: perfReport }
}

installPerfDumpHook()
