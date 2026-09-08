import type { SearchBlock, SearchListing, SearchPage } from '../data/search-listing-source'
import { getLogger } from '../services/log'

/**
 * **分页状态机的纯逻辑**(检索面终稿 附录 B §5.2–§5.4;
 * `apps/desktop-react/docs/search-panel-2026-09.md`)。不认识 React,不发请求,
 * 不认识任何一个能力的名字。
 *
 * 三件事在这里,一件都不多:
 *
 *  · `moreStateOf` —— 块尾那条项**此刻是什么**(四态 + 一条读数);
 *  · `appendPage` —— 一页**怎么落进**格里(三道闸);
 *  · `markPageError` —— 翻页塌了怎么记(**行留着**)。
 *
 * ── 为什么产地在这里,而不是在数据源那个文件里 ────────────────────────────
 * 它们是**同一件事的两半**:数据层那只 mutation 的 `settle` / `onError` 是唯一的
 * 写入口,而块尾那条项的四态是唯一的读出口 —— 「一页落进去之后屏上那条项变成
 * 什么」这条规则只该有一处。放在纯模型这一侧还有一个好处:测它不必起数据层
 * (格、mutation、端口一个都不用)。类型走 `import type`,运行时的边只有一条:
 * `data/search-listing-source.ts` → 这里。
 */

const log = getLogger('search.listing')

/* ── 块尾那条项的四态 + 一条读数 ────────────────────────────────────────── */

/**
 * 五格,但**只有四格是 item**:`end` 是一条读数(`role="presentation"`),
 * `none` 什么都不画。
 *
 * | 态 | 屏上 | 在不在 ↑↓ 序列 | 可按 |
 * | --- | --- | --- | --- |
 * | `more` | 「加载更多」/ total 已知时「已显示 a / 共 b」 | 在 | 是 |
 * | `loading` | 「加载中…」+ `aria-busy` | **在**(免得焦点途中蒸发) | 按下无效,**不 disabled** |
 * | `scanning` | 「扫描中…」+ `aria-busy` | **在**(同上) | 按下无效 |
 * | `error` | 「没加载出来 · 再试一次」 | 在 | 是(重发**同一个** cursor) |
 * | `partial` | 「已扫描的部分 · 未扫完」 | 不在 | — |
 * | `end` | 「共 N 条 · 已全部显示」 | 不在 | — |
 * | `none` | 不画 | 不在 | — |
 */
export type MoreState =
  | { kind: 'more'; shown: number; total: number | null }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'end'; total: number }
  /**
   * **这一块还没问**(09-07 事故第二条修)。「不挑」那一档不等去外部枚举的那几路,
   * 壳随即单独去问一次 —— 这一格是那段时间里屏上的样子:一块只有块尾一条
   * 「扫描中…」的块。它是 item(在 ↑↓ 序列里,免得焦点途中蒸发),但按下无效。
   */
  | { kind: 'scanning' }
  /**
   * **扫到一半就到点了**(同上第三条修)。行照画,块尾换成一句诚实的读数:
   * 「已扫描的部分 · 未扫完」—— 不是 item,因为没有「再来一页」这回事可按。
   */
  | { kind: 'partial'; shown: number }
  | { kind: 'none' }

/**
 * 这一块的块尾项此刻是什么。
 *
 * 次序**是判据**,不是口味:
 *  1. 零命中的块一个像素都不占(用户 09-05 裁定)——所以 `none` 排第一,
 *     它连「没搜成」都不说(那句话归页脚,`data-readout="block-errors"`);
 *  2. `pending || inflight` → `loading`(**闸②**):这一块自己在翻页,或者整格在
 *     重拉 / 回放,两种都不许再按 —— 回放链与 `loadMore` 因此永不重叠;
 *  3. 翻页塌了 → `error`(可按,重发同一个 cursor);
 *  4. 取尽 → `end` 读数;
 *  5. 剩下的才是「还能再要一页」。
 *
 * `total` 缺席时 `more` 那一格给 `null` —— **不知道就说不知道**,不拿本页条数
 * 冒充总数(「已显示 20 / 共 20」却还能再翻,那是谎话)。
 */
export function moreStateOf(block: SearchBlock, pending: boolean, inflight: boolean): MoreState {
  /*
   * **「还没问」排在「零命中不占行」前面**(09-07 事故第二条修)。
   *
   * 两件事长得一样(都是零行),而屏上必须分得开:R2 那条规矩说的是「问过了,
   * 没有」—— 那样的块一个像素都不占;这一块是「这一次没问它,正在去问」,
   * 它得留一条「扫描中…」在屏上,否则文件那一档会在半秒里凭空出现,
   * 用户读到的是「刚才它撒谎说没有」。
   */
  if (block.scanning === true) return { kind: 'scanning' }
  if (block.rows.length === 0) return { kind: 'none' }
  if (pending || inflight) return { kind: 'loading' }
  if (block.pageError !== undefined) return { kind: 'error' }
  // 只扫到一半:没有「下一页」可要(游标也确实没有),但也不许说「共 N 条」。
  if (block.partial === true) return { kind: 'partial', shown: block.rows.length }
  if (block.exhausted) return { kind: 'end', total: block.total ?? block.rows.length }
  return { kind: 'more', shown: block.rows.length, total: block.total ?? null }
}

/* ── 一页怎么落进格里 ──────────────────────────────────────────────────── */

/** 换掉一块,别的块**原样交回同一批引用**(律④:没变的行不重挂)。 */
function withBlock(
  listing: SearchListing,
  capability: string,
  next: SearchBlock,
): SearchListing {
  return {
    ...listing,
    blocks: listing.blocks.map(block => (block.capability === capability ? next : block)),
  }
}

