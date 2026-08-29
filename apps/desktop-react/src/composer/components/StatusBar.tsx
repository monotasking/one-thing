import { useT } from '../../i18n'
import { ChevronDown } from '../../components/icons'
import { truncate } from '../transitions'
import type { StatusState } from '../types'
import s from './Composer.module.css'

/** 状态条上那句话最多念这么多字,剩下的收进抽屉 —— 条是一眼,抽屉才是全文。 */
const HEADLINE_MAX = 24

/**
 * 状态条:有执行就常驻在面板顶上,点它开合状态抽屉。
 * 执行完了它**不消失**,只是从转圈换成绿点 —— 「刚才那件事做完了」也是一种状态。
 */
export function StatusBar({ status, open, onToggle }: {
  status: StatusState
  open: boolean
  onToggle: () => void
}) {
  const t = useT()
  const step = status.steps[status.stepIdx]
  const headline = status.running
    ? t('status.running', {
        name: status.name,
        step: step ? truncate(`${step.label} ${step.detail}`, HEADLINE_MAX) : '',
      })
    : t('status.done', { name: status.name, count: status.steps.length })

  return (
    <button
      type="button"
      className={s.statusbar}
      aria-label={t('status.toggle')}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className={status.running ? s.spinner : s.doneDot} aria-hidden="true" />
      <span className={s.statusText}>{headline}</span>
      <ChevronDown
        className={open ? `${s.chev} ${s.chevOpen}` : s.chev}
        strokeWidth={2}
        aria-hidden="true"
      />
    </button>
  )
}
