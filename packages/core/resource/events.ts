/**
 * K1 —— 「看」的第一块(`docs/design/atom-2026-09.md` §2 的 `Watch`)。
 *
 * **事件是事实,不是命令。** 一条事件说「这件事发生了」;要它发生是「做」的事,
 * 走 `ResourceTool` 那条管线。这只文件只有一张监听表和一条前缀判据。
 *
 * ── K1 只在内存里 ─────────────────────────────────────────────────────────
 * 接 EventBus / SSE / `events.jsonl` 是 K2 的事(§9 分期)。这里刻意不知道那些
 * 东西存在:一张纯内存的表加一个前缀匹配,谁要把它接出去谁自己 `watch` 一次再转
 * 发。§7 盲点 5 已经先判过一条:**不要求每种资源的事件都落盘** —— 哪些落盘由
 * `ResourceSpec` 说,不由内核统一,所以内核这一层连「落盘」这个概念都不该有。
 *
 * ── 为什么事件上没有时刻 ───────────────────────────────────────────────────
 * `core/toolkit/ports.ts` 有一个 `Clock` 端口,正是因为「现在几点」在内核里是注入
 * 的而不是 `Date.now()`。给这条事件加一格 `at` 就得在这里调 `Date.now()`(多一处
 * 不可测的隐式依赖)或者再穿一个 `Clock` 进来(为一格没人读的值加一个构造参数)。
 * 时刻由**落账的那一层**盖 —— 事件账本本来就在自己那一头盖时间戳。
 */

import { ResourceWatchPrefixError } from './errors.js'
import { formatRef, isRefPrefix, matchesRefPrefix, type Ref, type ResourceRef } from './ref.js'

/** 一条已经发生的事。`payload` 的形状由 `ResourceSpec.events[name].payload` 说了算。 */
export interface ResourceEvent {
  readonly ref: Ref
  readonly event: string
  readonly payload: unknown
}

export type ResourceEventListener = (event: ResourceEvent) => void

export class ResourceEventHub {
  private readonly watchers = new Map<string, Set<ResourceEventListener>>()

  /**
   * 发一条事件。没有人听就什么都不做 —— 发事件的一方不该知道有没有人听
   * (知道了就会开始「没人听就不算了」,而那是另一种真相)。
   */
  emit(ref: Ref | ResourceRef, event: string, payload: unknown): void {
    const id: Ref = typeof ref === 'string' ? ref : formatRef(ref)
    const fact: ResourceEvent = { ref: id, event, payload }
    for (const [prefix, listeners] of this.watchers) {
      if (!matchesRefPrefix(id, prefix)) continue
      // 拷一份再遍历:监听器在回调里退订是正常操作(面板被销毁),直接遍历活集合
      // 会漏掉后面的人。理由与 `registry.ts` 的 `notify` 逐字相同。
      for (const listener of [...listeners]) {
        try {
          listener(fact)
        } catch {
          // 一个坏掉的观察者不该把「这件事发生过」这个事实撤销掉,也不该把发它的
          // 那次 `apply` 变成失败。与 `runner.ts` 里 `notify` 吞掉 Observer 异常
          // 是同一条纪律:旁观者不是参与者。
        }
      }
    }
  }

  /**
   * 看住一个前缀。返回幂等的退订函数。
   *
   * 前缀只有两种合法形状(`scheme:` / `scheme:path/`,见 `ref.ts` 的 `isRefPrefix`),
   * 不合就**抛** —— 与地址不同,前缀几乎总是代码里的字面量,而一个静默失效的
   * 订阅是最难查的那种 bug(它什么都不做,而且不报错)。
   */
  watch(prefix: string, listener: ResourceEventListener): () => void {
    if (!isRefPrefix(prefix)) throw new ResourceWatchPrefixError(prefix)
    const listeners = this.watchers.get(prefix) ?? new Set<ResourceEventListener>()
    listeners.add(listener)
    this.watchers.set(prefix, listeners)
    return () => {
      const current = this.watchers.get(prefix)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.watchers.delete(prefix)
    }
  }

  /** 还有几个活着的订阅。只给测试与诊断用。 */
  get watcherCount(): number {
    let total = 0
    for (const listeners of this.watchers.values()) total += listeners.size
    return total
  }
}
