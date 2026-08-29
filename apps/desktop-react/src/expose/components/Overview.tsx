import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { ChevronDown, ChevronRight, Plus, Search } from '../../components/icons'
import { Button } from '../../ui/Button'
import { plural, useT } from '../../i18n'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../store'
import { columnsFromTemplate, filterGroups, isCollapsed } from '../transitions'
import { Highlight } from './Highlight'
import { SessionCard } from './SessionCard'
import s from './Overview.module.css'

/**
 * ── F 批:搜索是过滤器,不是第四层视图 ────────────────────────────────────
 * 输入搜索词之后屏幕**仍是这一套**:项目头 + 会话卡网格,和默认打开时逐像素相同。
 * 变的只有内容 —— 不命中的卡消失、变空的组消失、命中词在卡与组头上高亮。
 *
 * 所以这个组件里**一次 filter 都没有**:过滤是 `expose/transitions.ts` 的
 * `filterGroups`(纯函数,可单测),这里只是把它的结果画出来。同一个纯函数也被
 * `visibleCardIds` 用着,于是「屏幕上有哪些卡」与「方向键 / Quick Look 走哪些卡」
 * 天生是同一份事实,不会漂移。
 *
 * 退役的是 `SearchResults`(三层缩进的命中列表)—— 它是「搜索换一种呈现」那条路
 * 的全部实现,连同它的 CSS 与 `SearchHit` 形状一起删了。
 */
interface Props {
  /**
   * 这块面被摆出来了吗(ExposeView 算好递进来的同一份事实)。
   * 只有真的摆出来才抢焦点 —— Dock 悬停预览泡里也渲染一份 Overview,
   * 那一份 placed 恒为假:看一眼不该把光标从别处夺走。
   */
  placed?: boolean
}

/**
 * 「一行几张」的产地:**读 CSS 的计算值**,不在 JS 里重算一遍 auto-fill 的公式。
 * 两份公式就是两份真相,迟早对不上;这里只做「量一眼再报进状态机」。
 *
 * 量的时机 = 容器尺寸变了(ResizeObserver)+ 组数变了(网格可能刚出现 / 刚消失)。
 * jsdom 没有 ResizeObserver、getComputedStyle 也算不出网格轨道,
 * 所以两处都是「量不到就不动状态」—— 单测里列数保持出厂值,不会被环境噪声改写。
 */
function useGridColumns(
  hostRef: RefObject<HTMLElement | null>,
  report: (columns: number) => void,
  groupCount: number,
) {
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => {
      const grid = host.querySelector<HTMLElement>('[data-grid]')
      if (!grid) return
      const columns = columnsFromTemplate(getComputedStyle(grid).gridTemplateColumns)
      if (columns !== null) report(columns)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [hostRef, report, groupCount])
}

