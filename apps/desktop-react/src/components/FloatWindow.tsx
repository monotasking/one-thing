import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useStageStore } from '../stage/store'
import { findItem } from '../stage/items'
import { clampFloatRect, resizeFrom } from '../stage/transitions'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { resolveIcon, Maximize2, Pin, X } from './icons'
import { EXIT_MS } from './motion'
import { SHELF_SIDE_CHOICES } from '../stage/types'
import type { FloatRect } from '../stage/types'
import type { ResizeDir } from '../stage/transitions'
import s from './FloatWindow.module.css'

/** 八个把手:四边四角。角在数组末尾 = DOM 里靠后 = 画在边之上,所以角优先抢得到指针。 */
const HANDLES: Array<{ dir: ResizeDir; cls: string }> = [
  { dir: 'n', cls: s.hN },
  { dir: 's', cls: s.hS },
  { dir: 'w', cls: s.hW },
  { dir: 'e', cls: s.hE },
  { dir: 'nw', cls: s.hNW },
  { dir: 'ne', cls: s.hNE },
  { dir: 'sw', cls: s.hSW },
  { dir: 'se', cls: s.hSE },
]

interface WindowProps {
  id: string
  /** 在 floatOrder 里的次序;末位最上,所以 z 就是「基准档 + 次序」。 */
  order: number
  leaving?: boolean
}

/**
 * 一扇浮窗。它是「布局内的 fixed 层」,不走 portal —— portal 是给菜单那种
 * 会被祖先包含块坑到的浮层用的;浮窗自己就是层,没有祖先能坑它。
 *
 * 拖移与缩放遵守跟手定律:过程中零过渡、逐帧写**本地** state,松手才落 store。
 * 钳制两处共用 transitions 里的同一个纯函数,所以「拖着看到的」与「存下来的」逐像素相同。
 */
function FloatWindow({ id, order, leaving }: WindowProps) {
  const t = useT()
  const stored = useStageStore((st) => st.floats[id])
  const focusFloat = useStageStore((st) => st.focusFloat)
  const moveFloat = useStageStore((st) => st.moveFloat)
  const resizeFloat = useStageStore((st) => st.resizeFloat)
  const openAs = useStageStore((st) => st.openAs)
  const floatToEdge = useStageStore((st) => st.floatToEdge)
  const closeToDock = useStageStore((st) => st.closeToDock)

  // 拖拽过程中的实时矩形。松手清空,渲染就自动回到 store 那份(两者此刻相等)。
  const [live, setLive] = useState<FloatRect | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const liveRef = useRef<FloatRect | null>(null)

  const rect = live ?? stored
  const item = findItem(id)

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, dir: ResizeDir | null) => {
      if (e.button !== 0 || !rect) return
      e.preventDefault()
      focusFloat(id)
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      const from = rect
      const startX = e.clientX
      const startY = e.clientY
      const vp = { w: window.innerWidth, h: window.innerHeight }

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        const next = clampFloatRect(
          dir ? resizeFrom(from, dir, dx, dy) : { ...from, x: from.x + dx, y: from.y + dy },
          vp,
        )
        liveRef.current = next
        setLive(next)
      }
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        const final = liveRef.current
        liveRef.current = null
        setLive(null)
        if (!final) return
        if (dir) resizeFloat(id, final)
        else moveFloat(id, final.x, final.y)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [rect, id, focusFloat, moveFloat, resizeFloat],
  )

  if (!item || !rect) return null
  const title = t(item.titleKey)
  const Icon = resolveIcon(item.icon)

  return (
    <section
      className={leaving ? `${s.win} ${s.leaving}` : s.win}
      style={{
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
        zIndex: `calc(var(--z-float) + ${Math.max(order, 0)})`,
      }}
      role="dialog"
      aria-label={title}
      onPointerDown={() => focusFloat(id)}
    >
      <header
        className={s.head}
        onPointerDown={(e) => {
          // 头上的三个控件自己吃掉 pointerdown 才不会一按就开始拖。
          if ((e.target as HTMLElement).closest('button')) return
          begin(e, null)
        }}
        onDoubleClick={() => openAs(id, { kind: 'stage' })}
      >
        <Icon className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.title}>{title}</span>

        <button
          type="button"
          className={s.action}
          aria-label={t('stage.pinToEdge')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom })
          }}
        >
          <Pin className={s.icon} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={s.action}
          aria-label={t('float.toStage')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => openAs(id, { kind: 'stage' })}
        >
          <Maximize2 className={s.icon} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={s.action}
          aria-label={t('float.toDock')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => closeToDock(id)}
        >
          <X className={s.icon} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>

      <div className={s.body}>{renderContent(id)}</div>

      {HANDLES.map((h) => (
        <div
          key={h.dir}
          className={`${s.handle} ${h.cls}`}
          aria-hidden="true"
          onPointerDown={(e) => begin(e, h.dir)}
        />
      ))}

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={t('stage.pinToEdge')}>
          <MenuSection>{t('stage.pinToEdge')}</MenuSection>
          {SHELF_SIDE_CHOICES.map((c) => (
            <MenuItem
              key={c.value}
              onClick={() => {
                floatToEdge(id, c.value)
                setMenu(null)
              }}
            >
              {t(c.labelKey)}
            </MenuItem>
          ))}
        </Menu>
      )}
    </section>
  )
}

/**
 * 浮窗层:把 floatOrder 铺成一叠窗。它多做的唯一一件事是「留一帧给出场动画」——
 * 与 StageOverlay 的 held 同一条判例:形态机不该知道动画的存在。
 */
export function FloatLayer() {
  const order = useStageStore((st) => st.floatOrder)
  const [leaving, setLeaving] = useState<string[]>([])
  const prev = useRef<string[]>(order)

  useEffect(() => {
    const gone = prev.current.filter((id) => !order.includes(id))
    prev.current = order
    if (gone.length === 0) return
    setLeaving((l) => [...l, ...gone])
    const timer = setTimeout(
      () => setLeaving((l) => l.filter((id) => !gone.includes(id))),
      EXIT_MS,
    )
    return () => clearTimeout(timer)
  }, [order])

  return (
    <>
      {order.map((id, i) => (
        <FloatWindow key={id} id={id} order={i} />
      ))}
      {/* 又被打开的就不算「正在离场」了 —— 同一个 id 不许同时画两遍。 */}
      {leaving
        .filter((id) => !order.includes(id))
        .map((id) => (
          <FloatWindow key={`leaving-${id}`} id={id} order={0} leaving />
        ))}
    </>
  )
}