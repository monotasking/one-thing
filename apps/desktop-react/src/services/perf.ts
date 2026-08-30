/**
 * 性能探针 —— **只订阅浏览器已经在测的东西,自己一帧都不轮询**。
 *
 * 两个 PerformanceObserver,两类读数:
 *  · `long-animation-frame`(LoAF)—— 超过 50ms 的帧。它比老的 `longtask` 强在
 *    **带归因**:`scripts[]` 里有每段脚本的 invoker(哪个事件回调 / 哪个 rAF)、
 *    来源 URL 与自身耗时,所以「哪一帧卡了」能直接读成「谁卡的」;
 *  · `event`(Event Timing)—— 从用户按下到那次交互画完的端到端时长,
 *    `durationThreshold` 卡在 40ms(见 perf-budget),低于它的不进环。
 *
 * ── 为什么不做 rAF 轮询 ────────────────────────────────────────────────
 * rAF 轮询要**每帧跑一次自己的回调**才能量出帧间隔:它自己就是主线程上的负载,
 * 量的东西被量具改变了(而且它在页面空闲时照样烧电)。LoAF 是浏览器在渲染管线
 * 内部记的,零额外主线程开销,还比 rAF 多出归因信息。所以这里只有订阅,没有循环。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 落点与日志中枢同构:一份 200 条的环 + 一个 `window.__perf.dump()`。
 * 超预算的那些**同时**记进日志环(ns `perf.*`),这样崩溃现场倒出来的那份
 * 里就带着「崩之前卡过没有」。
 */
import { PERF_BUDGET } from '../perf-budget'
import { record } from './log'
import { notify } from './notify'
import { t } from '../i18n'

export type PerfKind = 'longFrame' | 'interaction'

/** LoAF 的归因摘要:一帧里最重的那几段脚本。 */
export type PerfScript = {
  /** 谁触发的 —— 事件回调名 / 'requestAnimationFrame' / classic-script 等。 */
  invoker: string
  /** 这一段自己花了多少毫秒。 */
  ms: number
  /** 脚本来源(有就带上,跨域时浏览器会给空串)。 */
  source?: string
}

export type PerfEntry = {
  ts: number
  kind: PerfKind
  /** longFrame = 整帧时长;interaction = 那次交互的端到端时长。 */
  ms: number
  /** longFrame 无名;interaction 是事件名(click / keydown / pointerdown)。 */
  name: string
  /** 只有 longFrame 有:那一帧的阻塞时长(blockingDuration)。 */
  blockingMs?: number
  /** 只有 longFrame 有:最多三段归因。 */
  scripts?: PerfScript[]
}

export const PERF_RING_CAPACITY = 200

/** 一帧最多留三段归因 —— 再多就不是「摘要」了,读的人也看不过来。 */
const MAX_SCRIPTS = 3

const ring: PerfEntry[] = []
let observers: PerformanceObserver[] = []

function push(entry: PerfEntry): void {
  ring.push(entry)
  if (ring.length > PERF_RING_CAPACITY) ring.splice(0, ring.length - PERF_RING_CAPACITY)
  listeners.forEach((fn) => fn(entry))
  // 超预算的同时进日志环:排障的人只 dump 一次就能看到「崩之前卡过没有」。
  const limit = entry.kind === 'longFrame' ? PERF_BUDGET.longFrameMs : PERF_BUDGET.interactionP95Ms
  if (entry.ms > limit) {
    const ms = Math.round(entry.ms)
    const detail = { name: entry.name, blockingMs: entry.blockingMs, scripts: entry.scripts }
    record('warn', `perf.${entry.kind}`, `${ms}ms`, [detail])
    /*
     * 超预算走 **silent**:它进通知中心存档,但一个字都不弹。
     *
     * 这是命运表里 silent 那一档存在的全部理由 —— 卡了一帧是「排障要看的事」,
     * 不是「用户该被打断的事」;真弹起来,一次卡顿会连着弹十几条,那本身就是新的卡顿源。
     * dev HUD(dev/PerfHud)一个字不动:它是仪表,读的是同一份环,与通知无关。
     */
    notify({
      level: 'silent',
      source: `perf.${entry.kind}`,
      title:
        entry.kind === 'longFrame'
          ? t('perf.longFrame', { ms })
          : t('perf.slowEvent', { name: entry.name, ms }),
      detail: JSON.stringify(detail, null, 2),
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

/** LoAF 条目里那几段脚本 → 归因摘要。按自身耗时降序,取前三。 */
export function summarizeScripts(scripts: readonly PerformanceEntry[] | undefined): PerfScript[] {
  if (!scripts?.length) return []
  return scripts
    .map((raw) => {
      const s = raw as PerformanceEntry & {
        invoker?: string
        invokerType?: string
        sourceURL?: string
      }
      return {
        invoker: s.invoker || s.invokerType || s.name || 'unknown',
        ms: Math.round(s.duration),
        source: s.sourceURL || undefined,
      }
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, MAX_SCRIPTS)
}

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
    const loaf = entry as PerformanceEntry & {
      blockingDuration?: number
      scripts?: PerformanceEntry[]
    }
    push({
      ts: Date.now(),
      kind: 'longFrame',
      ms: Math.round(entry.duration),
      name: 'frame',
      blockingMs: Math.round(loaf.blockingDuration ?? 0),
      scripts: summarizeScripts(loaf.scripts),
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
      push({ ts: Date.now(), kind: 'interaction', ms: Math.round(entry.duration), name: entry.name })
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
    __perf?: { dump: () => PerfEntry[] }
  }
}

export function installPerfDumpHook(): void {
  if (typeof window === 'undefined') return
  window.__perf = { dump: dumpPerf }
}

installPerfDumpHook()
