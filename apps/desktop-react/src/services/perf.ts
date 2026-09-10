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
  /**
   * 一句现场(只有 `perfCount` 记的那种 span 有)。
   *
   * 「理论不可能」的计数器不该只有一个数:哪条会话、哪条消息、第几次,是排障时
   * 唯一有用的三格。它们不各占一个字段 —— 那会让 `PerfEntry` 长成一张什么都往里
   * 塞的表;拼成一句话进这一格,HUD 与通知中心照原样显示。
   */
  detail?: string
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

/* ── 一批落账只吵一次(P4:通知不许自伤)──────────────────────────────────────
 *
 * 09-10 真机:一帧慢 → 那一帧里三十条读数全部超预算 → 每条各走一次
 * `notify()` → zustand 写 → **persist 同步序列化整个 200 条环写 localStorage** +
 * 通知中心面板重渲 —— 于是落账这一步自己变成 50–124ms 的长帧,下一次交互又慢,
 * 又三十条。正反馈的那一环就在这里。
 *
 * 修法不是「少记」,是**少吵**:一批落账里同一 kind 的超预算读数合成一句话 ——
 * 标题给最重的那条(它就是这一批里值得看的那条),detail 是它的完整现场,
 * 后面缀一行清单交代同批的其余几条(名字 / 毫秒 / 目标各一行)。
 * 记账那一半(`record` 进日志环)一条不少:环是纯内存,便宜。
 * ──────────────────────────────────────────────────────────────────────── */

/** 本批攒着的超预算读数,按 kind 分组。null = 不在批里(手工打点那条路)。 */
let batchNotify: Map<PerfKind, PerfEntry[]> | null = null

/** 在批里就攒着(返回 true = 这条的通知由 flush 统一说)。 */
function collectBatchNotify(entry: PerfEntry): boolean {
  if (!batchNotify) return false
  const list = batchNotify.get(entry.kind)
  if (list) list.push(entry)
  else batchNotify.set(entry.kind, [entry])
  return true
}

/** 清单里的一行:名字 + 毫秒 + 目标(有就带)。一条一行,给人扫的。 */
function oneLineOf(entry: PerfEntry): string {
  const ms = Math.round(entry.ms)
  return entry.target ? `${entry.name} ${ms}ms ${entry.target}` : `${entry.name} ${ms}ms`
}

