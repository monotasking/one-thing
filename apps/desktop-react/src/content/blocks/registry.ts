import type { ComponentType } from 'react'
import type { BlockModel, BlockKind } from '../model/blocks'
import { SOURCE_FALLBACK_KIND } from '../model/blocks'
import { missingStreamAnswer, type BlockCommit, type BlockStreamContract } from './stream/contract'

/**
 * 块注册表 —— **kind → 怎么画**(§3.1)。
 *
 * ── 注册表不 import 任何组件 ──────────────────────────────────────────
 * 依赖方向是「组件注册时自己找上门」,不是「注册表去认识每个组件」。这一条砍掉了
 * 环(组件 → 壳 → 注册表 → 组件),也让「加一个块」的代价是**新建一个目录**,
 * 而不是改这个文件。兜底的 `source-fallback` 也一样:它是被注册进来的一个普通块,
 * 注册表只记住「查不到时兜到这个 kind」。
 *
 * ── 三条规矩 ────────────────────────────────────────────────────────
 * 1. **重复注册 = 抛错**,不静默覆盖。同一个 kind 被两处注册,说明有人没看见
 *    另一处 —— 静默后胜会让「我改了怎么没生效」变成一小时的排查。
 * 2. **未知 kind 不是错误**:解析器可以产出注册表还不认识的 kind(版本错位、
 *    插件缺席),`resolveBlock` 兜到 `source-fallback` —— 源码永远可见,
 *    这是全系统的失败语义。
 * 3. **注册只发生在一个 barrel**(`./index.ts`)。运行时注册面留着(将来插件接入
 *    走同一个 `registerBlock`),但今天没有第二个调用方。
 */

/** 渲染器拿得到的现场信息。壳与块共用一份,别在块里再去读全局 store。 */
export interface BlockCtx {
  /** 这块内容属于哪条消息 —— 进日志、进错误现场名。 */
  messageId: string
  /** 这条消息此刻是不是正在生成(流式契约 §6 的输入)。 */
  streaming: boolean
  /**
   * **这条消息属于哪条会话**(U2 加的一格)。
   *
   * 有它才谈得上「对这条会话做一件事」—— 今天唯一的消费者是压缩折痕失败态那颗
   * 重试(`commandsPort.compactContext(sessionId)` + `selectEngineBusy` 都按会话问)。
   * 会话多开之后「当前会话」说不清这件事:一片没获得焦点的会话叶里那颗钮按下去
   * 必须重压**它自己**那条(与 `MessageActions` 收 `sessionId` 是同一条判例),
   * 所以它从壳递进来,而不是让段去读全局 store(见本接口开头那句)。
   *
   * **可缺席**:块也长在没有会话的地方(查看器里回放一份 markdown,
   * `viewer/kinds/markdown.tsx`)。缺席的含义是「这里没有会话」——
   * 于是那颗按会话动手的钮整个不画,而不是画一颗按下去不知道打给谁的钮。
   */
  sessionId?: string
  /**
   * **这块内容所在的文档在哪个目录**(图片批加的一格,正本 §2)。
   *
   * 有它才解得开相对路径的资产地址(`![](../91 Attachments/x.png)` —— 真店里图片
   * 地址的大头)。查看器 markdown 型传文件所在目录;**聊天今天不传**,因为「一条
   * 会话的相对路径相对谁」还没有答案(会话 workdir 是正本 §6 的 P3)。
   *
   * **可缺席,含义是「这里没有文档位置」** —— 于是相对地址落诚实态显出原地址,
   * 而不是拿当前页面的 URL 去拼一个谁也没写过的路径。
   */
  baseDir?: string
}

/** 动作词表 —— **封闭**(§4.2)。加一格是拍板件,不是随手件。 */
export type BlockActionVerb = 'copy' | 'download' | 'view-source' | 'zoom'

