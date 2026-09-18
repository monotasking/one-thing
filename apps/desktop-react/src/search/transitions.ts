import type { SearchItemRef, SearchResult } from '@shared/ipc/search'
import { splitHighlight } from '../expose/transitions'
import type { SearchOrigin, SearchRow } from './types'

/**
 * 检索面的**造行**那几只纯函数。不认识 React —— 组件只负责画。
 *
 * 高亮切片**直接复用** expose/transitions 的 splitHighlight(下面原样再导出),
 * 不复制一份:两个面上「什么算命中」必须是同一件事,否则迟早漂移。
 *
 * ── 第 ⑨ 步:分节与分页从这个文件里没有了 ────────────────────────────────
 * 从前这里还住着两台机:分节(`SearchSection` / `sectionsOf` / `flatRows` /
 * `sectionsWindow`)与分页(`SEARCH_FIRST_PAGE` / `SEARCH_PAGE_SIZE` /
 * `pageWindow` / `remoteSide` / `SearchMore` / `moreState`),以及那一大段解释
 * 「为什么是**递增 limit 重查**而不是真游标」的注释。三件事同时作废:
 *  · 分节的产地成了 `sequence.ts`(块 → 序列项,一次 flatten 兼管画与走位);
 *  · 分页的产地成了 `paging.ts` + `data/search-listing-source.ts`(逐块真游标、
 *    对同一格 `patch` 追加),`limit` 不再进查询键;
 *  · 「递增 limit 重查」那条路本身被推翻 —— 它正是「Load more 跳回顶部」的病根。
 * 最后一个消费者在第 ⑦ 步换心时就没了,本批下葬。留下的只有造行这一件事。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * S4b:壳这一侧**没有第二个产地了**
 * ══════════════════════════════════════════════════════════════════════════
 * S4a 之前这个文件里有三条**壳自己的**造行路:会话侧(本地滤整张 `listMeta`)、
 * 章节侧(按需拉的分段缓存)、文件侧(`files.list`),外加一路后端正文命中,
 * 最后由 `searchRows` / `browseRows` 拼成一张平铺列表。**那四路本批全部删掉**
 * (设计 `docs/design/search-index-2026-09.md` §4.0 那张枚举点清账表的最后一格:
 * 「壳自己拼三类的产地」)。
 *
 * 今天只剩一条路:`search.query({ category })` 回来的 `results`(单类档)
 * 或 `groups`(`all` 档),经 `resultRows` 变成行。于是——
 *
 *  · **加一类能搜的东西,这个文件一个字不改**;
 *  · 「什么算命中、怎么排、放宽到第几级、这一档一共多少条」全在后端一处答,
 *    壳不再有第二套口径去和它对不上。
 *
 * ── 换来的可感知变化(如实记账,不是悄悄改掉)──────────────────────────────
 * | 从前 | 现在 | 为什么 |
 * | --- | --- | --- |
 * | 会话**预览文本**(首条用户消息的截断)能搜到 | 搜不到 | chats 的索引 schema 只有 `title` 一格(拍点乙 a,`capabilities/sessions.ts`);从前那一路是壳拿 `previewText` 本地 `includes` 出来的 |
 * | 会话**章节**(标题 / 摘要)能搜到 | 搜不到 | 章节从来没有进过索引,它是 `sessions.getSegments` 按需拉的一份视图;要让它可搜是给 chats 补一条 feed,是后端的一批 |
 * | 命中是**子串**(`includes`) | 是**词与前缀** | 索引的语义(§2 拍定);「查询是某个词元的中段」从此不中,与 parity-B 的差集口径逐字同源 |
 * | 空间过滤靠「拿屏幕那张会话表筛」 | 靠 `filters.spaceId` 这一格结构地说 | 见 `./filters.ts` 的 `spaceFilterValue` |
 * | 会话行的出处是「项目 · 时间」 | 是后端给的 `subtitle`(会话的预览文本) | 项目名与相对时间都是**壳**才算得出来的东西,后端的候选上没有那两格 |
 * | 单类 `chats` 档里混着正文命中 | 不混(messages 自成一档) | S4a 已改,这里只是记账不再重复 |
 *
 * 这几条都在 S4a 的留账里预告过(「换掉 chats 的产地会一并换掉命中的口径、
 * 章节命中、当前空间投影 —— 那是一次可感知的行为变化」),本批把它做完并记下来。
 */
