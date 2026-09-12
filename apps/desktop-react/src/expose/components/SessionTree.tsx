import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useT } from '../../i18n'
import { useSessionsList, useSessionsSource } from '../../data/sessions-source'
import { hoverSessionRow, leaveSessionRow } from '../../data/chat-prefetch'
import { buildListModel, treeNodeDomId } from '../list-model'
import { projectNameOf } from '../projection'
import { useExposeStore } from '../store'
import { SectionHead } from './SectionHead'
import { SessionRow } from './SessionRow'
import { useSessionTime } from './session-time'
import { useContentDrag } from '../../workbench/useContentDrag'
import { openStateOf, useWorkbenchStore } from '../../workbench/store'
import { sessionRefOf } from '../../content/session-ref'
import { SessionActionsMenu } from './SessionActionsMenu'
import s from './SessionTree.module.css'


/**
 * 会话列表 —— **一张树**(设计 §1)。总览与「钻进某个组」那第二屏 09-04 合并成
 * 了它,`view.mode === 'list'` 一并退役。
 *
 * ── 无障碍:一个 Tab 位,活动行由 `aria-activedescendant` 指着(§3.1)───────
 * `role="tree"` + `tabIndex=0` 长在**容器**上;行是 `role="treeitem"` 的 `<div>`,
 * 谁都不可聚焦。理由是三律的推论:469 条会话不该是 469 个 Tab 位。
 * 于是「活动行」不是 `document.activeElement` 而是 store 的 `focusId` ——
 * 只有键盘与显式点击改得动它,`mouseenter` 一个字都不写(hover ≠ active)。
 * `aria-activedescendant` **只在 focusVisible 为真时**指人:焦点环只在键盘会话亮
 * (08-28 判例),没点亮的时候读屏也不该被拽到某一行上。
 *
 * ── 分节:节头是树的项,行装在 `role="group"` 里 ─────────────────────────
 * 09-04 用户报「分组没法收」之后,节头(SectionHead)自己就是一个
 * `role="treeitem" aria-level="1" aria-expanded`,它的会话行装在**紧跟其后的**
 * 一只 `role="group" aria-labelledby=<节头 id>` 里 —— 顶层会话 `aria-level="2"`、
 * 房间的子行 `aria-level="3"`(层级由模型给,行不自己 depth+1)。
 *
 * 那只 group 是**兄弟**不是孩子:名字要从节头取,而 accname 的 name-from-content
 * 会把嵌进去的整片行文本都算进节头的名字(「今天 重构 provider 抽象 发版房 …」)。
 * 外面那层 `div.section` 不带任何 role —— 它只为**粘顶**存在:`position: sticky`
 * 认的是父元素的盒子,六个节头共用一个父的话它们会一起堆在顶上互相盖住。
 *
 * 收起 = **原地形变**:`div.section` 与它里面的 SectionHead 都由 key 钉住,
 * 收展只是那只 group 在与不在,节头**不重挂**(四律第 4 条)。
 *
 * ── 模型只算一次 ────────────────────────────────────────────────────────
 * `buildListModel` 是纯函数,五步各有单测;这里按
 * `[sessions, scope, query, expandedRooms]` 记忆一份(`now` 在记忆体里取)。
 */