export function Overview({ placed = false }: Props) {
  const t = useT()
  const state = useExposeStore()
  const allGroups = useSessionsSource((st) => st.groups)
  const status = useSessionsSource((st) => st.status)
  const error = useSessionsSource((st) => st.error)
  const inputRef = useRef<HTMLInputElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const query = state.query
  const searching = query.trim().length > 0

  const groups = useMemo(() => filterGroups(allGroups, query), [allGroups, query])

  useGridColumns(innerRef, state.setColumns, groups.length)

  /*
   * 摆出来的那一刻,键盘归这块面 —— 焦点落进搜索条。
   * 在此之前它归 Dock 上那块瓦(点开面板的那个按钮),于是「刚开完面板按一下空格」
   * 会再次触发那颗按钮、把面板关掉:那是 08-30 用户报的键盘死区的另一半。
   * 依赖是 placed 这个布尔量而不是挂载:舞台 ⇄ 浮窗 ⇄ 架子搬家时它不变,不会重复抢焦点。
   */
  useEffect(() => {
    if (placed) inputRef.current?.focus()
  }, [placed])

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    /*
     * ↑↓ = 把键盘交给卡网格(词留着、输入框失焦),之后方向键 / 空格 / 回车
     * 就都是总览那一套了。这是命令面板的通行手势(搜索条在上、结果在下)。
     *
     * ←→ **故意不接**:它们在一个还在编辑的输入框里是移光标,是文本编辑的基本盘;
     * 为了「网格是二维的」把它抢走,代价是搜索条里没法改词。所以口径定成:
     * 纵向交接、横向留给光标 —— 交接之后焦点在网格上,四个方向才一起归导航。
     */
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      state.focusGrid()
      inputRef.current?.blur()
      return
    }
    if (e.key !== 'Enter') return
    // 回车 = 进入**屏幕上第一张卡**。它就是过滤后的阅读次序的头一个,
    // 不再有第二套「命中排序」—— 看到什么,回车就进什么。
    const first = groups.find((g) => !isCollapsed(state, g.id))?.sessions[0]
    if (first) {
      e.preventDefault()
      state.enterSession(first.id)
    }
  }

  /**
   * 分组区的四种「没有卡」。它们不是同一件事,所以不共用一句文案:
   * 搜不到 / 还在读 / 读失败(浏览器直开或 core 没起来)/ 真的一条会话都没有。
   * **一律不回退到 mock** —— 假数据比空更糟。
   */
  function renderGroups() {
    if (groups.length > 0) {
      return groups.map((group) => {
        const collapsed = isCollapsed(state, group.id)
        // 组名 / 副名两种来源:合成组给 key(界面文案),项目组给数据。
        const name = group.nameKey ? t(group.nameKey) : group.name
        const path = group.pathKey ? t(group.pathKey) : group.path
        const Caret = collapsed ? ChevronRight : ChevronDown

        /*
         * 折叠 / 展开是**原地形变**:组头这一行(以及它里面的开关按钮)在两态里
         * 是同一个 DOM 节点、同一个位置、同一个高度,只有下面的卡片区在条件渲染。
         * 组的次序永远只由数据源决定,不因为谁被折叠而重排 ——
         * 这两条合起来才保证「鼠标不动连点 N 次 = 精确切换 N 次」。
         */
        return (
          <section key={group.id} className={s.group}>
            <header className={s.groupHead}>
              <button
                type="button"
                className={s.groupToggle}
                data-testid={`group-toggle-${group.id}`}
                aria-expanded={!collapsed}
                onClick={() => state.toggleGroupCollapsed(group.id)}
              >
                <Caret className={s.caret} strokeWidth={1.75} aria-hidden="true" />
                {/* 组名也高亮:项目名命中时整组保留,不高亮就看不出这一组为什么还在。 */}
                <span className={s.groupName}>
                  <Highlight text={name ?? group.id} query={query} />
                </span>
                <span className={s.groupPath}>{path}</span>
              </button>
              <button
                type="button"
                className={s.count}
                onClick={() => state.enterList(group.id)}
              >
                {t(
                  plural(group.sessions.length, 'expose.sessionCountOne', 'expose.sessionCount'),
                  { count: group.sessions.length },
                )}
              </button>
              <Button
                variant="ghost"
                pill
                iconOnly
                className={s.plus}
                aria-label={t('expose.newSessionIn', { name: name ?? group.id })}
              >
                <Plus className={s.plusIcon} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </header>

            {/*
              折叠 = 高度过渡而非瞬跳(用户 08-28 实机反馈:卡区瞬间消失、下方组咣当上移,变化不连续)。
              grid-template-rows 1fr→0fr 技法:卡区保持挂载,收合时下方内容连续滑上来;
              inert 把折叠态的卡从焦点序/命中区里摘掉(视觉隐藏 ≠ 可交互)。
            */}
            <div className={collapsed ? `${s.body} ${s.bodyClosed}` : s.body} inert={collapsed || undefined}>
              <div className={s.bodyInner}>
                <div className={s.grid} data-grid>
                  {group.sessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      query={query}
                      current={session.id === state.currentSessionId}
                      focused={state.focusVisible && session.id === state.focusId}
                      onEnter={() => state.enterSession(session.id)}
                      onQuickLook={() => state.openQuickLook(session.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>
        )
      })
    }

    /*
     * 搜不到 ≠ 没有会话:这里有会话,只是没有一条配得上这个词。
     * 一行灰字就够 —— 插画会把「我打错了一个字」演成一场事故。
     */
    if (searching) {
      return <p className={s.noMatch}>{t('expose.noMatchingSessions')}</p>
    }

    if (status === 'error') {
      return (
        <div className={s.state}>
          <span className={s.stateTitle}>{t('expose.disconnectedTitle')}</span>
          <span className={s.stateHint}>
            {t('expose.disconnectedHint', { error: error ?? '' })}
          </span>
        </div>
      )
    }
    if (status === 'idle' || status === 'loading') {
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
    <div className={s.overview}>
      <header className={s.top}>
        <div className={s.searchWrap}>
          <Search className={s.searchIcon} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            className={s.search}
            value={state.query}
            onChange={(e) => state.setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t('expose.searchPlaceholder')}
            aria-label={t('expose.searchLabel')}
          />
        </div>
        <Button variant="ghost" pill className={s.newProject}>
          <Plus className={s.newIcon} strokeWidth={1.75} aria-hidden="true" />
          {t('expose.newProject')}
        </Button>
      </header>

      <div className={s.scroll}>
        <div className={s.inner} ref={innerRef}>{renderGroups()}</div>
      </div>
    </div>
  )
}
