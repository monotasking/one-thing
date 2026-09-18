import type { EventSpec } from '@onething/core/resource'

/**
 * **外界的一件事**(09-19 用户:「宠物输出状态,偶尔蹦几句话(有 trigger,比如时间,外界因素、如天气、
 * 可扩展)」)。
 *
 * 一只「外界来源」自己说清三件事:它会报哪几条事实(`events`,带 `moment` 声明 —— 宠物读的就是这一格)、
 * 此刻它知道什么(`snapshot`)、怎么开始听(`start`,返回停止)。`ambient:` 那只资源把一串来源的自述
 * 并成一份,宠物子系统照读注册表里的 `moment`,**一个来源的名字都不认识**。
 *
 * 陌生能力演练:加一只「日历」来源 = 写一个实现这个接口的类 + 在来源表里加一行;宠物、资源内核、
 * 事件桥一个字不改。
 */
export interface AmbientSource {
  /** 来源名,也是 `now` 读数里那一格的键。 */
  readonly id: string
  /** 这只来源会报的事实。事件名在所有来源之间必须唯一(并表时会查)。 */
  readonly events: Readonly<Record<string, EventSpec>>
  /** 此刻知道什么;还不知道 = `undefined`。 */
  snapshot(): Record<string, unknown> | undefined
  /** 开始听。`emit` 报一条事实;返回停止(幂等)。 */
  start(emit: (event: string, payload: Record<string, unknown>) => void): () => void
}

/** 可注入的时钟与计时器(测试手摇)。 */
export interface AmbientTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const SYSTEM_TIMERS: AmbientTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
