import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
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
 * ── 透传口子:落点自己的身份,不是样式旁路(09-01 批 2c)────────────────
 * 两形都把剩下的 HTML 属性原样摊到自己的根元素上(静态形 → `<div>`,
 * 可折叠形 → `ui/ButtonBase`,后者本来就透传 `ButtonHTMLAttributes`);
 * 照 `ui/Button` 的既有先例。它开的是**落点自己的 `data-testid` / `role` /
 * `aria-*`** —— 「这条组头在测试里叫什么」「它在这棵可访问性树里是什么角色」
 * 都是消费面的裁定,不该一条一条变成这件的 prop
 *(此前这里写的是「`role` 不收」,批 2c 收编模型目录时它成了真需求:
 * 那两条组头带着 `data-testid`,而测试正是等价迁移的证词)。
 * **样式仍然只走 `className` 皮肤**:透传不是 `style={{…}}` 的口子 ——
 * 配方产地重新被打散成每面一份,正是立这件要治的病。
 *
 * 三个不透传的键,各有理由:`children`(这件的身子由 label / note / caret
 * 三格拼出来,收了 children 只会被静默丢掉)、`onClick` 与 `type`
 *(开合的入口只有 `onToggle` 一个;`type='button'` 是 ButtonBase 的默认档,
 * 换成 submit 会让「展开这一组」顺手提交整张表)。
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
 *             disabled —— **禁着不淡化**,只换指针(09-01 批 2c 规范修正,
 *             理由见 .module.css 的 :disabled)。键盘由原生 <button> 白送:
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

/** 静态形的根是一个 `<div>`;`children` 不收(理由见文件头「透传口子」)。 */
interface StaticGroupHead extends GroupHeadBase, Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  onToggle?: never
  collapsed?: never
  disabled?: never
}

/** 可折叠形的根是 `ui/ButtonBase`;`children` / `onClick` / `type` 不收。 */
interface CollapsibleGroupHead
  extends GroupHeadBase,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'type'> {
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

  if (!props.onToggle) {
    // 三个自己的槽解构走,剩下的就是落点的身份(data-testid / role / aria-*)。
    // `className` 显式在前且已不在 rest 里 —— 透传盖不掉算好的皮肤。
    const {
      label: _label,
      note: _note,
      className: _cls,
      onToggle: _t,
      collapsed: _c,
      disabled: _d,
      ...rest
    } = props
    return (
      <div className={cls} {...rest}>
        {body}
      </div>
    )
  }

  const {
    label: _label,
    note: _note,
    className: _cls,
    collapsed,
    disabled,
    onToggle,
    ...rest
  } = props
  return (
    <ButtonBase
      className={cls}
      {...rest}
      aria-expanded={!collapsed}
      disabled={disabled}
      onClick={onToggle}
    >
      {body}
    </ButtonBase>
  )
}
