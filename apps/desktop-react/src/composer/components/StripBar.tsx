import { ButtonBase } from '../../ui/ButtonBase'
import { Progress } from '../../ui/Progress'
import { ChevronDown } from '../../components/icons'
import type { StripBarModel } from '../strip'
import s from './Composer.module.css'

const TONE_CLASS = { normal: '', accent: s.stripAccent, muted: s.stripMuted } as const

/**
 * 输入框顶上的一条(从前叫 `StatusBar`,外观不变)。画什么由登记表里那一条的
 * `useBar` 说,这一件只画皮:左边记号、一句话(可带淡色半句)、右边开合箭头。
 */
export function StripBar({ bar, open, onToggle }: {
  bar: StripBarModel
  open: boolean
  onToggle: () => void
}) {
  const { indicator } = bar
  return (
    /* 整条是一颗**结构性交互件**(通栏的一行,视觉本该定制)——
     * 裸钮三类判第③类,消费 `ui/ButtonBase` 只清 UA,`.statusbar` 皮肤不动。 */
    <ButtonBase
      className={s.statusbar}
      aria-label={bar.label}
      aria-expanded={open}
      onClick={onToggle}
    >
      {indicator.kind === 'spinner' && <span className={s.spinner} aria-hidden="true" />}
      {indicator.kind === 'done' && <span className={s.doneDot} aria-hidden="true" />}
      {indicator.kind === 'progress' && (
        <Progress className={s.stripProgress} value={indicator.value} label={bar.text} />
      )}
      <span className={[s.statusText, TONE_CLASS[bar.tone ?? 'normal']].filter(Boolean).join(' ')}>
        {bar.text}
        {bar.detail && <span className={s.stripDetail}> {bar.detail}</span>}
      </span>
      <ChevronDown
        className={open ? `${s.chev} ${s.chevOpen}` : s.chev}
        strokeWidth={2}
        aria-hidden="true"
      />
    </ButtonBase>
  )
}
