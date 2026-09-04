import type { SearchCapabilityManifestDto, SearchStatusResponse } from '@shared/ipc/search'

/**
 * 检索面的 tab / 图标 / 次序 —— **全部从 `search.capabilities` 回来的自述算**
 * (设计 `docs/design/search-index-2026-09.md` §9 第一条、§4.0 那张枚举点清账表
 * 最后一行「壳的 tab / 图标 / 标签 → manifest 的 `labelKey` / `icon`」)。
 *
 * 这个文件是检索面里**唯一**知道「有哪些档」的地方,而它的答案完全来自参数 ——
 * 它自己一个能力 id 都不认识。全仓唯一允许写死的那一个是 `ALL_TAB`,理由在下面。
 *
 * ── 为什么 `all` 可以写死,别的不行 ─────────────────────────────────────
 * `all` **不是一个能力**,它是「不挑」这个动作:注册表里没有它、后端也从不返回它
 * (`SearchRequest.category` 收 `'all'` 时走的是全部档那条分支)。所以它是 tab 条
 * 这个**控件**自己的一格,与「有哪些能力」无关 —— 一个能力都没注册它照样在。
 * 别的 id 一个都不许出现在壳里,由 `__tests__/no-capability-literals.test.ts` 执法。
 *
 * ── 纯函数,不认识 React ────────────────────────────────────────────────
 * 与 `transitions.ts` 同一体例:这里只有数据变换,组件只负责画。
 */

/** 「不挑」那一档。它不是能力,见文件头。 */
export const ALL_TAB = 'all'

/** tab 条上的一格。`labelKey` 与 `icon` 都是**自述原样**,壳不翻译也不改名。 */
export interface SearchTab {
  /** 能力 id,或 `ALL_TAB`。也是 `SearchRequest.category` 的取值。 */
  id: string
  /**
   * 文案键(壳查字典)。`all` 那一格用的是壳自己的键 —— 它没有自述可读。
   */
  labelKey: string
  /**
   * 宿主枚举图标名(`icon` 注册表的键)。自述给的是名字不是 URL / SVG,
   * 认不认得由图标注册表答(认不出画兜底图标,不是崩)。
   */
  icon: string
}

/** `all` 那一格的文案键。它在壳的字典里,不在任何一份自述里。 */
export const ALL_TAB_LABEL_KEY = 'search.scopeAll'
const ALL_TAB_ICON = 'Search'

/**
 * 自述表 → tab 条。
 *
 * 两条规矩,都来自 §9 第一条:
 *  1. **`all` 固定第一**;
 *  2. 其余**按 `order` 升序**。同 order 的按自述表原来的次序(注册顺序 = 缺省展示
 *     顺序,§4.3)—— 所以这里用的是**稳定**排序,不是自己再定一条 tiebreak。
 *
 * 注销一个能力,它那一格 tab 自动消失;新注册一个(包括插件能力),它自动出现在
 * 自己声明的位置上。壳这一侧一个字不改 —— 那正是 §4.0 的硬指标。
 */
export function tabsOf(manifests: readonly SearchCapabilityManifestDto[]): SearchTab[] {
  const rest = [...manifests]
    .map((manifest, index) => ({ manifest, index }))
    // `sort` 在 V8 上已经是稳定的,但这里仍然显式带上下标:判据是「同 order 保注册序」,
    // 写出来的判据不会因为引擎换了实现而变成一句默认行为。
    .sort((a, b) => a.manifest.order - b.manifest.order || a.index - b.index)
    .map(({ manifest }) => ({
      id: manifest.id,
      labelKey: manifest.labelKey,
      icon: manifest.icon,
    }))
  return [{ id: ALL_TAB, labelKey: ALL_TAB_LABEL_KEY, icon: ALL_TAB_ICON }, ...rest]
}

/** Tab / ⇧Tab 在 tab 条上轮转。到头回卷 —— 与从前那只 `nextScope` 逐字同义。 */
export function nextTab(tabs: readonly SearchTab[], current: string, step: 1 | -1): string {
  if (tabs.length === 0) return current
  const at = tabs.findIndex(tab => tab.id === current)
  // 当前这一档已经不在表里了(能力刚被注销)→ 从头开始,而不是留在一个不存在的档上。
  if (at < 0) return tabs[0].id
  return tabs[(at + step + tabs.length) % tabs.length].id
}

/**
 * 这一档还在不在。能力被注销(插件禁用 / 自述表刷新)时,面板要从一个已经不存在的
 * 档上退回 `all` —— 停在那儿等于把一个查不到东西的档留给用户。
 */
export function resolveTab(tabs: readonly SearchTab[], requested: string): string {
  return tabs.some(tab => tab.id === requested) ? requested : ALL_TAB
}

/* ── 索引状态(§9 第三条最后一行)────────────────────────────────────── */

/**
 * 底部那两行读数要的全部东西:「索引更新中(剩 n)」与「由 <host> 维护」。
 *
 * **两件事,两行**,不合成一句:
 *  - `pending > 0` 说的是「现在答的这一份还没追上账本」—— 与谁在维护无关;
 *  - `mode === 'reader'` 说的是「折账本的不是这台进程」—— 拍点庚 09-04 裁「先不做」,
 *    所以今天它恒 `owner`,这一行画不出来。**画它的逻辑仍然要在**(§10 S4 行的
 *    第七条断言),否则 §5.6 落地那天壳这边又是一次改造。
 */
export interface SearchIndexReadout {
  /** 还欠着几条没折进索引;0 = 追上了。 */
  pending: number
  /** 别人在维护索引时,那台宿主的名字;`owner` / `error` 时缺席。 */
  readerHost?: string
}

export function indexReadoutOf(status: SearchStatusResponse | undefined): SearchIndexReadout | undefined {
  if (status === undefined) return undefined
  // `error`(这台机器上根本没起索引)**不在这两行里说** —— 它不是「更新中」也不是
  // 「别人在维护」,而且它对用户的可见后果已经由「搜不到东西」自己说了。
  if (status.mode === 'reader') {
    return { pending: status.pending, readerHost: status.owner?.host ?? '' }
  }
  return { pending: status.pending }
}