/**
 * 「到时候去取」的取件口(P3)。
 *
 * `download.png` / `zoom` 要的是**画完之后**的那份 SVG,而 `def.actions` 是在渲染
 * 之前就被壳调用的 —— 声明的时刻还没有字节。所以这两格给的不是内容,是一个读
 * 渲染缓存的取件口:点下去那一刻现取。取不到(还在渲染 / 渲染失败)就什么都不做,
 * 不开一个空浮层、不落一个空文件。
 *
 * 它是**壳与块之间**的一个函数,不是模型里的一个函数 —— `BlockModel` 仍然是纯数据。
 */
export type SvgSource = () => string | undefined

/**
 * 放大浮层的第二种取件口:一张**位图**(图片批加,正本 §3)。
 *
 * 与 `SvgSource` 并列而不是把位图硬塞进 `svg` 那一格:浮层对两者的画法本来就不同
 * (矢量掀掉行内上限拉满,位图不放大),而词表**没有**新动词 —— `zoom` 还是那一条,
 * 只是取件口多了一种。取不到(还没加载完 / 解不开地址)回 undefined,执行器什么
 * 都不做,和 SVG 那一格逐字同义。
 */
export type ImageSource = () => { src: string; alt: string } | undefined

export type BlockAction =
  /** 进剪贴板。`text` 是**已经序列化好的那份**——序列化归块,写剪贴板归壳。 */
  | { verb: 'copy'; what: 'markdown' | 'csv' | 'source' | 'column'; text: string }
  /** 落文件。`svg` 缺席 = 这一格还没有执行器,壳会把它筛掉(见 shell/actions.ts)。 */
  | { verb: 'download'; what: 'csv' | 'png' | 'svg'; filename: string; svg?: SvgSource }
  /** 原地看源码。执行器是壳自己的状态,不需要块提供任何东西。 */
  | { verb: 'view-source' }
  /**
   * 放大到浮层。同 download:内容是点下去那一刻现取的。
   *
   * 两个取件口,**有其一就露得出来**(判据在 shell/actions.ts 的
   * `isBlockActionRunnable`):矢量图给 `svg`,位图给 `image`。
   */
  | { verb: 'zoom'; svg?: SvgSource; image?: ImageSource }

/**
 * 檐上的几格:左端身份(id/meta,小写 mono 灰)· 中段标题 · 增删读数。
 *
 * `stat` 是 P3 为 diff 檐加的一格,**是数据不是节点**:它长什么样(符号、颜色、
 * 顺序、字号)由壳一次说了算,块只报「加了几行删了几行」。写成 `ReactNode` 型的
 * 标题当然也能画出来,但那等于给每个块开了一道往檐上塞任意 UI 的口子 ——
 * 壳的整条分界(铁律 3)靠的就是块**没有**这个机会。
 */
export interface BlockChrome {
  id?: string
  meta?: string
  title?: string
  stat?: { add: number; del: number }
}

export interface BlockDef<M extends BlockModel = BlockModel> {
  kind: M['kind']
  /**
   * `object` = 进 BlockShell 的物件(有檐、有横滚、有限高折叠);
   * `flow` = 直排在纸上(段落 / 标题 / 引用 / 思考),壳只给它错误边界与懒加载,
   * **一个 DOM 节点都不多加** —— 它是聊天纸面上的一段字,不是一件东西。
   */
  presentation: 'object' | 'flow'
  /** 本体渲染器。只画 body,公共件一行不写。 */
  Component: ComponentType<{ model: M; ctx: BlockCtx }>
  /** 檐声明。undefined = 无檐(flow 块必然无檐)。 */
  chrome?: (model: M) => BlockChrome
  /** 动作声明。壳画前 1–2 个 + ⋯ 菜单。 */
  actions?: (model: M, ctx: BlockCtx) => BlockAction[]
  /**
   * 檐上**露出**几个动作(默认 2,其余进 ⋯ 菜单)。
   *
   * §4.2 那句「前 1–2 个」里的 1 就是这一格:图卡定稿只在檐上留一个「放大」,
   * 「下载 PNG / 查看源码」都收进 ⋯。这是**露出预算**,不是一个新动作词 ——
   * 词表照旧封闭,顺序照旧由块的声明决定。
   */
  frontActions?: 1 | 2
  /**
   * **流式五问**(R4a)。从前这一格是一个字 `streaming: 'append' | 'atomic'` ——
   * 它只答了五问里的第一问,而另外四问的答案散在增量解析器、key 派生、兜底路
   * 三个地方各写一遍。现在它们回到型自己身上,机制层零型特例。
   *
   * 少答一问 = 注册当场抛(见 `BlockRegistry.register`)。
   */
  stream: BlockStreamContract
  /** 重渲染器懒加载(shiki / mermaid / katex)。失败走降级,不炸整块。 */
  loader?: () => Promise<unknown>
}

