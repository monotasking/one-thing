import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronDown, Plus, Search, X, resolveIcon } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { useT } from '../../i18n'
import { useAsyncPending } from '../../data/kernel'
import {
  CREATE_KEY,
  currentSessions,
  sessionMutation,
  useSessionsSource,
} from '../../data/sessions-source'
import { useFocusScope } from '../../focus/useFocusScope'
import { buildProjects } from '../projection'
import { exposeIntentOf } from '../keys'
import { buildScopeMenu, toScopeMenuProjects } from '../scope-menu'
import { projectScope, scopeId, scopeSpecOf, visibleScopes } from '../scopes'
import { useExposeStore } from '../store'
import { sessionRowIdsOf } from '../transitions'
import type { ProjectScope } from '../types'
import s from './NavRows.module.css'

/**
 * 三行导航 —— **顶部不是工具栏,是三行与会话行同形同左缘的行**
 * (09-12 方向 A 拍板 1,正本 `docs/sessions-sidebar-2026-09.md` §3.1)。
 *
 * ── 它替掉了什么,以及为什么 ─────────────────────────────────────────────
 * 从前这里是 `Toolbar`:一行三件 `[窄档项目选择器][常驻搜索框][新会话]`。
 * 用户 09-12 真机报的三条病里有两条落在它身上:
 *  · 「搜索区比列表宽」—— 工具栏的页边距是 `--expose-pad`,列表那边还多让了
 *    `scrollbar-gutter: stable both-edges` 的两侧各 10px,于是两块面左缘差 10px;
 *  · 「标题只剩一点」—— 一条常驻的输入框在 240px 的架子里吃掉整整一行的宽,
 *    而它一天里有 99% 的时间是空的。
 * 方向 A 的答案是:**顶部这三件也是行**。同一个左缘(`--content-lead-left`)、
 * 同一个高(`--expose-nav-row-h` = `--expose-row-h`)、同一层悬停薄膜 ——
 * 于是「两块面对不齐」在结构上不存在,而搜索框只在**要搜的那一刻**才存在。
 *
 * ── 三行都是「结构性交互件」(裸钮三类判第③类)─────────────────────────
 * 它们视觉上本该长得像会话行,不是 28px 描边的 `ui/Button`,所以走
 * `ui/ButtonBase`(只清 UA、一个像素不画,焦点环仍走全局 `:focus-visible`)。
 * **不许裸 `<button>`** —— 那会把浏览器那套内边距 / 边框 / `text-align: center`
 * 带进来,每个消费面再手写一遍「清 UA」正是「各写各的」的另一种形态。
 *
 * ── 搜索行的两档是**同一行的两种形**,不是两件 ───────────────────────────
 * rest 是一行;点它(或 ↵ / Space —— `ButtonBase` 天生就认这两个键,这里
 * 一行键盘代码都不用写)原地换成 `ui/Input`。取件口 `data-expose-search`
 * 长在输入框上、`data-testid="expose-search-row"` 长在静息那一行上,
 * 作用域的落点(`restingTarget`,住在 ExposeView)按**先后两档**取人。
 * 键的交接(↓ / ↑ 交树、↵ 进第一条、←→ 不接)逐字沿用 Toolbar 那一份 ——
 * 判据一处产地 `expose/keys.ts`,所以这个文件里一个 'ArrowDown' 字面量都没有。
 *
 * **不画快捷键提示**:今天没有「聚焦会话搜索」这条全局命令(要不要加是用户的
 * 拍点,正本 §7 留账),而画一个按不出来的 ⌘K 是在说谎。
 */
