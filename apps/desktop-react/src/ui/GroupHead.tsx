import type { ReactNode } from 'react'
import { ButtonBase } from './ButtonBase'
import s from './GroupHead.module.css'

/**
 * **列表分组头**(09-01 批 2a 第 2 件,视觉词汇立件)。
 *
 * ── 两形一件,判据是「给不给 onToggle」──────────────────────────────────
 *   不给 → 静态组头(一个 <div>,纯结构标签,不进 Tab 序);
 *   给了 → 可折叠组头(消费 `ui/ButtonBase` —— 裸钮三类判的第③类:
 *          结构性交互件,视觉本该定制、但**不许裸着**),带 caret 与 `aria-expanded`。
 * 合成一件而不是两件,是因为同一条列表里两形会交替出现(ModelCatalog 里
 * 「已选置顶」那条是静态、每个厂牌那条可折叠)——两件组件必然长成两个样子,
 * 而它们本来就该是同一种东西。
 *
 * `role` 不收:静态形就是一个 <div>,**保持极简**。真要把它变成
 * `role="presentation"` 之类,那是消费面对自己那棵可访问性树的裁定,
 * 等真有那一格再开口子(开放式 props 透传会让这件立刻长出第二种形态)。
 *
 * ── 计数禁令 ────────────────────────────────────────────────────────────
 * `note` 是**右侧弱色文字读数**(「12 个模型」「上次 3 分钟前」),
 * **不是徽**。本仓禁令原文:tab / 列表 / 组头不挂计数徽;文字读数可以。
 * 所以这里没有 `count` prop,也永远不该有 —— 想挂徽的人得先去推翻那条禁令。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose;
 *             `note` 缺席时**那一格连 DOM 都不渲染**(不是渲染一个空 span ——
 *             空壳会在 flex 行里占掉一个 gap,组名的截断点就跟着漂)。
 *   交互状态:静态形无交互;可折叠形 rest / hover / focus(全局 :focus-visible 环)/
 *             disabled(见 .module.css 的 :disabled)。键盘由原生 <button> 白送:
 *             Space / ↵ 都触发 onClick,不需要一行手写。
 *   数据状态:collapsed 开合两态(caret 与 aria-expanded 同源翻转)、
 *             note 超长截断不换行(挤压纪律:结构行只截断)。
 * ──────────────────────────────────────────────────────────────────────
 */
interface GroupHeadBase {
  label: ReactNode
  /** 右侧弱色读数。文字,不是徽(见文件头「计数禁令」)。 */
  note?: ReactNode
  /** 落点自己的皮肤:sticky、底色、边线归消费方给(理由见 .module.css 头)。 */
  className?: string
}

interface StaticGroupHead extends GroupHeadBase {
  onToggle?: never
  collapsed?: never
  disabled?: never
}

interface CollapsibleGroupHead extends GroupHeadBase {
  onToggle: () => void
  /** 受控:这件自己不记开合,只画出被告知的那一态。 */
  collapsed: boolean
  /**
   * 钮禁点、但组名照旧看得见。判例:检索时组由判据打开,那一刻点它不该关上。
   */
  disabled?: boolean
}

export type GroupHeadProps = StaticGroupHead | CollapsibleGroupHead

export function GroupHead(props: GroupHeadProps) {
  const { label, note, className } = props
  const cls = [s.head, className ?? ''].filter(Boolean).join(' ')

  const body = (
    <>
      {props.onToggle && (
        <span className={s.caret} aria-hidden="true">
          {props.collapsed ? '▸' : '▾'}
        </span>
      )}
      <span className={s.label}>{label}</span>
      {/* 空槽不渲染 DOM(不是渲染一个空壳)—— 理由见文件头「生命状态」。 */}
      {note == null ? null : <span className={s.note}>{note}</span>}
    </>
  )

  if (!props.onToggle) return <div className={cls}>{body}</div>

  return (
    <ButtonBase
      className={cls}
      aria-expanded={!props.collapsed}
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      {body}
    </ButtonBase>
  )
}
