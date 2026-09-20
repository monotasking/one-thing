import { fnv1a } from '../../hash'

/**
 * 图种注册表 —— **第二张表**(§3.3),与主表同构。
 *
 * 主表回答「`figure` 这个 kind 谁来画」,这张表回答「`figKind:'mermaid'` 这张图
 * 谁来渲」。分成两张不是分层癖:主表的 `figure` 渲染器只做四件与图种无关的事
 * (查表 → 拉库 → 画 → 失败降级源码),这四件对 mermaid、plantuml、将来的 katex
 * 逐字相同;而「怎么把这段源码变成一个 SVG」每一种都不一样。合成一张表的话,
 * 加一种图 = 改 `figure` 渲染器,那正是块注册表当初要砍掉的那个环。
 *
 * ── 三条规矩,与主表逐条对齐 ────────────────────────────────────────────
 * 1. **重复注册 = 抛错**,不静默覆盖(同一条理由:静默后胜会让「我改了怎么没生效」
 *    变成一小时的排查)。
 * 2. **未知 figKind 不是错误**:查不到就是查不到,`resolve` 返回 undefined,
 *    图块画那段源码 —— 源码可见,全系统同一条失败语义。
 * 3. **注册只发生在一个 barrel**(`./index.ts`),与块的注册 barrel 同一处纪律。
 *
 * ── 缓存也住这里 ────────────────────────────────────────────────────────
 * 「同源不二渲」(§3.3)要有个地方记住渲染结果,而这个结果同时是三个消费者要的:
 * 图本体、放大浮层、PNG 导出。让它跟着**表**走而不是跟着组件走,是因为后两者是
 * 壳的动作 —— 壳不认识组件的 state,但可以问这张表要一份已经渲好的 SVG。
 */

/** 一次渲染的产物。今天只有 SVG;位图图种要来时这里加一格,消费者按格分支。 */
export interface FigureRendered {
  svg: string
}

export interface FigureKindDef {
  /** `BlockModel.figure.figKind` 的值,原样小写比对。 */
  kind: string
  /**
   * 重库的懒加载。**不走块壳的 `def.loader`** —— 那个会挂起 Suspense 画骨架,
   * 而图在库到之前有一个完全正确的样子:它自己的源码。用骨架盖住一份已经正确的
   * 渲染,是拿一段空白换一点颜色(与 shiki 同一条判据,见 code/highlight.ts)。
   * 所以拉库住在渲染流程里面,由 `renderFigure` 串起来。
   */
  loader?: () => Promise<unknown>
  /** 源码 → SVG。抛错 = 这张图画不出来,调用方降级到源码 + 一行说明。 */
  render: (source: string) => Promise<FigureRendered>
  /**
   * 檐上那个类型词。
   *
   * 檐由壳在**渲染之前**画,所以类型词只能从源码同步看出来 —— 拿渲染器认出来的
   * 那个类型是拿不到的(它要等异步渲染完,那时檐早画完了,再改就是闪一下)。
   * 于是这一格是个**同步的浅判断**,认不出就返回 undefined,壳显 figKind 本身。
   * 它只影响檐上那个词,认错的代价是显示得不够细,不是画错图。
   */
  label?: (source: string) => string | undefined
  /** PNG 导出的像素密度提示。缺席 = 壳的默认(2×)。 */
  toPngHint?: { scale?: number }
}

export class FigureKindRegistry {
  private readonly defs = new Map<string, FigureKindDef>()

  register(def: FigureKindDef): void {
    if (this.defs.has(def.kind)) {
      throw new Error(`图种重复注册:${def.kind}(同一个图种只能有一个渲染器)`)
    }
    this.defs.set(def.kind, def)
  }

  /** 反注册。与主表同一条理由,见 blocks/registry.ts 的 `unregister`。 */
  unregister(kind: string, def?: FigureKindDef): void {
    const held = this.defs.get(kind)
    if (!held) return
    if (def && held !== def) return
    this.defs.delete(kind)
  }