/** 收批:每个 kind 至多一条通知。批里一条都没有就一个字都不说。 */
function flushBatchNotify(): void {
  const pending = batchNotify
  batchNotify = null
  if (!pending) return
  pending.forEach((list, kind) => {
    let heaviest = list[0]
    for (const item of list) if (item.ms > heaviest.ms) heaviest = item
    const ms = Math.round(heaviest.ms)
    const rest = list.length - 1
    const head = titleFor(heaviest, ms)
    const detail = formatPerfDetail(heaviest)
    notify({
      level: 'silent',
      source: `perf.${kind}`,
      title: rest > 0 ? `${head}${t('perf.batchMore', { count: rest })}` : head,
      detail: rest > 0
        ? [
            detail,
            '',
            t('perf.batchRest', { count: rest }),
            ...list.filter((x) => x !== heaviest).map(oneLineOf),
          ].join('\n')
        : detail,
    })
  })
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
     * 一批落账里超预算的可能有十几条(卡的那一帧里每条交互都超标)。日志环便宜,
     * 所以 `record` 照旧**逐条**;通知不便宜(zustand 写 → 落盘 → 面板重渲),
     * 所以它**每批每 kind 只说一句**(见 `flushBatchNotify`)。
     * 批外那条路(perfSpan / perfMark 手工打点)照旧逐条 —— 那是人自己埋的点,
     * 一次调用就该有一次回音。
     */
    if (collectBatchNotify(entry)) return
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
 * 一次目标描述最多走几个节点。
 *
 * **为什么必须有这一格**(09-10 真机):`textContent` 的代价是**整棵子树**。
 * 事件条目的 target 常常是 `body` / `main` / 整条聊天列 —— 一次划过嵌套容器,
 * 浏览器给每一层祖先各报一条,于是「读一遍整篇文档的文字」被做了三十遍。
 * 而这句描述只要 48 个字符:它是给人认路的一句话,不是一份摘录。
 * 64 个节点足够把任何按钮 / 行 / 卡的可见文字凑够 48 个字符,再多都是白读。
 */
export const TARGET_SCAN_NODE_CAP = 64

/** 扫描时的字符预算。留 4 倍余量给空白折叠,收够就停,最后仍按 `truncate` 截。 */
const TARGET_SCAN_CHAR_BUDGET = TARGET_TEXT_MAX * 4

type TextishNode = {
  nodeType?: number
  nodeValue?: string | null
  childNodes?: ArrayLike<unknown>
}

/**
 * 有界地收一个元素下的可见文字。**不碰 `textContent`** —— 那一口没有上限。
 *
 * 显式栈的**深度优先、按文档序**遍历,两道闸各管一件事:走过的节点数(`nodeCap`)
 * 与收到的字符数(`charBudget`)。压栈时也照剩余额度截 —— 否则一个有一万个子节点
 * 的容器,光是把孩子推进栈就已经是一万次操作,闸就形同虚设。
 *
 * 返回 `visited` 不是为了好看:它是这条上界的**可断言面**(用例拿它证「一万个
 * 文本节点也只走 64 个」)。
 */
export function collectTargetText(
  root: unknown,
  nodeCap = TARGET_SCAN_NODE_CAP,
  charBudget = TARGET_SCAN_CHAR_BUDGET,
): { text: string; visited: number } {
  let out = ''
  let visited = 0
  const stack: unknown[] = [root]
  while (stack.length > 0 && visited < nodeCap && out.length < charBudget) {
    const node = stack.pop() as TextishNode
    visited += 1
    if (!node || typeof node !== 'object') continue
    if (node.nodeType === 3) {
      out += (node.nodeValue ?? '').slice(0, charBudget - out.length)
      continue
    }
    if (node.nodeType !== 1) continue
    const kids = node.childNodes
    if (!kids) continue
    const take = Math.min(kids.length, nodeCap - visited)
    for (let i = take - 1; i >= 0; i -= 1) stack.push(kids[i])
  }
  return { text: out.replace(/\s+/g, ' ').trim(), visited }
}

/**
 * 事件目标 → 一句人话。**排障时「哪个元素」比「哪个事件」有用得多**:
 * 「click 96ms」谁都不知道点的是什么,「button[data-testid="dock-tile-sessions"] click 96ms」
 * 当场就能复现。
 *
 * 三选一,按可复现性排序:testid(门与测试就是拿它定位的)> aria-label(人读得懂)
 * > 截断的可见文字(总比只有标签名强)。三个都没有就只给标签名。
 *
 * 最后那一档走 `collectTargetText` 的**有界**扫描,不读 `textContent`(见上)。
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
  const { text } = collectTargetText(el)
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

  if (entry.kind === 'span') {
    // `perfCount` 记的那种 span 没有耗时可言(ms 恒 0),显示它只会误导。
    return entry.detail ? `${entry.name} · ${entry.detail}` : `span ${entry.name} ${ms}ms`
  }

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
/**
 * **「理论不可能」的计数器进环**(R 线设计审查条 13:不变式违反 = 自愈 + 计数,
 * 永不 throw;计数器须有可见面)。
 *
 * 三条纪律,每条都有来处:
 *
 *  · **永不抛**。它的调用点全在自愈分支里 —— 那些分支本来就是「已经出事了但屏幕
 *    要活着」的地方,记一笔的动作自己再炸一次就是把自愈变成事故。
 *  · **节流去重**。缺段与违法都是**成串**发生的(一条 delta 丢了,后面每一条都对
 *    不上偏移),不节流的话 200 格的环会被同一件事冲干净,别的读数全丢 ——
 *    这与 `perfSpan` 设 `PERF_SPAN_MIN_MS` 门槛是同一条理由。
 *  · **键带现场**。同一条会话的同一件事按键节流,换会话 / 换消息各记各的。
 *
 * 落点是既有的那个环(HUD 与通知中心的诊断区读同一份),不新开一条观测路。
 */
export const PERF_COUNT_THROTTLE_MS = 5000

/** 节流表的上限(见 `perfCount` 里那段注:键只增,满了整份丢)。 */
export const PERF_COUNT_KEY_CAP = 500

const countSeenAt = new Map<string, number>()

export function perfCount(
  name: string,
  fields?: Record<string, string | number | undefined>,
  throttleMs: number = PERF_COUNT_THROTTLE_MS,
): void {
  try {
    const detail = Object.entries(fields ?? {})
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')
    const key = `${name}|${detail}`
    const now = Date.now()
    const seen = countSeenAt.get(key)
    if (seen !== undefined && now - seen < throttleMs) return
    /*
     * 节流表按 (名字, 现场) 分键,而现场里有消息 id —— 一条长会话里键是**只增**的。
     * 生产上这几个计数器应当恒 0(键一个都不长),但「应当」不是「必然」:满了就
     * 整份丢,下一轮从头节流。丢的代价只是可能多记一笔,而留着的代价是无界。
     */
    if (countSeenAt.size >= PERF_COUNT_KEY_CAP) countSeenAt.clear()
    countSeenAt.set(key, now)
    push({ ts: now, kind: 'span', ms: 0, name, ...(detail ? { detail } : {}) })
  } catch {
    // 记一笔都记不成,那也只能算了 —— 绝不把自愈路上的一次记账变成第二次事故。
  }
}

/** 测试用:把节流表清干净(它按会话 / 消息分键,用例之间会互相污染)。 */
export function __resetPerfCountThrottleForTests(): void {
  countSeenAt.clear()
}

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

/* ── 入队与空闲落账(P3:观察器不许自伤)────────────────────────────────────
 *
 * 09-01 真机分诊抓到的事:**观察器回调自己就是 57–119ms 长帧的来源**。
 * 量具污染了被量物 —— 而且是最坏的那一种污染,因为它恰好在页面已经卡住的时候
 * 加倍地卡(一次长帧风暴里每条 LoAF 都要走一遍下面这些)。
 *
 * 回调里从前干了六件事,没有一件便宜:
 *   ① `collectScripts` 全量 map + sort + 字符串拼 `at`;
 *   ② `describeTarget` 读 DOM(getAttribute / textContent)并截断拼串;
 *   ③ `formatPerfDetail` 拼出整段现场文本;
 *   ④ `record()` 进日志环;
 *   ⑤ `notify()` → zustand 写 → **React 同步重渲通知中心**;
 *   ⑥ `listeners.forEach` → HUD setState → 又一次渲染。
 * ③④⑤⑥ 都发生在**超预算**那条分支上 —— 也就是说,越卡的时候它干得越多。
 *
 * 修法:**回调里只入队**。一条 LoAF 进来只做三件 O(1) 的事:算一个下标、
 * 写三个预分配数组的格子、(必要时)排一次空闲任务。归因解析、序列化、上报
 * 全部挪到 `requestIdleCallback`(没有就退 `setTimeout 0`)。
 *
 * 队列是**预分配的环**:容量固定、不 push、不 splice、不造中间数组。满了丢最老的
 * 并记 `dropped` —— 丢了要说,不能假装读数是全的。
 *
 * 存的是**原始 entry 的引用**,不是解析后的对象:引用是 O(1),解析才是钱。
 * `event` 条目的 `target` 就挂在 entry 上,拿着引用等到空闲再读 ——
 * 元素那时可能已经离开文档,但**离开文档的元素照样答得出 tagName / getAttribute**,
 * 所以现场不丢(反过来,如果这里就地把 target 读成字符串,那才是把钱花在回调里)。
 * ──────────────────────────────────────────────────────────────────────── */

/** 队列容量。比环(200)略大一点:一次长帧风暴里 buffered 补发能有几十条。 */
const QUEUE_CAPACITY = 256

const QK_LOAF = 0
const QK_EVENT = 1

const qEntry: (PerformanceEntry | undefined)[] = new Array(QUEUE_CAPACITY).fill(undefined)
const qKind = new Uint8Array(QUEUE_CAPACITY)
const qTs = new Float64Array(QUEUE_CAPACITY)
/** 每格上那条交互的分组号(0 = 这格不是交互条目)。去重表指回这里对账。 */
const qInteraction = new Int32Array(QUEUE_CAPACITY)
let qHead = 0
let qCount = 0
let qDropped = 0
let qFiltered = 0
let drainScheduled = false

/* ── 入队那道闸(P4:三十条 hover 一条都不许进来)────────────────────────────
 *
 * 09-10 真机:**一次鼠标划过嵌套容器 = 30+ 条 Event Timing 条目** ——
 * pointerenter / pointerleave / pointerover / pointerout / mouseover / mouseout
 * 对每一层祖先各报一条。它们的 `interactionId` 一律是 0:规范说得很清楚,
 * 只有**真的一次交互**(点、按键、拖)才拿得到分组号。而页面一卡,这些条目
 * 每一条的端到端时长都会越过 40ms 的订阅线,于是「越卡进来的越多」。
 *
 * 两条规则,都是 O(1),都在入队这一刻判(判晚一步,那三十份 `describeTarget`
 * 与三十次落账就已经付过钱了):
 *  ① `interactionId === 0` 不进来 —— 它不是一次交互,INP 也不数它;
 *     指针 / 鼠标的 over·out·enter·leave·move 另有一张**明写的**名单,
 *     不靠「它恰好没有分组号」这个副作用成立:规则要写下来才守得住。
 *  ② 同一个 `interactionId` 只留**一条**,留**时长最大**的那条 ——
 *     一次点击浏览器会给 pointerdown / pointerup / click 三条同号条目,
 *     而 INP 的定义就是取同组里最长的那条。留最长 = 与 INP 同口径,
 *     也正是三条里唯一值得看的那条(另外两条是同一次交互的碎片)。
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 明写的非交互事件名单。它们**本来**就拿不到 `interactionId`,所以这张表在
 * 今天的浏览器上是重复的一道闸 —— 留着是因为规则该写成规则:哪天某个引擎给
 * hover 族发了分组号,这道闸仍然拦得住,而不是靠一个副作用侥幸成立。
 */
const NON_INTERACTION_EVENTS = new Set([
  'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointermove',
  'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'mousemove',
])

/** interactionId → 它此刻占着队列哪一格。留最长那条要靠它找回原位改写。 */
const eventSlot = new Map<number, number>()

/** 把某一格上的交互登记从去重表里摘掉(落账或被挤掉时)。 */
function forgetInteraction(idx: number): void {
  const id = qInteraction[idx]
  if (id === 0) return
  if (eventSlot.get(id) === idx) eventSlot.delete(id)
  qInteraction[idx] = 0
}

/**
 * 观察器回调自身耗时的读数环(**用它自己量自己**)。
 * 也是预分配的:量具的量具更不能分配内存。
 */
const OBSERVER_COST_CAPACITY = 512
const observerCost = new Float64Array(OBSERVER_COST_CAPACITY)
let observerCostIdx = 0
let observerCostCount = 0

function recordObserverCost(ms: number): void {
  observerCost[observerCostIdx] = ms
  observerCostIdx = (observerCostIdx + 1) % OBSERVER_COST_CAPACITY
  if (observerCostCount < OBSERVER_COST_CAPACITY) observerCostCount += 1
}

export interface PerfObserverCost {
  /** 采到几次回调。 */
  count: number
  p50: number
  p95: number
  p99: number
  max: number
  /** 队列满了丢掉几条 —— 丢了要说。 */
  dropped: number
  /** 入队那道闸拦下几条(非交互事件 + 同号只留一条)—— 拦了同样要说。 */
  filtered: number
  /** 此刻还压在队里没落账的条数。 */
  pending: number
}

/**
 * 观察器自伤的自证读数。**在这里才排序**(O(n log n) 一次),而不是在回调里。
 */
export function perfObserverCost(): PerfObserverCost {
  const sorted = Array.from(observerCost.slice(0, observerCostCount)).sort((a, b) => a - b)
  return {
    count: observerCostCount,
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    p99: round1(percentile(sorted, 99)),
    max: round1(sorted.length ? sorted[sorted.length - 1] : 0),
    dropped: qDropped,
    filtered: qFiltered,
    pending: qCount,
  }
}

/** 只给测试用:清空自计时与队列。 */
export function __resetPerfQueueForTests(): void {
  qEntry.fill(undefined)
  qInteraction.fill(0)
  eventSlot.clear()
  qHead = 0
  qCount = 0
  qDropped = 0
  qFiltered = 0
  drainScheduled = false
  batchNotify = null
  observerCostIdx = 0
  observerCostCount = 0
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: (deadline?: { timeRemaining(): number }) => void, opts?: { timeout: number }) => number
}

