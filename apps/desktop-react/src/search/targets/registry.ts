import type { ComponentType } from 'react'
import { getLogger } from '../../services/log'
import type { SearchRow } from '../types'

/**
 * **目标渲染注册表** —— 「结果行长什么样、点了去哪儿」由 `target.kind` 决定
 * (设计 `docs/design/search-index-2026-09.md` §4.3 末段 / §9 第二条)。
 *
 * 三张表同款(与查看器的 `content/viewer/registry.ts`、块的
 * `content/blocks/registry.ts` 逐条对着写):
 *  1. **重复注册 = 抛错**,不静默覆盖 —— 静默后胜会把「我改了怎么没生效」变成
 *     一小时排查;
 *  2. **注册只发生在一个 barrel**(`./index.ts`),import 它就是「这台上有哪些
 *     目标形」,一眼看全;
 *  3. **查不到不是错误**:缺渲染器的 kind 画成「只有标题的一行」并在 dev 下
 *     `warn` —— §4.3 的原话是「绝不因为壳没跟上而把结果吞掉」。
 *
 * ── 为什么是 `target.kind` 而不是结果的 `type` ─────────────────────────
 * `SearchResult.type` 是**旧形**的六个字面量(S5 会删);`target.kind` 是**开放**的
 * (`{ kind: string; payload: unknown }`),形由产它的能力自己定义并导出类型。
 * 按前者分发的话,加一种能力就要去改那个联合 —— 那正是 §4.0 要拆掉的枚举点。
 *
 * ── 渲染器手上有什么 ──────────────────────────────────────────────────
 * 一行**只读事实**(`SearchRow`)+ 一组窄回调(`SearchTargetContext`)。没有 store,
 * 没有 zustand,没有 client —— 落点是宿主给的能力,渲染器只说「我要去哪儿」。
 * 这条分界买到的是「结果行长什么样」的结构保证:徽 / 正文 / 出处三段在任何一种
 * kind 下都在同一个位置、同一种画法,新 kind 的作者根本没有做错的机会。
 */

/** 一行渲染器手上的窄回调。**宿主给能力,渲染器只说去哪儿。** */
export interface SearchTargetContext {
  /** 进一间会话;`messageId` 在场时另留一格「落到那条消息」的待办。 */
  enterSession(sessionId: string, messageId?: string): void
  /** 打开一个文件(壳今天还没有「打开器」,宿主如实报出落点)。 */
  openFile(path: string, line?: number): void
  /** 跑一条动作(命令面板那一档;宿主没有落点时如实说)。 */
  runAction(actionId: string): void
}

/** 一行渲染器画什么。**只有 body 那三段的正文那一段** —— 徽与出处归壳。 */
export interface SearchTargetRowProps {
  row: SearchRow
  /** 此刻的词(高亮用;行自带 `highlight` 时视图优先用那一份)。 */
  query: string
}

export interface SearchTargetRenderer {
  /** 表里的键,也是 `data-target-kind` 的值 —— 等于 `Candidate.target.kind`。 */
  kind: string
  /**
   * 行首那颗徽上的字。**两种产地**:界面文案(走字典,返回 `{ labelKey }`)与
   * 从数据推出来的字(扩展名之类,返回 `{ text }`)。混成一个 string 就分不清
   * 谁该进字典 —— 与从前 `SearchBadge` 那个可辨识联合是同一条判据。
   */
  badge(row: SearchRow): { labelKey: string } | { text: string }
  /** 中间那一段(命中原文 / 标题)。缺席 = 走壳的缺省画法(高亮 + 省略号)。 */
  Row?: ComponentType<SearchTargetRowProps>
  /** 点它去哪儿。**落点只有这一处**,面板不再 `switch (target.kind)`。 */
  activate(row: SearchRow, context: SearchTargetContext): void
  /**
   * 预览渲染器(§4.5 ②)。**S4a 一个都没有** —— 预览窗是 S4b。这一格现在就留着,
   * 是因为它与 `Row` 是同一张表上的两列(设计 §4.3「`registerTargetRenderer(kind,
   * { Row, Preview? })`」);S4b 加预览窗时这里一个字不改。
   */
  Preview?: ComponentType<{ row: SearchRow; payload: unknown }>
}

const renderers = new Map<string, SearchTargetRenderer>()

/** 重复注册 = 抛错(判例 1)。返回注销 —— 插件能力的渲染器随插件禁用一起走。 */
export function registerTargetRenderer(renderer: SearchTargetRenderer): () => void {
  if (renderers.has(renderer.kind)) {
    throw new Error(`search target renderer already registered: ${renderer.kind}`)
  }
  renderers.set(renderer.kind, renderer)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // 只删自己那一条:注销晚到时不许把后来注册的同名渲染器顺手删掉。
    if (renderers.get(renderer.kind) === renderer) renderers.delete(renderer.kind)
  }
}

const warned = new Set<string>()

/**
 * 查不到**不是错误**(判例 3):答 `undefined`,由调用方画「只有标题的一行」。
 *
 * dev 下每种 kind 只 `warn` 一次 —— 一张列表里二十条同 kind 的结果不该刷二十行日志。
 * 走的是壳的 `getLogger`,不是 `console`(log 闸)。
 */
export function resolveTargetRenderer(kind: string): SearchTargetRenderer | undefined {
  const renderer = renderers.get(kind)
  if (renderer === undefined && !warned.has(kind)) {
    warned.add(kind)
    getLogger('search.targets').warn('no renderer for this target kind; falling back to a title-only row', { kind })
  }
  return renderer
}

/** 表里现在有哪些 kind(测试与门读它)。 */
export function targetRendererKinds(): string[] {
  return [...renderers.keys()]
}

/** 测试用:清表重来。产品代码一处都不该调它。 */
export function resetTargetRenderers(): void {
  renderers.clear()
  warned.clear()
}
