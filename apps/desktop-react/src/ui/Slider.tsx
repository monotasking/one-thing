import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { PointerTrack } from './drag'
import s from './Slider.module.css'

/**
 * **Slider —— 组件库第 N 件「调一个数」**(音乐收尾立件,2026-09-10)。
 *
 * ── 它为什么必须先立件 ──────────────────────────────────────────────────
 * 「基础件先行」那条法的原话:动手写任何交互行为(键盘导航 / 选中态 / 悬浮层 /
 * **拖杆** / 异步反馈 / 提示……)之前先查 `src/ui/` 有没有对应件,有则必须消费,
 * 没有则**先立件入库再消费**。壳里今天只有 `ui/Splitter`(两块面之间那条界),
 * 它调的是**比例**、住在两栏之间、报的是 `role="separator"`;音乐面要的是
 * 进度条与音量 —— 调的是**一个数**、有自己的轨与钮、报的是 `role="slider"`。
 * 把 Splitter 拉过来担这一份工要给它加「轨怎么画」「填到哪儿」「值怎么格式化」
 * 三格开关,那是硬套不是收敛(与 `pointer-track.ts` 里「为什么 DragSession
 * 不吃 PointerTrack」是同一种判断)。
 *
 * 两件共享的东西已经各自只有一个产地了:**同一口指针跟踪**(`ui/drag`
 * 的 `PointerTrack` —— 三条结束路径、Esc 走响应链的瞬态口、window 上的监听)
 * 与同一条焦点环纪律(全局 `:focus-visible`,这里一个字不写)。
 *
 * ── 照 WAI-ARIA APG 的 slider 写(不引库)────────────────────────────────
 *   role="slider" + tabIndex=0        它是控件,进 Tab 序
 *   aria-valuenow / -valuemin / -valuemax  这一格的数与两头
 *   aria-valuetext                    **有 `format` 才报** —— 「241」对读屏
 *                                     是个谜,「4:01 / 4:58」才是话
 *   aria-label                        叫什么。走 i18n,组件里不落字面
 *   ←/↓ · →/↑                         走一格 `step`
 *   Home / End                        到两头
 * 方向键那一段是**行内结构键**(快捷键三层的第三层:方向键 / ↵ / Space 的 DOM
 * 焦点语义,不进任何表),落点是这件自己的 `onKeyDown` —— 与 `ui/Splitter`
 * 逐字同一个体例。它**不是** window 监听,响应链的 I2 管的是后者。
 *
 * ── 拖拽期间**零 React 重渲**(跟手定律,与 Splitter 同一条)──────────────
 * 拖动时把值写进根元素上那格 `--slider-fill` 与 `aria-valuenow`,不走 setState;
 * 松手才 `onCommit` 落一次。「拖着看到的」与「交出去的」是同一个数,因为两条路
 * 共用同一只 `clamp`。取消(Esc / 切走应用 / 指针被系统收走)= **还原到按下那
 * 一刻**,一个字都不 commit。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 一个受控件,值由 props 给;它**不持有值**(拖拽中那一格
 *    活值住在 DOM 上,松手即弃);卸载 = 如果此刻正拖着,`PointerTrack` 的三条
 *    结束路径之一会先跑到(window 上的监听不随这个节点消失),所以没有悬挂。
 *    换宿主(面板从架子拖成浮窗)不重挂,这件一格状态都不动。
 * ② UI 生命状态:empty —— `value` 给 `undefined` 时整条**画成停用**(读不到
 *    位置的时候画一条能拖的杆是撒谎);loading 无(它自己不取数);error 无
 *    (失败的话是发起方那一行的事);超量无(它只有一个数)。
 * ③ UI 交互状态:rest / hover(轨变亮、钮长出来)/ focus(全局环)/
 *    active=拖拽中(`data-sliding`)/ disabled(不接指针、不进 Tab 序)。
 *    **没有 pending 档** —— 落定之后屏幕上的反馈是那个数自己变了,
 *    给杆加一圈转圈正是律②要防的那种「刷新了就闪一下」。
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  label,
  format,
  disabled = false,
  testId,
  onCommit,
}: {
  /** 这一格的数。`undefined` = 读不到(整条画成停用)。 */
  value: number | undefined
  min?: number
  max?: number
  /** 键盘走一格是多少。指针那条路不受它管(指到哪儿就是哪儿)。 */
  step?: number
  /** 这条杆叫什么(aria-label)。走 i18n,组件里不落字面。 */
  label: string
  /** 数 → 说给读屏听的那句话(`aria-valuetext`)。缺席 = 只报数。 */
  format?: (value: number) => string
  disabled?: boolean
  testId?: string
  /** 落定。拖拽中**不叫** —— 每一帧发一次请求是把杆变成一台复读机。 */
  onCommit: (value: number) => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [sliding, setSliding] = useState(false)
  /** 拖拽过程里的最后一个值。松手落它 —— 不从 DOM 反读一次。 */
  const last = useRef(0)

  const clamp = useCallback(
    (raw: number) => Math.min(max, Math.max(min, Math.round(raw / step) * step)),
    [min, max, step],
  )

  /** 把值画到根上。**拖拽期间唯一的输出口** —— 不 setState(跟手定律)。 */
  const paint = useCallback(
    (next: number) => {
      const el = rootRef.current
      if (!el) return
      const span = max - min
      el.style.setProperty('--slider-fill', `${span > 0 ? ((next - min) / span) * 100 : 0}%`)
      el.setAttribute('aria-valuenow', String(next))
      if (format) el.setAttribute('aria-valuetext', format(next))
    },
    [min, max, format],
  )

  /** 指针横坐标 → 这条轨上的那个数。两条路(按下、拖动)共用。 */
  const valueAt = useCallback(
    (clientX: number, box: DOMRect) =>
      clamp(box.width > 0 ? min + ((clientX - box.left) / box.width) * (max - min) : min),
    [clamp, min, max],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // 右键留给上下文菜单;停用 / 读不到数时整条不接指针。
      if (e.button !== 0 || disabled || value === undefined) return
      e.preventDefault()
      const el = e.currentTarget
      const box = el.getBoundingClientRect()
      /** 按下那一刻的值 —— 取消时还原到它(props 里此刻正是它,两边咬合)。 */
      const before = value
      last.current = valueAt(e.clientX, box)
      paint(last.current)
      setSliding(true)

      PointerTrack.open(el, e.pointerId, {
        move: (ev) => {
          last.current = valueAt(ev.clientX, box)
          paint(last.current)
        },
        end: () => {
          setSliding(false)
          onCommit(last.current)
        },
        cancel: () => {
          // 画回按下那一刻:活值与 props 那份此刻相等,屏幕上等于这一下没发生过。
          paint(before)
          setSliding(false)
        },
      })
    },
    [disabled, value, valueAt, paint, onCommit],
  )

  const known = value ?? min
  const span = max - min
  const fill = span > 0 ? ((known - min) / span) * 100 : 0
  const inert = disabled || value === undefined

  return (
    <div
      ref={rootRef}
      className={s.slider}
      role="slider"
      tabIndex={inert ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={known}
      aria-valuetext={format ? format(known) : undefined}
      aria-disabled={inert || undefined}
      aria-orientation="horizontal"
      data-sliding={sliding || undefined}
      data-testid={testId}
      style={{ '--slider-fill': `${fill}%` } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (inert) return
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault()
          onCommit(clamp(known - step))
          return
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault()
          onCommit(clamp(known + step))
          return
        }
        if (e.key === 'Home') {
          e.preventDefault()
          onCommit(min)
          return
        }
        if (e.key === 'End') {
          e.preventDefault()
          onCommit(max)
        }
      }}
    >
      <span className={s.track} />
      <span className={s.fill} />
      <span className={s.knob} />
    </div>
  )
}