/**
 * 排一次空闲落账。**最多排一次** —— 一次风暴里 80 条 LoAF 不该排出 80 个任务。
 *
 * `timeout` 是有意给的:纯 idle 在持续繁忙的主线程上可能一直等不到,而这些读数
 * 正是**繁忙时**才产生的。给上限 = 最迟这么久一定落账,不至于攒到队列溢出。
 */
const DRAIN_TIMEOUT_MS = 500

function scheduleDrain(): void {
  if (drainScheduled) return
  drainScheduled = true
  const idle = typeof window !== 'undefined' ? (window as IdleWindow).requestIdleCallback : undefined
  if (typeof idle === 'function') idle(drainQueue, { timeout: DRAIN_TIMEOUT_MS })
  // 没有 requestIdleCallback(Safari 老版本 / jsdom)就退 setTimeout 0 ——
  // 它不是空闲,但至少让出了当前这一帧,回调本身仍然只入队。
  else setTimeout(drainQueue, 0)
}

/** 一次空闲里最多落几条 —— 剩下的排下一次,别把空闲片自己变成一次长任务。 */
const DRAIN_BATCH = 16

function drainQueue(deadline?: { timeRemaining(): number }): void {
  drainScheduled = false
  batchNotify = new Map()
  try {
    let done = 0
    while (qCount > 0 && done < DRAIN_BATCH) {
      /*
       * 空闲片用完了就收手 —— **每一条都问一次,第一条也不例外**。
       * 从前这里写着 `done > 0`:「至少硬做一条」。可这些读数恰恰是主线程最忙的
       * 时候产生的,`timeout` 逼出来的那次落账多半剩余时间就是 0,于是「至少一条」
       * 在最坏的时刻变成了「插队做一条」—— 而一条落账要解析归因、拼现场文本、
       * 写日志环,正是 09-10 那串 50–124ms 空闲长帧的底料。
       * 排到下一次不会丢:队列是环,`scheduleDrain` 的 timeout 保证最迟 500ms 再来。
       */
      if (deadline && deadline.timeRemaining() <= 1) break
      const idx = qHead
      qHead = (qHead + 1) % QUEUE_CAPACITY
      qCount -= 1
      const raw = qEntry[idx]
      qEntry[idx] = undefined // 放掉引用:别让一条队列钉住一棵 DOM 子树
      forgetInteraction(idx)
      if (!raw) continue
      settleQueued(qKind[idx], raw, qTs[idx])
      done += 1
    }
  } finally {
    // 这一批攒下的超预算读数,每个 kind 说一句就走(见 flushBatchNotify)。
    flushBatchNotify()
  }
  if (qCount > 0) scheduleDrain()
}

