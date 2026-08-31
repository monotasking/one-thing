import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import { resolveIcon, Plus } from './icons'
import { Badge } from '../ui/Badge'
import { DockPreview } from './DockPreview'
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
  /**
   * 实色瓦面:给这块瓦铺一层底色,底色由外面递进来的类名给
   * (那个类只做一件事:把 `--ws-face` 指到某一格色上,见 workspace/swatch.module.css)。
   *
   * 它不是「另一种瓦」,是同一块瓦的另一张脸:图标照画,放大 / 降淡 / 名字标签 /
   * 预览泡 / 运行点 / 右键菜单,一件都不变。今天唯一的用户是工作区切换器那一块——
   * **色**承载「我在哪」(瓦面同时就是那条常驻指示),**形**仍由图标承载。
   *
   * 08-31 之前这一格还带一个 `letter`,用一个字取代图标;用户否决了(拿字当图标
   * 与这套风格不符:整条 Dock 上只有它一块是字,扫一眼就跳出来,而它并不比
   * 别人重要)。首字母退回右键快切表与总览卡上的小色点 —— 在那两处它是
   * **列表里的区分记号**,不是一块瓦的脸。
   */
  face?: { className: string }
  /** 磁性放大的尺寸系数(1 = 静止)。布局尺寸,不是 transform。 */
  factor: number
  tileRef: (el: HTMLElement | null) => void
  labelSide?: LabelSide
  /**
   * 给了就**可能**出预览泡,不给就永远不出。**该不该出是 Dock 的判断**(它知道形态),
   * 「已经看得见的东西不必再预览」这条规则不该抄两份。
   */
  previewId?: string
  /**
   * 此刻这块瓦的泡开着没有 —— 09-01 起这一格是**受控**的:
   * 「一次只有一个泡」是**条**的性质,不是瓦的性质,所以主角是谁由 Dock 那只
   * hover-intent 说了算(病历见 ui/hover-intent.ts 文件头:所有权散在各瓦里时,
   * 两块瓦可以同时以为泡是自己的,而没有人能说「他正冲着我来,你们都别动」)。
   */
  previewOpen?: boolean
  /** 指针进 / 出这块瓦(泡是瓦的后代,所以停在泡上仍算「在瓦里」)。 */
  onHoverEnter?: () => void
  onHoverLeave?: () => void
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
  face,
  factor,
  tileRef,
  labelSide = 'top',
  previewId,
  previewOpen = false,
  onHoverEnter,
  onHoverLeave,
  onClick,
  onContextMenu,
}: Props) {
  const [labelVisible, setLabelVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  /**
   * 两级悬停:300ms 出名字,600ms 出预览。第二级到了就把第一级收掉 ——
   * 一次一个主角:泡里已经写着标题,标签留着就是同一句话说两遍。
   *
   * **这里只剩第一级**。第二级(泡)09-01 上收到 Dock 那只 hover-intent:
   * 「一次只有一个泡」「走向泡的路上谁都别插队」都是**跨瓦**的话,一块瓦
   * 说不出口(病历与真机读数见 ui/hover-intent.ts 文件头)。瓦仍然是那个
   * 报「指针进了 / 出了」的人 —— 泡是 .wrap 的后代,所以停在泡上照样算在瓦里,
   * 不必给泡另挂一套监听(挂了就是两处各记一半的 hover 状态)。
   * 前提是泡得吃指针:它的 pointer-events 是 auto(见 DockPreview)。
   *
   * 标签没有缝的烦恼(它贴着瓦),所以照旧移开即散。
   */
  const enter = () => {
    onHoverEnter?.()
    // 泡已经在场时不重排标签:从缝里回到泡上不该让它「重新长一遍」。
    if (previewOpen) return
    timer.current = setTimeout(() => setLabelVisible(true), TOOLTIP_DELAY_MS)
  }
  const leave = () => {
    if (timer.current) clearTimeout(timer.current)
    setLabelVisible(false)
    onHoverLeave?.()
  }

  const Icon = plus ? Plus : resolveIcon(icon ?? '')
  const badgeText = badge ? (badge.text ?? String(badge.count ?? '')) : ''

  return (
    <div className={s.wrap} onMouseEnter={enter} onMouseLeave={leave}>
      {labelVisible && !previewOpen && (
        <span className={`${s.label} ${LABEL_CLASS[labelSide]}`}>{title}</span>
      )}
      {previewOpen && previewId && (
        /* 点泡 = 点这块瓦。泡里那一眼说的就是「打开之后长这样」,
         * 所以点它的意思只可能是「那就打开吧」—— 不该再让用户把手移回瓦上。 */
        <DockPreview id={previewId} title={title} side={labelSide} onOpen={onClick} />
      )}
      <button
        type="button"
        ref={tileRef as (el: HTMLButtonElement | null) => void}
        className={
          plus
            ? `${s.tile} ${s.plus}`
            : face
              ? `${s.tile} ${s.faced} ${face.className}`
              : s.tile
        }
        /* 放大系数也进一格自定义属性。图标本身靠 width/height 的百分比就跟着长大,
         * 这一格留给那些**只能按父字号缩放**的东西(font-size 的百分比量的是父字号
         * 而不是父盒子)。字标瓦面退役后今天没有消费者,留着是因为下一个字形瓦面
         * 一定会再要它 —— 删了就得连同这段病历一起重新踩一遍。 */
        style={
          {
            width: `calc(var(--tile-size) * ${factor})`,
            height: `calc(var(--tile-size) * ${factor})`,
            '--tile-factor': factor,
          } as CSSProperties
        }
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-label={title}
        data-testid={testId}
        title=""
      >
        {/* 有没有色底,画的都是同一枚图标 —— 色底只是这块瓦的另一张脸,不是另一种瓦。 */}
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
