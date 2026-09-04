import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useStageStore } from '../../stage/store'
import { useChapterRecord, useSessionsSource } from '../../data/sessions-source'
import { useFilesSource, useSessionCwd } from '../../data/files-source'
import { useExposeStore } from '../../expose/store'
import { Highlight } from '../../expose/components/Highlight'
import { useSessionTime } from '../../expose/components/session-time'
import { FocusScope } from '../../focus/FocusScope'
import { useListSelection } from '../../ui/a11y/list-selection'
import { ButtonBase } from '../../ui/ButtonBase'
import { GroupHead } from '../../ui/GroupHead'
import { Input } from '../../ui/Input'
import { Segmented } from '../../ui/Segmented'
import type { SegmentedOption } from '../../ui/Segmented'
import { notify } from '../../services/notify'
import { Search } from '../../components/icons'
import { plural, useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import {
  browseRows,
  groupHeadAt,
  groupRowsByCapability,
  moreState,
  originText,
  pageWindow,
  remoteSide,
  resultRows,
  searchRows,
  targetText,
} from '../transitions'
import type { SearchMaterial, SearchRemoteSide } from '../transitions'
import type { MessageHit, SearchRow, SearchScope } from '../types'
import { ALL_TAB, indexReadoutOf, nextTab, resolveTab, tabsOf } from '../capabilities'
import {
  CHATS_CAPABILITY,
  FILES_CAPABILITY,
  MESSAGES_CAPABILITY,
  hasNativeSource,
} from '../sources'
import { resolveTargetRenderer } from '../targets'
import type { SearchTargetContext } from '../targets'
import {
  ensureMessageSearch,
  refetchMessageSearch,
  useMessageSearch,
} from '../../data/message-search-source'
import {
  ensureCapabilitySearch,
  ensureSearchCatalog,
  refetchCapabilitySearch,
  useCapabilitySearch,
  useSearchCapabilities,
  useSearchIndexStatus,
} from '../../data/search-catalog-source'
import { useLocateMessage } from '../../content/locate-message'
import { currentSpaceId } from '../../workspace/current'
import s from './SearchPanel.module.css'

/**
 * 检索面板 = 一块普通的 Dock 内容(id 'search'),所以它能上舞台 / 变浮窗 / 钉到边,
 * 三种形态里长得一模一样 —— 这正是 renderContent 那张表存在的理由。
 *
 * 终稿的形状:**搜索行 + 一张平铺列表**,没有二次分组、没有分栏、没有分节标题。
 * 一行永远是三件东西:行首小徽 / 命中原文一行 / 行尾灰色出处。
 * 空词时那张列表换成**浏览全部会话**,行的解剖一格没变 —— 所以下面只有一套行渲染,
 * 也只有一套分页机件(09-01 裁定:空词是浏览态,一样有总数读数、一样能翻页)。
 *
 * 它自己不写一行检索逻辑:命中、排序、轮转、走行全在 search/transitions 的纯函数里,
 * 组件只有「谁被选中」和「输入框里是什么」两个本地状态。
 */

/** 一次搜索最多为多少条命中会话补拉章节(取数上限,不是结果上限)。 */
const CHAPTER_PREFETCH_LIMIT = 8

/**
 * 远端检索的合并窗口(D5 立,09-02 起两路共用)。会话侧是本地滤(整张 listMeta
 * 在手,零延迟),文件侧与正文侧都是**一次真查询**(前者后端列目录再滤,后者
 * 后端逐会话读消息),所以每敲一个字母就发一次请求是不合适的。
 * 窗口按「打完一个词的停顿」取,不按「最快能有多快」取。
 *
 * **一个窗口、一条副作用管两路**,不是各自去抖:两路的主语里都有那个词,
 * 两个计时器只会让它们在不同的帧上落地,屏幕上多闪一次。
 */
const SEARCH_DEBOUNCE_MS = 220

/** 「正文那一路此刻一条都没有」的那**一个**空表(身份稳定,见消费处)。 */
const NO_HITS: readonly MessageHit[] = []

/**
 * 徽上的字 —— **由这一行的目标渲染器答**(S4a),不再是面板自己 `switch` 一遍。
 *
 * 两种产地照旧分得清清楚楚:`labelKey` 那种是界面文案(走字典),`text` 那种是
 * 从数据推出来的(扩展名之类,换语言不该变)。缺渲染器时是空徽 —— 那一行仍然
 * 画出来(标题行),只是没有徽可写:§4.3「绝不因为壳没跟上而把结果吞掉」。
 */
function badgeText(row: SearchRow, t: TFn): string {
  const renderer = resolveTargetRenderer(row.target.kind)
  if (renderer === undefined) return ''
  const badge = renderer.badge(row)
  return 'labelKey' in badge ? t(badge.labelKey as MessageKey) : badge.text
}

export function SearchPanel() {
  const t = useT()
  const [query, setQuery] = useState('')
  /*
   * 此刻这一档。**它是一个能力 id(或 `all`),不是三个字面量之一**(S4a)——
   * 档位表由 `search.capabilities` 回来的自述算出来,所以这一格的取值面
   * 也随之开放。能力被注销时 `resolveTab` 把它退回 `all`(见下面)。
   */
  const [requestedScope, setScope] = useState<SearchScope>(ALL_TAB)
  const [cursor, setCursor] = useState(0)
  /** 第几页,从 1 数。换词 / 换范围就回到第一页(那是另一张列表了)。 */
  const [page, setPage] = useState(1)
  /** 选中的是不是底部那条 item。**它不是 cursor 的一个值** —— 见 onKeyDown。 */
  const [onMore, setOnMore] = useState(false)
  /*
   * ── 档位:从自述读,不是一张写死的表(§9 第一条)───────────────────────
   * 注销一个能力,它那一格 tab 自动消失;注册一个(包括插件能力)自动出现在它
   * 自己声明的位置上 —— 面板这一侧一个字不改。
   */
  const manifests = useSearchCapabilities()
  const tabs = useMemo(() => tabsOf(manifests), [manifests])
  /** 这一档还在不在。刚被注销的档退回 `all` —— 停在一个不存在的档上等于给死路。 */
  const scope = resolveTab(tabs, requestedScope)
  const indexStatus = useSearchIndexStatus()
  const indexReadout = useMemo(() => indexReadoutOf(indexStatus), [indexStatus])
  /*
   * 「全部空间」那一格过滤片是 **S4b**;今天恒假,所以跨空间徽画不出来。
   * 留着这一格(而不是把徽整段删掉)是因为 §10 S4 行的第五条门断言守的正是
   * 「画它的逻辑在不在」—— 过滤片落地那天这里只换一个产地,徽一个字不改。
   */
  const allSpaces = false
  const spaceId = currentSpaceId()
  const enterSession = useExposeStore((st) => st.enterSession)
  const closeToDock = useStageStore((st) => st.closeToDock)
  const sessions = useSessionsSource((st) => st.sessions)
  /*
   * 章节缓存是**一族 query**(键 = sessionId),而这块面要的是「凡是手上有章的
   * 会话,章里也搜一遍」—— 键面由数据说了算,不是由屏幕点名。所以订整族,
   * 摊成 `searchRows` 一直吃的那张 Record(判据与形状逐字不变,见那只 hook)。
   */
  const chapters = useChapterRecord()
  const ensureChapters = useSessionsSource((st) => st.ensureChapters)
  const cwd = useSessionCwd()
  const fileHits = useFilesSource((st) => st.searchHits)
  const fileQuery = useFilesSource((st) => st.searchQuery)
  const fileStatus = useFilesSource((st) => st.searchStatus)
  const fileError = useFilesSource((st) => st.searchError)
  const fileLimit = useFilesSource((st) => st.searchLimit)
  const searchFiles = useFilesSource((st) => st.searchFiles)
  /** 点一条正文命中 = 进会话 + 留一格「落到那条消息」的待办(见 activate)。 */
  const locateMessage = useLocateMessage((st) => st.locateMessage)
  const timeOf = useSessionTime()
  const listRef = useRef<HTMLDivElement>(null)
  /** 这块面的根。由 `<FocusScope rootRef>` 写进来(落点从它里面找那格输入框)。 */
  const panelRef = useRef<HTMLDivElement | null>(null)

  /*
   * 换词 / 换范围 = 换了一张列表:选中回第一行、页码回第一页。
   *
   * 这一手写在**渲染里**而不是 useEffect 里,理由很具体:分页把 `page` 收进了
   * 取数副作用的依赖表,而在副作用里重置会先多跑一轮渲染 —— 那一轮带着「新词 +
   * 旧页码」,主语已经换了页码还没回来,于是那条「主语没变就当场发」的判据会把
   * 它当成一次翻页,合并窗口就白设了。渲染中重置(React 官方那条「状态派生自
   * 上一次输入」的写法)让副作用只看得见重置之后的那一份。
   */
  const listKey = `${scope}:${query}`
  const [lastKey, setLastKey] = useState(listKey)
  if (lastKey !== listKey) {
    setLastKey(listKey)
    setCursor(0)
    setOnMore(false)
    setPage(1)
  }

  const searching = query.trim().length > 0
  /*
   * 这一档要不要问壳自带的那两路。判据是「这一档是不是那个能力(或者不挑)」,
   * id 从 `search/sources.ts` 那张记账表读 —— 面板里不写能力 id 的字面量。
   */
  const wantsNativeMessages = scope === ALL_TAB || scope === MESSAGES_CAPABILITY
  const wantsNativeFiles = scope === ALL_TAB || scope === FILES_CAPABILITY
  /** 会话侧(标题 / 预览 / 章节)。正文命中同样由它造,所以两个能力都算数。 */
  const wantsNativeSessions = scope === ALL_TAB || scope === CHATS_CAPABILITY || scope === MESSAGES_CAPABILITY
  /*
   * 手上这批文件命中说的**是不是此刻这个词**。去抖窗口那 220ms 里词已经变了而
   * 结果还没回来 —— 不问这一句,屏幕上就会闪一下上一个词的结果。对不上就当作
   * 「还没有」(空),而不是拿旧的顶一会儿。
   */
  const fileAnswerIsCurrent = fileQuery === query.trim()
  const files = useMemo(
    () => (fileAnswerIsCurrent ? fileHits : []),
    [fileAnswerIsCurrent, fileHits],
  )
  /*
   * 正文那一路(09-02)。它是 kernel 的一格 query,键 = 「词 + 这一页要多少条」——
   * 所以**不必再问一句「这批答案是不是此刻这个词」**:换词就是换了一格,
   * 那一格自己的 `data` 天然只属于自己的词(文件侧要问那一句,是因为它把
   * 「上一次的答案」存在一个跟着词走的公共格子里)。
   */
  const messageLimit = pageWindow(page)
  /*
   * 这一档要不要问正文那一路:`all` 与 `messages` 要,别的档不要。判据用的是
   * `hasNativeSource` 那张记账表的同一个 id —— 面板这里不写 `'messages'`。
   */
  const messageAnswer = useMessageSearch(query, wantsNativeMessages ? messageLimit : 0)
  // 缺席那一份用**同一个**空表:每次渲染现造一个 `[]` 会让下面那只 memo 的
  // 依赖每帧都变,整张列表白重算一遍(律④那条身份纪律的同一件事)。
  const messages = messageAnswer.data?.hits ?? NO_HITS
  const material: SearchMaterial = useMemo(
    () => ({
      sessions,
      chapters,
      files,
      messages,
      timeOf: (session) => timeOf(session.updatedAt),
    }),
    [sessions, chapters, files, messages, timeOf],
  )
  /*
   * ── 通用那一路(S4a)────────────────────────────────────────────────
   * 壳没有自带产地的能力(`prompts` / `daily` / `actions`,以及任何一个插件能力)
   * 走 `search.query` + 目标渲染注册表。**只在选中那一档时问** —— `all` 档不发:
   * 那一档的配额由后端各能力自述说了算,壳这边再拼一次就是两套分组逻辑。
   * (`all` 档带上它们是 S4b 的事,留账写在报告里。)
   */
  const genericCapability = scope !== ALL_TAB && !hasNativeSource(scope) ? scope : ''
  const genericAnswer = useCapabilitySearch(genericCapability, query, pageWindow(page))
  const genericRows = useMemo(
    () => (genericAnswer.data === undefined
      ? []
      : resultRows(genericAnswer.data.results, genericCapability)),
    [genericAnswer.data, genericCapability],
  )

  const tabOrder = useMemo(() => tabs.map(tab => tab.id), [tabs])
  const rows = useMemo(() => {
    if (genericCapability) return genericRows
    const built = searching ? searchRows(query, scope, material) : browseRows(scope, material)
    // 全部档按能力归堆(§7.2);单类档就是一张平铺列表,不归。
    return scope === ALL_TAB ? groupRowsByCapability(built, tabOrder) : built
  }, [query, scope, searching, material, genericCapability, genericRows, tabOrder])

  /**
   * 文件侧此刻的处境。取尽判据是**回来的条数 < 要的条数** —— 后端这一条既没有
   * 游标也不下发总数,这是唯一能判的一句(理由写在 transitions 的「分页」一节)。
   * 这一档不看文件(会话 / 消息 / 通用那几档)时它恒定「取尽」——「没有人可问」
   * 就是「后面没有了」,不是「还在等」。
   */
  const fileSide: SearchRemoteSide = useMemo(() => {
    if (!wantsNativeFiles) return 'exhausted'
    if (!fileAnswerIsCurrent || fileStatus === 'idle' || fileStatus === 'loading') return 'pending'
    if (fileStatus === 'error') return 'failed'
    return fileHits.length < fileLimit ? 'exhausted' : 'more'
  }, [wantsNativeFiles, fileAnswerIsCurrent, fileStatus, fileHits.length, fileLimit])

  /**
   * 正文侧此刻的处境。**同一张四态表,判据逐条对应** —— 两路的形状一样,
   * 只是读的是 kernel 的快照而不是手写的四件套:
   *  · 这一档不看正文 / 没给词 → 恒定「取尽」(没有人可问);
   *  · 在飞、或者这一格从来没有过答案 → pending;
   *  · 上一发塌了(错误在,而且**没有旧答案**)→ failed;
   *    有旧答案时错误只由列表上面那行说,底下照旧按旧答案判取尽 —— 律②。
   *  · 落地了 → 回来的条数 < 要的条数 = 取尽。
   */
  const messageSide: SearchRemoteSide = useMemo(() => {
    if (!wantsNativeMessages || !searching) return 'exhausted'
    const answer = messageAnswer.data
    if (messageAnswer.inflight || !answer) {
      return messageAnswer.error && !answer ? 'failed' : 'pending'
    }
    return answer.hits.length < answer.limit ? 'exhausted' : 'more'
  }, [wantsNativeMessages, searching, messageAnswer.data, messageAnswer.inflight, messageAnswer.error])

  /**
   * 通用那一路的处境。**同一张四态表**,只是取尽判据多了一格真游标:
   * 后端这条口给得出 `cursor` 时,「后面还有没有」不用再靠「回来的条数 == 要的
   * 条数」去猜 —— 有游标就是有,没有就是没有(§9 第三条:「加载更多」**有 cursor
   * 才画**)。给不出游标的能力退回旧判据。
   */
  const genericSide: SearchRemoteSide = useMemo(() => {
    if (!genericCapability) return 'exhausted'
    const answer = genericAnswer.data
    if (genericAnswer.inflight || !answer) {
      return genericAnswer.error && !answer ? 'failed' : 'pending'
    }
    if (answer.cursor !== undefined) return 'more'
    return answer.results.length < answer.limit ? 'exhausted' : 'more'
  }, [genericCapability, genericAnswer.data, genericAnswer.inflight, genericAnswer.error])

  const more = moreState({
    searching,
    page,
    /*
     * 这里仍然是「**此刻造得出来的行数**」,一格没动 —— `moreState` 那张判据表
     * 的入参口径就是它(`shown = min(total, pageWindow)`)。后端给的那个真 `total`
     * (单类档能力知道才给)**不塞进这里**:它是「全集有多大」,而这一格是
     * 「我手上有多少」,混成一个数会让 `shown` 超过真实行数。真 total 由底下
     * 那一行状态自己说(§9 第三条第一项)。
     */
    total: rows.length,
    remote: remoteSide(fileSide, messageSide, genericSide),
  })
  /** 屏幕上这一页。会话侧本来就全量在手,所以翻页在那一侧纯粹是把窗口拉大。 */
  const visible = useMemo(() => rows.slice(0, pageWindow(page)), [rows, page])
  /** 底部那条 item 能不能按(加载中也留在轮转序列里,免得焦点在加载途中蒸发)。 */
  const moreIsItem = more.kind === 'more' || more.kind === 'loading' || more.kind === 'error'

  /*
   * 走行归 `ui/a11y/list-selection`(09-01 批 4,从手写的 `moveRow` 迁进来)。
   * 这块面正是那只原语管的那一族:**焦点恒在输入框**,列表只是屏幕上的候选,
   * 所以它必须自己记一个下标 —— 也就必须防着 hover 去改那个下标。
   *
   * 受控档:`cursor` 还留在本地 state 里不动。它有两个原语管不着的读写方 ——
   * 渲染中的「换词就归零」(见上面那段 listKey)与底部那条 item 的 `onMore`,
   * 交出去反而要在两处各写一遍回写。
   *
   * 三个档位逐条对着**现状**填,不取原语的默认口味:
   *  · `loop: false`   —— 到端点就停(既有 `moveRow` 就是一次夹,不回卷);
   *  · `homeEnd: false` —— Home / End 留给输入框的行首行尾(既有 onKeyDown 也不接它);
   *  · `scrollBlock: null` —— 滚入视野由下面那条本地 effect 统一管,理由写在那里。
   * 轴向取默认的纵向:← → 既有实现同样不接(它们在编辑中的输入框里是移光标)。
   */
  const selection = useListSelection({
    count: visible.length,
    active: cursor,
    onActiveChange: setCursor,
    loop: false,
    homeEnd: false,
    scrollBlock: null,
  })

  /*
   * 章节是**按需**拉的:标题 / 预览命中的那几条先把章节补回来,下一轮渲染里
   * 它们的章节行就一起出现。上限是刻意的 —— 一个字母就为几十条会话各发一次
   * 请求,那不叫按需。会话侧另外两样(标题、预览)本来就在 listMeta 里,即时滤。
   */
  useEffect(() => {
    if (!searching || !wantsNativeSessions) return
    const q = query.trim().toLowerCase()
    let asked = 0
    for (const session of sessions) {
      if (asked >= CHAPTER_PREFETCH_LIMIT) break
      if (!session.title.toLowerCase().includes(q) && !session.preview.toLowerCase().includes(q)) {
        continue
      }
      asked += 1
      void ensureChapters(session.id)
    }
  }, [searching, query, wantsNativeSessions, sessions, ensureChapters])

  /*
   * 两路远端各是一次**真查询**,所以它们有自己的取数副作用(会话侧没有:整张表
   * 在手)。合并窗口挡的是「每敲一个字母发一次请求」;各自的档位闸另判 ——
   * 只发这一档要的那几路(`wantsNativeFiles` / `wantsNativeMessages` /
   * `genericCapability` 三个闸):用户已经说了这一轮不看别的那几侧。
   *
   * 分页是**递增 limit 重查**:第 n 页带一个更大的 limit 从头再要一次(两条口都
   * 只有 limit 没有游标 —— 代价与留账写在 transitions 的「分页」一节),
   * 所以 `page` 也在依赖表里:翻一页就是重发一次。
   *
   * 合并窗口只挡**打字的余波**:主语(词 + 根)没变 —— 也就是这一次是翻页或者
   * 「重试」—— 就当场发。让一次确定的点击等 220ms 是把它当成了打字。
   *
   * ── 09-02:一条副作用两路,不是两条各自去抖 ──────────────────────────────
   * 主语里的 `cwd` 只与文件那一路有关:换工作目录会让这条重跑,于是正文那一路
   * 也跟着 `ensure` 一次。**那一次是免费的** —— 正文侧是键控缓存,同一个
   * 「词 + limit」问过就当场早退,一个字节都不出门。这正是把缓存做成键控换来的
   * 那一格:两路可以共用一个主语,而不必为了省一次请求去拆第二个计时器。
   */
  const askedSubject = useRef<string | null>(null)
  useEffect(() => {
    if (!wantsNativeFiles && !wantsNativeMessages && !genericCapability && !searching) return
    // 主语里带上这一档:换档就是换了一次要问的东西(通用那一路尤其 —— 它的键
    // 第一格就是能力 id),不带的话换档会被当成一次「主语没变」而当场发。
    const subject = JSON.stringify([query.trim(), cwd, scope])
    const sameSubject = askedSubject.current === subject
    askedSubject.current = subject
    const run = () => {
      if (wantsNativeFiles) void searchFiles(query, cwd, pageWindow(page))
      if (wantsNativeMessages) void ensureMessageSearch(query, pageWindow(page))
      if (genericCapability) void ensureCapabilitySearch(genericCapability, query, pageWindow(page))
    }
    /*
     * 主语没变、而且已经翻过页 —— 那这一次只能是「加载更多」或者「重试」,
     * 两者都是一次**确定的点击**,当场发。第一页永远走合并窗口:换词换范围都
     * 落在第一页,那才是打字的余波要挡的地方。
     */
    if (sameSubject && page > 1) {
      run()
      return
    }
    const timer = setTimeout(run, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, scope, cwd, page, searching, searchFiles, wantsNativeFiles, wantsNativeMessages, genericCapability])

  /*
   * 自述与索引状态:面板挂上来问一次(幂等,`ensure` 的语义)。**只此一次** ——
   * 它们不是跟着词走的东西,进不了下面那条带去抖的副作用。
   */
  useEffect(() => {
    void ensureSearchCatalog()
  }, [])

  // 底部那条 item 没了(取尽 / 列表空了)就不能再让选中停在它上面。
  useEffect(() => {
    if (!moreIsItem) setOnMore(false)
  }, [moreIsItem])

  /*
   * 选中行滚进视野。block:'nearest' = 只在它真的出界时才滚,列表不会为了走一行整屏跳。
   *
   * 这一条**没有交给原语**(所以上面传了 `scrollBlock: null`):底部那条 item 不是
   * 一个下标,进不了原语按下标认行的那张表,而「停在末位」与「从末位回到行上」
   * 这两下同样要滚。一条 effect 同时覆盖 cursor 与 onMore 两个产地,
   * 比「原语滚一半、本地再补一半」少一处会走形的接缝。
   */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      onMore ? '[data-row="more"]' : `[data-row="${cursor}"]`,
    )
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, onMore, visible])

  /*
   * tab 条 = 自述表(§9 第一条)。文案键、图标名、次序全部来自 manifest ——
   * 这里一个能力 id、一句文案、一个图标名都没有。
   */
  const options: Array<SegmentedOption<SearchScope>> = tabs.map((tab) => ({
    value: tab.id,
    label: t(tab.labelKey as MessageKey),
  }))

  /** 组头的名字 = 那个能力的自述文案键。查不到就画 id —— 不静默留白。 */
  const groupLabel = (capability: string): string => {
    const tab = tabs.find(item => item.id === capability)
    return tab === undefined ? capability : t(tab.labelKey as MessageKey)
  }

  /** 第 i 行前面要不要一条组头。**只在全部档**;单类档一张平铺列表就是它自己那一组。 */
  const groupHeadOf = (index: number): string | undefined =>
    (scope === ALL_TAB ? groupHeadAt(visible, index) : undefined)

  /**
   * 落点 = **目标渲染注册表**里那一格的 `activate`(S4a)。
   *
   * 从前这里是一个 `switch (row.target.kind)`,两支写死 —— 那正是 §4.0 要拆掉的
   * 枚举点:加一种能搜的东西就得回来改这个 switch。今天面板给的是**能力**
   * (进会话 / 打开文件 / 跑一条动作),去哪儿由那一类自己的渲染器说。
   *
   * 缺渲染器时**什么都不做但仍然收回 Dock**?不 —— 那会让人以为按下去生效了。
   * 缺渲染器的行是「只有标题的一行」,按它如实说一句「这一类还打不开」,
   * 与文件那一路 D5 的诚实缺口同一个体例。
   */
  const targetContext: SearchTargetContext = {
    enterSession(sessionId, messageId) {
      enterSession(sessionId)
      /*
       * 正文命中还带一个落点(09-02):进会话之后要滚到**那条消息**上。
       *
       * 这一下**只留一格待办**,不在这里去找 DOM:换会话之后聊天区要重开一次
       * 折叠、折出来的消息还要渲染成节点,而这一帧那棵树还是上一条会话的。
       * 待办由 `toc/useChatToc` 在锚点真的出现时消掉(判据是折叠落地,
       * 不是猜一个延迟)—— 理由与整条链写在 `content/locate-message.ts` 头上。
       *
       * 缺席 messageId 的那几种(标题 / 预览 / 章节命中)一个字都不改:
       * 它们的落点本来就是这条会话本身。
       */
      if (messageId) locateMessage(sessionId, messageId)
    },
    openFile(path, line) {
      /*
       * 这是接真源的缝。壳里还没有「打开一个文件」这件能力(没有编辑器面、
       * 没有主进程),所以这里只把落点如实报出来。接上真实打开器时,
       * 换掉的就是这一行 —— 行模型、跳转目标、收回 Dock 的手感都不动。
       *
       * 走 notify 而不是从前那个散装 toast:级别 info(它既不是成功也不是错,
       * 只是「这就是我能做到的」),于是它同样进通知中心存档 ——
       * 用户过一会儿想不起刚才那行报的是哪个文件时,还翻得到。
       */
      notify({
        level: 'info',
        source: 'search.open',
        title: t('search.openedFile', {
          file: targetText({ kind: 'file', payload: { filePath: path, line } }),
        }),
      })
    },
    runAction(actionId) {
      /*
       * 动作类命中(命令 / 提示词 / 「新建今天的日记」)。壳今天**没有**执行它们的
       * 落点 —— 旧搜索窗那条 `executeAction` 是窗口活,新壳没有对应的面。
       * 所以这里如实说出来而不是静默吞掉:一次按下去什么都不发生的点击,
       * 比一句「这个还没接上」更让人怀疑是不是自己按错了。留账在报告里。
       */
      notify({
        level: 'info',
        source: 'search.open',
        title: t('search.actionUnavailable', { action: actionId }),
      })
    },
  }

  const activate = (row: SearchRow) => {
    const renderer = resolveTargetRenderer(row.target.kind)
    if (renderer === undefined) {
      notify({
        level: 'info',
        source: 'search.open',
        title: t('search.targetUnavailable', { kind: row.target.kind }),
      })
      return
    }
    renderer.activate(row, targetContext)
    // 选中就是这块面板的活干完了,收回 Dock —— 与 Quick Look 进会话同一个手感。
    closeToDock('search')
  }

  /**
   * 按底部那条 item。两件事共用它,因为它们在用户眼里是同一个动作(「再来一次」):
   *  - 'more' = 再要一页(页码 +1,取数副作用据此带更大的 limit 重发);
   *  - 'error' = 同一页重试(主语没变,所以当场发,不等合并窗口)。
   * 'loading' / 'end' 按下去什么都不做 —— 它们不是动作,是读数。
   */
  const activateMore = () => {
    if (more.kind === 'more') {
      setPage((p) => p + 1)
      return
    }
    if (more.kind !== 'error') return
    /*
     * 重试**两路一起重来**(09-02)。底下那条 item 只有一个 —— 用户按的是
     * 「再来一次」,而不是「重试文件那一半」;哪一路塌了不是他要分辨的事。
     * 正文那一路走 `refetch`(用户明确要求重来,不是 `ensure` 的「问过就算了」)。
     */
    if (wantsNativeFiles) void searchFiles(query, cwd, pageWindow(page))
    if (wantsNativeMessages) void refetchMessageSearch(query, pageWindow(page))
    if (genericCapability) void refetchCapabilitySearch(genericCapability, query, pageWindow(page))
  }

  /*
   * 键盘住在面板自己身上,**不是 keymap 里的命令**:它只在这块面有焦点时才成立,
   * 而命令表管的是「面板关着时也要能触发」的那一类。Esc 这里一个字不写 ——
   * 让位契约由宿主(舞台 / 浮窗 / 架子)执行,内容层不许把它吃掉。
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // 拦下默认行为:这块面里 Tab 是「换搜索范围」,不是「把焦点交出去」。
      e.preventDefault()
      setScope(nextTab(tabs, scope, e.shiftKey ? -1 : 1))
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const down = e.key === 'ArrowDown'
      /*
       * 底部那条 item 是轮转序列的**末位**,但它不是 cursor 的一个值:
       * 按一次「加载更多」列表就长了,末位的下标随之变 —— 用下标记住它,
       * 加载完选中就落到了一条真结果上,再按一次回车会把人送走。
       * 一个布尔说的是「我停在末位」,列表怎么长它都还在末位。
       */
      if (onMore) {
        if (!down) setOnMore(false)
        return
      }
      if (down && moreIsItem && cursor >= visible.length - 1) {
        setOnMore(true)
        return
      }
      // 走行本身归原语(夹范围 / 不回卷的判据与 useRoving 同源,不再自己算一遍)。
      selection.handleKey(e.key)
      return
    }
    if (e.key === 'Enter') {
      if (onMore) {
        e.preventDefault()
        activateMore()
        return
      }
      const row = visible[cursor]
      if (!row) return
      e.preventDefault()
      activate(row)
    }
  }

  /*
   * ── 开出来就打字:一句**声明**,不是一个 `autoFocus`(09-03 R2)──────────
   * 从前那格输入框挂着 DOM 的 `autoFocus`(带一条 jsx-a11y 豁免:「这块面板是
   * 用户刚刚显式召唤出来的」)。R2 之后这块面是响应链上的一格 `region`:
   * `restingTarget` 说落点是这格输入框,`activateOnMount` 说「挂上来就把焦点
   * 送进去」—— 于是「焦点落在哪儿」与「什么时候送」变成两句可读的话,
   * 而不是一个 DOM 属性 + 一条豁免注释。
   *
   * 顺带兑现的另一件:`autoFocus` 只在**首次挂载**那一帧有效,而这块面被架子
   * keep-alive 着切来切去时并不重挂 —— 从此那件事由宿主的 `activate()` 答
   * (§11 拍点 2),不再取决于「这一次是不是真的重新挂载」。
   *
   * **Esc 一个字不写**:让位契约由宿主(舞台 / 浮窗 / 架子)执行 —— 树里那就是
   * 「这一格不声明 `onEscape`,于是根本不进 Esc 候选表」。
   */
  return (
    <FocusScope
      scope="search"
      rootRef={panelRef}
      restingTarget={() => panelRef.current?.querySelector('input') ?? null}
      activateOnMount
    >
      {({ scopeProps }) => (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
         * 这里挂 onKeyDown 是**事件委托**,不是把一个 div 变成控件:真正拿焦点的是里面那个
         * 输入框(落点声明),↑↓/⏎ 从它冒泡上来,由面板统一按当前 cursor 处理。
         * 规则防的是「给死元素装交互却不给焦点」—— 焦点在,只是在子节点上。
         *
         * 面板内的 Tab / ⇧Tab 是**换搜索范围**,仍然是这一层的行内结构键(不进任何表):
         * 派发器只在 `modal` 作用域里圈禁 Tab,这块面是 `region`,所以那一下原样到这儿。 */
        <div {...scopeProps} className={s.panel} data-testid="search-panel" onKeyDown={onKeyDown}>
          <div className={s.head}>
            <Input
              className={s.input}
              value={query}
              onValueChange={setQuery}
              size="lg"
              prefix={<Search className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
              placeholder={t('search.placeholder')}
              aria-label={t('search.label')}
            />
            <Segmented
              options={options}
              value={scope}
              onChange={setScope}
              label={t('search.scopeLabel')}
            />
          </div>

          {/*
            * 文件检索失败不许静默:它与「没搜到」是两件事,合成一句「无结果」等于
            * 把一次失败说成一次空结果。这一行在**有命中时也画**(会话侧照常有结果,
            * 但文件侧那一半确实塌了),后端原话原样跟在后面。
            */}
          {wantsNativeFiles && fileStatus === 'error' && fileAnswerIsCurrent && (
            <p className={s.failed}>
              {t('search.filesFailed')}
              <span className={s.failedDetail}>{fileError}</span>
            </p>
          )}

          {/*
            * 正文检索失败(09-02):**同一条判据、同一个形制**,只是换一句话与另一个
            * 产地的原话。两路各说各的 —— 合成一句「检索失败」会让人分不清是哪一半塌了,
            * 而它们是两条独立的口(一条可能好着,另一条塌了)。
            *
            * 判据里没有「答案是不是当前这个词」那一句(文件侧要问):正文侧是键控的
            * 一格 query,`messageAnswer` 本身就只属于当前这个词与这一页。
            */}
          {wantsNativeMessages && searching && messageAnswer.error && (
            <p className={s.failed}>
              {t('search.messagesFailed')}
              <span className={s.failedDetail}>{messageAnswer.error}</span>
            </p>
          )}

          <div className={s.body} ref={listRef} role="listbox" aria-label={t('search.resultsLabel')}>
            {rows.length === 0 ? (
              <p className={s.none}>
                {/* 空词 + 只看文件 = 不是「无结果」,是「还没给词」:文件侧在浏览态**没有
                  * 产地**(`files.list` 只在带词时才有意义),见 search/transitions.ts
                  * 文件头第 2 条。这句话如实说出那个缺口,不去伪造一张「最近打开」。
                  * 会话侧的浏览态不落在这一支:它有产地(整张 listMeta),所以走列表。 */}
                {scope === FILES_CAPABILITY && !searching
                  ? t('search.filesNeedQuery')
                  : t('search.noResults')}
              </p>
            ) : (
              visible.map((row, i) => (
                <Fragment key={row.id}>
                  {/*
                    * 组头(§9 第四条)。**只在全部档画**,而且只在这一组的第一行前面 ——
                    * 它不是一条 item(不进 role=listbox 的轮转序列,所以 `role="presentation"`),
                    * 是一条把列表切开的分隔读数。组头带这一组的名字与「查看全部」:
                    * 后者切到那一档的 tab、从第一页重来。
                    */}
                  {groupHeadOf(i) !== undefined && (
                    <GroupHead
                      className={s.groupBand}
                      role="presentation"
                      data-group={groupHeadOf(i)}
                      label={groupLabel(groupHeadOf(i) ?? '')}
                      note={
                        /*
                         * 右侧那一格是**文字读数**,不是计数徽(库件的计数禁令原文:
                         * tab / 列表 / 组头不挂计数徽,文字读数可以)。这里放的是
                         * 「查看全部」那颗行内微型文字动作 —— 裸钮三类判的第③类,
                         * 走 `ui/ButtonBase` 保本地皮肤。
                         */
                        <ButtonBase
                          className={s.groupAll}
                          onClick={() => setScope(groupHeadOf(i) ?? ALL_TAB)}
                        >
                          {t('search.viewAll')}
                        </ButtonBase>
                      }
                    />
                  )}
                {/* 一条命中 = 结构件(role=option)→ `ui/ButtonBase` 只清 UA。 */}
                <ButtonBase
                  role="option"
                  aria-selected={!onMore && i === cursor}
                  data-row={i}
                  data-target-kind={row.target.kind}
                  data-capability={row.capability}
                  className={!onMore && i === cursor ? `${s.row} ${s.rowOn}` : s.row}
                  onClick={() => {
                    setOnMore(false)
                    // **显式点击**是原语允许改 active 的第二条产地(第一条是键盘)。
                    // 与它对着的禁令:行上一个 mouseenter / mouseover 都不许挂。
                    selection.select(i)
                    activate(row)
                  }}
                >
                  {/*
                    * 徽是**两层**:外层那颗胶囊 hug 内容(宽度由内容定,不写死),
                    * 内层负责弯腰 —— text-overflow 只在块容器上生效,而胶囊为了居中
                    * 是 inline-flex,直接挂在它身上的省略号永远不会出现。
                    * 09-01 报障:徽列按四字符(CHAT/MSG/MD)写死 34px,八字符的
                    * NOTEBOOK 直接撑破边框 —— 词表是**数据**(扩展名 / 无扩展名的整个
                    * 文件名都会进来),不是一张可以枚举完的表,所以修法只能是结构性的。
                    */}
                  <span className={s.chip}>
                    <span className={s.chipText}>{badgeText(row, t)}</span>
                  </span>
                  <span className={row.code ? `${s.text} ${s.code}` : s.text}>
                    {/* 高亮两条产地一条渲染:行自带 `highlight`(正文命中,后端判的)
                      * 就用那一份,没有就照当前的词自己切 —— 判据写在 Highlight 上。 */}
                    <Highlight
                      text={row.text}
                      query={searching ? query : ''}
                      {...(row.highlight ? { ranges: row.highlight } : {})}
                    />
                  </span>
                  <span className={s.origin}>{originText(row.origin)}</span>
                  {/*
                    * 徽(§9「徽」那一条)。两颗,都只在**事实成立**时画:
                    *  · 归档 —— `facets.archived` 为真。索引照建归档会话的文档
                    *    (S3b 治好的那条病),所以它们**搜得到**,但得让人一眼看出来。
                    *  · 跨空间 —— `facets.spaceId` 与当前空间不同。**只在「全部空间」
                    *    过滤下才画**(§9 原话):默认那一档里根本不会出现别的空间的行,
                    *    画一颗恒不出现的徽等于骗自己。过滤片本身是 S4b,所以今天
                    *    `allSpaces` 恒假 —— **画它的逻辑要在**,那正是第五条门断言守的。
                    */}
                  {row.facets?.archived === true && (
                    <span className={s.tag} data-tag="archived">{t('search.badgeArchived')}</span>
                  )}
                  {allSpaces
                    && typeof row.facets?.spaceId === 'string'
                    && row.facets.spaceId !== spaceId && (
                    <span className={s.tag} data-tag="space">{t('search.badgeOtherSpace')}</span>
                  )}
                </ButtonBase>
                </Fragment>
              ))
            )}

            {/*
              * 「加载更多」是**列表最后一条 item**,不是一颗悬浮在角上的按钮:
              * 它跟着列表滚、跟着列表排、跟着 ↑↓ 走(末位),形制照这张表既有的行语汇
              * (同一个 .row 骨架,只是没有徽、没有出处),所以它读起来是这张列表的
              * 一部分而不是一件外挂控件。
              *
              * 取尽那一刻它换成一条**读数**(不是按钮、不进轮转序列)—— 一条按不动的
              * 按钮比一句话更让人犹豫。
              *
              * 08-31 拍板:搜索态下这一行**常驻**。读数与按钮之间怎么切由 moreState
              * 那张判据表定,这里只负责画:能按的那三种走上面的 button,`end`/`count`
              * 两种读数走下面的 p —— 所以「共 N 条」不再是翻过页的人才看得到。
              *
              * 09-01 拍板:**空词那张浏览列表也走这一行**(用户:「我要能够在这里面看到
              * 所有的条数,所有的记录,要能够翻页」)。这里一个字都不用改 —— 判据表把
              * 浏览态翻成了 'exhausted',于是它自动落在 more(带 total)/ end 两格上。
              *
              * 里面那句话裹了一层 span:底部这一行也是 subgrid,文字要落在**第二列**
              * (与上面各行的正文同一条竖线起笔)。从前靠 padding-left 的 calc 对齐,
              * 而徽列换成内容自适应之后那个 calc 已经算不出来了。
              */}
            {moreIsItem && (
              /* 「加载更多」是列表的**最后一条 item**(同一套行语汇)→ `ui/ButtonBase`。 */
              <ButtonBase
                role="option"
                aria-selected={onMore}
                data-row="more"
                data-testid="search-more"
                className={onMore ? `${s.more} ${s.rowOn}` : s.more}
                onClick={() => {
                  setOnMore(true)
                  activateMore()
                }}
              >
                <span className={s.moreText}>
                  {more.kind === 'loading' && t('search.loading')}
                  {more.kind === 'error' && t('search.loadFailed')}
                  {more.kind === 'more' &&
                    (more.total === null
                      ? t('search.loadMore')
                      : t('search.loadMoreCount', { shown: more.shown, total: more.total }))}
                </span>
              </ButtonBase>
            )}
            {more.kind === 'end' && (
              <p className={s.end}>
                {/* 英文里 result / results 是两句话(08-31 走查在屏幕上量到「1 results」)。
                    选键走 i18n 的 `plural`,与 QuickLook 的消息数逐字同一手。 */}
                <span className={s.moreText}>
                  {t(plural(more.total, 'search.allShownOne', 'search.allShown'), {
                    total: more.total,
                  })}
                </span>
              </p>
            )}
            {more.kind === 'count' && (
              <p className={s.end}>
                <span className={s.moreText}>{t('search.shownCount', { shown: more.shown })}</span>
              </p>
            )}

            {/*
              * ── 底部状态行(§9 第三条)────────────────────────────────────
              * 四条读数,**各说各的一件事,一条都不合并**。它们排在「加载更多 /
              * 已全部显示」那一行之后,因为那一行说的是「这张列表」,而这四条说的
              * 是「这次检索是怎么答出来的」。
              *
              * 每一条都**只在事实成立时画**,判据逐条:
              *  1. `total` —— 后端给了真数才画(单类档,能力知道就给)。壳自己数出来
              *     的那个数已经由上面那一行说了,这里说的是「全集有多大」。
              *  2. 「已放宽」—— `relaxed > 0`:严格档没中、放宽了才有命中(§6.2)。
              *     不说出来的话,用户会以为自己那个词精确命中了这些行。
              *  3. 「索引更新中(剩 n)」—— `pending > 0`:现在答的这一份还没追上账本。
              *  4. 读者模式 —— `mode === 'reader'`:折账本的是另一台进程。**今天恒
              *     `owner`**(§5.6 拍点庚 09-04 裁「先不做」),所以这一行画不出来 ——
              *     画它的逻辑在这里,那正是 §10 S4 行第七条门断言守的东西。
              */}
            {genericAnswer.data?.total !== undefined && (
              <p className={s.end} data-readout="total">
                <span className={s.moreText}>
                  {t('search.totalCount', { total: genericAnswer.data.total })}
                </span>
              </p>
            )}
            {(genericAnswer.data?.relaxed ?? 0) > 0 && (
              <p className={s.end} data-readout="relaxed">
                <span className={s.moreText}>{t('search.relaxed')}</span>
              </p>
            )}
            {indexReadout !== undefined && indexReadout.pending > 0 && (
              <p className={s.end} data-readout="index-pending">
                <span className={s.moreText}>
                  {t('search.indexPending', { pending: indexReadout.pending })}
                </span>
              </p>
            )}
            {indexReadout?.readerHost !== undefined && (
              <p className={s.end} data-readout="index-reader">
                <span className={s.moreText}>
                  {t('search.indexReader', { host: indexReadout.readerHost })}
                </span>
              </p>
            )}
          </div>
        </div>
      )}
    </FocusScope>
  )
}
