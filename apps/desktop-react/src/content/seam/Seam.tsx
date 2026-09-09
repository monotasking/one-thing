import type { HTMLAttributes, ReactNode } from 'react'
import { ChevronDown } from '../../components/icons'
import { FoldBody, FoldFoot, FoldTrigger } from '../../ui/Fold'
import s from './Seam.module.css'

/**
 * **折痕基座**(09-09 立件,起因:上下文更新那一行按用户裁定改成折痕形态之后,
 * 压缩折痕与它是同一种东西的两个实例 —— 再抄一份线与标签就是「各写各的」的
 * 下一个案发现场,与 `ui/Fold` 立件时的判据逐字相同)。
 *
 * ── 折痕是什么 ──────────────────────────────────────────────────────────
 * **系统在两回合之间做的一件事**,画成一条贯穿整行的细线 + 一枚居中的标签。
 * 它不是一件物件(卡是「多了一件东西」),也不是谁说的话 —— 消息流里的气泡都是
 * 「谁说了什么」,而折痕说的是「这中间发生过一件不属于任何人的事」。
 * 今天两个实例:压缩(`content/CompactSeam.tsx`)与上下文更新
 * (`content/ContextDeltaSeam.tsx`)。
 *
 * ── 它住 content/ 不住 ui/ ──────────────────────────────────────────────
 * 判据是「离开这块纸还讲不讲得通」:按钮、菜单、浮层在任何一块面上都讲得通,
 * 折痕离开消息流没有意义。所以它是 content 级基座,不进组件库。
 *
 * ── 状态词是通用的 ──────────────────────────────────────────────────────
 * `data-state` 三档,**说的是这道折痕自己**:
 *  · `running`  —— 正在发生(光扫 + `--seam-fill` 按比例填色,填色只在这一档有意义);
 *  · `settled`  —— 已经落定(实线);
 *  · `danger`   —— 出事了(线与标签一同换成 danger 的色调)。
 * 压缩折痕把 compacting / completed / failed 映射过来,上下文更新折痕恒 `settled`。
 * **基座里不出现任何一种折痕的名字** —— 第三种折痕进来时,这两个文件一行不改。
 *
 * ── API 形状:复合 children,不收表 ─────────────────────────────────────
 * 判据是 09-01 库自审那条:**项里装什么由消费方决定 → 复合 children**
 * (与 `ui/Menu` 族、`ui/Fold` 同一条)。折痕的中间那一枚标签在压缩上是
 * 「已压缩 42 条 · 701k → 96k」+ 展开摘要,在上下文更新上是
 * 「上下文更新 · 变量 2」+ 展开逐块表 —— 没有一张表说得出这两者。
 *
 * ── 折叠只有一种写法 ────────────────────────────────────────────────────
 * 要折叠时消费方在外面包一层 `ui/Fold`,标签写 `<SeamLabel fold>` —— 触发器的
 * 身份(role/tabIndex/aria-expanded/aria-controls)与那枚 chevron 都由这里给,
 * **消费方拿不到、也不需要拿到折痕的类名**。反面写法是把 `.seamLabel` 的 class
 * 交出去让消费方自己指到 `FoldTrigger` 上:那等于同一件事有「组件」与「类名」
 * 两套 API,而类名那一套没有类型、没有默认值、忘了拼就静默走形。
 *
 * ── 三张状态表(库件规格)──────────────────────────────────────────────
 * ① 生命周期:一族纯展示件,零 state / 零订阅 / 零计时器 / 零模块级副作用
 *    → **不需要 HMR dispose**。折叠那一半的寿命归 `ui/Fold`。
 * ② UI 生命状态:不取数,没有 empty / loading / error;**超量**两处 —— 标签一行
 *    只截断不换行(结构行),正文多长归消费方(`SeamBody` 只给盒子)。
 * ③ UI 交互状态:`SeamLabel` 不折叠时只有 rest(它不是钮);`fold` 时
 *    rest / hover(`--st-hover`)/ focus(全局环)/ 展开。`SeamFoot` 同。
 *    没有 disabled 档 —— 折痕是一件已经发生的事,不存在「此刻不能看」。
 */

/** 这道折痕自己在什么档上。**通用词** —— 见文件头。 */
export type SeamState = 'running' | 'settled' | 'danger'

