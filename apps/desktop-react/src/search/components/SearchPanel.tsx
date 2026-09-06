import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { FocusScope } from '../../focus/FocusScope'
import { useListSelection } from '../../ui/a11y/list-selection'
import { ButtonBase } from '../../ui/ButtonBase'
import { GroupHead } from '../../ui/GroupHead'
import type { SegmentedOption } from '../../ui/Segmented'
import { notify } from '../../services/notify'
import { plural, useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import {
  flatRows,
  itemRefOf,
  moreState,
  pageWindow,
  remoteSide,
  sectionsOf,
  sectionsWindow,
  targetText,
} from '../transitions'
import type { SearchRemoteSide, SearchSection } from '../transitions'
import type { SearchRow, SearchScope } from '../types'
import {
  ALL_TAB,
  browseCapabilitiesOf,
  indexReadoutOf,
  labelKeyOf,
  labelTextOf,
  nextTab,
  resolveTab,
  tabsOf,
} from '../capabilities'
import {
  INITIAL_FILTERS,
  facetKeysOf,
  filterChipsOf,
  filtersOf,
} from '../filters'
import type { SearchFilterState } from '../filters'
import type { SearchContinuation } from '../continuations'
import { EMPTY_HISTORY, canGoBack, goBack, goForward, pushHistory } from '../history'
import type { SearchHistoryEntry } from '../history'
import { resolveTargetRenderer } from '../targets'
import type { SearchTargetContext } from '../targets'
import {
  ensureCapabilitySearch,
  ensureSearchCatalog,
  refetchCapabilitySearch,
  useCapabilitySearch,
  useSearchCapabilities,
  useSearchIndexStatus,
} from '../../data/search-catalog-source'
import type { SearchPreviewMode } from '../../data/search-catalog-source'
import { useLocateMessage } from '../../content/locate-message'
import { useSessionCwd } from '../../data/files-source'
import { currentSpaceId } from '../../workspace/current'
import { DEFAULT_SPACE_ID } from '../../workspace/types'
import { SearchPreview } from './SearchPreview'
import { SearchFailedLine } from './SearchFailedLine'
import { SearchFilterBar } from './SearchFilterBar'
import { SearchFooter } from './SearchFooter'
import { SearchHead } from './SearchHead'
import { SearchRow as SearchRowView } from './SearchRow'
import { SearchRowMenu } from './SearchRowMenu'
import type { RowMenuState } from './SearchRowMenu'
import s from './SearchPanel.module.css'

/**
 * 检索面板 = 一块普通的 Dock 内容(id 'search'),所以它能上舞台 / 变浮窗 / 钉到边,
 * 三种形态里长得一模一样 —— 这正是 renderContent 那张表存在的理由。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * S4b:**一条数据路,零能力 id**
 * ══════════════════════════════════════════════════════════════════════════
 * S4a 之前这块面同时吃四个产地(会话表 / 章节缓存 / `files.list` / 正文检索),
 * `all` 档的分组是壳自己按 `row.capability` 归的堆。**本批全部收进一条路**:
 * `search.query({ category, filters })` —— 单类档看 `results`,`all` 档看
 * `groups`(次序 / 名字 / total / 「没搜成」全由后端说)。
 *
 * 于是这个文件里**一个能力 id 的字面量都没有**了(`sources.ts` 随之删除),
 * 由 `__tests__/no-capability-literals.test.ts` 那道闸执法 —— 它的范围本批从
 * 「骨架」收紧到了整个 `src/search`,只留 `targets/`(一种目标形一个渲染模块,
 * §4.0 允许动的两处之一)与用例。
 *
 * 终稿的形状:**搜索行 + 片条 + 左列表右预览**。窄档下预览换成行下展开
 * (§4.5 ⑥;由 `.main` 上那条 `@container` 决定,不是第二棵树)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 一、生命周期 ─────────────────────────────────────────────────────────
 * | 时机 | 这里发生什么 |
 * | --- | --- |
 * | 挂载 | `ensureSearchCatalog()` 问一次自述与索引状态;查询那一发要等去抖窗口 |
 * | 首载 | tab 条只有 `all` 一格(自述还没回来),片条一颗都没有,列表空 |
 * | 换宿主(舞台 / 浮窗 / 架子) | **不重挂**(架子 keep-alive);焦点由宿主 `activate()` 送进来,`activateOnMount` 只管首次 |
 * | 换空间 | 空间片是「当前」时 `filters.spaceId` 跟着变 → 换一个 query 键 → 重问 |
 * | 卸载 | 本地状态(词 / 档 / 片 / 历史 / 选中)全没了;查询缓存留着 |
 *
 * ── 二、UI 生命状态 ──────────────────────────────────────────────────────
 * | 状态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | empty | `rows.length === 0` | 一句「无结果」;**列表不清屏**(律②:重拉期间旧行留着) |
 * | loading | `answer.data === undefined && inflight` | 旧行留在屏上;底部读数走 `moreState` 的 pending 那一格 |
 * | ready | 有 `data` | 按节画 |
 * | error | `answer.error` 在 | 列表上面一行「没搜成」+ 后端原话,**与旧结果并陈** |
 * | 超量 | 后端截断 / 组很多 | 底部那条 item(「加载更多」有 cursor 或给满了才画)+ 列表自己滚 |
 *
 * ── 三、UI 交互状态 ──────────────────────────────────────────────────────
 * rest / hover / focus / active 全长在库件上(`ui/Segmented` / `ui/FilterChip` /
 * `ui/ButtonBase` + `ui/a11y/list-selection`);pending 只在底部那条 item 上
 * (「加载中…」);disabled 有两处,都是**禁灰而不消失**:摆不出 facet 键的片、
 * 走到头的历史前进 / 后退。
 */

/** 「正文那一路此刻一条都没有」的那**一个**空表(身份稳定,见消费处)。 */
const NO_ROWS: readonly SearchRow[] = []

/**
 * 远端检索的合并窗口。每敲一个字母发一次请求是不合适的 —— 窗口按「打完一个词的
 * 停顿」取,不按「最快能有多快」取。
 */
const SEARCH_DEBOUNCE_MS = 220

/*
 * 徽上那个字怎么来的、右键菜单开在哪儿这两件事**搬出去了**(第 ⑥ 步拆件):
 * `./SearchRow.tsx` 的 `badgeText`、`./SearchRowMenu.tsx` 的 `RowMenuState`。
 */

export function SearchPanel() {
  const t = useT()
  const [query, setQuery] = useState('')
  /*
   * 此刻这一档。**它是一个能力 id(或 `all`),不是三个字面量之一** ——
   * 档位表由 `search.capabilities` 回来的自述算出来,所以这一格的取值面
   * 也随之开放。能力被注销时 `resolveTab` 把它退回 `all`(见下面)。
   */
  const [requestedScope, setScope] = useState<SearchScope>(ALL_TAB)
  const [cursor, setCursor] = useState(0)
  /** 第几页,从 1 数。换词 / 换范围 / 换片就回到第一页(那是另一张列表了)。 */
  const [page, setPage] = useState(1)
  /** 选中的是不是底部那条 item。**它不是 cursor 的一个值** —— 见 onKeyDown。 */
  const [onMore, setOnMore] = useState(false)
  /** 过滤片(§9 第五条)。缺省那一份**等价于一格都不发**,理由见 `../filters.ts`。 */
  const [filters, setFilters] = useState<SearchFilterState>(INITIAL_FILTERS)
  /** 查询历史(§4.6)。**只在内存里**,面板卸载就没了 —— 本批不落盘。 */
  const [history, setHistory] = useState(EMPTY_HISTORY)
  /**
   * 多选(§4.5 ③)。**按行 id 记,不按下标** —— 翻一页下标就全变了,而「我选中的
   * 是这两条」这件事不该跟着页码漂。次序有意义:compare 的左右两格照它排。
   */
  const [picked, setPicked] = useState<readonly string[]>([])
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)

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
   * ── 过滤片:哪几颗画得出来由**自述**说(§4.0 那张清账表的「过滤片」一行)──
   * 单类档 = 那一个能力声明的 facets;`all` 档 = 各组声明的并集。
   */
  const spaceId = currentSpaceId()
  /**
   * 文件那一路的**扫描根**(S4b 修)。它落成 `filters.dir` 的缺省 ——
   * S4b 之前文件档搜的就是这条根,改读后端之后要由壳结构地递回去,理由与
   * 「为什么不写 app-state」都在 `../filters.ts` 的 `DIR_FACET` 上。
   */
  const cwd = useSessionCwd()
  const available = useMemo(
    () => facetKeysOf(manifests, scope, ALL_TAB),
    [manifests, scope],
  )
  const chips = useMemo(() => filterChipsOf(filters, available), [filters, available])
  /*
   * 结构化的那一份。**`now` 只在片是时间档时才真的进键** —— `filtersOf` 对
   * `time: 'any'` 恒答缺席,所以这只 memo 的依赖里带一个时钟不会让键每帧都变。
   * (真选了时间档之后,键确实会随着「今天的零点」走,那是对的。)
   */
  const wire = useMemo(
    () => filtersOf(filters, {
      spaceId,
      defaultSpaceId: DEFAULT_SPACE_ID,
      now: Date.now(),
      available,
      ...(cwd === null ? {} : { cwd }),
    }),
    [filters, spaceId, available, cwd],
  )
  /** 跨空间徽**只在「全部空间」下画**(§9 原话)。 */
  const allSpaces = filters.space === 'all'

  const enterSession = useExposeStore((st) => st.enterSession)
  const closeToDock = useStageStore((st) => st.closeToDock)
  const locateMessage = useLocateMessage((st) => st.locateMessage)
  const listRef = useRef<HTMLDivElement>(null)
  /** 这块面的根。由 `<FocusScope rootRef>` 写进来(落点从它里面找那格输入框)。 */
  const panelRef = useRef<HTMLDivElement | null>(null)

  /*
   * 换词 / 换档 / 换片 = 换了一张列表:选中回第一行、页码回第一页、多选清空。
   *
   * 这一手写在**渲染里**而不是 useEffect 里,理由很具体:分页把 `page` 收进了
   * 取数副作用的依赖表,而在副作用里重置会先多跑一轮渲染 —— 那一轮带着「新词 +
   * 旧页码」,主语已经换了页码还没回来,于是那条「主语没变就当场发」的判据会把
   * 它当成一次翻页,合并窗口就白设了。
   */
  const searching = query.trim().length > 0
  /*
   * ── 空词的「所有」档 = 浏览态,不发 `category: 'all'`(S4b 修)───────────
   * 09-01 用户裁定:「我要能够在这里面看到所有的条数,所有的记录,要能够翻页」。
   * 后端的 `'all'` 是**分组总览**(§7.2:各能力按配额各给几条、不分页),那是
   * **有词**时要的东西;空输入框那一屏要的是浏览。判据只能是「有没有词」。
   *
   * 去问谁**从自述读**(`browseCapabilitiesOf`:声明了 `browse` 的那些能力),
   * 所以这一行里没有任何能力的名字。今天只有一个能力声明它 —— 于是这一发与
   * 单类档逐字相同(平铺、无组头、可翻页),正是旧行为;哪天有第二个,
   * 屏幕上自己多一组,这个文件一个字不改。
   *
   * 「零词元」这里用的是 `query.trim()`。后端那只 `normalizeQuery` 还会剥掉开头
   * 的 `>` 与 `/`,所以单打一个 `/` 在壳这边算**有词** → 走分组总览,而 chats
   * 在那张总览里照旧答「最近几间会话」。两边不完全同源是**有意**的:壳不去复制
   * 一份意图前缀的归一化(那是后端 + 各能力自述的事),而这一形的可见后果只是
   * 版式,不是内容。
   */
  const browsePlan = useMemo(
    () => (scope === ALL_TAB && !searching ? browseCapabilitiesOf(manifests) : []),
    [scope, searching, manifests],
  )
  /** 这一次真正去问谁:一个能力 id / `'all'`,或者浏览态那张表。 */
  const asked = browsePlan.length > 0 ? browsePlan : scope
  /**
   * 行归到哪个能力名下(`itemRefOf` 拿它去问预览 / 动作)。浏览态只有一个能力时
   * 答案是**那个能力**,不是 `'all'` —— 一条 `capability: 'all'` 的 item 后端认不出。
   */
  const rowCapability = browsePlan.length === 1 ? browsePlan[0] : scope

  const listKey = `${JSON.stringify(asked)}:${query}:${JSON.stringify(wire)}`
  const [lastKey, setLastKey] = useState(listKey)
  if (lastKey !== listKey) {
    setLastKey(listKey)
    setCursor(0)
    setOnMore(false)
    setPage(1)
    setPicked([])
  }

  const limit = pageWindow(page)
  /** **唯一那条数据路**(S4b)。`all` / 单类 / 浏览态走同一条口,差别只在问谁。 */
  const answer = useCapabilitySearch(asked, query, limit, wire)

  const sections = useMemo(
    () => sectionsOf(answer.data, rowCapability),
    [answer.data, rowCapability],
  )
  const rows = useMemo(() => (sections.length === 0 ? NO_ROWS : flatRows(sections)), [sections])

  /**
   * 远端此刻的处境。**取尽判据先问游标**:后端给得出 `cursor` 时「后面还有没有」
   * 不用靠「回来的条数 == 要的条数」去猜(§9 第三条:「加载更多」有 cursor 才画)。
   * 给不出游标的能力退回旧判据。
   */
  const remote: SearchRemoteSide = useMemo(() => {
    const data = answer.data
    if (answer.inflight || !data) return answer.error && !data ? 'failed' : 'pending'
    if (data.cursor !== undefined) return 'more'
    /*
     * **浏览态的组是可以翻页的**(S4b 修):每一组各要了一整页,所以「后面还有
     * 没有」逐组判,再按 `remoteSide` 那张次序表合成一路 —— 那只合成器留到今天
     * 等的就是这个消费者(判据是次序,不是口味:failed > more > pending > exhausted)。
     */
    if (data.browse === true) {
      return remoteSide(...(data.groups ?? []).map((group): SearchRemoteSide => (
        group.error !== undefined
          ? 'failed'
          : group.results.length < data.limit ? 'exhausted' : 'more'
      )))
    }
    /*
     * `all` 档不分页(§7.2「总览的目的是『大概在哪一类』;要翻页去单类」)——
     * 它的 `results` 是各组拼接再切到 limit 的一刀,拿它去比 limit 会把
     * 「组多到装满了」误读成「后面还有」。所以那一档恒定取尽。
     */
    if (data.groups !== undefined) return 'exhausted'
    return data.results.length < data.limit ? 'exhausted' : 'more'
  }, [answer.data, answer.inflight, answer.error])

  const more = moreState({ page, total: rows.length, remote })
  /*
   * 屏幕上这一页。翻页只是把窗口拉大,不重排。
   *
   * 窗口切在**扁平下标**上,所以 n 组各要了一整页时它要放大 n 倍 —— 否则第二组
   * 永远出不来(第一组先把配额吃光的那种病)。后端的分组总览不同:那一份的
   * `results` 本来就只有一页那么多,窗口就是 limit。
   */
  const windowSize = answer.data?.browse === true
    ? limit * Math.max(sections.length, 1)
    : limit
  const visible = useMemo(
    () => sectionsWindow(sections, windowSize),
    [sections, windowSize],
  )
  const visibleRows = useMemo(() => flatRows(visible), [visible])
  /** 底部那条 item 能不能按(加载中也留在轮转序列里,免得焦点在加载途中蒸发)。 */
  const moreIsItem = more.kind === 'more' || more.kind === 'loading' || more.kind === 'error'

  /*
   * 走行归 `ui/a11y/list-selection`。这块面正是那只原语管的那一族:**焦点恒在
   * 输入框**,列表只是屏幕上的候选,所以它必须自己记一个下标 —— 也就必须防着
   * hover 去改那个下标。三个档位逐条对着现状填,不取原语的默认口味。
   */
  const selection = useListSelection({
    count: visibleRows.length,
    active: cursor,
    onActiveChange: setCursor,
    loop: false,
    homeEnd: false,
    scrollBlock: null,
  })

  /*
   * 取数副作用。合并窗口只挡**打字的余波**:主语(词 + 档 + 片)没变 —— 也就是
   * 这一次是翻页或者「重试」—— 就当场发。让一次确定的点击等 220ms 是把它当成了打字。
   */
  const askedSubject = useRef<string | null>(null)
  useEffect(() => {
    const subject = listKey
    const sameSubject = askedSubject.current === subject
    askedSubject.current = subject
    const run = () => {
      void ensureCapabilitySearch(asked, query, pageWindow(page), wire)
    }
    if (sameSubject && page > 1) {
      run()
      return
    }
    const timer = setTimeout(run, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    /*
     * `listKey` 已经把「问谁 + 词 + 片」编成一个字符串了,后面三格是**同一件事的
     * 另一种写法** —— 写全是因为它们真的在闭包里被读了,而且它们与 `listKey`
     * 同时变(`wire` / `asked` 都是身份稳定的 memo,`query` 是 state),所以写全
     * 不会多跑一轮。判据仍然只有 `listKey` 一个:`askedSubject` 比的就是它。
     */
  }, [listKey, page, asked, query, wire])

  /*
   * 自述与索引状态:面板挂上来问一次(幂等,`ensure` 的语义)。**只此一次** ——
   * 它们不是跟着词走的东西,进不了上面那条带去抖的副作用。
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
   * 这一条**没有交给原语**(所以上面传了 `scrollBlock: null`):底部那条 item 不是
   * 一个下标,进不了原语按下标认行的那张表,而「停在末位」与「从末位回到行上」
   * 这两下同样要滚。
   */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      onMore ? '[data-row="more"]' : `[data-row="${cursor}"]`,
    )
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, onMore, visibleRows])

  /*
   * tab 条 = 自述表(§9 第一条)。文案键、图标名、次序全部来自 manifest ——
   * 这里一个能力 id、一句文案、一个图标名都没有。
   */
  const options: Array<SegmentedOption<SearchScope>> = tabs.map((tab) => ({
    value: tab.id,
    // 翻不出来就画原文 —— 一格空白的 tab 比一个陌生的 id 糟得多(判据在 labelTextOf)。
    label: labelTextOf(tab.labelKey, t(tab.labelKey as MessageKey)),
  }))

  /**
   * 节头的名字。**两个产地,先问后端**:
   *  · `all` 档的组名是后端给的文案键(`groups[].label`);
   *  · 浏览态那几组是壳自己拼的(一组一次查询),后端没给名字 —— 从自述表读
   *    那个能力自己的 `labelKey`。
   * 拿到键之后同一条判据:翻得出画译文,翻不出画原文(判据在 `labelTextOf`)。
   */
  const sectionLabel = (section: SearchSection): string => {
    const key = section.labelKey || labelKeyOf(manifests, section.capability) || section.capability
    return labelTextOf(key, t(key as MessageKey))
  }

  /* ── 落点 ─────────────────────────────────────────────────────────────── */

  const targetContext: SearchTargetContext = {
    enterSession(sessionId, messageId) {
      enterSession(sessionId)
      /*
       * 正文命中还带一个落点:进会话之后要滚到**那条消息**上。这一下**只留一格
       * 待办**,不在这里去找 DOM —— 换会话之后聊天区要重开一次折叠、折出来的消息
       * 还要渲染成节点,而这一帧那棵树还是上一条会话的。
       */
      if (messageId) locateMessage(sessionId, messageId)
    },
    openFile(path, line) {
      /*
       * 这是接真源的缝。壳里还没有「打开一个文件」这件能力(没有编辑器面、
       * 没有主进程),所以这里只把落点如实报出来。
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
   */
  const activateMore = () => {
    if (more.kind === 'more') {
      setPage((p) => p + 1)
      return
    }
    if (more.kind !== 'error') return
    void refetchCapabilitySearch(asked, query, pageWindow(page), wire)
  }

  /* ── 续搜(§4.6)───────────────────────────────────────────────────────── */

  /**
   * 此刻这一步(记历史用)。
   *
   * `activeId` 是**行的 id**,不是下标(检索面终稿 落差 #18,`../history.ts` 那一格
   * 改名时随手过来的最小适配):这条旧路仍然按下标走行,所以两头各翻译一次 ——
   * 记的时候把下标翻成 id,还原的时候翻回来(见 `applyEntry`)。
   */
  const entryNow = (): SearchHistoryEntry => ({
    query,
    capability: scope,
    filters,
    activeId: visibleRows[cursor]?.id ?? null,
  })

  /** 把一步落成屏幕上的状态。**替换**,不是 push 一帧 —— 退回去靠历史。 */
  const applyEntry = (entry: SearchHistoryEntry): void => {
    setQuery(entry.query)
    setScope(entry.capability)
    setFilters(entry.filters)
    // 那一条还在屏上就回到它,不在就回列表首 —— 与第 ⑦ 步 `reconcile` 的落位
    // 规则同一句话(找不到就落序列首项)。
    setCursor(Math.max(0, visibleRows.findIndex(row => row.id === entry.activeId)))
    setOnMore(false)
    setPicked([])
  }

  /**
   * 走一条续搜。**先把当前这一步记进历史,再换状态** —— 顺序反过来的话记下的
   * 就是新那一步,↑ / ⌘[ 回去会回到自己身上。
   */
  const runContinuation = (continuation: SearchContinuation): void => {
    const next = pushHistory(history, entryNow())
    if (continuation.kind === 'scope') {
      const filtersNext = { ...filters, scope: continuation.chip }
      setHistory(pushHistory(next, { query, capability: scope, filters: filtersNext, activeId: null }))
      setFilters(filtersNext)
      setCursor(0)
      setPicked([])
      return
    }
    const filtersNext: SearchFilterState = continuation.chip === undefined
      ? { ...filters, scope: undefined }
      : { ...filters, scope: continuation.chip }
    setHistory(pushHistory(next, {
      query: continuation.query,
      capability: continuation.capability,
      filters: filtersNext,
      activeId: null,
    }))
    applyEntry({
      query: continuation.query,
      capability: continuation.capability,
      filters: filtersNext,
      activeId: null,
    })
  }

  const stepHistory = (direction: 'back' | 'forward'): void => {
    const moved = direction === 'back' ? goBack(history) : goForward(history)
    if (moved === undefined) return
    setHistory(moved.history)
    applyEntry(moved.entry)
  }

  /* ── 预览(§4.5)───────────────────────────────────────────────────────── */

  /**
   * 这一次预览哪几条。**多选优先,没多选就是键盘位那一行** —— 「选中」在这块面
   * 有两层含义(键盘位 / 明确挑出来的几条),预览要的是后者在场时的后者。
   */
  const previewRows = useMemo(() => {
    if (picked.length > 0) {
      const byId = new Map(rows.map(row => [row.id, row]))
      return picked.map(id => byId.get(id)).filter((row): row is SearchRow => row !== undefined)
    }
    const row = visibleRows[cursor]
    return row === undefined ? [] : [row]
  }, [picked, rows, visibleRows, cursor])

  /**
   * 基数(§4.5 ③)。**「可比」的判据是同 kind** —— diff 一条消息和一个文件没有
   * 意义,所以两条不同 kind 的落 batch 而不是 compare。
   */
  const previewMode: SearchPreviewMode = useMemo(() => {
    if (previewRows.length <= 1) return 'single'
    if (previewRows.length === 2 && previewRows[0].target.kind === previewRows[1].target.kind) {
      return 'compare'
    }
    return 'batch'
  }, [previewRows])

  const previewItems = useMemo(() => previewRows.map(itemRefOf), [previewRows])
  /** 单选且这一条随候选带了预览(`mode: 'inline'`)时的那一份 —— 零请求。 */
  const inlinePreview = previewRows.length === 1 ? previewRows[0].preview : undefined

  /* ── 键盘 ─────────────────────────────────────────────────────────────── */

  /**
   * 面域局部键的落点(⌘[ / ⌘])。声明的正本在 `focus/scopes.ts`,
   * 这里只给两只处理器 —— 键与动作在两处不可能分叉,由那边的比对表钉着。
   *
   * **这张表的身份必须稳**(所以是 `useMemo([])` + 一格 ref):作用域实例每次
   * 拿到一份新的 `keyHandlers` 都要往树上重写一次,而这块面每敲一个字母都在
   * 重渲染 —— 处理器本身不变,变的只是它闭包里的那份历史,那正是 ref 的用处。
   */
  const stepRef = useRef(stepHistory)
  stepRef.current = stepHistory
  const searchKeys = useMemo(() => ({
    'history.back': () => stepRef.current('back'),
    'history.forward': () => stepRef.current('forward'),
  }), [])

  /*
   * 键盘住在面板自己身上,**不是 keymap 里的命令**:它只在这块面有焦点时才成立。
   * Esc 这里一个字不写 —— 让位契约由宿主(舞台 / 浮窗 / 架子)执行。
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // 拦下默认行为:这块面里 Tab 是「换搜索范围」,不是「把焦点交出去」。
      e.preventDefault()
      setScope(nextTab(tabs, scope, e.shiftKey ? -1 : 1))
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const down = e.key === 'ArrowDown'
      /*
       * ↑ **在「输入框空着、而且选中还停在第一行」时是「回上一条查询」**
       * (§4.6 结论最后一段;终端里 ↑ 的那个手感)。判据是这两条合起来的:
       *  · 输入框里有字的时候 ↑ 只能是走行 —— 那一刻用户在挑结果,不是在回忆;
       *  · 停在第一行 = 已经走到头了,再往上就没有行可走了,那一下才轮得到历史。
       * 走不动(历史空)时**什么都不做**,而不是掉回走行 —— 那会让同一下键
       * 在两种时候干两件事。
       */
      if (!down && !searching && cursor === 0 && !onMore && canGoBack(history)) {
        e.preventDefault()
        stepHistory('back')
        return
      }
      e.preventDefault()
      /*
       * 底部那条 item 是轮转序列的**末位**,但它不是 cursor 的一个值:
       * 按一次「加载更多」列表就长了,末位的下标随之变。一个布尔说的是
       * 「我停在末位」,列表怎么长它都还在末位。
       */
      if (onMore) {
        if (!down) setOnMore(false)
        return
      }
      if (down && moreIsItem && cursor >= visibleRows.length - 1) {
        setOnMore(true)
        return
      }
      selection.handleKey(e.key)
      return
    }
    if (e.key === 'Enter') {
      if (onMore) {
        e.preventDefault()
        activateMore()
        return
      }
      const row = visibleRows[cursor]
      if (!row) return
      e.preventDefault()
      activate(row)
    }
  }

  /**
   * 点一行。**⇧ / ⌘ 是多选**(§4.5 ③「多选是列表的能力,与预览基数解耦」),
   * 素点是「打开」。
   *
   * 两者共用一次点击不是含糊:带修饰键的点击在这套形态语法里从来就是「挑」,
   * 不带的是「做」—— 与文件树、会话总览同一条。
   */
  const onRowClick = (row: SearchRow, index: number, e: ReactMouseEvent) => {
    setOnMore(false)
    // **显式点击**是原语允许改 active 的第二条产地(第一条是键盘)。
    selection.select(index)
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setPicked(current => (current.includes(row.id)
        ? current.filter(id => id !== row.id)
        : [...current, row.id]))
      return
    }
    setPicked([])
    activate(row)
  }

  /* ── 画 ───────────────────────────────────────────────────────────────── */

  return (
    <FocusScope
      scope="search"
      rootRef={panelRef}
      restingTarget={() => panelRef.current?.querySelector('input') ?? null}
      keyHandlers={searchKeys}
      activateOnMount
    >
      {({ scopeProps }) => (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
         * 这里挂 onKeyDown 是**事件委托**,不是把一个 div 变成控件:真正拿焦点的是里面那个
         * 输入框(落点声明),↑↓/⏎ 从它冒泡上来,由面板统一按当前 cursor 处理。
         * 面板内的 Tab / ⇧Tab 是**换搜索范围**,仍然是这一层的行内结构键(不进任何表)。 */
        <div {...scopeProps} className={s.panel} data-testid="search-panel" onKeyDown={onKeyDown}>
          <SearchHead
            query={query}
            onQueryChange={setQuery}
            options={options}
            scope={scope}
            onScopeChange={setScope}
            t={t}
          />

          {/*
            * ── 片条(§9 第五条 + §4.6 结论 1)──────────────────────────────
            * 三段,次序固定:历史的两颗方向钮 / 范围片 / 过滤片。
            * 一颗片都摆不出、也没有范围片、历史也是空的时候整条不画 ——
            * 一条恒空的横条只是在占地方。
            */}
          <SearchFilterBar
            filters={filters}
            chips={chips}
            available={available}
            history={history}
            onFilters={setFilters}
            onStepHistory={stepHistory}
            t={t}
          />

          {/*
            * 检索失败不许静默:它与「没搜到」是两件事,合成一句「无结果」等于把一次
            * 失败说成一次空结果。判据与原话都搬进了 `./SearchFailedLine.tsx`。
            */}
          <SearchFailedLine error={answer.error} t={t} />

          <div className={s.main}>
          <div className={s.body} ref={listRef} role="listbox" aria-label={t('search.resultsLabel')}>
            {rows.length === 0 && visible.every(section => section.error === undefined) ? (
              <p className={s.none}>{t('search.noResults')}</p>
            ) : (
              visible.map(section => (
                <Fragment key={section.capability}>
                  {/*
                    * 节头(§9 第四条)。**只在 `all` 档画**(单类档那一节 `head` 为假)。
                    * 它不是一条 item(不进 role=listbox 的轮转序列,所以
                    * `role="presentation"`),是一条把列表切开的分隔读数。
                    * 右侧那一格是**文字读数**,不是计数徽 —— 库件的计数禁令原文:
                    * tab / 列表 / 组头不挂计数徽,文字读数可以。
                    */}
                  {section.head && (
                    <GroupHead
                      className={s.groupBand}
                      role="presentation"
                      data-group={section.capability}
                      label={sectionLabel(section)}
                      note={
                        <span className={s.groupNote}>
                          {/* 这一组塌了 —— §9 第四条原话「某组 error 时组头一句『没搜成』」。 */}
                          {section.error !== undefined && (
                            <span className={s.groupFailed} data-group-error={section.capability}>
                              {t('search.groupFailed')}
                            </span>
                          )}
                          {section.total !== undefined && (
                            <span className={s.groupTotal} data-group-total={section.capability}>
                              {t('search.totalCount', { total: section.total })}
                            </span>
                          )}
                          <ButtonBase
                            className={s.groupAll}
                            onClick={() => {
                              setHistory(pushHistory(history, entryNow()))
                              setScope(section.capability)
                            }}
                          >
                            {t('search.viewAll')}
                          </ButtonBase>
                        </span>
                      }
                    />
                  )}
                  {section.rows.map((row, k) => {
                    const index = section.offset + k
                    return (
                      /* 一条命中 = 结构件(role=option);画法整件在 `./SearchRow.tsx`。 */
                      <SearchRowView
                        key={row.id}
                        row={row}
                        index={index}
                        selected={!onMore && index === cursor}
                        picked={picked.includes(row.id)}
                        allSpaces={allSpaces}
                        spaceId={spaceId}
                        defaultSpaceId={DEFAULT_SPACE_ID}
                        query={searching ? query : ''}
                        t={t}
                        onClick={(e) => onRowClick(row, index, e)}
                        onContextMenu={(e) => {
                          /*
                           * **动作单产地 = 右键上下文菜单**(09-01 判例)。这一行的全部
                           * 动作(打开 + 续搜那几条)收进同一张表,不散在行尾挂几颗钮。
                           */
                          e.preventDefault()
                          selection.select(index)
                          setOnMore(false)
                          setRowMenu({ row, x: e.clientX, y: e.clientY })
                        }}
                      />
                    )
                  })}
                </Fragment>
              ))
            )}

            {/*
              * 「加载更多」是**列表最后一条 item**,不是一颗悬浮在角上的按钮:
              * 它跟着列表滚、跟着列表排、跟着 ↑↓ 走(末位),形制照这张表既有的行语汇。
              * 取尽那一刻它换成一条**读数**(不是按钮、不进轮转序列)——
              * 一条按不动的按钮比一句话更让人犹豫。
              */}
            {moreIsItem && (
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
                {/* 英文里 result / results 是两句话。选键走 i18n 的 `plural`。 */}
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
              * 四条读数,**各说各的一件事,一条都不合并**。整件在 `./SearchFooter.tsx`;
              * 它今天仍然画在 listbox **里面** —— 搬出去是第 ⑦ 步(a11y 那一格)。
              */}
            <SearchFooter
              total={answer.data?.total}
              relaxed={answer.data?.relaxed}
              indexReadout={indexReadout}
              t={t}
            />
          </div>

          {/*
            * 预览窗(§4.5 ⑥「面板左列表右预览」)。窄档下它由 `.main` 上那条
            * `@container` 收成「行下展开」那一形 —— 一棵树,两种版式。
            */}
          <SearchPreview
            items={previewItems}
            mode={previewMode}
            {...(inlinePreview === undefined ? {} : { inline: inlinePreview })}
            {...(previewRows.length === 1 ? { row: previewRows[0] } : {})}
            query={searching ? query : ''}
          />
          </div>

          {/* 行的动作表(右键)。「打开」+ 这一类自报的续搜(§4.6);整件在
            * `./SearchRowMenu.tsx`。 */}
          <SearchRowMenu
            state={rowMenu}
            available={available}
            t={t}
            onClose={() => setRowMenu(null)}
            onOpen={activate}
            onContinuation={runContinuation}
          />
        </div>
      )}
    </FocusScope>
  )
}
