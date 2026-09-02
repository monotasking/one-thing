import { useEffect, useRef, useState } from 'react'

/**
 * **「一次落位」的淡入闸**(09-02 批 9a 立件,原产地:模型服务面的
 * 「上次拉取」时刻与行区)。
 *
 * 一句话:token 变了就播一遍,`animationend` 自己收。它管的是**什么时候播**,
 * 不管播什么 —— 动画名与时长都归消费方那条 CSS 规则(`--kf-*` 名字表 +
 * `--dur` 族,唯一产地 `styles/motion.css`)。
 *
 * ── 为什么没有一个 ms 字面量 ────────────────────────────────────────────
 * 收尾看 `animationend`,不看计时器。于是**动效档调到「无」时时长是 0ms**,
 * `animationend` 立刻回来,这段逻辑连一个分支都不必写 —— 而拿 setTimeout 计时
 * 的写法必须自己认得「现在是 0ms 档」,那就是第二个产地。
 *
 * ── 挂载那一次不播 ──────────────────────────────────────────────────────
 * 首帧屏幕上本来就在长内容,再淡一次是噪音。所以初值记的是**当前** token,
 * 不是一个不可能的哨兵值。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:挂载不播(见上);token 每变一次播一次;卸载无需拆卸
 *             (没有计时器、没有订阅);**无模块级副作用 → 不需要 HMR dispose**。
 *             播放中 token 又变了 = 仍然只有一发(`on` 已经是 true,
 *             再置一次 true 是恒等变换),`end` 一到就收 —— 不叠帧、不排队。
 *   交互状态:无。这件不是控件,它只交出一个开关。
 *   数据状态:on / off 两态。**「变了」由消费方定义** —— 时刻前进(每次成功都有)
 *             与内容真的变了(dataRev)是两件事,各喂一只闸,各播各的;
 *             把两者合成一个 token 就等于「刷新回来一个字节没变也让整表闪一下」,
 *             无中生有的动静比没有动静更糟。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 * ```tsx
 * const pulse = useSettlePulse(dataRev)
 * <div className={`${s.rows} ${pulse.on ? s.settled : ''}`} onAnimationEnd={pulse.end}>
 * ```
 * `end` 挂在**同一个**元素的 `onAnimationEnd` 上。它是冒泡事件:里面还有别的
 * 动画时,消费方自己判 `event.target === event.currentTarget` 再调
 * —— 这只件不替消费方认它的 DOM。
 */
export function useSettlePulse(token: unknown): { on: boolean; end: () => void } {
  const seen = useRef(token)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (token === seen.current) return
    seen.current = token
    setOn(true)
  }, [token])
  return { on, end: () => setOn(false) }
}
