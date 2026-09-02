import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useStageStore } from '../stage/store'
import { findItem } from '../stage/items'
import { HostTitle, useHostTitleText } from './HostTitle'
import { clampFloatRect, resizeFrom, snapSideAt } from '../stage/transitions'
import { setSnapSide } from './snap-hint'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { IconButton } from '../ui/IconButton'
import { resolveIcon, Maximize2, Pin, X } from './icons'
import { exitMs } from './motion'
import { SHELF_SIDE_CHOICES } from '../stage/types'
import type { FloatRect, ShelfSide } from '../stage/types'
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
  /*
   * 钉边菜单贴着**那颗钮**的下缘开,所以要能**在任意时刻**量到那颗钮的矩形。
   * 刻意不改成「在 onPointerDown 里记一次」:那条路键盘按 ↵ 走不到,
   * 菜单会开在 0,0。
   *
   * 09-02 批 8b:ref 直接落在 `ui/IconButton` 上(批 8a 给它补了 `ref` 那一格
   * 类型 —— React 19 里 ref 对函数组件是普通 prop,经 rest 摊到
   * `ui/ButtonBase` 那件 forwardRef,最后落在真的 `<button>` 上)。
   * 从前外面包的那格贴身 `span`(`.actionSlot`,inline-flex + flex:none,
   * 逐像素等于钮自己)因此退役 —— 它存在的唯一理由就是库件递不进 ref。
   */
  const pinRef = useRef<HTMLButtonElement>(null)

  const rect = live ?? stored
  const item = findItem(id)
  /*
   * 檐上那句话:**有活标题就说活标题**(09-01 合檐)。查看器摆进浮窗时自己那条
   * 檐整条不画,文件名与未保存丸改由这一条说 —— 判据与画法在 HostTitle 一处,
   * 三个宿主(浮窗 / 舞台 / 盖)共用,免得那颗丸只在其中一处被记得。
   * 取在**早退之前**:它是 hook,不许排在 `if (!item) return null` 后面。
   */
  const liveTitle = useHostTitleText(id, '')

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, dir: ResizeDir | null) => {
      if (e.button !== 0 || !rect) return
      e.preventDefault()
      focusFloat(id)
      const el = e.currentTarget
      // 捕获失败(如 pen 抬笔竞态、合成指针)不放弃拖拽:capture 只是锦上添花,
      // 监听本来就挂在元素上,丢 capture 最多丢"指针滑出元素后的帧"。
      try { el.setPointerCapture(e.pointerId) } catch { /* 不阻断 */ }
      const from = rect
      const startX = e.clientX
      const startY = e.clientY
      const vp = { w: window.innerWidth, h: window.innerHeight }
      // 只有「拖着整扇窗走」才谈吸附;拉把手改身量与落到哪条边无关。
      let landing: ShelfSide | null = null

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        const next = clampFloatRect(
          dir ? resizeFrom(from, dir, dx, dy) : { ...from, x: from.x + dx, y: from.y + dy },
          vp,
        )
        liveRef.current = next
        setLive(next)
        if (dir) return
        landing = snapSideAt({ x: ev.clientX, y: ev.clientY }, vp)
        setSnapSide(landing)
      }
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        const final = liveRef.current
        liveRef.current = null
        setLive(null)
        setSnapSide(null)
        if (!final) return
        if (dir) {
          resizeFloat(id, final)
          return
        }
        // 松手在热带里 = 钉上去(浮窗塌进架子,那一次形变走 --dur-enter);
        // 不在热带里就照常落位 —— 高亮散了不改变松手的语义。
        if (landing) floatToEdge(id, landing)
        else moveFloat(id, final.x, final.y)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [rect, id, focusFloat, moveFloat, resizeFloat, floatToEdge],
  )

  if (!item || !rect) return null
  const title = liveTitle || t(item.titleKey)
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
        <HostTitle id={id} fallback={t(item.titleKey)} className={s.title} />

        {/* 檐上三颗全部消费 `ui/IconButton`;本地那份 `.action` 皮肤已删 ——
          * 28×28 正是库件的 md 档,hover / active / 焦点环从此随件走。
          * `onPointerDown` 那一下仍要拦住:不拦,按住钮就等于按住檐在拖窗。 */}
        <IconButton
          ref={pinRef}
          icon={Pin}
          size="md"
          label={t('stage.pinToEdge')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const r = pinRef.current?.getBoundingClientRect()
            if (r) setMenu({ x: r.left, y: r.bottom })
          }}
        />
        <IconButton
          icon={Maximize2}
          size="md"
          label={t('float.toStage')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => openAs(id, { kind: 'stage' })}
        />
        <IconButton
          icon={X}
          size="md"
          label={t('float.toDock')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => closeToDock(id)}
        />
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
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  /*
   * 「刚离场的」在**渲染期同步**导出,不等 effect(08-30 用户报障的真因):
   * 用 effect 检测晚一个提交 —— order 丢掉 id 的那一帧真窗已经卸载,离场副本
   * 下一帧才挂上,肉眼就是「消失 → 再闪现 → 再消失」,而且旧写法的副本用的是
   * `leaving-${id}` 这个**新 key** = Exposé 那样的重面板整棵重挂一遍。
   * 渲染期 setState(同组件)会让 React 在提交前重跑本次渲染 —— 这正是官方的
   * 「从 props 派生 state」形状,窗因此一帧都不缺席。
   */
  /*
   * 动效档「无」时**根本不进离场名单**:没有出场动画要播,也就没有理由让一扇
   * 已经关掉的窗在 DOM 里再活 120ms。关掉 = 这次提交里就没有它。
   * (排一个 0ms 的定时器也能到,但那要多等一个宏任务 —— 与 StageOverlay 同一条。)
   */
  if (prev.current !== order) {
    const newlyGone = prev.current.filter((id) => !order.includes(id) && !leaving.includes(id))
    prev.current = order
    if (newlyGone.length > 0 && exitMs() > 0) setLeaving((l) => [...l, ...newlyGone])
  }

  // 每个离场 id 各自计时;又被打开的当场从离场名单摘掉(它回到 order 那一半去画)。
  useEffect(() => {
    for (const id of leaving) {
      if (order.includes(id)) {
        const timer = timers.current.get(id)
        if (timer) clearTimeout(timer)
        timers.current.delete(id)
        setLeaving((l) => l.filter((x) => x !== id))
        continue
      }
      if (timers.current.has(id)) continue
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id)
          setLeaving((l) => l.filter((x) => x !== id))
          // 现问一次动效档:「无」档下 exitMs() = 0,关窗即卸载,不留空壳。
        }, exitMs()),
      )
    }
  }, [leaving, order])
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), [])

  /*
   * 离场窗与在场窗必须并进**同一个数组**再渲染:JSX 里两个并排的 `{array}` 是两个
   * 子槽,key 只在各自槽内认人 —— id 跨槽挪动照样卸载重挂(本测试修前抓的第二个
   * 坑)。一个数组一个 key 命名空间,id 从「在场」挪去「离场」只是位置变了,
   * 实例与 DOM 原封不动,出场动画播在活实例上。两半永远不含同一个 id
   * (filter 保证),不会撞 key。
   */
  const shown = [
    ...order.map((id, i) => ({ id, at: i, leaving: false })),
    ...leaving
      .filter((id) => !order.includes(id))
      .map((id, i) => ({ id, at: order.length + i, leaving: true })),
  ]
  return (
    <>
      {shown.map((w) => (
        <FloatWindow key={w.id} id={w.id} order={w.at} leaving={w.leaving} />
      ))}
    </>
  )
}