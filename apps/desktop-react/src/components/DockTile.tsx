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
  /**
   * 这块瓦对应的 item id。它只作 `data-testid` 用 —— 门(scripts/gate-*.mjs)
   * 要能在真机上点开一块面,而 aria-label 是**翻译过的**文案,跟着系统语言变,
   * 拿它当选择器就是让门依赖用户的语言设置。
   */
  testId?: string
  icon?: string
  badge?: StageBadge
  /**
   * 未读点:右上角一颗 accent 小圆点,**只说「有」不说「几个」**。
   *
   * 它与 `badge` 是两档并存的语法,不是同一件事的两种画法:徽是「有几个」
   * (数 / ✓ / 短字),点是「有没有」。通知未读刻意用点 —— 计数徽在 tab 与列表上
   * 是禁令(它把「回来看看」变成「还欠你 37 件事」),Dock 瓦上同一条判据成立。
   * 两者同时给的话都画得出来(徽在角上、点在徽外侧),但今天没有这种瓦。
   */
  dot?: boolean
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
  testId,
  icon,
  badge,
  dot,
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
        data-testid={testId}
        title=""
      >
        <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
        {/* 徽的配方在 ui/Badge,贴在哪由这里说了算 —— 所以定位是本地类。 */}
        {badge && (
          <Badge tone={badge.tone} className={s.badgeAt}>
            {badgeText}
          </Badge>
        )}
        {/* 未读点。位置与徽同一个角(右上),所以它不吃 DOT_CLASS 那张按边翻向的表 ——
            那张表管的是**运行点**,它贴的是朝外那一侧。 */}
        {dot && <span className={s.unread} data-testid="dock-unread" aria-hidden="true" />}
        {running && <span className={`${s.dot} ${s[DOT_CLASS[labelSide]]}`} aria-hidden="true" />}
      </button>
    </div>
  )
}
