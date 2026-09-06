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
  const rest = orderedManifests(manifests).map(manifest => ({
    id: manifest.id,
    labelKey: manifest.labelKey,
    icon: manifest.icon,
  }))
  return [{ id: ALL_TAB, labelKey: ALL_TAB_LABEL_KEY, icon: ALL_TAB_ICON }, ...rest]
}

/**
 * 展示次序(`order` 升序,同 `order` 保注册序)。**一处算** —— tab 条与空词的
 * 浏览态各排一遍就是两个产地,而它们说的是同一句话。
 */
function orderedManifests(
  manifests: readonly SearchCapabilityManifestDto[],
): SearchCapabilityManifestDto[] {
  return [...manifests]
    .map((manifest, index) => ({ manifest, index }))
    // `sort` 在 V8 上已经是稳定的,但这里仍然显式带上下标:判据是「同 order 保注册序」,
    // 写出来的判据不会因为引擎换了实现而变成一句默认行为。
    .sort((a, b) => a.manifest.order - b.manifest.order || a.index - b.index)
    .map(({ manifest }) => manifest)
}

/**
 * **空词时「所有」档去问谁**(S4b 修;09-01 用户裁定:「我要能够在这里面看到
 * 所有的条数,所有的记录,要能够翻页」)。
 *
 * ── 为什么空词的 `all` 档不能发 `category: 'all'` ─────────────────────────
 * `'all'` 在后端是**分组总览**(§7.2:「总览的目的是『大概在哪一类』;要翻页去
 * 单类」)—— 各能力按自己的配额各给几条、不分页、不报总数。那张总览在**有词**
 * 时正是想要的;而空输入框那一屏用户要的是**浏览**:全部会话、看得见总条数、
 * 翻得了页。两件事同一个档位,判据只能是「有没有词」。
 *
 * ── 为什么答案从自述里读,而不是写一个 `'chats'` ─────────────────────────
 * 「空词的时候我有东西可列」是**能力自己**才知道的事(chats 有一条空词绕开索引
 * 直接调旧 `searchChats` 的路;别的能力对零词元恒零命中)。写死一个 id 就是又一个
 * 枚举点 —— §4.0 那条硬指标与 `__tests__/no-capability-literals.test.ts` 都不许。
 * 所以能力在 manifest 上自报一格 `browse`,壳读表:声明了的各占一组,
 * 今天恰好只有一个,于是屏幕上就是一张平铺的会话列表 —— 与旧行为逐字相同。
 *
 * 次序与 tab 条同一条(见 `orderedManifests`)。
 */
export function browseCapabilitiesOf(
  manifests: readonly SearchCapabilityManifestDto[],
): string[] {
  return orderedManifests(manifests)
    .filter(manifest => manifest.browse === true)
    .map(manifest => manifest.id)
}

/**
 * **输入框占位里那串档名**(R12;落差 #51「占位文案过期」/ #125 / #129)。
 *
 * 从前占位是字典里写死的一句「搜文件、章节、消息、会话…」—— 那句话上一次说对是在
 * 「章节」还是一个档的时候。名字要从**自述**来:能力表里有哪几档,占位就说哪几档,
 * 注销一个它自己就消失,新注册一个它自己就出现,壳这一侧一个字不改。
 *
 * `all` 那一格不进去:它不是一类能搜的东西,是「不挑」这个动作。
 * 次序与 tab 条同一条(`orderedManifests`)—— 屏幕上从左到右念下来就是这串字。
 *
 * 译文由调用方递进来(与 `labelTextOf` 同一体例:字典在 i18n,不在这里);
 * 空表(自述还没回来)= 空数组,由调用方退回那句不带档名的占位。
 */
export function scopeNamesOf(
  tabs: readonly SearchTab[],
  labelOf: (tab: SearchTab) => string,
): string[] {
  return tabs.filter(tab => tab.id !== ALL_TAB).map(labelOf).filter(name => name.length > 0)
}

