import type { SearchItemRef, SearchResponse, SearchResult } from '@shared/ipc/search'
import { splitHighlight } from '../expose/transitions'
import type { SearchOrigin, SearchRow, SearchTarget } from './types'

/**
 * 检索面的全部逻辑。纯函数,不认识 React —— 组件只负责画。
 *
 * 高亮切片**直接复用** expose/transitions 的 splitHighlight(下面原样再导出),
 * 不复制一份:两个面上「什么算命中」必须是同一件事,否则迟早漂移。
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

/**
 * 通知里那句「已打开 …」的落点。
 *
 * 带行号时与 fileLine 出处同一个拼法;不带(今天的常态 —— 真实产地给不出行号)
 * 就是整条路径 —— **不补一个 `:1` 去凑格式**,那会让人以为后端说了它在第一行。
 */
export function targetText(target: SearchTarget): string {
  const payload = (target.payload ?? {}) as { filePath?: string; line?: number; sessionId?: string }
  if (typeof payload.filePath !== 'string') return payload.sessionId ?? ''
  return payload.line === undefined
    ? payload.filePath
    : originText({ kind: 'fileLine', file: fileName(payload.filePath), line: payload.line })
}

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
    rows.push({
      id: result.id,
      capability,
      text: result.title,
      origin: { kind: 'path', path: result.subtitle ?? result.detail ?? '' },
      target: result.target,
      ...(result.matchRanges === undefined ? {} : { highlight: result.matchRanges }),
      ...(result.facets === undefined ? {} : { facets: result.facets }),
      ...(result.preview === undefined ? {} : { preview: result.preview }),
    })
  }
  return rows
}

/** 一行 → 预览 / 动作请求里那条 `items` 的元素(§4.5 ③ 的 `SearchItemRef`)。 */
export function itemRefOf(row: SearchRow): SearchItemRef {
  return { capability: row.capability, id: row.id, target: row.target }
}

/* ── 分节(§7.2 全部档 / §9 第四条)──────────────────────────────────────── */

/**
 * 屏幕上的一节。
 *
 * **`all` 档的节由后端的 `groups` 说了算**(S4b;S4a 那时是壳按 `row.capability`
 * 自己归堆的)。这不是一次等价重构:后端那份 `groups` 还带着两样壳算不出来的
 * 东西 —— 每组的**真 total**(能力知道就给)与**这一组塌了没有**(`error`)。
 * 一个只有 `error`、一条结果都没有的组因此**照样有节头**(§9 第四条原话
 * 「某组 `error` 时组头一句『没搜成』」)—— 那正是按行归堆表达不出来的一格。
 *
 * 单类档只有一节,而且**没有节头**(一张平铺列表就是它自己那一组)。
 */
export interface SearchSection {
  /** 能力 id;也是 `data-group` 的值(门按它认,不按名字 —— 名字随语言变)。 */
  capability: string
  /**
   * 节头上写什么。后端给的是 `labelKey`(`SearchResponse.groups[].label`
   * 装的就是它),壳查字典;查不到就画原文 —— 插件能力给的可能本来就是成品字。
   */
  labelKey: string
  /** 这一组一共多少条(能力知道才给)。缺席 = 不知道,**不是 0**。 */
  total?: number
  /** 这一组塌了的原话;缺席 = 没塌。 */
  error?: string
  rows: SearchRow[]
  /** 这一节第一行在**整张扁平列表**里的下标(走行的 cursor 用的是那个下标)。 */
  offset: number
  /** 画不画节头。单类档那一节不画。 */
  head: boolean
}

/** 逐节补上 `offset`。**一处算**,组件不许自己再累一遍(两处必然错开)。 */
function withOffsets(sections: Array<Omit<SearchSection, 'offset'>>): SearchSection[] {
  let offset = 0
  return sections.map((section) => {
    const at = offset
    offset += section.rows.length
    return { ...section, offset: at }
  })
}

/**
 * 一次回执 → 屏幕上的那几节。
 *
 * `groups` 在场(= `all` 档)就按组分节,次序**原样保留** —— 后端已经按各
 * manifest 的 `order` / `orderWhenIntent` 排好了(§7.2),壳再排一次就是第二个
 * 产地。不在场(单类档)就是一节,不画节头。
 */
export function sectionsOf(
  answer: { results: readonly SearchResult[]; groups?: SearchResponse['groups'] } | undefined,
  capability: string,
): SearchSection[] {
  if (answer === undefined) return []
  if (answer.groups !== undefined) {
    return withOffsets(answer.groups.map(group => ({
      capability: group.capability,
      labelKey: group.label,
      ...(group.total === undefined ? {} : { total: group.total }),
      ...(group.error === undefined ? {} : { error: group.error }),
      rows: resultRows(group.results, group.capability),
      head: true,
    })))
  }
  return withOffsets([{
    capability,
    labelKey: capability,
    rows: resultRows(answer.results, capability),
    head: false,
  }])
}

