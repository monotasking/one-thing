import { useCallback, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { resolveIcon } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { useRoving } from '../../ui/a11y/roving'
import { useT } from '../../i18n'
import { useSessionsSource } from '../../data/sessions-source'
import { buildProjects } from '../projection'
import {
  projectScope,
  sameScope,
  scopeId,
  scopeSpecOf,
  visibleScopes,
} from '../scopes'
import { useExposeStore } from '../store'
import { useContentDrag } from '../../workbench/useContentDrag'
import { filesRootRef } from '../../content/kinds/files-root-ref'
import type { ProjectScope } from '../types'
import s from './Rail.module.css'

/**
 * 侧栏 —— **范围**的唯一选择面(设计 §1.3)。
 *
 * ── 它为什么读表而不写分支 ────────────────────────────────────────────────
 * 「有哪几档范围」的产地是 `expose/scopes.ts` 的 `SCOPE_SPECS`(能力自述),
 * 「有哪些项目」的产地是 `projection.buildProjects`。这只组件里**不出现任何
 * 范围名**:加一档「归档」= 表里加一行 + i18n 一对,这个文件一个字不用改
 * (设计 §6 陌生能力演练第一条)。
 *
 * ── 无障碍:一个 Tab 位,不是 N 个按钮 ───────────────────────────────────
 * `role="listbox"` + 项 `role="option"`,走 `ui/a11y/roving`(axis vertical、loop)。
 * 焦点**真的落在项上**(这一族的当前项就是 `document.activeElement`,压根没有
 * 第二个下标可被污染),所以是 roving 而不是 list-selection —— 判据写在
 * CLAUDE.md「hover ≠ active」那条的末尾。
 *
 * roving 在容器上挂一条 keydown:那是 I2 的**唯一例外**(容器级、只接结构键、
 * 只在作用域内部移动),理由写在 `ui/a11y/roving.ts` 自己的命中处。它消费掉的
 * 那一下会 `preventDefault()`,所以 `ExposeView` 根上那条委托看见
 * `defaultPrevented` 就让开 —— 侧栏里按 ↓ 不会顺手把树的活动行也挪一格。
 *
 * ── 侧栏项不带数字(08-30 计数禁令)────────────────────────────────────────
 * 也不做「新建项目…」:目录选择流在 React 壳没有产地,死按钮不搬进新壳(§1.3 留账)。
 */
interface RailItem {
  key: string
  scope: ProjectScope
  label: string
  icon: string
  /**
   * 这一档拖出去是什么(W3 裁定 6:项目一行 → `files-root:<path>`)。
   * **固定那几档没有**(「全部」「协作」「无项目」不是一个目录,拖不出东西),
   * 所以这一格是可选的 —— 它同时就是「这一行能不能拖」的判据,没有第二个布尔。
   */
  dragPath?: string
}

export function Rail() {
  const t = useT()
  const sessions = useSessionsSource((st) => st.sessions)
  const scope = useExposeStore((st) => st.scope)
  const ref = useRef<HTMLDivElement>(null)
  useRoving(ref, { axis: 'vertical', loop: true })

  /** 固定档(全部 / 协作 / 无项目;后两档只在非空时出现,判据在 `visibleScopes`)。 */
  const fixed = useMemo<RailItem[]>(
    () =>
      visibleScopes(sessions).map((item) => {
        const spec = scopeSpecOf(item)
        return { key: scopeId(item), scope: item, label: t(spec.labelKey), icon: spec.icon }
      }),
    [sessions, t],
  )

  /** 项目档:名字与顺序都由 `buildProjects` 说了算(按组内最新活动倒序)。 */
  const projects = useMemo<RailItem[]>(() => {
    const icon = scopeSpecOf({ kind: 'project', projectId: '' }).icon
    return buildProjects(sessions).map((project) => {
      const item = projectScope(project.id)
      return { key: scopeId(item), scope: item, label: project.name, icon, dragPath: project.path }
    })
  }, [sessions])

  /*
   * **一个项目拖出去 = 以它的目录为根的一棵文件树**(W3,设计 §3.1 第三行)。
   *
   * 与文件树行逐字同型:按下时记一格路径、起拖时读它(`useContentDrag` 的
   * `ref()` 无参 —— 它不认识侧栏)。**行不离开侧栏**(树 / 面常驻铁律的拖拽版),
   * 而没过阈值的一次按下松开仍旧是一次普通点击(切范围),所以这一格不改
   * 侧栏原有的任何行为。
   */
  const dragPath = useRef<string | null>(null)
  const startDrag = useContentDrag({
    ref: () => (dragPath.current ? filesRootRef(dragPath.current) : null),
  })
  const onItemPointerDown = useCallback(
    (item: RailItem, e: ReactPointerEvent<HTMLElement>) => {
      if (!item.dragPath) return
      dragPath.current = item.dragPath
      startDrag(e)
    },
    [startDrag],
  )

  const renderItem = (item: RailItem) => {
    const selected = sameScope(scope, item.scope)
    const Icon = resolveIcon(item.icon)
    return (
      /* 结构性交互件(裸钮三类判第③类)→ `ui/ButtonBase` 只清 UA,皮肤在本文件。 */
      <ButtonBase
        key={item.key}
        role="option"
        aria-selected={selected}
        data-roving-item=""
        tabIndex={selected ? 0 : -1}
        data-testid={`expose-scope-${item.key}`}
        className={selected ? `${s.item} ${s.on}` : s.item}
        onClick={() => useExposeStore.getState().setScope(item.scope)}
        onPointerDown={(e) => onItemPointerDown(item, e)}
      >
        <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.label}>{item.label}</span>
      </ButtonBase>
    )
  }

  return (
    <div
      ref={ref}
      className={s.rail}
      role="listbox"
      aria-label={t('expose.scopeLabel')}
      data-testid="expose-rail"
    >
      {fixed.map(renderItem)}
      {/* 固定档与项目之间一条发丝线。它不是一个 option,所以对读屏是 presentation。 */}
      {projects.length > 0 && <div className={s.sep} role="presentation" />}
      {projects.map(renderItem)}
    </div>
  )
}