/** 空闲里才做的事:解析归因 → 组成 PerfEntry → 走 push(记环 / 上报)。 */
function settleQueued(kind: number, raw: PerformanceEntry, ts: number): void {
  if (kind === QK_LOAF) {
    const loaf = raw as LoafEntry
    push({
      ts,
      kind: 'longFrame',
      ms: Math.round(raw.duration),
      name: 'frame',
      blockingMs: Math.round(loaf.blockingDuration ?? 0),
      scripts: collectScripts(loaf.scripts),
      ...loafPhases(loaf),
    })
    return
  }
  const event = raw as EventEntry
  push({
    ts,
    kind: 'interaction',
    ms: Math.round(raw.duration),
    name: raw.name,
    target: describeTarget(event.target),
    interactionId: event.interactionId || undefined,
    ...eventPhases(event),
  })
}

/** 回调里唯一允许发生的事。几个 O(1) 的写,零分配、零字符串、零 DOM。 */
function enqueue(kind: number, entry: PerformanceEntry): void {
  let interaction = 0
  if (kind === QK_EVENT) {
    interaction = (entry as EventEntry).interactionId || 0
    // ① 不是一次交互(hover 族与其它非交互事件)—— 一步都不往下走。
    if (interaction === 0 || NON_INTERACTION_EVENTS.has(entry.name)) {
      qFiltered += 1
      return
    }
    // ② 同号的已经在队里:留时长最大的那条(与 INP 同口径),不占第二格。
    const slot = eventSlot.get(interaction)
    if (slot !== undefined) {
      const held = qEntry[slot]
      if (held && qInteraction[slot] === interaction) {
        if (entry.duration > held.duration) {
          qEntry[slot] = entry
          qTs[slot] = Date.now()
        }
        qFiltered += 1
        return
      }
      // 那一格已经落账 / 被挤掉了,登记是陈的 —— 清掉,照新的一条走下去。
      eventSlot.delete(interaction)
    }
  }
  const idx = (qHead + qCount) % QUEUE_CAPACITY
  if (qCount === QUEUE_CAPACITY) {
    // 满了丢最老的 —— 新读数比旧读数有用(正在卡的是现在)。
    qHead = (qHead + 1) % QUEUE_CAPACITY
    qDropped += 1
  } else {
    qCount += 1
  }
  forgetInteraction(idx) // 这一格上如果还压着一条交互的登记,先摘干净
  qEntry[idx] = entry
  qKind[idx] = kind
  qTs[idx] = Date.now()
  if (interaction !== 0) {
    qInteraction[idx] = interaction
    eventSlot.set(interaction, idx)
  }
  scheduleDrain()
}

