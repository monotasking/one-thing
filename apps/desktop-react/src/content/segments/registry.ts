import type { ComponentType } from 'react'
import type { ProjectedMessage } from '../../data/chat-fold'
import type { GroupedNode } from '../assemble/group'
import type { BlockCtx } from '../blocks/registry'
import type { SegmentKind, SegmentModel } from '../model/segments'

/**
 * 段注册表 —— **kind → 谁生产、怎么画、几何怎么答**(G 线 P3,正本
 * `docs/stream-geometry-2026-09.md` §20)。
 *
 * 照 `blocks/registry.ts` 的样子立(类 + 单例、重复注册即抛、`unregister` 比身份、
 * `registerSegment(def, import.meta.hot)` 自动配退役)。三处**故意**与块表不同:
 *
 * 1. **未知 kind 不兜底,查不到就抛。** 段由装配管线独家产出,而产地正是表里那几条
 *    def 自己 —— 所以「查不到」只可能是装配错误(`./index.ts` 那个 barrel 没被
 *    import),与块表 `source-fallback` 缺席那一支是同一条路。词汇在**类型层仍然封闭**
 *    (`SegmentModel` 联合、`SegmentKind` 都不变);表改变的只是「加一种段要改哪几个
 *    文件」,不是词汇的开放性。
 * 2. **契约不是块的五问。** 五问答的是块流机制里的政策,段这一层没有那台机制:段 key
 *    由序号 + kind 派生(`assemble/key.ts`),失败由错误边界兜,中间态由每一型自己的
 *    模型说。照抄一份没人读的答案就是假话 —— 段契约 = **几何三问 + `prose` 一问**。
 * 3. **生产也进表。** 块表只管画,段表两头都管:def 自述它消费哪一种归组节点
 *    (`node`),或者认领整条消息(`claim`,今天只有压缩折痕)。装配循环从此只做
 *    一件事:按节点种查 def、调它的 `produce`。
 *
 * ── 这个文件不认识任何一型 ────────────────────────────────────────────
 * 不 import 任何组件、不 import 任何 assemble 步骤 —— 上面那三行 `import type` 全在
 * 编译期擦掉,运行时这里零依赖。依赖方向是「kind 文件注册时自己找上门」:注册表
 * 去认识每一型的那一天,就是 `SegmentView` 的 switch 换了个地方复活的那一天。
 * (`__tests__/registry.test.ts` 有一条静态门盯着这句话。)
 */

/** 一型段在流式期间与落定时的几何答案。**P3 没有运行时读者**,读者是 P4 的 HeightBook。 */
export interface SegmentGeometry {
  /** 流式期间它的形:grow 随内容长 / fixed 高度钉死 / reserve 先立骨架再填。 */
  liveForm: 'grow' | 'fixed' | 'reserve'
  /** 只有这一个合法答案,写出来是为了必答(G4)。 */
  settle: 'same-height'
  /** 什么情况下允许变矮:never / user-only(人亲手收起)。没有「自动」这一档(G3)。 */
  shrink: 'never' | 'user-only'
}

/** 装配循环递给 `produce` 的现场 —— 只有「这条消息的事实」,没有 React、没有 DOM。 */
export interface ProduceCtx {
  /** 缓存身份 `${messageId}#${段序号}` —— 与今天 `textToFrame` / `markdownToFrame` 收的第一个参数逐字相同。 */
  id: string
  /** 这条消息还在流(`message.isStreaming === true`)。 */
  live: boolean
  /** 这一节点是序列上最后一件(思考段 `thinking` 的判据,裁定 D)。 */
  isLast: boolean
}

/** `View` 统一收的三格。四个既有组件的 props 各不相同,由各自 kind 文件里的适配函数翻过去。 */
export interface SegmentViewProps<M extends SegmentModel = SegmentModel> {
  model: M
  /** 这一段的稳定 key(`assemble/key.ts` 的 `segmentKey`)—— 块 key 与检索段的身份都挂在它下面。 */
  segmentKey: string
  ctx: BlockCtx
}

export interface SegmentDef<M extends SegmentModel = SegmentModel, N extends GroupedNode = GroupedNode> {
  kind: M['kind']
  /** 消费哪一种归组节点。整条消息认领型(compact)缺席这一格。 */
  node?: N['node']
  /** 节点 → 段;`null` = 这一节点不成段(rich-text 一个块都没解出来时)。 */
  produce?: (node: N, ctx: ProduceCtx) => M | null
  /** 第 ⓪ 步:这条消息自述它整条是什么。按注册序问,第一个认领的赢。 */
  claim?: (message: ProjectedMessage) => M | null
  View: ComponentType<SegmentViewProps<M>>
  geometry: SegmentGeometry
  /** 这一段算不算「正文」(收场通知挑句子问的那一句,`ChatStream.hasVisibleProse`)。缺席 = 不算。 */
  prose?: (model: M) => boolean
}

