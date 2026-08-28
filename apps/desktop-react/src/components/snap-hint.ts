import { useSyncExternalStore } from 'react'
import type { ShelfSide } from '../stage/types'

/**
 * 「松手就会钉到这条边」的预示,是一次拖拽过程里的**瞬态**,不是形态机的状态:
 * 它活不过松手那一刻,存进 stage store 会让 persist 与形态不变式都要为它多担一份心。
 *
 * 但它有两个生产者(浮窗标题栏拖拽、从架子上撕下 tab)和一个消费者(SnapHint),
 * 所以它也不能是某个组件的私有 state。这就是一个模块级瞬态:一处真相、三行订阅、
 * 随页面同生共死。别往这里加第二件事 —— 它一旦长出第二个字段,就该是一个真 store 了。
 */
let current: ShelfSide | null = null
const subscribers = new Set<() => void>()

export function setSnapSide(next: ShelfSide | null): void {
  if (next === current) return
  current = next
  for (const notify of subscribers) notify()
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** 服务端快照恒为 null:预示只在有指针的地方存在。 */
export function useSnapSide(): ShelfSide | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
