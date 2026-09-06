import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import s from './Splitter.module.css'

/**
 * **Splitter —— 组件库第 19 件**(09-01 立件;报障:「file open 之后,没办法调整宽度」)。
 *
 * 文件面板那条分栏从前是**两档写死的 fr**(`--files-tree-fr` / `--files-viewer-fr`),
 * 用户改不了。这件把「两块面之间那条可拖的界」抽成库件,而不是在 FilesPanel 里
 * 现写一段 —— 壳里已经有一处同款手势(EdgeShelf 的厚度把手),再写第三处就一定
 * 会有三种手感、三套 a11y。
 *
 * ── 照 WAI-ARIA APG 的 window splitter 写(不引库)────────────────────────
 *   role="separator" + tabIndex=0        它是**可聚焦**的分隔符(APG 明说:
 *                                        可调的 separator 进 Tab 序,不可调的不进)
 *   aria-orientation                     竖杆(左右分栏)= vertical
 *   aria-valuenow / -valuemin / -valuemax 前一栏占的百分比
 *   aria-controls                        它调的是哪一块(前一栏的 id)
 *   ←/→(竖杆)· ↑/↓(横杆)             走一格 step(缺省 `SPLITTER_STEP`)
 *   Home / End                           到两头
 *   Enter                                回默认(APG 的 restore 那一格;
 *                                        与**双击杆**是同一个动作的两种手势)
 *
 * ── 拖拽期间**零 React 重渲**(跟手定律)──────────────────────────────────
 * 拖动时把值直接写进容器上那个 CSS 变量(`liveVar`),不走 setState ——
 * 于是那棵树一次都不重渲,更不可能重挂。松手才 `onCommit` 落一次 store。
 * 「拖着看到的」与「存下来的」是同一个数,因为两条路共用同一个 `clampRatio`。
 *
 * 拖拽期间容器上会挂 `data-splitting="true"`:分栏那条 `transition` 得在这段
 * 时间里关掉,否则列宽会**追着**指针走(过渡把每一帧都拖慢一拍)。
 */
/**
 * **键盘走一格是多少**(W7-t / B8)。设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §6 的原话:
 * 「分隔杆:`ui/Splitter`,比例存在标签上,**键盘 ←/→ 5% 一步**」。
 *
 * 它是**一个常量、一个产地**:设计里那个 5 与代码里这个 5 只该有一份,
 * 而修前代码里是 2 —— 一条写在正本里两个月、屏幕上从来没兑现过的规格。
 * 消费方要更细的档自己传 `step`(今天一处都没有),缺省一律读这一格。
 */
export const SPLITTER_STEP = 5

