import type { ReactNode } from 'react'
import { Button } from './Button'
import { Spinner } from './Spinner'
import s from './InlineEditStrip.module.css'

/**
 * **行内输入条**(09-02 批 12 立件):`[前缀?][控件槽 grow][主钮][取消]` 一行排完。
 *
 * ── 为什么立件 ──────────────────────────────────────────────────────────
 * 「基础件先行」。凭证池一块面上此刻有**四个**同形产地:改密钥 / 改备注 / 添加 /
 * 删除确认。四处要的是同一件事 —— 一条临时长在某一行里的条,右端两颗钮,
 * 忙的时候主钮自己说「在办了」。各写一份的必然结局是「这一处忙态会转圈,
 * 那一处不会」,而每一份自己都跑得通,没有门看得见。
 *
 * ── 删除确认为什么也是它(而不是另立一形)──────────────────────────────
 * 派工令允许在「硬套不合适」时另立最小形。核下来**不必**:删除确认与改密钥
 * 在这块面上占的是**同一个槽位**(行内、右端两颗钮、Esc 收回),差别只有两格 ——
 * 前缀那一格装的是一句后果而不是旧尾号,主钮是 `danger` 而不是 `primary`,
 * 中间的控件槽空着。两格都已经是这件的 props;为它另立一件会让「行里长出一条」
 * 这件事有两个产地,而那正是立这件要治的病。
 * 唯一因此放宽的是 `children` 可空 —— 一条没有输入框的条仍是一条条。
 *
 * ── 手势不在这件里 ──────────────────────────────────────────────────────
 * `↵` / `Esc` / 一进来选中全文归 `ui/inline-edit`(那件管的是**手势**),这件管的是
 * **形**。消费方把 `useInlineEdit` 摊在它塞进来的那件控件上 —— 两件各管一半,
 * 合成一件就等于逼所有消费方都得有一个输入框(删除确认那一形当场破)。
 * 与之配套:这一形**失焦不取消**(`cancelOnBlur: false`),因为它有并肩的真钮 ——
 * `blur` 在 `click` 之前到,失焦即取消会把那两颗钮变成永远点不到的。
 *
 * ── 三张状态表(库件规格)──────────────────────────────────────────────
 * ① 生命周期
 *    挂载   纯渲染,一个 hook 都没有。它是「某一行此刻多长出来的一条」,
 *           所以它的寿命由消费方那一格局部态决定,自己不记任何东西。
 *    换宿主 没有第二种落点:它长在一行里,宽度吃那一行剩下的地方
 *           (控件槽是唯一的弯腰件 —— 抗挤压律一)。
 *    卸载   无订阅 / 无计时器 / 无模块级副作用 → **不需要 HMR dispose**。
 * ② UI 生命状态
 *    这件不取数。它只有「在场」这一种 —— 不在场时消费方压根不渲染它。
 *    错误**不归它**:后端那句原话是整块面的事(落卡底),不是这一条的事;
 *    塞进条里会让行高在出错那一刻跳一次,而草稿还在里面。
 * ③ UI 交互状态
 *    rest     主钮可点(`canSave`)/ 禁(空值);取消恒可点。
 *    busy     整条禁灰:主钮 `disabled` + `aria-busy` + 文案换 `savingLabel` +
 *             一枚 `ui/Spinner`(**按钮内**是 Spinner 仅有的两个合法位之一),
 *             取消一并禁 —— 一次写已经发出去了,「取消」取消不掉它。
 *             控件本身的禁由消费方给(它才知道那件控件是什么)。
 *    focus    走各件自己的环,这件一个字不画。
 */
export interface InlineEditStripProps {
  /** 左端那一格:旧值(改密钥)或一句后果(删除确认)。不给就不占位。 */
  prefix?: ReactNode
  /** 控件槽。删除确认那一形是空的 —— 它没有要填的东西。 */
  children?: ReactNode
  /** 主钮文案。 */
  saveLabel: string
  /** 忙态的主钮文案。 */
  savingLabel: string
  /** 取消钮文案。 */
  cancelLabel: string
  /** 主钮的语气。`primary` = 落定一次编辑;`danger` = 删除确认。 */
  tone?: 'primary' | 'danger'
  /** 写在飞。整条禁灰,主钮报 `aria-busy`。 */
  busy?: boolean
  /** 主钮可不可点(空值时禁)。缺省可点 —— 删除确认那一形没有「空值」一说。 */
  canSave?: boolean
  onCommit: () => void
  onCancel: () => void
  className?: string
}

export function InlineEditStrip({
  prefix,
  children,
  saveLabel,
  savingLabel,
  cancelLabel,
  tone = 'primary',
  busy = false,
  canSave = true,
  onCommit,
  onCancel,
  className,
}: InlineEditStripProps) {
  return (
    <span
      className={[s.strip, children == null ? s.noControl : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {prefix != null && <span className={s.prefix}>{prefix}</span>}
      {children != null && <span className={s.control}>{children}</span>}
      <Button
        size="sm"
        variant={tone}
        disabled={busy || !canSave}
        aria-busy={busy || undefined}
        onClick={onCommit}
      >
        {busy && <Spinner size="sm" />}
        {busy ? savingLabel : saveLabel}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        {cancelLabel}
      </Button>
    </span>
  )
}
