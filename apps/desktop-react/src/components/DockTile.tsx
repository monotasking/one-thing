import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { resolveIcon, Plus } from './icons'
import { Badge } from '../ui/Badge'
import { DockPreview } from './DockPreview'
import type { StageBadge } from '../stage/types'
import { PREVIEW_DELAY_MS, TOOLTIP_DELAY_MS } from './motion'
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
  /**
   * 给了就出预览泡,不给就不出。**该不该出是 Dock 的判断**(它知道形态),
   * 瓦只知道「悬停够久了」——「已经看得见的东西不必再预览」这条规则不该抄两份。
   */
  previewId?: string
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
  previewId,
  onClick,
  onContextMenu,
}: Props) {
  const [labelVisible, setLabelVisible] = useState(false)
  const [previewVisible, setPreviewVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (previewTimer.current) clearTimeout(previewTimer.current)
    },
    [],
  )

  /**
   * 两级悬停:300ms 出名字,600ms 出预览。第二级到了就把第一级收掉 ——
   * 一次一个主角:泡里已经写着标题,标签留着就是同一句话说两遍。
   * 移开即散(退场谦逊律:不给退场动画,直接消失)。
   */
  const enter = () => {
    timer.current = setTimeout(() => setLabelVisible(true), TOOLTIP_DELAY_MS)
    if (previewId) {
      previewTimer.current = setTimeout(() => setPreviewVisible(true), PREVIEW_DELAY_MS)
    }
  }
  const leave = () => {
    if (timer.current) clearTimeout(timer.current)
    if (previewTimer.current) clearTimeout(previewTimer.current)
    setLabelVisible(false)
    setPreviewVisible(false)
  }

  const Icon = plus ? Plus : resolveIcon(icon ?? '')
  const badgeText = badge ? (badge.text ?? String(badge.count ?? '')) : ''

  return (
    <div className={s.wrap} onMouseEnter={enter} onMouseLeave={leave}>
      {labelVisible && !previewVisible && (
        <span className={`${s.label} ${LABEL_CLASS[labelSide]}`}>{title}</span>
      )}
      {previewVisible && previewId && (
        <DockPreview id={previewId} title={title} side={labelSide} />
      )}
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