/**
 * 一张表一个实例 —— 模块级单例只是**其中一个**实例。
 *
 * 写成类而不是一组模块级函数,是为了让测试能各起各的表:表是有状态的(注册过什么),
 * 而「重复注册抛错」这条规矩本身就要测,用例之间共用一张全局表必然互相污染。
 * 生产侧永远只有下面那一个单例。
 */
export class BlockRegistry {
  private readonly defs = new Map<string, BlockDef>()

  /**
   * 收窄的 def 存进宽表要一次 cast:`ComponentType<{model: 段落}>` 不是
   * `ComponentType<{model: 任意块}>` 的子类型(props 是逆变位)。这不是类型漏洞 ——
   * **表的键与 def 的 kind 是同一个字符串**,所以取出来时拿到的模型必然是它认识的
   * 那一种。cast 圈在这一行里,消费侧(resolve)因此不必再有一个。
   */
  register<M extends BlockModel>(def: BlockDef<M>): void {
    if (this.defs.has(def.kind)) {
      throw new Error(`块 kind 重复注册:${def.kind}(同一个 kind 只能有一个渲染器)`)
    }
    /*
     * **缺一问,注册即抛**(R4a)。
     *
     * 类型系统已经拦得住漏写的静态调用方,这一道是给**运行时注册**的(将来的插件块、
     * 测试里手搓的 def):沉默地少一问,机制层就得替它猜,而「替它猜」正是六轮事故的
     * 那条路。抛,不 warn —— warn 会被滚过去。
     */
    const missing = missingStreamAnswer(def.stream)
    if (missing) {
      throw new Error(`块 ${def.kind} 的流式契约少答了:${missing}(五问缺一不许注册)`)
    }
    this.defs.set(def.kind, def as unknown as BlockDef)
  }

  /**
   * 反注册。**只为一件事存在:模块的 HMR 退役**(CLAUDE.md「模块级副作用必须配
   * HMR dispose」)。热更时旧模块先把自己那一格摘掉,新模块再登记 —— 于是
   * 「重复注册 = 抛错」这条法**原样保留**:它本来要抓的是「两个不同模块抢同一个
   * kind」,而热更是同一个模块的另一版,不是那件事。
   *
   * 摘的时候比一次身份:表里那一格已经是别人的了就不动 —— dispose 的顺序不是
   * 我们能左右的,盲摘会把新注册的那一格删掉。
   */
  unregister(kind: string, def?: BlockDef): void {
    const held = this.defs.get(kind)
    if (!held) return
    if (def && held !== def) return
    this.defs.delete(kind)
  }

  /** 查不到就是 `source-fallback` —— 未知不是错误,是一种展示。 */
  resolve(kind: string): BlockDef {
    const hit = this.defs.get(kind)
    if (hit) return hit
    const fallback = this.defs.get(SOURCE_FALLBACK_KIND)
    if (!fallback) {
      // 走到这里说明注册 barrel 没被 import —— 这是装配错误,不是内容错误,
      // 兜底不了(兜底本身缺席),所以当场说清是哪一件事没做。
      throw new Error(`块注册表还没装:${SOURCE_FALLBACK_KIND} 缺席(是不是漏了 import ./blocks)`)
    }
    return fallback
  }

