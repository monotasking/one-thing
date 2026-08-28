import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { resolveIcon, Plus } from './icons'
import { Badge } from '../ui/Badge'
import type { MagnifyTransform } from './useMagnify'
import type { StageBadge } from '../stage/types'
import { TOOLTIP_DELAY_MS } from './motion'
import s from './DockTile.module.css'

interface Props {
  /** 已经过 i18n 的成品文案 —— 瓷砖不认识 key,谁摆它谁翻译。 */
  title: string
  icon?: string
  badge?: StageBadge
  running?: boolean
  plus?: boolean
  transform: MagnifyTransform
  tileRef: (el: HTMLElement | null) => void
  onClick?: () => void
  onContextMenu?: (e: MouseEvent) => void
}

export function DockTile({ title, icon, badge, running, plus, transform, tileRef, onClick, onContextMenu }: Props) {
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
      {labelVisible && <span className={s.label}>{title}</span>}
      <button
        type="button"
        ref={tileRef as (el: HTMLButtonElement | null) => void}
        className={plus ? `${s.tile} ${s.plus}` : s.tile}
        style={{ transform: `translateY(${transform.lift}px) scale(${transform.scale})` }}
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
        {running && <span className={s.dot} aria-hidden="true" />}
      </button>
    </div>
  )
}