export function SessionTree({ treeRef }: { treeRef: RefObject<HTMLDivElement | null> }) {
  const t = useT()
  const timeOf = useSessionTime()
  /*
   * 只订阅画面真正消费的那几格,**不整仓订阅**(08-30 真机画像第二记):
   * `useExposeStore()` 不带 selector 时,store 每 notify 一次这里就整棵重渲一次 ——
   * 而切回这个 tab 时 open() 归位必然 notify(它总是造新 state 对象)。
   * 动作一律走 `useExposeStore.getState()`(引用稳定,事件处理器里取用)。
   */
  const scope = useExposeStore((st) => st.scope)
  const query = useExposeStore((st) => st.query)
  const expandedRooms = useExposeStore((st) => st.expandedRooms)
  const collapsedSections = useExposeStore((st) => st.collapsedSections)
  const focusId = useExposeStore((st) => st.focusId)
  const focusVisible = useExposeStore((st) => st.focusVisible)
  const currentSessionId = useExposeStore((st) => st.currentSessionId)
  const sessions = useSessionsSource((st) => st.sessions)
  /*
   * 「读到哪一步了」读的是列表那一格 query 的快照。两个读数**正交**,各画各的:
   *  · `phase === 'initial'` = 从来没有过列表 → 只有这时候画「正在读」;
   *    一旦有过就永远是 ready,重拉时屏幕上那份留着(律②);
   *  · `error` = 最近一次没拿到的原话,**与列表并存**(那一行在 Overview 上)。
   */
  const { phase, error } = useSessionsList()

  /*
   * **这一条开着没有**(W5-b 裁定 7)。三格订阅,与 `FilesPanel` 那一处逐字同源
   * —— 判据是纯函数 `openStateOf`,渲染层不自己判一次;订的是这三格而不是整仓,
   * 理由与上面那段一样(树一动这里就整棵重渲)。
   */
  const regions = useWorkbenchStore((st) => st.regions)
  const hiddenTabs = useWorkbenchStore((st) => st.hidden)
  const panelPath = useWorkbenchStore((st) => st.panelPath)
  const openStateOfSession = useCallback(
    (sessionId: string) =>
      openStateOf({ regions, hidden: hiddenTabs, panelPath }, sessionRefOf(sessionId)),
    [regions, hiddenTabs, panelPath],
  )

  /**
   * 右键菜单那一格(点锚:光标坐标开出来,滚动时维持原位)。
   * 它是**这块面**的状态而不是行的:一屏至多一张菜单,长在行上就是 400 份。
   */
  const [menu, setMenu] = useState<{ id: string; title: string; x: number; y: number } | null>(null)

  /*
   * `now` 在**记忆体里**取一次,不在渲染体里现取:后者每渲染一帧换一个数,
   * useMemo 当场作废,而且同一屏里两行会因为差了几毫秒落进不同的日子。
   * 落桶随「会话表 / 范围 / 词 / 展开集 / 收起的节」任何一格变化重算 —— 跨过午夜那一刻
   * 由下一次列表变动带过去(整点重排不是本批的事,没有定时器)。
   */
  const model = useMemo(
    () =>
      buildListModel({ sessions, scope, query, expandedRooms, collapsedSections, now: Date.now() }),
    [sessions, scope, query, expandedRooms, collapsedSections],
  )

  /*
   * 四只**身份恒定**的回调(见 SessionRow 文件头那段病历):动作走 `getState()`
   * (store 的动作引用本来就稳定,不必进依赖表),id 由行自己交回来。
   */
  const onEnter = useCallback(
    (sessionId: string) => useExposeStore.getState().enterSession(sessionId),
    [],
  )
  const onToggleRoom = useCallback(
    (sessionId: string) => useExposeStore.getState().toggleRoom(sessionId),
    [],
  )
  /*
   * **一行会话是一个拖拽来源,而且它落哪儿都行**(W5-b 裁定 8)。
   *
   * W3 时这里有三格自述:`rules.accepts`(只许落中央)、`rules.split: false`、
   * 以及一口 `onDrop`(不插树,改走 `enterSession`)。会话成为一种真内容之后
   * **三格一起消失**,正是 W3 那段注脚里写的预言:
   *  · 落得下吗 —— 由 `ContentKind.regions` 生成(会话那一种没有声明,于是
   *    哪儿都行);拒绝那句话的产地也跟着搬进了 `useContentDrag`;
   *  · 分不分屏 —— 开着:会话可以切一刀放到旁边,那正是「会话并排」;
   *  · 落定做什么 —— 走缺省那条 `dropRef`:真往树里插一格。
   * 浮影也不必再手写:名字与图标问种类表(`title` 会答这条会话的真名)。
   */
  const dragSessionId = useRef<string | null>(null)
  const startSessionDrag = useContentDrag({
    ref: () => (dragSessionId.current ? sessionRefOf(dragSessionId.current) : null),
  })
  const onDragPointerDown = useCallback(
    (sessionId: string, e: ReactPointerEvent<HTMLElement>) => {
      dragSessionId.current = sessionId
      startSessionDrag(e)
    },
    [startSessionDrag],
  )
  const onToggleSection = useCallback(
    (sectionId: string) => useExposeStore.getState().toggleSection(sectionId),
    [],
  )
  /** 点空心那颗点 = 把这一份请回它藏起来时那个位置(与文件树行同一口)。 */
  const onRestore = useCallback(
    (sessionId: string) =>
      useWorkbenchStore.getState().restoreHidden(`session:${sessionId}`),
    [],
  )
  /*
   * ── 悬停预取(第 6 单)—— 委托在**树容器**上,不长在行上 ──────────────────
   *
   * 与那条 `scrollIntoView` 的 effect 同一条理由(见 SessionRow 文件头第 ③ 笔):
   * 一屏 400 行,而「指针此刻停在哪一行」永远只有**一行**。挂在行上就是 400 份
   * 监听 + 两格新 prop,而那两格 prop 会连着 memo 的稳定性一起还债 —— 冷开预算
   * 是一行一行乘出来的。所以这里与键盘走同一条路:事件委托,行本身一个字不动。
   *
   * 用 `pointerover` / `pointerleave` 而不是 `pointerenter` / `pointerout`:
   * 前者一对是**冒泡的**(委托要的正是这个)与**只在真的离开容器时发一次**;
   * `pointerenter` 压根不冒泡到这里,`pointerout` 则会在行内每换一个子元素时
   * 各发一次,拿它当「离开」用就是每走过一个图标撤一次单。
   *
   * **它不碰 active,也不碰焦点**(hover ≠ active 两态纪律):`hoverSessionRow`
   * 全部的作用是起一只表,到点了去 `chat-source` 的注册表里把那条会话捂热。
   */
  const onTreePointerOver = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const row = (e.target as HTMLElement | null)?.closest?.('[data-session-id]')
    const sessionId = row?.getAttribute('data-session-id')
    if (sessionId) hoverSessionRow(sessionId)
    else leaveSessionRow()
  }, [])
  const onMenu = useCallback(
    (sessionId: string, point: { x: number; y: number }) => {
      const title = currentSessionsTitle(sessionId)
      setMenu({ id: sessionId, title, x: point.x, y: point.y })
    },
    [],
  )
  const closeMenu = useCallback(() => setMenu(null), [])

  /*
   * 项目名按 `projectId` 记一份。`projectNameOf` 只是一次 `lastIndexOf` + `slice`,
   * 单次便宜 —— 贵在**每行每次渲染都跑一遍**,而 400 行摊下来通常只有十几个不同的
   * 目录。名字是从 id 裁出来的纯函数,同一个 id 永远同一个名字,所以这份记忆体
   * 没有失效的那一天(随组件生死)。
   */
  const projectNames = useMemo(() => {
    const cache = new Map<string, string>()
    return (projectId: string | null | undefined): string | null => {
      if (!projectId) return null
      const hit = cache.get(projectId)
      if (hit !== undefined) return hit
      const name = projectNameOf(projectId)
      cache.set(projectId, name)
      return name
    }
  }, [])

  /** 项目 chip 只在「全部」范围出现(设计 §1.1);别的范围里它是句废话。 */
  const showProject = scope.kind === 'all'
  const searching = query.trim().length > 0
  const activeId = focusVisible && focusId ? focusId : null

  /*
   * 键盘走到视口外的行时把它带回来 —— **一条 effect,不是每行一条**
   * (09-04 冷开预算,病历在 SessionRow 文件头第 ③ 笔)。这件事本来就只关心
   * 活动行那**一条**;长在行上意味着 400 行各挂一条,其中 399 条永远只是
   * 「我不是活动行」。这里按 id 从 DOM 上取那一条 —— 是一次**读**(getElementById
   * + scrollIntoView),不是 `.focus()`、也不读 `activeElement`:焦点始终停在
   * `role="tree"` 那一个 Tab 位上(§3.1 的 activedescendant 形),响应链的
   * I1/I3 一个字没碰。
   */
  useEffect(() => {
    if (!activeId) return
    // 活动项可能是一个节头 —— 焦点 id → DOM id 的翻译只有 `treeNodeDomId` 一处。
    document.getElementById(treeNodeDomId(activeId))?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  function renderBody() {
    if (model.sections.length > 0) {
      return model.sections.map((section) => (
        <div key={section.id} className={s.section}>
          <SectionHead
            id={section.id}
            label={section.label}
            expanded={section.head.expanded}
            active={section.head.id === activeId}
            onToggle={onToggleSection}
          />
          {section.head.expanded && (
            <div
              className={s.group}
              role="group"
              aria-labelledby={`expose-section-${section.id}`}
            >
              {section.rows.map((row) => (
                <SessionRow
                  key={row.id}
                  id={row.id}
                  title={row.session.title}
                  kind={row.session.kind}
                  projectName={showProject ? projectNames(row.session.projectId) : null}
                  time={timeOf(row.session.updatedAt)}
                  query={query}
                  depth={row.depth}
                  level={row.level}
                  expandable={row.expandable}
                  expanded={row.expanded}
                  current={row.id === currentSessionId}
                  openState={openStateOfSession(row.id)}
                  active={row.id === activeId}
                  menuOpen={row.id === menu?.id}
                  showProject={showProject}
                  t={t}
                  onEnter={onEnter}
                  onToggleRoom={onToggleRoom}
                  onDragPointerDown={onDragPointerDown}
                  onRestore={onRestore}
                  onMenu={onMenu}
                />
              ))}
            </div>
          )}
        </div>
      ))
    }

    /*
     * 四种「屏幕上没有行」。它们不是同一件事,所以不共用一句文案:
     * 搜不到 / 读失败 / 还在读 / 真的一条会话都没有。
     * **一律不回退到 mock** —— 假数据比空更糟。
     */
    if (searching) return <p className={s.noMatch}>{t('expose.noMatchingSessions')}</p>
    if (error) {
      return (
        <div className={s.state}>
          <span className={s.stateTitle}>{t('expose.disconnectedTitle')}</span>
          <span className={s.stateHint}>{t('expose.disconnectedHint', { error })}</span>
        </div>
      )
    }
    // 骨架 / 等待只看 `phase`(律①):从来没有过列表才算「还在读」。
    if (phase === 'initial') {
      return (
        <div className={s.state}>
          <span className={s.stateHint}>{t('expose.loading')}</span>
        </div>
      )
    }
    return (
      <div className={s.state}>
        <span className={s.stateTitle}>{t('expose.emptyTitle')}</span>
        <span className={s.stateHint}>{t('expose.emptyHint')}</span>
      </div>
    )
  }

  return (
    /*
     * `data-testid="expose-overview-scroll"` 留在**滚动容器**上(工作区门按它问
     * 「换空间有没有把这棵树掀了」)—— 行会换、节会换,而这个容器必须是同一个
     * 节点(四律第 4 条:禁整树重挂)。
     */
    <div className={s.scroll} data-testid="expose-overview-scroll">
      {/* `role="tree"` + `tabIndex=0` 正是 APG 的 activedescendant 形:焦点停在
        * 容器上,项由 `aria-activedescendant` 指。键盘由作用域根那条委托接
        * (见 ExposeView),所以这里不挂 onKeyDown —— 一个键只许有一个产地。 */}
      <div
        ref={treeRef}
        className={s.tree}
        role="tree"
        tabIndex={0}
        aria-label={t('item.sessions')}
        aria-activedescendant={activeId ? treeNodeDomId(activeId) : undefined}
        data-testid="expose-tree"
        onPointerOver={onTreePointerOver}
        onPointerLeave={leaveSessionRow}
      >
        {renderBody()}
      </div>
      {menu && (
        <SessionActionsMenu
          sessionId={menu.id}
          title={menu.title}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

/** 菜单头上那一行名字。**取一次**,不订阅 —— 它是弹出那一刻的一张快照。 */
function currentSessionsTitle(sessionId: string): string {
  return useSessionsSource.getState().sessions.find((row) => row.id === sessionId)?.title ?? sessionId
}
