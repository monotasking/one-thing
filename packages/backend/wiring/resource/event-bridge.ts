/**
 * K2a —— 把资源事件转发上事件总线(`docs/design/atom-2026-09.md` §4「所有出口都是
 * 投影」的「事件走既有 SSE」那半句)。
 *
 * ## 方向是单向的,而且方向是 K1 定的
 *
 * K1 留账写死了这一条:**装配层单向订阅 hub + `own()` 退订,hub 不反向认识
 * EventBus**。`ResourceEventHub`(`core/resource/events.ts`)是一张纯内存的监听表,
 * 它连"落盘"这个概念都不该有,更不该知道有一条总线存在。所以这只文件住在装配层:
 * 它是唯一同时认识两头的地方。
 *
 * ## 不许列 scheme 名
 *
 * 转发要订阅"每个已 mount 的命名空间",而那份名单**只能问注册表**
 * (`kernel.registry.list()`),不能在这里写死 —— 写死一次,接一个邮箱就要回来改
 * 这只文件,而 §8 演练的答案必须是「能力自己的模块 + 一行注册」。名单还会变
 * (插件装/卸、MCP 连/断),所以除了开局同步一次,还要 `registry.subscribe` 跟新:
 * 注册表的 `register` / 注销都会通知(K0 那份实现里写着)。
 *
 * 为什么不干脆订阅一个"什么都收"的通配前缀:`isRefPrefix` 只认两种形状
 * (`scheme:` / `scheme:path/`),而那是刻意的 —— 一个不收尾的前缀会跨段吃掉别的
 * 地址(`file:/a` 吃 `file:/ab`)。与其为转发在内核里开一种新前缀,不如在这里
 * 按名单订阅:名单是数据,新前缀是机制。
 *
 * ## 时刻在这里盖
 *
 * hub 的事件没有时刻(`events.ts` 头注释:内核里叫 `Date.now()` 是一处不可测的
 * 隐式依赖,穿一个 `Clock` 进来又是为一格没人读的值加构造参数)。**时刻由落账的
 * 那一层盖** —— 这里就是那一层。
 */

import type { ResourceEvent, ResourceKernel } from '@onething/core/resource'
import type { EventBus } from '../../events/event-bus.js'

/**
 * 订阅这台内核上**全部**已登记命名空间的事件,每条转成一条 `resource:event` 放上
 * 总线。返回退订(装配层 `own()` 它)。
 *
 * 幂等地跟着注册表走:新登记的补订阅,注销掉的撤订阅。退订函数把两样一起撤。
 */
export function forwardResourceEventsToBus(kernel: ResourceKernel, bus: EventBus): () => void {
  const watching = new Map<string, () => void>()
  let stopped = false

  const forward = (event: ResourceEvent): void => {
    bus.emitGlobal({
      type: 'resource:event',
      ref: event.ref,
      event: event.event,
      payload: event.payload,
      at: Date.now(),
    })
  }

  const sync = (): void => {
    if (stopped) return
    const live = new Set<string>()
    for (const spec of kernel.registry.list()) {
      live.add(spec.scheme)
      if (watching.has(spec.scheme)) continue
      watching.set(spec.scheme, kernel.events.watch(`${spec.scheme}:`, forward))
    }
    for (const [scheme, stop] of [...watching]) {
      if (live.has(scheme)) continue
      stop()
      watching.delete(scheme)
    }
  }

  sync()
  const unsubscribe = kernel.registry.subscribe(sync)

  return () => {
    stopped = true
    unsubscribe()
    for (const stop of watching.values()) stop()
    watching.clear()
  }
}