/** 按节点种查出来的 def —— 注册那一刻已经验过 `produce` 在场,消费侧因此不必再判一次。 */
export type NodeSegmentDef = SegmentDef & Required<Pick<SegmentDef, 'node' | 'produce'>>

/** 词汇里的某一型。kind 文件给自己的 def 定型用。 */
export type SegmentOf<K extends SegmentKind> = Extract<SegmentModel, { kind: K }>

/** 归组词汇里的某一种节点。kind 文件给自己的 `produce` 定型用。 */
export type NodeOf<K extends GroupedNode['node']> = Extract<GroupedNode, { node: K }>

const LIVE_FORMS: readonly SegmentGeometry['liveForm'][] = ['grow', 'fixed', 'reserve']
const SHRINKS: readonly SegmentGeometry['shrink'][] = ['never', 'user-only']

/**
 * 几何三问少答了哪一问(答全了回 undefined)。
 *
 * 类型已经拦得住漏写的静态调用方;这一道是给**运行时注册**的(测试里手搓的 def、将来
 * 不经 tsc 的来路)。与块表 `missingStreamAnswer` 同一条理由:沉默地少一问,P4 的读者
 * 就得替它猜,而「替它猜」正是这条线要根除的东西。
 */
export function missingGeometryAnswer(geometry: Partial<SegmentGeometry> | undefined): string | undefined {
  if (!geometry) return 'geometry'
  if (!LIVE_FORMS.includes(geometry.liveForm as SegmentGeometry['liveForm'])) return 'liveForm'
  if (geometry.settle !== 'same-height') return 'settle'
  if (!SHRINKS.includes(geometry.shrink as SegmentGeometry['shrink'])) return 'shrink'
  return undefined
}

/**
 * 一张表一个实例 —— 模块级单例只是**其中一个**实例(理由同块表:「重复注册抛错」
 * 这条规矩本身要测,用例之间共用一张全局表必然互相污染)。
 */
export class SegmentRegistry {
  /** kind → def。**插入序就是「按注册序问」的那个序**(Map 保证),`claim` 靠它。 */
  private readonly byKind = new Map<string, SegmentDef>()
  /** 节点种 → def。一种节点只能有一个 def(§20.4:两个 def 抢同一种节点就是没想清楚谁生产)。 */
  private readonly byNode = new Map<string, NodeSegmentDef>()

  /**
   * 宽表存窄 def 要一次 cast(props 与 produce 形参都在逆变位)。这不是类型漏洞:表的
   * 键就是 def 的 kind / node,取出来喂进去的模型与节点必然是它认识的那一种。cast 圈在
   * 这一行,消费侧不再有第二个。
   */
  register<M extends SegmentModel, N extends GroupedNode>(input: SegmentDef<M, N>): void {
    const def = input as unknown as SegmentDef
    if (this.byKind.has(def.kind)) {
      throw new Error(`段 kind 重复注册:${def.kind}(同一个 kind 只能有一个 def)`)
    }
    /*
     * **产地二选一,必有其一**。两个都缺:一条没有产地的段是死词汇 —— 表上有它,装配
     * 永远产不出它,几何答案没人会去兑现。两个都有:这一型既认领整条消息、又消费某种
     * 节点,「它从哪来」就有了两个答案,而装配第 ⓪ 步与循环会各自产出一份,谁也不知道
     * 屏幕上那一段是哪条路来的。
     */
    const hasNode = def.node !== undefined
    const hasClaim = def.claim !== undefined
    if (!hasNode && !hasClaim) {
      throw new Error(`段 ${def.kind} 没有产地:node 与 claim 必有其一`)
    }
    if (hasNode && hasClaim) {
      throw new Error(`段 ${def.kind} 有两个产地:node 与 claim 只许二选一`)
    }
    // 认了节点就得会生产 —— 否则装配循环查到它也无从下手。
    if (hasNode && !def.produce) {
      throw new Error(`段 ${def.kind} 认领节点 ${def.node} 却没有 produce`)
    }
    if (hasNode && this.byNode.has(def.node as string)) {
      const held = this.byNode.get(def.node as string)
      throw new Error(`节点 ${def.node} 已由段 ${held?.kind} 生产(一种节点只能有一个 def):${def.kind}`)
    }
    const missing = missingGeometryAnswer(def.geometry)
    if (missing) {
      throw new Error(`段 ${def.kind} 的几何契约少答了:${missing}(三问缺一不许注册)`)
    }
    this.byKind.set(def.kind, def)
    if (hasNode) this.byNode.set(def.node as string, def as NodeSegmentDef)
  }

