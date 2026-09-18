import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { FrameCoalescer } from '../../ui/frame-coalescer'

/**
 * **这块面此刻是什么形**(音乐面 v7,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §1)。
 *
 * 两个阈值,一处产地。它们**不能只住在 CSS 的容器查询里**,因为形不只决定画什么,
 * 还决定一条状态规矩:「从一栏变两栏时,若正停在歌词页则退回唱机」(§3.1)——
 * 那句话要一个 JS 认得出的布尔。所以反过来:JS 量宽、算形,CSS 读 `data-wide` /
 * `data-drawer` 两格属性。两处各写一遍阈值就会像 M1 那样漂(那时注释写着 960、
 * 查询条件里也是 960,而设计早就说 900)。
 *
 * ── 量的是**面板自己的宽**,不是窗口宽 ──────────────────────────────────
 * 这块面落在架子 / 浮窗 / 舞台三种宿主里,同一扇窗里它可以只有 320,也可以有 1200。
 * `window.innerWidth` 在这三种落点下说的都是同一个数,而那个数与这块面长什么样无关。
 */

/** ≥ 这个宽:两栏(左唱机 + 右常驻歌词),歌条上没有「歌词」钮。 */
export const MUSIC_WIDE_AT = 900

/** ≥ 这个宽:播放列表从右侧滑出;再窄就从底部升起。 */
export const MUSIC_DRAWER_SIDE_AT = 560

export interface MusicPanelForm {
  /** 两栏。 */
  wide: boolean
  /** 抽屉从哪儿来。 */
  drawer: 'side' | 'sheet'
}

/** 纯算术:一个宽 → 一种形。单测直接吃。 */
export function formOfWidth(width: number): MusicPanelForm {
  return {
    wide: width >= MUSIC_WIDE_AT,
    drawer: width >= MUSIC_DRAWER_SIDE_AT ? 'side' : 'sheet',
  }
}

/** 没量到之前的形:一栏 + 底部弹层。**最窄那一档是缺省** —— 猜宽会在窄机器上闪一帧两栏。 */
const NARROW: MusicPanelForm = { wide: false, drawer: 'sheet' }

/**
 * 跟着元素的宽走。RO 回调**只读不写**:量到变化只排一帧,下一帧里读完再 setState
 * (仓里那条 09-14 判例 —— 观察器回调里当场写,写的那一格又被别人读回来就成了环)。
 *
 * jsdom 没有 `ResizeObserver`,挂载那一次 `useLayoutEffect` 的量仍然跑得到 ——
 * 用例要演「跨过 900」就自己装一只(与 `TurntableScene` 同一条守法)。
 */
export function useMusicPanelForm(ref: { current: HTMLElement | null }): MusicPanelForm {
  const [form, setForm] = useState<MusicPanelForm>(NARROW)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = formOfWidth(el.clientWidth)
    // 同一种形就不换身份 —— 每量一次换一个对象会把下游的 effect 全部重跑。
    setForm((prev) => (prev.wide === next.wide && prev.drawer === next.drawer ? prev : next))
  }, [ref])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const el = ref.current
    if (typeof ResizeObserver !== 'function' || !el) return
    const frame = new FrameCoalescer(measure)
    const ro = new ResizeObserver(() => frame.schedule())
    ro.observe(el)
    return () => {
      ro.disconnect()
      frame.cancel()
    }
  }, [measure, ref])

  return form
}