export { splitHighlight }

/* ── 路径拆解 ──────────────────────────────────────────────────────────── */

export function fileName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/** 徽上那两三个字母。没有扩展名就把整个名字大写 —— 不造「未知」这种文案。 */
export function fileExt(path: string): string {
  const name = fileName(path)
  const at = name.lastIndexOf('.')
  return (at <= 0 ? name : name.slice(at + 1)).toUpperCase()
}

/* ── 出处 ──────────────────────────────────────────────────────────────── */

/**
 * 行尾那行灰字的拼法只在这里定一次。
 * 分隔符是**标点**不是文案(换语言不该变),所以纯函数可以给;
 * 真·文案(徽上的「会话」「消息」)一个字都不在这里。
 */
export function originText(origin: SearchOrigin): string {
  switch (origin.kind) {
    case 'session':
      return origin.session
    case 'fileLine':
      return `${origin.file}:${origin.line}`
    case 'projectTime':
      return `${origin.project} · ${origin.time}`
    case 'time':
      return origin.time
    case 'path':
      return origin.path
  }
}

/*
 * 这里从前还有一只 `targetText` —— 通知里那句「已打开 {file}」的拼法。
 * 那句通知是个**占位**:它只说自己打开了,从没接过打开动作(09-18 报障
 * 「搜到笔记后回车,有提示框显示已打开,但实际上没打开」)。今天那一路真的走
 * `openFileInCurrentTarget`,打开的那块查看器自己就是反馈,通知与这只拼法一起
 * 退役 —— 留一只零读者的拼法,留下的是一份「这里会弹一句话」的假话。
 */

/* ── 造行 ──────────────────────────────────────────────────────────────── */

/**
 * 后端交回来的一批结果 → 屏幕上的行。**唯一的造行路**(S4b)。
 *
 * 三件事在这里发生,一件都不多:
 *
 *  1. **`target` 缺席的丢掉**。没有落点的行按下去什么都不会发生,画出来只会
 *     让人以为自己按错了。缺的是**渲染器**时不丢(那一支画「只有标题的一行」,
 *     §4.3 的原话);缺的是**落点**时才丢 —— 两者不是一回事。
 *  2. **出处取 `subtitle`,退到 `detail`**。这两格是各能力自己填的一句话
 *     (消息 → 所属会话名;会话 → 预览文本;文件 → 路径),壳不解释它,
 *     也不去猜第三个产地。
 *  3. **高亮用后端给的 `matchRanges`**,不在壳里再 `indexOf` 一遍 —— 两个产地
 *     各说一次「什么算命中」迟早漂移(后端的 `normalizeQuery` 会剥掉开头的
 *     `>` 与 `/`,本地那一遍不会)。
 */
export function resultRows(
  results: readonly SearchResult[],
  capability: string,
): SearchRow[] {
  const rows: SearchRow[] = []
  for (const result of results) {
    if (result.target === undefined) continue
    /*
     * ── 无标题(检索面终稿 §6「无标题会话」)────────────────────────────────
     * 后端把占位名归了空(`sessionTitleOf`),所以 `title` 真的可能是空串。
     * 兜底次序是**用户裁定的那一条**:首条用户消息(它就是 `subtitle`)顶上,
     * 两样都没有才由行画「未命名会话」。顶上去之后出处那一格随之空掉 ——
     * 同一句话不在一行里画两遍。
     */
    const title = result.title
    const subtitle = result.subtitle ?? result.detail ?? ''
    const titled = title.length > 0
    const promoted = !titled && subtitle.length > 0
    rows.push({
      id: result.id,
      capability,
      text: titled ? title : promoted ? subtitle : '',
      origin: { kind: 'path', path: titled ? subtitle : '' },
      target: result.target,
      ...(titled || promoted ? {} : { untitled: true }),
      ...(result.matchRanges === undefined || !titled ? {} : { highlight: result.matchRanges }),
      ...(result.facets === undefined ? {} : { facets: result.facets }),
      ...(result.preview === undefined ? {} : { preview: result.preview }),
      ...(result.source === undefined ? {} : { source: result.source }),
    })
  }
  return rows
}

/** 一行 → 预览 / 动作请求里那条 `items` 的元素(§4.5 ③ 的 `SearchItemRef`)。 */
export function itemRefOf(row: SearchRow): SearchItemRef {
  return { capability: row.capability, id: row.id, target: row.target }
}