  has(kind: string): boolean {
    return this.defs.has(kind)
  }

  /**
   * 声明了「承诺」的那几型 —— 增量解析器按它逐个试补(R4a 立,R4b 更名)。
   *
   * 返回的是 `(kind, 承诺函数)` 对,**顺序 = 注册顺序**。今天只有表一型,所以顺序
   * 不是问题;将来多于一型时它是一条需要拍板的政策(谁先认领),那时这一行会长出
   * 一个显式的优先级字段 —— 在此之前不假装已经有了。
   */
  commitPolicies(): readonly { kind: string; commit: BlockCommit }[] {
    const out: { kind: string; commit: BlockCommit }[] = []
    for (const def of this.defs.values()) {
      if (def.stream.commit) out.push({ kind: def.kind, commit: def.stream.commit })
    }
    return out
  }
}

const registry = new BlockRegistry()

/**
 * 注册一个块。**第二个形参是调用模块自己的 `import.meta.hot`**,给了它就自动配好
 * 热更退役 —— 每个 kind 的 `index.ts` 写成:
 *
 * ```ts
 * registerBlock({ kind: 'list', … }, import.meta.hot)
 * ```
 *
 * ── 为什么把 hot 递进来,而不是各自写一段 dispose ──────────────────────────
 * `import.meta.hot` 是**每个模块自己的**,注册表拿不到调用方那一份,所以只能递。
 * 但递进来之后,退役那一段就只写一遍(在这里),不是每个 kind 各抄两行 ——
 * 而「加一个块 = 新建一个目录 + barrel 加一行」这条代价不变(hot 长在同一次
 * 调用里,想漏得先把参数删掉,而静态门盯着这个参数,见
 * `__tests__/hmr-dispose.test.ts`)。
 *
 * 不给 hot 也能注册(运行时插件、测试),那时就没有退役 —— 那些调用方的寿命
 * 本来也不是「这个模块实例」。
 *
 * ── 为什么不是「重复注册改成替换」──────────────────────────────────────
 * 09-01 那条 `unhandledrejection`(「块 kind 重复注册:list」)的病因是热更,
 * 不是两处抢注册。把法从「抛错」放宽成「替换 + warn」等于为了治热更把**真正的
 * 冲突**一起放过了(而那正是这张表当初立这条法要抓的东西)。退役是对症的那一刀:
 * 热更时旧的先走,法一个字不动。
 */
export function registerBlock<M extends BlockModel>(def: BlockDef<M>, hot?: ImportMetaHot): void {
  registry.register(def)
  // 生产构建里 hot 恒为 undefined,这一段连同 import.meta.hot 一起被摇掉。
  hot?.dispose(() => registry.unregister(def.kind, def as unknown as BlockDef))
}

/** Vite 的 `import.meta.hot` 里这一批只用得到 `dispose` 一口。 */
export interface ImportMetaHot {
  dispose(cb: () => void): void
}

/**
 * 摘掉一格。`registerBlock` 递了 hot 时它是自动的(热更退役),这一口留给
 * **没有 hot 的那些调用方**:将来的运行时插件卸载,和要自己收尾的测试。
 * 带上 `def` 就只摘「确实是我注册的那一格」——理由见 `BlockRegistry.unregister`。
 */
export function unregisterBlock(kind: string, def?: BlockDef): void {
  registry.unregister(kind, def)
}

export function resolveBlock(kind: BlockKind | string): BlockDef {
  return registry.resolve(kind)
}

export function isBlockRegistered(kind: string): boolean {
  return registry.has(kind)
}

/** 生产那张表上声明了承诺政策的几型(增量解析器的唯一政策来源)。 */
export function blockCommitPolicies(): readonly { kind: string; commit: BlockCommit }[] {
  return registry.commitPolicies()
}

export type { BlockStreamContract } from './stream/contract'