/** 那几节摊平成一张列表(走行、翻页、选中都按这张表的下标)。 */
export function flatRows(sections: readonly SearchSection[]): SearchRow[] {
  return sections.flatMap(section => section.rows)
}

/**
 * 只保留窗口内那一页的节(翻页把窗口拉大,不是重排)。
 *
 * 切在**扁平下标**上而不是逐节切:窗口说的是「屏幕上一共放几行」,
 * 逐节各切一刀会让第二组永远出不来(第一组先把配额吃光的那种病)。
 * 切空的节**仍然留着**,只要它有节头要说的话(total / 没搜成)——
 * 那一行是读数,不是行。
 */
export function sectionsWindow(
  sections: readonly SearchSection[],
  window: number,
): SearchSection[] {
  const out: SearchSection[] = []
  for (const section of sections) {
    const rows = section.rows.slice(0, Math.max(0, window - section.offset))
    if (rows.length === 0 && !section.head) continue
    out.push({ ...section, rows })
  }
  return out
}

/* ── 分页 ──────────────────────────────────────────────────────────────────
 *
 * ## 为什么是「递增 limit 重查」而不是真游标
 *
 * `search.query` 有 `cursor` 这一格(§7.3),但**今天没有一个内置能力给得出**
 * (`singleResponse` 原样转发 `page?.cursor`,而三种基座此刻都不产它)。所以分页
 * 仍然是**要更多**:第 n 页带一个更大的 limit 从头重查一遍。
 * **代价如实记在这里**:每翻一页都是一次全量重拉再截断,不是增量取。
 * 哪天能力开始给游标,`genericSide` 那一处已经先认游标了(有 cursor 就是有下一页),
 * 换成真游标翻页是那一处再加一格,不是重写这一节。
 *
 * ## 「取尽」的判据有两条,先问游标
 *
 *  1. 回执带 `cursor` → 后面**确实**还有(后端说的);
 *  2. 不带游标时退回**回来的条数 < 要的条数**。等号成立时后端只是说「我给满了」,
 *     不是说「没有了」—— 所以那一刻不许写「已全部显示」。
 *
 * ## 空词 = 浏览态,同一套机件(09-01 用户裁定)
 *
 * 空词不是「没在搜」:chats 那一路在后端有一条**空词绕开索引直接调旧
 * `searchChats`** 的分支(S3b),于是浏览态照样有行、照样有读数、照样能翻页。
 * 没有第二套分页机件,也没有第二个「一页多少条」的常量。
 */

/** 首屏默认给多少条。 */
export const SEARCH_FIRST_PAGE = 20

/** 每按一次「加载更多」再放出多少条(同时也是远端 limit 的增量)。 */
export const SEARCH_PAGE_SIZE = 20

/** 第 n 页(从 1 数)的窗口大小 = 首屏 + 之后每页的增量。 */
export function pageWindow(page: number): number {
  return SEARCH_FIRST_PAGE + Math.max(page - 1, 0) * SEARCH_PAGE_SIZE
}

/**
 * **远端此刻的处境**。四态,不是三个布尔 —— 「还在路上」与「给满了」与「取尽了」
 * 是三件不同的事,合成布尔就得在读的地方再拼一次。
 *
 * S4b 之前这里合成的是两三路(文件 / 消息 / 通用);现在只有**一路**(唯一那条
 * `search.query`)。`remoteSide` 那只合成器因此没有消费者了,但它**留着**:
 * 「几路合成一路,次序是判据」这条判据本身没有变,而 §4.4 ⑧ 的「边打边出、
 * 各组渐次到达」真做起来时全部档就会重新变成多路。留一只有单测的纯函数,
 * 比到时候再重新推一遍那张次序表便宜。
 */
export type SearchRemoteSide =
  /** 取尽了(或这一档根本不看远端):后面没有了。 */
  | 'exhausted'
  /** 给满了 / 有游标:后面**可能**还有。 */
  | 'more'
  /** 还在路上 / 还没发。 */
  | 'pending'
  /** 这一次塌了。 */
  | 'failed'

