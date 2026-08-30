import type { ComponentType } from 'react'
import type { BlockModel, BlockKind } from '../model/blocks'
import { SOURCE_FALLBACK_KIND } from '../model/blocks'

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
}

/** 动作词表 —— **封闭**(§4.2)。加一格是拍板件,不是随手件。 */
export type BlockActionVerb = 'copy' | 'download' | 'view-source' | 'zoom'

export type BlockAction =
  /** 进剪贴板。`text` 是**已经序列化好的那份**——序列化归块,写剪贴板归壳。 */
  | { verb: 'copy'; what: 'markdown' | 'csv' | 'source' | 'column'; text: string }
  /** 落文件。P0 没有执行器,声明了也不会露出(见 shell/actions.ts)。 */
  | { verb: 'download'; what: 'csv' | 'png' | 'svg'; filename: string }
  /** 原地看源码。执行器是壳自己的状态,不需要块提供任何东西。 */
  | { verb: 'view-source' }
  /** QuickLook 同族浮层。P0 没有执行器。 */
  | { verb: 'zoom' }

/** 檐上的三格:左端身份(id/meta,小写 mono 灰)· 中段标题。 */
export interface BlockChrome {
  id?: string
  meta?: string
  title?: string
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
  /** 流式契约:append = 可半成品渲染(code);atomic = 闭合才画(table/figure)。 */
  streaming: 'append' | 'atomic'
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
    this.defs.set(def.kind, def as unknown as BlockDef)
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
}

const registry = new BlockRegistry()

export function registerBlock<M extends BlockModel>(def: BlockDef<M>): void {
  registry.register(def)
}

export function resolveBlock(kind: BlockKind | string): BlockDef {
  return registry.resolve(kind)
}

export function isBlockRegistered(kind: string): boolean {
  return registry.has(kind)
}
