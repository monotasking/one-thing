import type { ReactNode } from 'react'
import s from './Card.module.css'

/**
 * **区块卡骨架**(09-01 批 2a 第 3 件,视觉词汇立件)。
 *
 * ── 立件依据:并集实测 ──────────────────────────────────────────────────
 * providers 详情栏的五处卡(OAuthCard / UsageCard / ProviderDetail 的 .card /
 * ModeCard / CredentialPool)那九行 CSS **逐字相同**;第六处
 * components/ErrorBoundary 只差一格内边距。`ui:consume` 的 `shared-vocab-css`
 * 把 `.card` 记成 7 个产地 —— 这件就是那 7 个产地的收口。
 *
 * ── API 形状:开放内容走 children(09-01 库自审立法)──────────────────
 * 判据是「项里装什么由谁说了算」。卡身里装的是**任意东西**(表单行、读数条、
 * 一张七列表、几颗钮),由消费方说了算 → 走复合 children,不收 `items`/`rows`。
 * `title` / `note` 是**卡自己的檐**,形态封闭(一行标题 + 一格弱色注),
 * 所以它们是 props。两种风格不许混用:这件永远不会长出一个 `sections` 数组。
 *
 * ── 标题层级不定死(titleAs)─────────────────────────────────────────
 * 卡不知道自己挂在文档的第几层。写死 h3 会让某些面出现「h2 底下直接跳 h4」
 * 或者反过来,而**跳级是读屏软件导航时真的会迷路的那一类问题**。
 * 缺省 h3(详情栏里最常见的一档:面标题 h2 → 卡标题 h3),
 * 迁移时各面按原级显式传,不引起无障碍树跳级。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:无订阅 / 无计时器 / 无模块级副作用 → 不需要 HMR dispose;
 *             `title` 与 `note` 都缺席时**整条檐不渲染 DOM**(不是渲染一个空 div ——
 *             空檐会在 column flex 里多吃一个 gap,卡身位置整段下移)。
 *   交互状态:无。**卡不是控件** —— 它没有 hover / focus / disabled。
 *             整张卡可点的那一形(WorkspaceOverview 的工作区卡)是**结构性交互件**,
 *             归 `ui/ButtonBase`,不归这件:一件既是容器又是按钮,
 *             迟早要给它加 `onClick` 再加 `disabled` 再加 hover 配方。
 *   数据状态:pad 两档、bordered 两态、note 两个落点、超长标题截断不换行。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface CardProps {
  title?: ReactNode
  /** 弱色注。落点由 notePlacement 决定(并集里两种落点都真实存在)。 */
  note?: ReactNode
  /**
   * `'inline'`(缺省)= 标题右侧的一个**读数**(UsageCard 的缓存时刻);
   * `'below'` = 标题下方的一**句话**(ProviderDetail 的 .cardNote)。
   * 两者字号与行距不同,因为它们不是同一种东西 —— 见 .module.css。
   */
  notePlacement?: 'inline' | 'below'
  /** 标题的标签名。缺省 h3;迁移时各面保持原级,别让无障碍树跳级。 */
  titleAs?: 'h2' | 'h3' | 'h4'
  /** `'md'`(缺省)= --sp-3,并集里五处的值;`'lg'` = --sp-4,错误卡那一档。 */
  pad?: 'md' | 'lg'
  /** 缺省 true(并集里今天六处全有边线)。 */
  bordered?: boolean
  className?: string
  children?: ReactNode
}

export function Card({
  title,
  note,
  notePlacement = 'inline',
  titleAs: Title = 'h3',
  pad = 'md',
  bordered = true,
  className,
  children,
}: CardProps) {
  const cls = [
    s.card,
    pad === 'lg' ? s.padLg : s.padMd,
    bordered ? s.bordered : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const inlineNote = notePlacement === 'inline' && note != null
  const belowNote = notePlacement === 'below' && note != null

  return (
    <div className={cls}>
      {/* 空槽不渲染 DOM —— 理由见文件头「生命状态」。 */}
      {title == null && !inlineNote ? null : (
        <div className={s.head}>
          {title == null ? null : <Title className={s.title}>{title}</Title>}
          {inlineNote ? <span className={s.note}>{note}</span> : null}
        </div>
      )}
      {belowNote ? <p className={s.noteBelow}>{note}</p> : null}
      {children}
    </div>
  )
}
