import { useCallback, useMemo } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Plus, Search } from '../../components/icons'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
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
import { projectScope, scopeId, scopeSpecOf, visibleScopes } from '../scopes'
import { useExposeStore } from '../store'
import { sessionRowIdsOf } from '../transitions'
import type { ProjectScope } from '../types'
import s from './Toolbar.module.css'

/**
 * 工具栏 —— `[窄档项目选择器] [搜索] [新会话]`(设计 §1.4)。
 *
 * ── 搜索是**过滤器**,不是第四层视图 ─────────────────────────────────────
 * 输入之后屏幕仍是这一套(侧栏 + 工具栏 + 树),变的只有内容:不命中的行消失、
 * 空掉的节消失、命中词高亮、子行命中时父房间自动展开。过滤本身一句都不在这里 ——
 * 它是 `list-model.applyQuery` 那只纯函数(可单测),这块面只递一个词进去。
 *
 * ── 搜索框是这块面作用域的**落点**,但落点的声明不在这里 ─────────────────
 * 「焦点进这块面时落在哪儿」是作用域的声明(`restingTarget`,住在 ExposeView),
 * 搜索条只是它此刻的那个元素 —— 所以这里只负责给它挂一枚**取件口**
 * `data-expose-search`,由那一句声明按它取人(与 `viewer/JumpBar` 的
 * `restingTarget = () => root.querySelector('input')` 同一判例:不为了一个落点
 * 去改库件 `ui/Input` 的 props 形状)。
 *
 * ── 键的交接(三条,逐字沿用卡片时代的口径)─────────────────────────────
 *  · ↓ / ↑ = 把键盘交给树(`focusGrid()` 点亮锚点 + `activate()` 把焦点挪出
 *    输入框),**只点亮不走步**(现有用例逐字钉着);
 *  · ↵ = 进「屏幕上第一行」—— 看到什么就进什么,没有第二套命中排序;
 *  · ← / → **不接**:在一个还在编辑的输入框里它们是移光标,那是文本编辑的基本盘。
 * 键名判据一处产地:`expose/keys.ts` 的 `exposeIntentOf`(所以这个文件里
 * 一个 'ArrowDown' 字面量都没有 —— 设计 §3.2 那道禁令)。
 */
export function Toolbar() {
  const t = useT()
  const query = useExposeStore((st) => st.query)
  const scope = useExposeStore((st) => st.scope)
  const sessions = useSessionsSource((st) => st.sessions)
  const { activate } = useFocusScope()
  /*
   * 建会话正在飞吗 —— **逐格**读数(键 = CREATE_KEY),不是整面的忙布尔(病型 B)。
   * 卡片时代它长在组头那颗 `+` 上,现在搬到工具栏这颗「新会话」上,语义一个字不变。
   */
  const creating = useAsyncPending(sessionMutation, CREATE_KEY)

  /** 窄档选择器的选项 = 与侧栏**同一张表**(固定档 + 项目),不另起一份口径。 */
  const options = useMemo(() => {
    const fixed = visibleScopes(sessions).map((item) => ({
      value: scopeId(item),
      label: t(scopeSpecOf(item).labelKey),
    }))
    const projects = buildProjects(sessions).map((project) => ({
      value: scopeId(projectScope(project.id)),
      label: project.name,
    }))
    return [...fixed, ...projects]
  }, [sessions, t])

  /** 选择器交回来的是 `scopeId` 的字面,这里翻回一格 `ProjectScope`。 */
  const onPick = useCallback((value: string) => {
    const next: ProjectScope = value.startsWith('project:')
      ? projectScope(value.slice('project:'.length))
      : ({ kind: value } as ProjectScope)
    useExposeStore.getState().setScope(next)
  }, [])

  /*
   * 「新会话」建在哪个项目下:`project` 范围建到该项目,其余范围建无项目会话
   * (设计 §1.4)。协作范围里建出来的是一条普通会话 —— 建房要 `kind:'room'`
   * 加一份成员名册,那是一次独立的入口设计,按旧例不动(§7 留账)。
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

  const newLabel = t('expose.newSession')

  return (
    <div className={s.toolbar} data-testid="expose-toolbar">
      {/*
       * 窄档(容器 < 760)的项目选择器。**常驻 DOM、由容器查询决定显不显**:
       * 宽档 `display: none` 把它一并移出无障碍树,所以同一时刻只有一个范围控件
       * 被读屏读到(宽档是侧栏那只 listbox)。
       */}
      <Select
        className={s.scopePick}
        size="sm"
        label={t('expose.scopeLabel')}
        options={options}
        value={scopeId(scope)}
        onChange={onPick}
      />

      <Input
        className={s.search}
        data-expose-search=""
        size="sm"
        value={query}
        onValueChange={(value) => useExposeStore.getState().setQuery(value)}
        onKeyDown={onSearchKey}
        prefix={<Search className={s.searchIcon} strokeWidth={1.75} aria-hidden="true" />}
        placeholder={t('expose.searchPlaceholder')}
        aria-label={t('expose.searchLabel')}
      />

      {/*
       * 律③:反馈长在**发起它的那个控件**上,而且只上无障碍语义(`aria-busy`)——
       * 零新像素。**不用 `disabled`**:「在飞」不是「不可用」,禁灰会把它从焦点序
       * 里摘掉,键盘走到一半的人当场丢焦点。
       *
       * 宽 / 窄两颗是同一件事的两种形(< 480 缩成图标钮,设计 §1.5),
       * 逻辑只有一份(`onNew` / `creating`),另一颗永远 `display: none`
       * —— 所以任何一刻焦点序里只有一颗。
       */}
      <Button
        variant="ghost"
        pill
        className={s.newWide}
        data-testid="expose-new-session"
        aria-busy={creating || undefined}
        onClick={onNew}
      >
        <Plus className={s.newIcon} strokeWidth={1.75} aria-hidden="true" />
        {newLabel}
      </Button>
      <IconButton
        icon={Plus}
        label={newLabel}
        className={s.newNarrow}
        testId="expose-new-session-narrow"
        aria-busy={creating || undefined}
        onClick={onNew}
      />
    </div>
  )
}