/* ── 观察者 ──────────────────────────────────────────────────────────────── */

/** 这个浏览器认不认某种 entryType。认不出就整条跳过,不抛。 */
function supports(type: string): boolean {
  const types = (PerformanceObserver as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes
  return Array.isArray(types) ? types.includes(type) : false
}

function observe(type: string, init: PerformanceObserverInit, kind: number): void {
  if (!supports(type)) return
  try {
    const observer = new PerformanceObserver((list) => {
      /*
       * 自计时把**整个回调**框在里面(不是逐条),因为「观察器回调自身耗时」
       * 问的就是这一段。`getEntries()` 也在框内 —— 它同样是回调的开销。
       */
      const t0 = nowMs()
      const entries = list.getEntries()
      for (let i = 0; i < entries.length; i += 1) enqueue(kind, entries[i])
      recordObserverCost(nowMs() - t0)
    })
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

  observe('long-animation-frame', { type: 'long-animation-frame', buffered: true }, QK_LOAF)

  observe(
    'event',
    {
      type: 'event',
      buffered: true,
      durationThreshold: PERF_BUDGET.eventDurationThresholdMs,
    } as PerformanceObserverInit,
    QK_EVENT,
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
      /** 量具自己的账:观察器回调耗时分位 + 丢弃 / 待落账条数。 */
      observerCost: () => PerfObserverCost
    }
  }
}

export function installPerfDumpHook(): void {
  if (typeof window === 'undefined') return
  window.__perf = { dump: dumpPerf, report: perfReport, observerCost: perfObserverCost }
}

installPerfDumpHook()

/*
 * ── 模块级副作用的 HMR 退役(CLAUDE.md 施工纪律)──────────────────────────
 * 这个模块在模块作用域里起了两样活东西:两个 `PerformanceObserver`(经
 * `startPerfProbe`,由 main.tsx 调)和一个排在空闲里的落账任务。热更之后旧模块
 * 那两个观察器**不会自己停**:它们照旧回调,写的是旧模块那份队列与环,于是屏幕上
 * 的 HUD 与 `window.__perf` 读的是新模块的空表,而真读数落在一个没人看的旧表里
 * ——与 chat-source 双折叠器同一个病。
 *
 * 退役**复用既有的那一口**(`stopPerfProbe`),不写第二套拆卸;队列一并清掉,
 * 免得旧队列钉着一批 entry 与 DOM 引用等一个永远不会来的空闲。
 */
if (import.meta.hot) {
  /*
   * 退役要**交班**,不能只是收摊。探针是 main.tsx 起的,而 main.tsx 在这次热更里
   * 不会重跑 —— 旧模块一停,新模块就永远没人来启动它,读数从此静悄悄地没了。
   * (这一格是自己给自己挖的:第一版只写了 stopPerfProbe。)
   * 所以旧模块把「我当时在跑」记进 `hot.data`,新模块开机自己接上。
   */
  if (import.meta.hot.data?.wasRunning) startPerfProbe()
  import.meta.hot.dispose((data: { wasRunning?: boolean }) => {
    data.wasRunning = started
    stopPerfProbe()
    __resetPerfQueueForTests()
  })
}
