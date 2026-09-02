import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import { resolveIcon, Plus } from './icons'
import { Badge } from '../ui/Badge'
import { ButtonBase } from '../ui/ButtonBase'
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
   * 它不是「另一种瓦」,是同一块瓦的另一张脸:图标照画,放大 / 名字标签 /
   * 运行点 / 右键菜单,一件都不变。今天唯一的用户是工作区切换器那一块——
   * **色**承载「我在哪」(瓦面同时就是那条常驻指示),**形**仍由图标承载。
   *
   * 08-31 之前这一格还带一个 `letter`,用一个字取代图标;用户否决了(拿字当图标
   * 与这套风格不符:整条 Dock 上只有它一块是字,扫一眼就跳出来,而它并不比
   * 别人重要)。首字母退回右键快切表与总览卡上的小色点 —— 在那两处它是
   * **列表里的区分记号**,不是一块瓦的脸。
   */
  face?: { className: string }
  /**
   * 磁性放大的尺寸系数(1 = 静止)。布局尺寸,不是 transform。
   *
   * 09-02 起这块瓦**不再往外交一个 ref**:静止坐标系改成「一个锚点 + 一串常量」
   * 算出来之后,没有人再需要量单块瓦的矩形了(见 dock-magnify.ts 的文件头)。
   * 那个 `tileRef` 从「写了没人读」变成「连写都不必写」,一并摘掉。
   */
  factor: number
  labelSide?: LabelSide
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
  labelSide = 'top',
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
   * 悬停 300ms 出名字标签 —— **这是瓦上仅剩的一级悬停**。
   *
   * 曾经还有第二级:600ms 长出一块预览泡(一眼活视图),出泡时把标签收掉。
   * 09-02 用户裁定「不需要这个功能了」,泡连同它的整套机件(跨瓦的 hover-intent
   * 主角制、瞄准三角区、收拢宽限、自动隐藏的回身窗口)一起退役 —— 于是瓦也不再
   * 需要向条报「指针进了 / 出了」,`onHoverEnter` / `onHoverLeave` 两个口子随之摘掉。
   *
   * 标签没有缝的烦恼(它贴着瓦,不是浮在 12px 之外),所以照旧移开即散。
   */
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
      {/* 瓦是裸钮三类判的第③类(结构性交互件:视觉本该定制)—— 消费
        * `ui/ButtonBase` 只清 UA,磁性放大 / 色底 / 徽 / 点那一整套皮肤原样留在本地。 */}
      <ButtonBase
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
      </ButtonBase>
    </div>
  )
}
