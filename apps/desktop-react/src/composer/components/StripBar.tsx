import { ButtonBase } from '../../ui/ButtonBase'
import { Progress } from '../../ui/Progress'
import { ChevronDown, CircleAlert, Info, TriangleAlert } from '../../components/icons'
import { Tooltip } from '../../ui/Tooltip'
import type { StripBarModel } from '../strip'
import s from './Composer.module.css'

const TONE_CLASS = { normal: '', accent: s.stripAccent, muted: s.stripMuted } as const

/** 通知记号:级别 → 图标与它那一格状态色(状态色只上图标,不换底)。 */
const NOTICE_GLYPH = {
  info: { Icon: Info, className: s.noticeInfo },
  warning: { Icon: TriangleAlert, className: s.noticeWarn },
  error: { Icon: CircleAlert, className: s.noticeError },
} as const

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
  const glyph = indicator.kind === 'notice' ? NOTICE_GLYPH[indicator.severity] : null
  const button = (
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
      {glyph && (
        <glyph.Icon
          className={`${s.noticeGlyph} ${glyph.className}`}
          strokeWidth={2}
          aria-hidden="true"
          data-severity={indicator.kind === 'notice' ? indicator.severity : undefined}
        />
      )}
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
  // 补充说明挂在整条上(一条通知的 description 就在这里):条只念标题,全文悬停 / 聚焦可见。
  return bar.tip ? <Tooltip content={bar.tip}>{button}</Tooltip> : button
}