/**
 * 这个能力的文案键(自述原样)。查不到 = `undefined`。
 *
 * 用处只有一个:空词浏览态那几组是**壳自己拼的**(一组一次查询),后端没给
 * 组名 —— 名字于是从自述表读。后端给了名字的组(`all` 档的 `groups`)照旧用
 * 后端那一份,这里不去覆盖它:两条路各有产地,不合并成「壳说了算」。
 */
export function labelKeyOf(
  manifests: readonly SearchCapabilityManifestDto[],
  capability: string,
): string | undefined {
  return manifests.find(manifest => manifest.id === capability)?.labelKey
}

/**
 * 屏幕上那一格写什么。
 *
 * `labelKey` 是**自述原样**,而字典里不一定有它 —— 一个插件能力(或任何一个不在
 * 壳这份字典里的能力)给的键翻不出来,`translate` 会答 `undefined`,渲染成一格
 * **空白 tab**。空白比原文糟得多:原文至少说得出「这一档叫 zzz-unknown」,
 * 而空白让人以为控件坏了。
 *
 * 所以判据是一句话:**翻得出就画译文,翻不出就画原文**。它是纯函数(译文由调用
 * 方递进来),与这个文件里别的东西同一体例 —— 字典在 i18n,不在这里。
 */
export function labelTextOf(labelKey: string, translated: string | undefined): string {
  return translated || labelKey
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
  /**
   * **这台上根本没起索引**(`status.mode === 'error'`;检索面终稿 落差 #19)。
   *
   * 从前这一格被吞掉了 —— 判词是「它对用户的可见后果已经由『搜不到东西』自己
   * 说了」,而那正是问题:屏幕上「一条都没搜到」与「索引坏了所以只剩扫描那几类」
   * 长得一模一样,用户没有任何办法分辨。09-05 裁定:上屏一句人话
   * (「索引不可用 · 只显示未建索引的结果」),**没有重试** —— 重建索引不是
   * 一颗按钮能承诺的事。
   *
   * 判据只认 `mode` 这一格,不去匹配报错文案(那是字符串匹配当根因)。
   */
  unavailable?: boolean
  /**
   * **语义召回还没就绪**(S7 §15;步⑦ 留账 E-6 第一条)。
   *
   * 契约上 `status.vector` 有四态,而值得占一行字的只有中间那两态:
   *  · `downloading` —— 嵌入模型还在下载(第一次开开关那一段,110MB);
   *  · `embedding` —— 模型有了,还在把文档嵌进向量(`vectorPending` 是真读数)。
   * `ready` 与 `off` **什么都不画**:开关关着不是新闻,能用了也不必宣布 ——
   * 页脚是「此刻有什么不对劲」的地方,不是功能清单。
   *
   * 缺席 = 这一格答不上来(旧后端 / 索引问不出来),同样不画。
   */
  vector?: 'downloading' | 'embedding'
  /** 还有几份文档没嵌进去(`vector==='embedding'` 时才有意义)。 */
  vectorPending?: number
}

export function indexReadoutOf(status: SearchStatusResponse | undefined): SearchIndexReadout | undefined {
  if (status === undefined) return undefined
  /*
   * 语义召回那一格与 `mode` **无关**:索引是 reader / error 时它照样可能在下载模型。
   * 所以它在三条 return 之前先算好,三条各自驮上 —— 不在其中一条里偷偷漏掉。
   */
  const vector = status.vector === 'downloading' || status.vector === 'embedding'
    ? {
      vector: status.vector,
      ...(status.vectorPending === undefined ? {} : { vectorPending: status.vectorPending }),
    }
    : {}
  if (status.mode === 'reader') {
    return { pending: status.pending, readerHost: status.owner?.host ?? '', ...vector }
  }
  if (status.mode === 'error') {
    return { pending: status.pending, unavailable: true, ...vector }
  }
  return { pending: status.pending, ...vector }
}