/**
 * 几路远端合成一路。**次序是判据,不是口味**:
 *
 *  1. `failed` —— 一次失败必须说出来,而底部那条 item 正是「再试一次」的落点;
 *  2. `more`   —— 有人说「我给满了」= 后面可能还有,那就得留一条能按的 item
 *     (排在 pending 前面:另一路还没说话不该把这条已经知道的路堵掉);
 *  3. `pending`—— 还没人说过有,于是**不许诺**,只报此刻的条数;
 *  4. `exhausted` —— 每一路都说完了才轮得到它。
 *
 * 空入参(不看远端)= `exhausted`:没有人可问,就是没有更多。
 */
const REMOTE_ORDER: SearchRemoteSide[] = ['failed', 'more', 'pending', 'exhausted']

export function remoteSide(...sides: SearchRemoteSide[]): SearchRemoteSide {
  for (const candidate of REMOTE_ORDER) {
    if (sides.includes(candidate)) return candidate
  }
  return 'exhausted'
}

/**
 * 列表底部那条 item 的处境。它是**一条 item**,不是一颗悬浮按钮 ——
 * 所以「没有它」也是一种正经状态('none'),而不是把它画成禁用态占着位置。
 */
export type SearchMore =
  | { kind: 'none' }
  /** 还能再要。`total` 只有在远端取尽时才知道 —— 不知道就是 null,不猜。 */
  | { kind: 'more'; shown: number; total: number | null }
  | { kind: 'loading' }
  | { kind: 'error' }
  /** 取尽了:「共 N 条 · 已全部显示」。非交互读数,第一页就取尽也算数。 */
  | { kind: 'end'; total: number }
  /**
   * 远端还没落定:先如实报**此刻已经在屏幕上的条数**。非交互读数 ——
   * 它既不许诺「还有更多」(远端没说过话),也不说「全都在这了」(那要等取尽)。
   */
  | { kind: 'count'; shown: number }

export interface SearchMoreInput {
  /**
   * 第几页,从 1 数。
   *
   * S4b 之前这里还有一格 `searching`(有没有词),用来把**浏览态**翻译成
   * `remote: 'exhausted'` —— 那时浏览态的行来自壳自己那张会话表,整表在手,
   * 「后面还有没有」当场就知道。今天浏览态与搜索态走的是**同一条** `search.query`
   * (空词那一形由 chats 能力自己接住,S3b),`remote` 在两种态下都是真读数,
   * 那次翻译因此没有对象了,这一格随之删掉。
   */
  page: number
  /** 此刻**造得出来**的全部行数(受当前 limit 约束的那一份)。 */
  total: number
  /** 远端此刻的处境。 */
  remote: SearchRemoteSide
}

/**
 * ## 底部那一行是**常驻读数**,不是「翻过页才出现的东西」(08-31 拍板)
 *
 * 只要有行,底下就一直有一行东西可读。它是按钮还是读数由处境决定,
 * 而不是由「有没有翻过页」决定。
 *
 * | 行数  | page | remote      | 结果      | 屏幕上                       |
 * | ---   | ---  | ---         | ---       | ---                          |
 * | 0 条  | 任意 | 任意        | `none`    | 什么都不画                    |
 * | >0    | >1   | failed      | `error`   | 「没加载成,点一下重试」(可按) |
 * | >0    | >1   | pending     | `loading` | 「加载中…」                    |
 * | 窗口装不下(shown<total) | 任意 | exhausted | `more`(带 total) | 「加载更多 · 已显示 a / 共 b」 |
 * | 窗口装不下        | 任意 | 其余        | `more`(total=null) | 「加载更多」            |
 * | 全装下            | 任意 | exhausted   | `end`     | 「共 N 条 · 已全部显示」(读数) |
 * | 全装下            | 1    | pending     | `count`   | 「已显示 N 条」(读数)         |
 * | 全装下            | 任意 | more/failed | `more`(total=null) | 「加载更多」            |
 *
 * 两处判据不变的理由:远端 pending 的第一页**仍然不许诺**「加载更多」(那一句是在
 * 说「后面还有」,而这一刻没人说过有);failed 的第一页那次「没搜成」归列表上面
 * 那行,而这条 item 是「再试一次」的落点(所以它是可按的 `more`,不是读数)。
 */
export function moreState({ page, total, remote: side }: SearchMoreInput): SearchMore {
  if (total === 0) return { kind: 'none' }
  if (page > 1) {
    if (side === 'failed') return { kind: 'error' }
    if (side === 'pending') return { kind: 'loading' }
  }
  const shown = Math.min(total, pageWindow(page))
  if (shown < total) return { kind: 'more', shown, total: side === 'exhausted' ? total : null }
  if (side === 'exhausted') return { kind: 'end', total }
  if (side === 'pending') return { kind: 'count', shown }
  return { kind: 'more', shown, total: null }
}
