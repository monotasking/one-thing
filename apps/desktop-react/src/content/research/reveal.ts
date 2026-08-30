import { useEffect, useRef } from 'react'

/**
 * 「滚到那一段检索并展开」的**一条细线**。
 *
 * ── 为什么不用 DOM 查找 ──────────────────────────────────────────────────
 * 消息尾的来源条要让**别的组件**(那一段检索)改变自己的状态。DOM 那条路
 * (`querySelector('[data-research-id=…]')` 然后 `scrollIntoView`)只能把段滚进
 * 视野,**没法让它展开** —— 展开态是 React 本地状态,DOM 上没有它的把手。
 * 于是要么把展开态提升进某个 store(一件屏幕上的瞬时事就此变成全局状态,
 * 换个窗口还得共享),要么给一条只送「请露面」这个意思的信号。选后者。
 *
 * ── 为什么不是 zustand ───────────────────────────────────────────────────
 * 这里没有**状态**可存:一次点击是一个事件,不是一个值。存成 store 的话必然要
 * 处理「上一次点的还留在里面」——「已经露过面了要不要清掉」这种问题只会由
 * 「把事件存成状态」凭空造出来。所以就是一组监听者,发一次、听一次,不留痕。
 *
 * 监听者是模块级的:同一时刻屏幕上只有一份聊天区,而段的挂载/卸载自己会加减。
 */

type Listener = (id: string) => void

const listeners = new Set<Listener>()

/** 请 id 对应的那段检索露面(展开 + 滚进视野)。没人听就是什么也不发生。 */
export function revealResearch(id: string): void {
  // 复制一份再遍历:监听者在回调里卸载(段被折叠器换掉)不该打断这一轮。
  for (const listener of [...listeners]) listener(id)
}

export function useResearchReveal(id: string, onReveal: () => void): void {
  // 回调每帧都是新函数;把它放进 ref,订阅就只跟着 id 走 —— 否则每次重渲染都要
  // 退订再订阅一次。
  const latest = useRef(onReveal)
  latest.current = onReveal

  useEffect(() => {
    const listener = (target: string) => {
      if (target === id) latest.current()
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [id])
}
