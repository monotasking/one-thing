import { useCallback, useEffect, useMemo, type RefObject } from 'react'
import { useT } from '../../i18n'
import { useSessionsList, useSessionsSource } from '../../data/sessions-source'
import { buildListModel } from '../list-model'
import { projectNameOf } from '../projection'
import { useExposeStore } from '../store'
import { togglePinAndAnnounce } from './pin-announce'
import { SectionHead } from './SectionHead'
import { SessionRow } from './SessionRow'
import { useSessionTime } from './session-time'
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
 * ── 分节:`role="group" aria-labelledby=<节头 id>` ───────────────────────
 * 节头是 `<h3>`(SectionHead),粘顶、无底、无计数、不可折叠。
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
   * `now` 在**记忆体里**取一次,不在渲染体里现取:后者每渲染一帧换一个数,
   * useMemo 当场作废,而且同一屏里两行会因为差了几毫秒落进不同的日子。
   * 落桶随「会话表 / 范围 / 词 / 展开集」任何一格变化重算 —— 跨过午夜那一刻
   * 由下一次列表变动带过去(整点重排不是本批的事,没有定时器)。
   */
  const model = useMemo(
    () => buildListModel({ sessions, scope, query, expandedRooms, now: Date.now() }),
    [sessions, scope, query, expandedRooms],
  )

  /*
   * 四只**身份恒定**的回调(见 SessionRow 文件头那段病历):动作走 `getState()`
   * (store 的动作引用本来就稳定,不必进依赖表),id 由行自己交回来。
   */
  const onEnter = useCallback(
    (sessionId: string) => useExposeStore.getState().enterSession(sessionId),
    [],
  )
  const onPeek = useCallback(
    (sessionId: string) => useExposeStore.getState().openQuickLook(sessionId),
    [],
  )
  const onToggleRoom = useCallback(
    (sessionId: string) => useExposeStore.getState().toggleRoom(sessionId),
    [],
  )
  // 置顶两个入口(图钉 / ⌘⇧P)共用同一件,播报也就只有一个产地(见 pin-announce)。
  const onTogglePin = useCallback((sessionId: string) => togglePinAndAnnounce(sessionId), [])

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
    document.getElementById(`expose-row-${activeId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  function renderBody() {
    if (model.sections.length > 0) {
      return model.sections.map((section) => (
        <section
          key={section.id}
          className={s.section}
          role="group"
          aria-labelledby={`expose-section-${section.id}`}
        >
          <SectionHead id={section.id} label={section.label} />
          {section.rows.map((row) => (
            <SessionRow
              key={row.id}
              id={row.id}
              title={row.session.title}
              kind={row.session.kind}
              isPinned={row.session.isPinned}
              projectName={showProject ? projectNames(row.session.projectId) : null}
              time={timeOf(row.session.updatedAt)}
              query={query}
              depth={row.depth}
              expandable={row.expandable}
              expanded={row.expanded}
              current={row.id === currentSessionId}
              active={row.id === activeId}
              showProject={showProject}
              t={t}
              onEnter={onEnter}
              onPeek={onPeek}
              onTogglePin={onTogglePin}
              onToggleRoom={onToggleRoom}
            />
          ))}
        </section>
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
        aria-activedescendant={activeId ? `expose-row-${activeId}` : undefined}
        data-testid="expose-tree"
      >
        {renderBody()}
      </div>
    </div>
  )
}