export function NavRows() {
  const t = useT()
  const query = useExposeStore((st) => st.query)
  const searching = useExposeStore((st) => st.searching)
  const scope = useExposeStore((st) => st.scope)
  const sessions = useSessionsSource((st) => st.sessions)
  const { activate } = useFocusScope()
  /*
   * 建会话正在飞吗 —— **逐格**读数(键 = CREATE_KEY),不是整面的忙布尔(病型 B)。
   * 语义一个字没随形态变:反馈只上 `aria-busy`,**不用 disabled**(「在飞」不是
   * 「不可用」,禁灰会把它从焦点序里摘掉,键盘走到一半的人当场丢焦点)。
   */
  const creating = useAsyncPending(sessionMutation, CREATE_KEY)

  /** 范围表 = 与侧栏**同一张表**(固定档 + 项目),不另起一份口径。 */
  const table = useMemo(
    () => ({
      fixed: visibleScopes(sessions).map((item) => ({
        value: scopeId(item),
        label: t(scopeSpecOf(item).labelKey),
      })),
      projects: toScopeMenuProjects(buildProjects(sessions), (project) =>
        scopeId(projectScope(project.id)),
      ),
    }),
    [sessions, t],
  )
  /** 行上那句话按 id 在**整张表**里查(见下),所以这一格要摊平的那一份。 */
  const options = useMemo(() => [...table.fixed, ...table.projects], [table])

  /**
   * 范围行上显示的那句话 = **当前这一档在上面那张表里的名字**。
   * 项目那一档不能读 `scopeSpecOf(scope).labelKey`(那一格是「项目」这个类名,
   * 不是「transreader」这个项目名),所以按 id 在表里查 —— 一张表,两处消费。
   */
  const current = scopeId(scope)
  const scopeLabel = options.find((o) => o.value === current)?.label ?? t('expose.scopeAll')
  const ScopeIcon = resolveIcon(scopeSpecOf(scope).icon)

  /** 选择器交回来的是 `scopeId` 的字面,这里翻回一格 `ProjectScope`。 */
  const onPick = useCallback((value: string) => {
    const next: ProjectScope = value.startsWith('project:')
      ? projectScope(value.slice('project:'.length))
      : ({ kind: value } as ProjectScope)
    useExposeStore.getState().setScope(next)
  }, [])

  /*
   * 「新会话」建在哪个项目下:`project` 范围建到该项目,其余范围建无项目会话。
   * 协作范围里建出来的是一条普通会话 —— 建房要 `kind:'room'` 加一份成员名册,
   * 那是一次独立的入口设计,按旧例不动。
   */
  const onNew = useCallback(() => {
    // 二次闸:飞着的时候再按几下都当没按(⌘N 自动重复那条路的闸在 store.newSession)。
    if (creating) return
    const st = useExposeStore.getState()
    void st.newSession(st.scope.kind === 'project' ? st.scope.projectId : null)
  }, [creating])

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const intent = exposeIntentOf(e.key)
    if (intent === 'move-down' || intent === 'move-up') {
      e.preventDefault()
      /*
       * 两句话是一件事:`focusGrid()` 让键盘位显形(focusVisible),`activate()`
       * 把焦点从搜索条挪到这块面的落点上 —— 落点正是按 focusVisible 分档的
       * (见 ExposeView)。从前那一手 `blur()` 会让焦点掉到 body,而 R1 之后
       * 孤儿焦点会被收回落点、于是**弹回搜索条**,树纹丝不动。
       */
      useExposeStore.getState().focusGrid()
      activate('programmatic')
      return
    }
    if (intent !== 'enter') return
    const st = useExposeStore.getState()
    // **第一条会话**,不是序列首 —— 序列首是节头(09-04 分节可折叠之后),
    // 而搜索条上的 ↵ 说的一直是「进屏幕上第一条会话」。
    const first = sessionRowIdsOf(st, { sessions: currentSessions(), now: Date.now() })[0]
    if (!first) return
    e.preventDefault()
    st.enterSession(first)
  }

  /*
   * ── 搜索行开合那一拍,焦点跟着走 ─────────────────────────────────────────
   * 「开什么焦点进什么」(响应链规则 2)的落地形是**开的人点名、被开的那一格
   * 挂载时自己取走** —— 所以这里不是「点完当场 `.focus()`」(那一刻输入框还
   * 不在文档里),而是在**提交之后**叫一句 `activate()`,由作用域的
   * `restingTarget` 去认此刻该是谁:开出来 → 输入框;收回去 → 搜索行那颗钮
   * (键盘位亮着时是树 —— 那时焦点本来就不在这一行上,见 ExposeView 的三档)。
   *
   * `prev` 那一格 ref 是**只在翻面那一拍动手**的判据:没有它,这只 effect 会
   * 在每次重渲染后把焦点往回拽一次(打字时焦点已经在输入框里,拽是白拽;
   * 而键盘走到树上之后再重渲一次就会被拽回来 —— 那正是 R1 之前那个病)。
   *
   * ── 它与孤儿回收是**同一件事的两条路,而这一条是被声明的那条** ────────────
   * A1 的反证量过:把这只 effect 整只拆掉,`gate:sessions` ④ 的「焦点落在
   * 输入框里」与「Esc → 焦点回搜索那一行」两条在真机上**照旧全绿** ——
   * 因为换形让焦点成了孤儿,而孤儿由响应链结构性地收回同一个落点(I1)。
   * 保留它有两个理由,都不是「保险」:
   *  ① **明说 vs 副作用** —— 「点开搜索所以焦点进输入框」是这一下手势的意图,
   *    靠「那颗钮恰好被卸载了」成立是靠副作用;哪天搜索行改成两件常驻、
   *    只切 `hidden`,副作用当场消失而意图还在;
   *  ② jsdom 那一头没有这条回收(React 同步卸载 + jsdom 的焦点语义与
   *    Chromium 不同),拆掉之后 `NavRows.test` 三条当场红 —— 而单测钉的正是
   *    这个意图。真机的绿与 jsdom 的红同时存在时,该留的是**说得出意图**的那条。
   */
  const prevSearching = useRef(searching)
  useEffect(() => {
    if (prevSearching.current === searching) return
    prevSearching.current = searching
    activate('programmatic')
  }, [searching, activate])

  /**
   * 范围菜单那一格。**点锚不跟滚**那一档在这里不适用:锚是一行常驻的钮,
   * 所以走 `anchor`(活矩形)那一档 —— 菜单贴着这一行的下缘左对齐并跟着它滚
   * (与 `ui/Select` 的面板同一条裁定)。矩形从 ref 现读,不存一份。
   */
  const scopeRowRef = useRef<HTMLButtonElement>(null)
  const [scopeOpen, setScopeOpen] = useState(false)
  const scopeAnchor = useCallback(
    () => scopeRowRef.current?.getBoundingClientRect() ?? null,
    [],
  )

  /*
   * ── 范围菜单自己的两格临时状态(A6)──────────────────────────────────────
   * 筛选词与「更早」的开合**只活在这一次打开里**:关掉再开是一张干净的表
   * (与搜索行那两格不落盘逐字同一条理由)。所以它们由开关那一口一并清 ——
   * 一件事一个产地,不再在 `onClose` / 选中 / Esc 三处各清一遍。
   */
  const [scopeFilter, setScopeFilter] = useState('')
  const [olderOpen, setOlderOpen] = useState(false)
  const setScopeMenuOpen = useCallback((open: boolean) => {
    setScopeOpen(open)
    if (!open) {
      setScopeFilter('')
      setOlderOpen(false)
    }
  }, [])

  /**
   * 这一刻那张表长什么样 —— 判据全在纯函数 `expose/scope-menu.ts`(三段 +
   * 画不画筛选框 + 折不折),这只组件只负责把它画出来。
   * `Date.now()` 在这里现读:菜单是**开的那一刻**照的一张相,它活不过这一次打开
   * (词一变重算一次,而那一刻与开的那一刻差着几秒 —— 对一条 7 天的线无关紧要)。
   */
  const menuModel = useMemo(
    () =>
      buildScopeMenu({
        fixed: table.fixed,
        projects: table.projects,
        query: scopeFilter,
        now: Date.now(),
        olderExpanded: olderOpen,
      }),
    [table, scopeFilter, olderOpen],
  )

  const newLabel = t('expose.newSession')

  return (
    <div className={s.nav} data-testid="expose-nav">
      <ButtonBase
        className={s.row}
        data-testid="expose-new-session"
        aria-busy={creating || undefined}
        onClick={onNew}
      >
        <Plus className={s.glyph} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.label}>{newLabel}</span>
      </ButtonBase>

      {searching ? (
        /*
         * 输入框那一档。**它自己就是那一行** —— md 档高 `--btn-md`,而
         * `--expose-nav-row-h` 读的就是那一格(判词写在 tokens.css 上),
         * 所以换形时上下两行一个像素都不动:「原地变成输入框」的字面实现。
         * 这里**不从消费侧改它的高**:两个单类选择器特异性相同,谁赢由样式表
         * 先后决定,那是一条会随 import 次序漂的规则(SectionHead 那条
         * `composes` 判例同因)。要它们同高就让 token 读同一个数。
         */
        <Input
          className={s.searchOpen}
          data-expose-search=""
          size="md"
          value={query}
          onValueChange={(value) => useExposeStore.getState().setQuery(value)}
          onKeyDown={onSearchKey}
          prefix={<Search className={s.glyph} strokeWidth={1.75} aria-hidden="true" />}
          placeholder={t('expose.searchPlaceholder')}
          aria-label={t('expose.searchLabel')}
        />
      ) : (
        /*
         * ── 静息那一档,**A6 起有两种形** ───────────────────────────────────
         * 词是空的 → 一行字(与从前逐字相同);**词还在** → 那一行自己把词说出来
         * (「筛选 · <词>」)并在行尾挂一颗 ×。后者是「离开活动路径就收回」那条
         * 拍板的另一半:收形不收词,而一个**看不见的过滤器**是 09-04 立法禁掉的
         * 东西 —— 所以收回来的那一行必须说得出自己还在滤什么。
         *
         * × 是一颗**真钮**,所以它不能长在那一行(`ButtonBase`)**里面**
         * (`<button>` 套 `<button>` 是非法 HTML)。于是带词那一档外面包一格:
         * 悬停薄膜挪到包着的那一格上,两件同亮同灭,读起来仍是一行。
         * 它 `tabIndex={-1}` 不进 Tab 序 —— 键盘那条路是 Esc(与它同一口,
         * 判词在 `ExposeView.onEscape`),与会话行尾那颗 ⋯ 逐字同一条。
         */
        <div className={query ? s.keptRow : undefined}>
          <ButtonBase
            className={query ? s.keptMain : s.row}
            data-testid="expose-search-row"
            onClick={() => useExposeStore.getState().openSearch()}
          >
            <Search className={s.glyph} strokeWidth={1.75} aria-hidden="true" />
            <span className={s.label}>
              {query ? t('expose.filterChip', { query }) : t('expose.searchRow')}
            </span>
          </ButtonBase>
          {query && (
            <IconButton
              icon={X}
              size="xs"
              tip={false}
              tabIndex={-1}
              testId="expose-filter-clear"
              label={t('expose.filterClear')}
              onClick={() => useExposeStore.getState().setQuery('')}
            />
          )}
        </div>
      )}

      {/*
       * 范围行。**常驻 DOM,由容器查询决定显不显**:≥761 时 `display: none` 顺手
       * 把它移出无障碍树,于是同一时刻只有一个范围控件被读屏读到(宽档是侧栏
       * 那只 listbox)。阈值 760 与 tokens 的 --expose-rail-bp 是同一事实的两处
       * 写法 —— `@container` 的条件里不能写 var(),改的时候两处一起改。
       */}
      <ButtonBase
        ref={scopeRowRef}
        className={`${s.row} ${s.scopeRow}`}
        data-testid="expose-scope-row"
        aria-haspopup="menu"
        aria-expanded={scopeOpen}
        onClick={() => setScopeMenuOpen(true)}
      >
        <ScopeIcon className={s.glyph} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.label}>{scopeLabel}</span>
        <ChevronDown className={s.chev} strokeWidth={2} aria-hidden="true" />
      </ButtonBase>
      {scopeOpen && (
        <Menu
          x={0}
          y={0}
          anchor={scopeAnchor}
          anchorPlace="below-start"
          label={t('expose.scopeLabel')}
          onClose={() => setScopeMenuOpen(false)}
          /*
           * 项目多时顶上那格筛选框(A6 §9 拍板 2)。**头部槽是库件的一格**
           * (`ui/Menu.header`):不进 roving、不跟着滚、在 `role="menu"` 外面,
           * ↓ / ↑ / ↵ 三个键由库件交给菜单体 —— 这里一行键盘代码都不写。
           */
          header={
            menuModel.filterShown ? (
              <Input
                size="sm"
                data-expose-scope-filter=""
                value={scopeFilter}
                onValueChange={setScopeFilter}
                placeholder={t('expose.scopeFilterPlaceholder')}
                aria-label={t('expose.scopeFilterPlaceholder')}
              />
            ) : undefined
          }
          /*
           * Esc **先清词再关**(拍板 2 的最后一句)。答 `false` 时库件照旧关菜单 ——
           * 「这一下归不归我」由消费方答,而关不关是库件的事。
           */
          onEscape={() => {
            if (!scopeFilter) return false
            setScopeFilter('')
            return true
          }}
        >
          {/* 固定三档钉在最上面,**不参与过滤**(判词在 `scope-menu.ts`)。 */}
          {menuModel.fixed.map((option) => (
            <MenuItem
              key={option.value}
              checked={option.value === current}
              onClick={() => {
                setScopeMenuOpen(false)
                onPick(option.value)
              }}
            >
              {option.label}
            </MenuItem>
          ))}
          {/* 有项目可画时才隔一条线:一条悬在空处的分隔线是在说「下面还有」而其实没有。 */}
          {(menuModel.recent.length > 0 || menuModel.olderCount > 0) && <MenuSeparator />}
          {menuModel.recent.map((option) => (
            <MenuItem
              key={option.value}
              checked={option.value === current}
              onClick={() => {
                setScopeMenuOpen(false)
                onPick(option.value)
              }}
            >
              {option.label}
            </MenuItem>
          ))}
          {/*
           * 「更早 · N 个」。它是一行**动作**(点开 / 收起),不是一个值,所以
           * 不带 `checked` —— 角色因此是 `menuitem` 而不是 `menuitemradio`,
           * 读屏软件不会把它念成「这一档没选中」。
           */}
          {menuModel.olderCount > 0 && (
            <MenuItem onClick={() => setOlderOpen((on) => !on)}>
              {t('expose.scopeOlder', { n: menuModel.olderCount })}
            </MenuItem>
          )}
          {menuModel.older.map((option) => (
            <MenuItem
              key={option.value}
              checked={option.value === current}
              onClick={() => {
                setScopeMenuOpen(false)
                onPick(option.value)
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  )
}
