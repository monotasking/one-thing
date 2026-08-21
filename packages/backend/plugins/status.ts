/**
 * 插件流状态的装配层接线(R6)。
 *
 * core 管账与清扫语义,这里只做宿主的事:
 *  1. 把状态投递到会话事件总线(`content:part`)—— 既有轨道,desktop 的 IPCBridge
 *     与 web 的 SSE 都消费它,没有为 R6 新开通道;
 *  2. 在流结束时**强制清扫**该会话的全部插件状态;
 *  3. 会话被删除时清扫(会话可能根本没走到"流结束")。
 *
 * 第 2 条是本期的核心,而**时机**决定它是不是真的兜住了:清扫必须发生在终止
 * 事件**之前**。终止事件一旦过线,renderer 会自己把 transient 扫干净,后到的
 * cleared 事件就落在了一条已经收尾的消息上 —— 宿主清扫成了空转,真正兜底的
 * 是渲染层的兜底逻辑。所以这里用 EventBus 的 **interceptor**(commit 与 fan-out
 * 之前的相位),而不是事后观察者。
 */
import {
  CorePluginStatusRegistry,
  type CorePluginStatusPart,
} from '@onething/core/plugins'
import { SESSION_STREAM_TERMINAL_EVENTS } from '@shared/events/session-events.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('plugins')


type SessionEventEmitter = (
  sessionId: string,
  event: { type: string; [key: string]: unknown },
) => Promise<unknown> | unknown

interface StatusHostPorts {
  emitSessionEvent: SessionEventEmitter
  /** 会话上是否有正在跑的流 —— 状态只在流内有意义。 */
  isStreaming?(sessionId: string): boolean
}

/**
 * 宿主接线。
 *
 * 整个模块只有这一处可变状态,而且**每次 configure 都整体替换** —— 早先版本把
 * emitter 存在模块级闭包里且从不清,dev 热重载之后它会一直指着上一次的 EventBus,
 * 事件发进一个没人听的总线。
 */
let ports: StatusHostPorts | null = null

/**
 * 全进程一本账。
 *
 * 每插件一本的话,按会话清扫就要遍历所有插件的账 —— 而"扫干净"恰恰是这一期
 * 唯一必须保证的事,不能依赖调用方记得把每本都传进来。
 */
const statusRegistry = new CorePluginStatusRegistry({
  isStreaming: sessionId => ports?.isStreaming?.(sessionId) ?? true,
  warn: message => log.warn('plugin status registry', { detail: message }),
})

export function getPluginStatusRegistry(): CorePluginStatusRegistry {
  return statusRegistry
}

export function configurePluginStatusHost(options: StatusHostPorts): void {
  ports = options
}

/**
 * 拆掉宿主接线并停掉在飞的补发。**生产 shutdown 路径调用它。**
 *
 * 与 `resetPluginStatusHostForTests` 分开命名:一个叫 ForTests 的函数出现在
 * 生产 shutdown 里,下一个做清理的人会理所当然地删掉它。
 */
export function detachPluginStatusHost(): void {
  ports = null
  clearTrailingFlush()
}

/** 测试用:拆掉接线、停掉补发,并清空账本。 */
export function resetPluginStatusHostForTests(): void {
  detachPluginStatusHost()
  statusRegistry.reset()
}

export function emitPluginStatusPart(sessionId: string, part: CorePluginStatusPart): void {
  // 走既有的 content:part 会话事件,不新开轨道(§5.2 第 4 条)。
  void ports?.emitSessionEvent(sessionId, { type: SESSION_EVENT_TYPES.CONTENT_PART, part })
}

// ── 合并窗的 trailing flush ────────────────────
//
// core 的账本把窗口内的 label 变化压住(只更账不投递),这里负责在窗口结束后
// 把最后一条补发出去。少了它,突发进度的**最终状态**会被丢掉 —— 而最终状态
// 恰恰是唯一必须送达的那条(R5 的 panel-refresh 犯过同一个错)。

const TRAILING_FLUSH_MS = 220

/**
 * 补发定时器**按会话**。
 *
 * 上一版是模块级单定时器,而清扫是按会话触发的 —— 会话 A 结束时
 * `clearTrailingFlush()` 会把会话 B 被合并窗压住的最终状态一起吞掉。
 * 两个会话同时在跑是常态(群聊、并行回合),这不是边角情况。
 */
const trailingFlushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTrailingFlush(sessionId?: string): void {
  if (sessionId === undefined) {
    for (const timer of trailingFlushTimers.values()) clearTimeout(timer)
    trailingFlushTimers.clear()
    return
  }
  const timer = trailingFlushTimers.get(sessionId)
  if (!timer) return
  clearTimeout(timer)
  trailingFlushTimers.delete(sessionId)
}

function scheduleTrailingFlush(): void {
  for (const sessionId of statusRegistry.pendingSessionIds()) {
    if (trailingFlushTimers.has(sessionId)) continue
    const timer = setTimeout(() => {
      trailingFlushTimers.delete(sessionId)
      for (const { sessionId: target, part } of statusRegistry.flushPending(sessionId)) {
        emitPluginStatusPart(target, part)
      }
      scheduleTrailingFlush()
    }, TRAILING_FLUSH_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    trailingFlushTimers.set(sessionId, timer)
  }
}

/** 插件 show 之后由 api 层调用 —— 有被压住的变化就排一次补发。 */
export function notePluginStatusPending(): void {
  scheduleTrailingFlush()
}

/**
 * 流结束时的强制清扫。
 *
 * 三种终止事件都要接 —— 漏一种就漏一类残留,而 error 与 aborted 恰恰是插件最
 * 可能没走到 clear 的那两条路径。名单来自 shared 的单一权威,不在这里手抄第五份。
 */
export async function sweepPluginStatusForSession(sessionId: string): Promise<CorePluginStatusPart[]> {
  const cleared = statusRegistry.clearSession(sessionId)
  for (const part of cleared) {
    // 逐条 await:清扫必须在终止事件之前**完成**过线,否则 renderer 收到 cleared
    // 时那条消息已经收尾了。
    await ports?.emitSessionEvent(sessionId, { type: SESSION_EVENT_TYPES.CONTENT_PART, part })
  }
  return cleared
}

/**
 * 插件停用 / 熔断 / 卸载时清扫它在**所有**会话里的状态。
 *
 * 只等流结束是不够的:一个刚被熔断禁用的插件,它挂在别的会话上的状态没人再会
 * 来撤下,而那些会话可能几小时后才结束。
 */
export function sweepPluginStatusForPlugin(pluginId: string): Array<{ sessionId: string; part: CorePluginStatusPart }> {
  const cleared = statusRegistry.clearPlugin(pluginId)
  for (const { sessionId, part } of cleared) emitPluginStatusPart(sessionId, part)
  return cleared
}

interface StatusSweepBus {
  intercept?(handler: (
    event: { type: string; [key: string]: unknown },
    sessionId: string,
  ) => Promise<{ suppress?: boolean }> | { suppress?: boolean }): () => void
  onGlobal?(type: string, handler: (envelope: { event: { sessionId?: string } }) => void): () => void
}

/**
 * 接上清扫。返回退订函数(shutdown 必须调用它 —— 否则重启插件系统会叠加拦截器,
 * 而旧那个还指着上一次的接线)。
 */
export function subscribePluginStatusSweep(bus: StatusSweepBus): () => void {
  const unsubscribes: Array<() => void> = []

  // 终止事件的**前置**拦截:在 commit 与 fan-out 之前把 cleared 发出去。
  const unintercept = bus.intercept?.(async (event, sessionId) => {
    if ((SESSION_STREAM_TERMINAL_EVENTS as readonly string[]).includes(event.type)) {
      // 只取消**这个会话**的补发 —— 全局取消会吞掉别的会话的最终状态。
      clearTrailingFlush(sessionId)
      await sweepPluginStatusForSession(sessionId)
    }
    return {}
  })
  if (unintercept) unsubscribes.push(unintercept)

  // 会话被删掉时也要清账:那个会话可能根本没走到"流结束"。
  const unsubDeleted = bus.onGlobal?.('session:deleted', (envelope) => {
    const sessionId = String(envelope?.event?.sessionId ?? '')
    if (sessionId) void sweepPluginStatusForSession(sessionId)
  })
  if (unsubDeleted) unsubscribes.push(unsubDeleted)

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
    clearTrailingFlush()
  }
}