export interface SeamProps extends HTMLAttributes<HTMLDivElement> {
  'data-state': SeamState
  children?: ReactNode
}

/**
 * 折痕的根:三列 grid + 那一格状态。
 *
 * `data-prose="object"` **自带**:折痕按物件档留白(与错误卡同一档,节奏表在
 * `content/ChatStream.module.css`)—— 它上下都该有一口气,而不是像一段字那样贴着。
 * 这是折痕这种形态的属性,不是每个消费方各记一次的事。
 *
 * `style` 原样透传,`--seam-fill`(k/N 的比值)就从那里进来:自定义属性的值是
 * 算出来的比值,不是字面量(Token 纪律管的是写死的量)。
 */
export function Seam({ className, children, ...rest }: SeamProps) {
  return (
    <div className={className ? `${s.seam} ${className}` : s.seam} data-prose="object" {...rest}>
      {children}
    </div>
  )
}

/** 线。一道折痕有两条(标签左右各一),右边那条的光束错开半程 —— 那在 CSS 里。 */
export function SeamLine() {
  return <span className={s.seamLine} />
}

export interface SeamLabelProps extends HTMLAttributes<HTMLElement> {
  /**
   * 缺省 `span`。理由与 `ui/Fold` 的 `as` 同源:折痕住在消息流的 flex 列里,
   * 标签常与别的行内物同段;需要块级时消费方自己说。
   */
  as?: 'span' | 'div'
  /**
   * 这枚标签是不是折叠的把手。`true` 时它是 `ui/Fold` 的 `FoldTrigger`,尾巴上
   * 自带一枚 chevron(展开态自己转 180°)。外面必须有一层 `<Fold>`,否则 Fold 自己
   * 会抛 —— 那正是它该抛的地方,不在这里补第二份判据。
   */
  fold?: boolean
}

/**
 * 居中那一枚标签。
 *
 * danger 档的色调**不经这里** —— 它由根上的 `data-state` 说了算(CSS 里一条后代
 * 选择器),消费方不需要记得多拼一个 class。
 */
export function SeamLabel({ as = 'span', fold = false, children, ...rest }: SeamLabelProps) {
  if (fold) {
    return (
      <FoldTrigger as={as} className={`${s.seamLabel} ${s.seamLabelFold}`} {...rest}>
        {children}
        <ChevronDown className={s.seamChevron} strokeWidth={1.9} aria-hidden="true" />
      </FoldTrigger>
    )
  }
  const Tag = as
  return (
    <Tag className={s.seamLabel} {...rest}>
      {children}
    </Tag>
  )
}

/** 标签里那几格数字(k/N、前后读数):tabular-nums,换位时不推着前面那句话动。 */
export function SeamCount({ children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={s.seamCount} {...rest}>
      {children}
    </span>
  )
}

/** 整行宽的那一句(失败原话之类),居中、原样、不重排。 */
export function SeamSentence({ children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={s.seamSentence} {...rest}>
      {children}
    </span>
  )
}

export interface SeamBodyProps extends HTMLAttributes<HTMLElement> {
  className?: string
}

/**
 * 线下面那个盒子(`ui/Fold` 的 body 皮肤)。**只给盒子** —— 里面装什么、怎么排,
 * 归消费方(压缩折痕装块渲染的摘要,上下文更新折痕装逐块表)。
 */
export function SeamBody({ className, children, ...rest }: SeamBodyProps) {
  return (
    <FoldBody className={className ? `${s.seamBody} ${className}` : s.seamBody} {...rest}>
      {children}
    </FoldBody>
  )
}

export interface SeamFootProps extends HTMLAttributes<HTMLElement> {
  as?: 'span' | 'div'
}

/**
 * 底把手(`ui/Fold` 的 foot 皮肤)。正文往往几屏长,读到底还得滚回顶上那枚标签
 * 才能收 —— 这颗只在展开态出场,按下合上并把标签送回视野(行为全在 `ui/Fold`,
 * 这里只有皮肤 + 那枚朝上的 chevron)。
 */
export function SeamFoot({ as = 'span', children, ...rest }: SeamFootProps) {
  return (
    <FoldFoot as={as} className={s.seamFoot} {...rest}>
      <ChevronDown className={s.seamFootChevron} strokeWidth={1.9} aria-hidden="true" />
      {children}
    </FoldFoot>
  )
}