  /** 查不到就是 undefined —— 未知图种不是错误,是「这台不认识它」。 */
  resolve(kind: string): FigureKindDef | undefined {
    return this.defs.get(kind)
  }

  has(kind: string): boolean {
    return this.defs.has(kind)
  }
}

/** 只用得到 `dispose` 一口(与 blocks/registry.ts 同一个形状)。 */
export interface ImportMetaHot {
  dispose(cb: () => void): void
}

const registry = new FigureKindRegistry()

/**
 * 注册一个图种。第二个形参是调用模块自己的 `import.meta.hot` —— 与主表
 * `registerBlock` 逐字同一条纪律(CLAUDE.md「模块级副作用必须配 HMR dispose」):
 * 这张二级表同样是模块级单例,热更时旧的不摘就会撞「图种重复注册」。
 */
export function registerFigureKind(def: FigureKindDef, hot?: ImportMetaHot): void {
  registry.register(def)
  hot?.dispose(() => registry.unregister(def.kind, def))
}

export function resolveFigureKind(kind: string): FigureKindDef | undefined {
  return registry.resolve(kind)
}

export function isFigureKindRegistered(kind: string): boolean {
  return registry.has(kind)
}

/* ── 渲染缓存 ──────────────────────────────────────────────────────────── */

export type FigureEntry =
  | { status: 'rendering' }
  | { status: 'done'; svg: string }
  /** `message` 是渲染器说的那句原话,不改写(与错误消息卡同一条纪律)。 */
  | { status: 'error'; message: string }

const CACHE = new Map<string, FigureEntry>()
/** 上限:缓存不能变成一条永远不还的内存借条(与 shiki 的染色缓存同一手)。 */
const CACHE_MAX = 32

/**
 * 缓存键 = 图种 + 源码哈希 + 源码长度。
 *
 * 用哈希而不是整段源码当键:图源码动辄上千字符,而这张表要被**每一帧**查
 * (檐上的动作声明、本体、浮层)。长度掺进键里是给 32 位哈希加一道廉价的防撞。
 */
export function figureCacheKey(kind: string, source: string): string {
  return `${kind}:${source.length}:${fnv1a(source)}`
}

export function readFigureEntry(kind: string, source: string): FigureEntry | undefined {
  return CACHE.get(figureCacheKey(kind, source))
}

/** 已经渲好的那份 SVG(放大 / PNG 导出的取件口)。没渲好就是 undefined。 */
export function cachedFigureSvg(kind: string, source: string): string | undefined {
  const entry = readFigureEntry(kind, source)
  return entry?.status === 'done' ? entry.svg : undefined
}

/**
 * 渲一次(同源不二渲)。
 *
 * 已在缓存里(不论成功失败)就直接返回那一格 —— 失败也缓存:同一段画不出来的
 * 源码在屏幕上反复出现时,不该每次都再去拉一次库、再失败一次。
 */
export async function renderFigure(def: FigureKindDef, source: string): Promise<FigureEntry> {
  const key = figureCacheKey(def.kind, source)
  const hit = CACHE.get(key)
  if (hit && hit.status !== 'rendering') return hit

  if (CACHE.size >= CACHE_MAX) CACHE.clear()
  CACHE.set(key, { status: 'rendering' })

  try {
    // 拉库与渲染是**同一条路**上的两步:库拉不到和图画不出来,屏幕上是同一件事
    // (源码 + 一行说明),所以它们共用这一个 try。
    if (def.loader) await def.loader()
    const { svg } = await def.render(source)
    const done: FigureEntry = { status: 'done', svg }
    CACHE.set(key, done)
    return done
  } catch (thrown) {
    const failed: FigureEntry = { status: 'error', message: messageOf(thrown) }
    CACHE.set(key, failed)
    return failed
  }
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error && thrown.message) return thrown.message
  return String(thrown)
}

/** 只给测试用:缓存是模块级的,用例之间要能各渲各的。 */
export function clearFigureCacheForTest(): void {
  CACHE.clear()
}