export function Splitter({
  containerRef,
  orientation = 'vertical',
  value,
  min = 15,
  max = 85,
  step = SPLITTER_STEP,
  defaultValue,
  label,
  controls,
  liveVar,
  liveTarget,
  testId,
  onCommit,
}: {
  /** 量比例用的那块容器(杆自己不知道自己有多宽)。 */
  containerRef: RefObject<HTMLElement | null>
  /** vertical = 竖着的一条杆(左右分栏);horizontal = 横着的(上下分栏)。 */
  orientation?: 'vertical' | 'horizontal'
  /** 前一栏占的百分比(0–100)。 */
  value: number
  min?: number
  max?: number
  step?: number
  /** 双击 / ↵ 回到的那个值。缺席 = 这两个手势不做事。 */
  defaultValue?: number
  /** 这条杆叫什么(aria-label)。走 i18n,组件里不落字面。 */
  label: string
  /** 它调的是哪一块的尺寸(那块面的 DOM id)。 */
  controls?: string
  /** 拖拽期间把实时值写进这个 CSS 变量(如 `--files-split`)。 */
  liveVar?: string
  /**
   * 活值写在**哪个元素**上。缺省就是 `containerRef` —— 一格分栏里那两件是同一个盒。
   *
   * 分家的场合是**嵌套切分**(拼贴树,W1):比例是相对**这一次切分那块地**算的
   * (所以量的是它),而活值要写在**整棵树的根**上 —— 依赖它的那些格子是根的
   * 后代、是这次切分那块地的兄弟,自定义属性只向下继承,写在量的那个盒上它们
   * 一格都收不到。两件事本来就是两个问题:「相对谁算」与「谁看得见」。
   */
  liveTarget?: RefObject<HTMLElement | null>
  testId?: string
  onCommit: (value: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  /** 拖拽过程里的最后一个值。松手时落它 —— 不从 DOM 反读一次。 */
  const last = useRef(value)

  const clamp = useCallback(
    (raw: number) => Math.min(max, Math.max(min, Math.round(raw))),
    [min, max],
  )

  /** 把值写进容器那个变量。**拖拽期间唯一的输出口** —— 不 setState。 */
  const paint = useCallback(
    (next: number) => {
      const el = (liveTarget ?? containerRef).current
      if (!el || !liveVar) return
      el.style.setProperty(liveVar, `${next}`)
    },
    [containerRef, liveTarget, liveVar],
  )

  const commit = useCallback(
    (next: number) => {
      last.current = next
      paint(next)
      onCommit(next)
    },
    [paint, onCommit],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      const box = containerRef.current?.getBoundingClientRect()
      if (!box) return
      // 捕获失败(pen 抬笔竞态 / 合成指针)不放弃拖拽:capture 只是锦上添花,
      // 监听本来就挂在元素上(与 EdgeShelf 那条把手逐字同一条判例)。
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* 不阻断 */
      }
      const container = containerRef.current
      container?.setAttribute('data-splitting', 'true')
      setDragging(true)
      last.current = value

      const move = (ev: PointerEvent) => {
        const ratio =
          orientation === 'vertical'
            ? ((ev.clientX - box.left) / box.width) * 100
            : ((ev.clientY - box.top) / box.height) * 100
        last.current = clamp(ratio)
        paint(last.current)
      }
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        container?.removeAttribute('data-splitting')
        setDragging(false)
        onCommit(last.current)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [containerRef, orientation, value, clamp, paint, onCommit],
  )

  const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
  const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'

  /* eslint-disable jsx-a11y/no-noninteractive-tabindex,
                    jsx-a11y/no-noninteractive-element-interactions --
   * 两条规则都以为 `separator` 永远是装饰(一条画在菜单里的横线)。**APG 的
   * window splitter 恰恰相反**:可调的 separator 是控件 —— 它要进 Tab 序、
   * 要报 aria-valuenow、要接方向键与 Home/End。这里给的正是那一整套(见文件头
   * 那张键盘表),所以这两条在这里是误报。
   *
   * 不是关掉整条规则、也不是把 role 换成 button 蒙混过去:换成 button 会让读屏
   * 念出「按钮」,而用户听到的应该是「分隔条,45」。 */
  return (
    <div
      className={[
        s.bar,
        orientation === 'vertical' ? s.vertical : s.horizontal,
        dragging && s.dragging,
      ]
        .filter(Boolean)
        .join(' ')}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-controls={controls}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        // 这里的双击**不是动作触发**(禁令区那条说的是「别拿双击当一个动作的
        // 唯一入口」),它是分隔杆的通行手势「回默认」,而且 ↵ 是它平级的第二个
        // 入口 —— 键盘用户不必依赖它。
        if (defaultValue !== undefined) commit(defaultValue)
      }}
      onKeyDown={(e) => {
        if (e.key === back) {
          e.preventDefault()
          commit(clamp(value - step))
          return
        }
        if (e.key === forward) {
          e.preventDefault()
          commit(clamp(value + step))
          return
        }
        if (e.key === 'Home') {
          e.preventDefault()
          commit(min)
          return
        }
        if (e.key === 'End') {
          e.preventDefault()
          commit(max)
          return
        }
        if (e.key === 'Enter' && defaultValue !== undefined) {
          e.preventDefault()
          commit(defaultValue)
        }
      }}
    />
  )
}
/* eslint-enable jsx-a11y/no-noninteractive-tabindex,
                 jsx-a11y/no-noninteractive-element-interactions */
