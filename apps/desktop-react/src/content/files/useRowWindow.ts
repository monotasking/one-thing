import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject, UIEvent } from 'react'
import { rowWindow } from '../../data/files-source'

/**
 * **窗口化的那一半量测**(09-02 批 9d 立件)。
 *
 * 算式早就是纯函数了(`data/files-source` 的 `rowWindow`:行数 × 卷到哪儿 ×
 * 视口多高 → 这一帧画哪一段)。可是它的**两个入参从哪儿来**——「卷到哪儿」与
 * 「视口多高」——从前是散在面板里的三段:两格 `useState`、一段
 * `ResizeObserver` 的 `useLayoutEffect`、以及 `onScroll` 里那句补量。
 * 三段合起来才是一件事,而那件事与「文件树长什么样」毫无关系:任何一列
 * 定高的长表都可以照抄。所以它出文件。
 *
 * 收的**只有量测**:算术仍在 `rowWindow`(纯函数,能被逐条钉死),这里
 * 一行都不重算。**零回调**——它不通知任何人,调用方拿到的就是这一帧的答案。
 *
 * ── 三张状态表(状态先行)────────────────────────────────────────────────
 *  ① 生命周期:`useLayoutEffect` 挂一次 `ResizeObserver`(依赖空表 —— 观察的是
 *     `bodyRef` 指的那个元素,而那个元素的身份在这件的寿命里不变;树常驻铁律
 *     正是这条依赖敢空着的前提)。卸载时 `disconnect()`。无模块级副作用、
 *     无计时器、无订阅 → **不需要 HMR dispose**(判据:寿命是不是「模块实例」——
 *     不是,是调用它的那个组件)。`ResizeObserver` 缺席(jsdom / 老宿主)时
 *     只是没有观察者,首帧那一次 `measure()` 照量 —— **降级成一次性量测,
 *     不是崩**,单测正是跑在这一档上。
 *  ② UI 生命状态:视口还没量到(`viewportH === 0`)时 `rowWindow` 交回
 *     **整表**(它自己那条早退),所以首帧画全量、第二帧收窄 —— 而不是画零行
 *     闪一记白。行数为 0 时交回空窗与两块零高撑子。
 *  ③ UI 交互状态:无。它不画任何东西。
 */
export interface RowWindowSlice<T> {
  /** 挂到那块**可滚的身**上(它同时是 ResizeObserver 观察的对象)。 */
  bodyRef: RefObject<HTMLDivElement | null>
  /** 原样接到那块身的 `onScroll` 上。 */
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  /** 这一帧真要画的那几行。 */
  shown: readonly T[]
  /** 窗口前后的两块空撑子:它们不是内容,只是让卷轴与「全画出来」一样长。 */
  padTop: number
  padBottom: number
}

/**
 * 它吃的是**整个行数组**而不是 `rows.length`:`shown` 这一格要交出来的正是
 * 那一段切片,只给一个长度就得把 `start` / `end` 递回调用方去切 —— 那等于
 * 把窗口化的下标算术又漏回了消费面(而那正是这件要收走的东西)。
 */
export function useRowWindow<T>(rows: readonly T[]): RowWindowSlice<T> {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setViewportH(el.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
    /*
     * 顺手把视口高度也读一遍。ResizeObserver 是**主要**产地,这里是补丁:
     * 面板刚从收起态展开、或宿主换了形态的那一帧,观察者还没来得及回调,
     * 而用户已经在卷了 —— 那一帧按旧高度算窗口会短一截。
     * 代价是一次 clientHeight 读(我们本来就在读 scrollTop,同一次布局),
     * 而且值没变时 setState 会被 React 直接短路,不引起重渲染。
     */
    setViewportH(event.currentTarget.clientHeight)
  }, [])

  const win = rowWindow(rows.length, scrollTop, viewportH)
  return {
    bodyRef,
    onScroll,
    shown: rows.slice(win.start, win.end),
    padTop: win.padTop,
    padBottom: win.padBottom,
  }
}
