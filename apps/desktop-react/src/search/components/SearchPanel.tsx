import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useStageStore } from '../../stage/store'
import { useSessionsSource } from '../../data/sessions-source'
import { useFilesSource, useSessionCwd } from '../../data/files-source'
import { useExposeStore } from '../../expose/store'
import { Highlight } from '../../expose/components/Highlight'
import { useSessionTime } from '../../expose/components/session-time'
import { Input } from '../../ui/Input'
import { Segmented } from '../../ui/Segmented'
import type { SegmentedOption } from '../../ui/Segmented'
import { notify } from '../../services/notify'
import { Search } from '../../components/icons'
import { plural, useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import {
  SCOPES,
  browseRows,
  moreState,
  moveRow,
  nextScope,
  originText,
  pageWindow,
  searchRows,
  targetText,
} from '../transitions'
import type { SearchFileSide, SearchMaterial } from '../transitions'
import type { SearchBadge, SearchRow, SearchScope } from '../types'
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
 * 文件检索的合并窗口(D5)。会话侧是本地滤(整张 listMeta 在手,零延迟),
 * 文件侧是**一次真查询**(后端 ripgrep 列目录再滤),所以每敲一个字母就发一次
 * 请求是不合适的。窗口按「打完一个词的停顿」取,不按「最快能有多快」取。
 */
const FILE_SEARCH_DEBOUNCE_MS = 220

const SCOPE_LABELS: Record<SearchScope, MessageKey> = {
  all: 'search.scopeAll',
  sessions: 'search.scopeSessions',
  files: 'search.scopeFiles',
}

/** 徽上的字:前两种是界面文案(走字典),文件那种是从扩展名推出来的数据。 */
function badgeText(badge: SearchBadge, t: TFn): string {
  if (badge.kind === 'file') return badge.ext
  return t(badge.kind === 'session' ? 'search.badgeSession' : 'search.badgeMessage')
}

export function SearchPanel() {
  const t = useT()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [cursor, setCursor] = useState(0)
  /** 第几页,从 1 数。换词 / 换范围就回到第一页(那是另一张列表了)。 */
  const [page, setPage] = useState(1)
  /** 选中的是不是底部那条 item。**它不是 cursor 的一个值** —— 见 onKeyDown。 */
  const [onMore, setOnMore] = useState(false)
  const enterSession = useExposeStore((st) => st.enterSession)
  const closeToDock = useStageStore((st) => st.closeToDock)
  const sessions = useSessionsSource((st) => st.sessions)
  const chapters = useSessionsSource((st) => st.chapters)
  const ensureChapters = useSessionsSource((st) => st.ensureChapters)
  const cwd = useSessionCwd()
  const fileHits = useFilesSource((st) => st.searchHits)
  const fileQuery = useFilesSource((st) => st.searchQuery)
  const fileStatus = useFilesSource((st) => st.searchStatus)
  const fileError = useFilesSource((st) => st.searchError)
  const fileLimit = useFilesSource((st) => st.searchLimit)
  const searchFiles = useFilesSource((st) => st.searchFiles)
  const timeOf = useSessionTime()
  const listRef = useRef<HTMLDivElement>(null)

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
   * 手上这批文件命中说的**是不是此刻这个词**。去抖窗口那 220ms 里词已经变了而
   * 结果还没回来 —— 不问这一句,屏幕上就会闪一下上一个词的结果。对不上就当作
   * 「还没有」(空),而不是拿旧的顶一会儿。
   */
  const fileAnswerIsCurrent = fileQuery === query.trim()
  const files = useMemo(
    () => (fileAnswerIsCurrent ? fileHits : []),
    [fileAnswerIsCurrent, fileHits],
  )
  const material: SearchMaterial = useMemo(
    () => ({ sessions, chapters, files, timeOf: (session) => timeOf(session.updatedAt) }),
    [sessions, chapters, files, timeOf],
  )
  const rows = useMemo(
    () => (searching ? searchRows(query, scope, material) : browseRows(scope, material)),
    [query, scope, searching, material],
  )

  /**
   * 文件侧此刻的处境。取尽判据是**回来的条数 < 要的条数** —— 后端这一条既没有
   * 游标也不下发总数,这是唯一能判的一句(理由写在 transitions 的「分页」一节)。
   * `scope === 'sessions'` 时这一档根本不看文件,所以它恒定「取尽」。
   */
  const fileSide: SearchFileSide = useMemo(() => {
    if (scope === 'sessions') return 'exhausted'
    if (!fileAnswerIsCurrent || fileStatus === 'idle' || fileStatus === 'loading') return 'pending'
    if (fileStatus === 'error') return 'failed'
    return fileHits.length < fileLimit ? 'exhausted' : 'more'
  }, [scope, fileAnswerIsCurrent, fileStatus, fileHits.length, fileLimit])

  const more = moreState({ searching, page, total: rows.length, files: fileSide })
  /** 屏幕上这一页。会话侧本来就全量在手,所以翻页在那一侧纯粹是把窗口拉大。 */
  const visible = useMemo(() => rows.slice(0, pageWindow(page)), [rows, page])
  /** 底部那条 item 能不能按(加载中也留在轮转序列里,免得焦点在加载途中蒸发)。 */
  const moreIsItem = more.kind === 'more' || more.kind === 'loading' || more.kind === 'error'

  /*
   * 章节是**按需**拉的:标题 / 预览命中的那几条先把章节补回来,下一轮渲染里
   * 它们的章节行就一起出现。上限是刻意的 —— 一个字母就为几十条会话各发一次
   * 请求,那不叫按需。会话侧另外两样(标题、预览)本来就在 listMeta 里,即时滤。
   */
  useEffect(() => {
    if (!searching || scope === 'files') return
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
  }, [searching, query, scope, sessions, ensureChapters])

  /*
   * 文件侧是一次**真查询**,所以它有自己的取数副作用(会话侧没有:整张表在手)。
   * 合并窗口挡的是「每敲一个字母发一次请求」;`scope === 'sessions'` 时连发都不发 ——
   * 用户已经说了这一轮不看文件。
   *
   * 分页是**递增 limit 重查**:第 n 页带一个更大的 limit 从头再要一次(后端只有
   * limit 没有游标 —— 代价与留账写在 transitions 的「分页」一节),所以 `page`
   * 也在依赖表里:翻一页就是重发一次。
   *
   * 合并窗口只挡**打字的余波**:主语(词 + 根)没变 —— 也就是这一次是翻页或者
   * 「重试」—— 就当场发。让一次确定的点击等 220ms 是把它当成了打字。
   */
  const askedSubject = useRef<string | null>(null)
  useEffect(() => {
    if (scope === 'sessions') return
    const subject = JSON.stringify([query.trim(), cwd])
    const sameSubject = askedSubject.current === subject
    askedSubject.current = subject
    const run = () => void searchFiles(query, cwd, pageWindow(page))
    /*
     * 主语没变、而且已经翻过页 —— 那这一次只能是「加载更多」或者「重试」,
     * 两者都是一次**确定的点击**,当场发。第一页永远走合并窗口:换词换范围都
     * 落在第一页,那才是打字的余波要挡的地方。
     */
    if (sameSubject && page > 1) {
      run()
      return
    }
    const timer = setTimeout(run, FILE_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, scope, cwd, page, searchFiles])

  // 底部那条 item 没了(取尽 / 列表空了)就不能再让选中停在它上面。
  useEffect(() => {
    if (!moreIsItem) setOnMore(false)
  }, [moreIsItem])

  // 选中行滚进视野。block:'nearest' = 只在它真的出界时才滚,列表不会为了走一行整屏跳。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      onMore ? '[data-row="more"]' : `[data-row="${cursor}"]`,
    )
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, onMore, visible])

  const options: Array<SegmentedOption<SearchScope>> = SCOPES.map((value) => ({
    value,
    label: t(SCOPE_LABELS[value]),
  }))

  const activate = (row: SearchRow) => {
    switch (row.target.kind) {
      case 'session':
        enterSession(row.target.sessionId)
        break
      case 'file':
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
          title: t('search.openedFile', { file: targetText(row.target) }),
        })
        break
    }
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
    if (more.kind === 'error') void searchFiles(query, cwd, pageWindow(page))
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
      setScope((sc) => nextScope(sc, e.shiftKey ? -1 : 1))
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
      setCursor((i) => moveRow(i, down ? 1 : -1, visible.length))
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

  return (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 这里挂 onKeyDown 是**事件委托**,不是把一个 div 变成控件:真正拿焦点的是里面那个
     * 输入框(autoFocus),↑↓/⏎ 从它冒泡上来,由面板统一按当前 cursor 处理。
     * 规则防的是「给死元素装交互却不给焦点」—— 焦点在,只是在子节点上。 */
    <div className={s.panel} data-testid="search-panel" onKeyDown={onKeyDown}>
      <div className={s.head}>
        <Input
          className={s.input}
          value={query}
          onValueChange={setQuery}
          size="lg"
          /* eslint-disable-next-line jsx-a11y/no-autofocus --
           * 命令面板的**唯一**用法就是「⌘P 敲出来就打字」。这里不自动聚焦等于
           * 让每个用户开完面板再按一次 Tab —— 规则防的是「页面一进来就抢焦点」,
           * 而这块面板是用户刚刚显式召唤出来的瞬态浮层,焦点本来就该在它身上。 */
          autoFocus
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
      {scope !== 'sessions' && fileStatus === 'error' && fileAnswerIsCurrent && (
        <p className={s.failed}>
          {t('search.filesFailed')}
          <span className={s.failedDetail}>{fileError}</span>
        </p>
      )}

      <div className={s.body} ref={listRef} role="listbox" aria-label={t('search.resultsLabel')}>
        {rows.length === 0 ? (
          <p className={s.none}>
            {/* 空词 + 只看文件 = 不是「无结果」,是「还没给词」:文件侧在浏览态**没有
              * 产地**(`files.list` 只在带词时才有意义),见 search/transitions.ts
              * 文件头第 2 条。这句话如实说出那个缺口,不去伪造一张「最近打开」。
              * 会话侧的浏览态不落在这一支:它有产地(整张 listMeta),所以走列表。 */}
            {scope === 'files' && !searching ? t('search.filesNeedQuery') : t('search.noResults')}
          </p>
        ) : (
          visible.map((row, i) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={!onMore && i === cursor}
              data-row={i}
              className={!onMore && i === cursor ? `${s.row} ${s.rowOn}` : s.row}
              onClick={() => {
                setOnMore(false)
                setCursor(i)
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
                <span className={s.chipText}>{badgeText(row.badge, t)}</span>
              </span>
              <span className={row.code ? `${s.text} ${s.code}` : s.text}>
                <Highlight text={row.text} query={searching ? query : ''} />
              </span>
              <span className={s.origin}>{originText(row.origin)}</span>
            </button>
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
          <button
            type="button"
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
          </button>
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
      </div>
    </div>
  )
}
