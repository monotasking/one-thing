import { useEffect } from 'react'
import { useStageStore, viewport } from './store'

/**
 * **窗子变大变小 → 浮窗与架子跟着回到视口里**(09-04;W7-p 裁定 3 起架子也归它,设计
 * `docs/design/react-shell-sessions-list-2026-09.md` §4)。
 *
 * 判据与算术整件在 `stage/transitions.ts`(`fitFloatRect` / `reclampShelves` /
 * `reclampAll`,纯的、测得起来);这里只有宿主那一半:**一条 window resize 监听 +
 * 挂载时的一次**,量一次视口,交给 store 的 `reclampFloats`(名字留着 —— 它是
 * 「按此刻的视口重钳一遍」这句话的口,钳什么由那只纯函数说了算)。走的是**重钳那把尺**(整扇拉回视口内),手势那把
 * (`clampFloatRect`,允许拖出界只留 40px)一字没动 —— 两把尺的分工表在
 * `transitions.ts` 的「浮窗几何」节开头。
 *
 * 三件事写在这儿而不是散在浮窗里:
 *  · **一条监听,挂在壳上一次**。每扇浮窗各挂一条的话,开五扇就有五条监听在同一发
 *    resize 上各跑一遍钳制 —— 而钳制本来就是全表一起做的事(`reclampAll`)。
 *  · **rAF 合并**。拖窗口边框时 resize 一秒几十上百发;合并成一帧一次,与
 *    `ui/float.ts` 的 `useFloatPosition` 逐字同一手(那边合并的是重定位)。
 *  · **它不是 keydown**。响应链 I2 管的是键盘监听只许住在 `src/focus/`;resize 是
 *    宿主几何,不经过响应链,所以这一条不碰那条法(`ui:consume` 的三条零基线硬闸
 *    也只认 keydown / focus / activeElement 三种命中)。
 *
 * 恒等那一格在纯函数里:一格都没动时 `reclampAll` 交回同一个对象,zustand 的 `set`
 * 认 `Object.is` 直接不通知 —— 所以「拉一下窗口但什么都没越界」不会推一轮渲染。
 *
 * 模块作用域里一格状态都没有(计时器与监听都长在组件的 effect 里,React 卸载时
 * 自然拆),所以不配 HMR dispose —— 判据是那条法自己的一句话:「这东西的寿命是不是
 * 『这个模块实例』」,这里的答案是「没有这东西」(同 `ui/float.ts` 末尾那段判例)。
 */
export function useViewportReclamp(): void {
  const reclampFloats = useStageStore((st) => st.reclampFloats)

  useEffect(() => {
    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        reclampFloats(viewport())
      })
    }
    /*
     * **挂上就先钳一次**(W7-p 裁定 3)。存下来的架子厚度与浮窗矩形是**上一台
     * 窗口**的:上次 1600 宽时钉的 700 右架子,这次开在 900 的窗里就是「中央区
     * 只剩 200」——而 resize 事件此刻还没有、也可能一直不来(用户不拉窗口)。
     * 一格都没越界时 `reclampAll` 交回同一个对象,zustand 连订阅都不推,所以
     * 这一句在正常开机路上是零成本。
     */
    schedule()
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
    }
  }, [reclampFloats])
}
