import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { resolveIcon, Plus } from './icons'
import { Badge } from '../ui/Badge'
import type { StageBadge } from '../stage/types'
import { TOOLTIP_DELAY_MS } from './motion'
import s from './DockTile.module.css'

/** 名字标签浮在瓦的哪一侧。由 Dock 按停靠边算好递进来 —— 瓦不认识「边」。 */
export type LabelSide = 'top' | 'bottom' | 'left' | 'right'

/* 运行点贴朝外侧 = 标签(朝内侧)的对面 */
const DOT_CLASS: Record<LabelSide, string> = {
  top: 'dotBottom',
  bottom: 'dotTop',
  left: 'dotRight',
  right: 'dotLeft',
}

const LABEL_CLASS: Record<LabelSide, string> = {
  top: s.labelTop,
  bottom: s.labelBottom,
  left: s.labelLeft,
  right: s.labelRight,
}

interface Props {
  /** 已经过 i18n 的成品文案 —— 瓷砖不认识 key,谁摆它谁翻译。 */
  title: string
  icon?: string
  badge?: StageBadge
  running?: boolean
  plus?: boolean
  /** 磁性放大的尺寸系数(1 = 静止)。布局尺寸,不是 transform。 */
  factor: number
  tileRef: (el: HTMLElement | null) => void
  labelSide?: LabelSide
  onClick?: () => void
  onContextMenu?: (e: MouseEvent) => void
}

export function DockTile({
  title,
  icon,
  badge,
  running,
  plus,
  factor,
  tileRef,
  labelSide = 'top',
  onClick,
  onContextMenu,
}: Props) {
  const [labelVisible, setLabelVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const enter = () => {
    timer.current = setTimeout(() => setLabelVisible(true), TOOLTIP_DELAY_MS)
  }
  const leave = () => {
    if (timer.current) clearTimeout(timer.current)
    setLabelVisible(false)
  }

  const Icon = plus ? Plus : resolveIcon(icon ?? '')
  const badgeText = badge ? (badge.text ?? String(badge.count ?? '')) : ''

  return (
    <div className={s.wrap} onMouseEnter={enter} onMouseLeave={leave}>
      {labelVisible && <span className={`${s.label} ${LABEL_CLASS[labelSide]}`}>{title}</span>}
      <button
        type="button"
        ref={tileRef as (el: HTMLButtonElement | null) => void}
        className={plus ? `${s.tile} ${s.plus}` : s.tile}
        style={{ width: `calc(var(--tile-size) * ${factor})`, height: `calc(var(--tile-size) * ${factor})` }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-label={title}
        title=""
      >
        <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
        {/* 徽的配方在 ui/Badge,贴在哪由这里说了算 —— 所以定位是本地类。 */}
        {badge && (
          <Badge tone={badge.tone} className={s.badgeAt}>
            {badgeText}
          </Badge>
        )}
        {running && <span className={`${s.dot} ${s[DOT_CLASS[labelSide]]}`} aria-hidden="true" />}
      </button>
    </div>
  )
}