/**
 * 把一页追加进某一块。**三道闸,每一道都是结构保证,不是纪律**:
 *
 * ① **cursor 捕获**(`fromCursor` 是发车那一刻那一块的游标)——格里这一块的游标
 *    已经不是它了就整发丢弃。治两件事:mutation 不折叠同键并发(同一条 more 连按
 *    两下 = 两发同游标),以及「头页 `refetch` 在翻页飞行期间落地」。
 * ② **忙态锁**在 `moreStateOf`(见上)—— 这里只管落地。
 * ③ **零新增即取尽**:去重之后一条新 id 都没有 → 游标置空按取尽处理 + 一行 warn。
 *    后端的 `readOffsetCursor` 对指纹不匹配是**静默归零返回第一页**(不抛),没有
 *    这一道,去重会把它藏成「按了永远没反应」。
 *
 * 返回 `undefined` / 原对象 = 这一发不落地(`Query.patch` 收到 `undefined` 是
 * 恒等变换)。
 */
export function appendPage(
  prev: SearchListing | undefined,
  capability: string,
  fromCursor: string,
  page: SearchPage,
): SearchListing | undefined {
  if (prev === undefined) return prev
  const block = prev.blocks.find(b => b.capability === capability)
  if (block === undefined) return prev
  // 闸①:发车时那一格游标已经不是现在这一格了 —— 这一发过期,丢。
  if (block.cursor !== fromCursor) return prev

  const seen = new Set(block.rows.map(row => row.id))
  const added = page.rows.filter(row => !seen.has(row.id))

  if (added.length === 0) {
    // 闸③:一条新 id 都没有。**当取尽处理**,并且说出来 —— 静默的话屏上那条
    // 「加载更多」会永远在,按下去永远没反应。
    log.warn('a page added nothing; treating this block as exhausted', {
      capability,
      shown: block.rows.length,
    })
    const { cursor: _cursor, pageError: _pageError, ...rest } = block
    return withBlock(prev, capability, { ...rest, exhausted: true })
  }

  // `cursor` 与 `pageError` 两格**先摘掉再按新页填**:留着展开的话「新页没有游标」
  // 那一档会把旧游标原样留下 —— 取尽了却还画着「加载更多」,按下去发一个过期游标。
  const { cursor: _stale, pageError: _pageError, ...rest } = block
  const next: SearchBlock = {
    ...rest,
    rows: [...block.rows, ...added],
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    ...(page.total === undefined ? {} : { total: page.total }),
    exhausted: page.cursor === undefined,
    pages: block.pages + 1,
  }
  return withBlock(prev, capability, next)
}

/* ── 补扫那一块怎么落地 ────────────────────────────────────────────────── */

/**
 * 「不挑」那一档没问的那一块,壳单独问回来了(09-07 事故第二条修的壳侧一半)。
 *
 * 它不是 `appendPage`:那一只是**追加**(闸①按 `fromCursor` 判过期),而这一发
 * 补的是一块**空块的第一页** —— 没有游标可对,行也不该去重(本来就没有行)。
 * 两件事分开写,不是把 `appendPage` 掰出一条 if。
 *
 * 三格一起翻面:`scanning` 摘掉、行填上、游标按这一页说的填(于是块尾那条项从
 * 「扫描中…」变成「加载更多」或「共 N 条」)。这一块已经不在了(换词换出去的旧格)
 * 就是恒等变换。
 */
export function landScan(
  prev: SearchListing | undefined,
  capability: string,
  page: SearchPage,
): SearchListing | undefined {
  if (prev === undefined) return prev
  const block = prev.blocks.find(b => b.capability === capability)
  if (block === undefined) return prev
  const { scanning: _scanning, error: _error, pageError: _pageError, ...rest } = block
  return withBlock(prev, capability, {
    ...rest,
    rows: page.rows,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    ...(page.total === undefined ? {} : { total: page.total }),
    ...(page.relaxed === undefined ? {} : { relaxed: page.relaxed }),
    ...(page.partial === true ? { partial: true } : {}),
    ...(page.actions === undefined ? {} : { actions: page.actions }),
    exhausted: page.cursor === undefined,
    pages: 1,
  })
}

/**
 * 那一发补扫塌了。落 `error` 而不是 `pageError` —— 这一块**一行都没有**,
 * 它塌的是头页,而头页的失败归页脚那一行「<能力名>没搜成 · 重试」(R2)。
 * `scanning` 同时摘掉:再画「扫描中…」就是在说谎。
 */
export function landScanError(
  prev: SearchListing | undefined,
  capability: string,
  message: string,
): SearchListing | undefined {
  if (prev === undefined) return prev
  const block = prev.blocks.find(b => b.capability === capability)
  if (block === undefined) return prev
  const { scanning: _scanning, ...rest } = block
  return withBlock(prev, capability, { ...rest, error: message })
}

/**
 * 翻页塌了。**行一条不丢、游标一个字不动** —— 重试按下去要发的是**同一个**
 * cursor(那一页本来就没拿到),而不是从头再来。
 *
 * 清它的地方只有一处:下一次成功的 `appendPage`(所以没有 `clearPageError`)。
 */
export function markPageError(
  prev: SearchListing | undefined,
  capability: string,
  message: string,
): SearchListing | undefined {
  if (prev === undefined) return prev
  const block = prev.blocks.find(b => b.capability === capability)
  if (block === undefined) return prev
  return withBlock(prev, capability, { ...block, pageError: message })
}