  /**
   * 反注册。只为 HMR 退役存在(理由与块表逐字相同):热更时旧模块先把自己那格摘掉,
   * 新模块再登记,于是「重复注册 = 抛错」原样保留。摘之前比一次身份 —— dispose 的
   * 先后不由我们决定,盲摘会把新注册的那一格删掉。节点那张索引跟着一起摘,同样比身份。
   */
  unregister(kind: string, def?: SegmentDef): void {
    const held = this.byKind.get(kind)
    if (!held) return
    if (def && held !== def) return
    this.byKind.delete(kind)
    if (held.node !== undefined && this.byNode.get(held.node) === held) this.byNode.delete(held.node)
  }

  /** 查不到就抛 —— 未知段是装配错误,不是一种展示(见文件头第 1 条)。 */
  resolve(kind: string): SegmentDef {
    const hit = this.byKind.get(kind)
    if (hit) return hit
    throw new Error(`段 kind 没有注册:${kind}(是不是漏了 import content/segments)`)
  }

  /** 节点种 → 生产它的那个 def。查不到同样是装配错误(归组步多出一种节点而没人认领)。 */
  forNode(node: GroupedNode): NodeSegmentDef {
    const hit = this.byNode.get(node.node)
    if (hit) return hit
    throw new Error(`节点 ${node.node} 没有段认领(是不是漏了 import content/segments)`)
  }

  /**
   * 第 ⓪ 步:按注册序逐个问「这条消息整条是不是你」,第一个认领的赢。都不认就 null,
   * 消息照常走节点循环 —— 降级是「照实把正文摆出来」,不是吞掉这条消息。
   */
  claim(message: ProjectedMessage): SegmentModel | null {
    for (const def of this.byKind.values()) {
      if (!def.claim) continue
      const claimed = def.claim(message)
      if (claimed) return claimed
    }
    return null
  }

  has(kind: string): boolean {
    return this.byKind.has(kind)
  }

  kinds(): readonly string[] {
    return [...this.byKind.keys()]
  }
}

const registry = new SegmentRegistry()

/** Vite 的 `import.meta.hot` 里这一批只用得到 `dispose` 一口。 */
export interface ImportMetaHot {
  dispose(cb: () => void): void
}

/**
 * 注册一型段。**第二个形参是调用模块自己的 `import.meta.hot`**,给了它就自动配好热更
 * 退役 —— 理由与 `registerBlock` 逐字相同:hot 是每个模块自己的,注册表拿不到,只能递;
 * 递进来之后退役只写这一遍,而静态门(`__tests__/hmr-dispose.test.ts`)盯着这个参数。
 */
export function registerSegment<M extends SegmentModel, N extends GroupedNode>(
  def: SegmentDef<M, N>,
  hot?: ImportMetaHot,
): void {
  registry.register(def)
  // 生产构建里 hot 恒为 undefined,这一段连同 import.meta.hot 一起被摇掉。
  hot?.dispose(() => registry.unregister(def.kind, def as unknown as SegmentDef))
}

/** 摘掉一格。`registerSegment` 递了 hot 时它是自动的;这一口留给没有 hot 的调用方(测试)。 */
export function unregisterSegment(kind: string, def?: SegmentDef): void {
  registry.unregister(kind, def)
}

/** kind → def。**查不到抛**(见文件头第 1 条)。 */
export function resolveSegment(kind: SegmentKind | string): SegmentDef {
  return registry.resolve(kind)
}

/** 归组节点 → 生产它的 def。**查不到抛**。 */
export function segmentDefForNode(node: GroupedNode): NodeSegmentDef {
  return registry.forNode(node)
}

/** 第 ⓪ 步:这条消息整条是不是某一型段。没人认领 = null。 */
export function claimSegment(message: ProjectedMessage): SegmentModel | null {
  return registry.claim(message)
}

export function isSegmentRegistered(kind: string): boolean {
  return registry.has(kind)
}

/** 生产那张表上此刻登记了哪几型(测试核对「每一种词汇都有 def」用)。 */
export function registeredSegmentKinds(): readonly string[] {
  return registry.kinds()
}
