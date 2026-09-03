/**
 * Electron IPC 桥 → `@onething/client` 的 `Transport`(C2,
 * `docs/design/client-sdk-2026-09.md` §4.1 末段 / §5.2)。
 *
 * **为什么这只文件住在 renderer 而不是包里**:它要 `window.electronAPI`,而
 * `packages/client` 的边界规则明令禁裸用浏览器全局与宿主别名。包只定义
 * `Transport` 那三个方法;谁有本事把它实现出来,谁就住在自己那棵树里。
 * 这正是「换一种传输 = 写一个文件」那条演练(方案 §6 第二条)的活证据。
 *
 * ## 三条推送合成一条流
 *
 * `Transport.events()` 交出的是**一条** `AsyncIterable<TransportEvent>`,而 IPC 桥
 * 上是三条各自独立的订阅(`onSessionEvent` / `onSessionStream` /
 * `onSettingsChanged`)。这里把三条合成一条:各订阅一次,收到的载荷贴上
 * `IPC_CHANNELS` 里那三个名字(**用常量不用字面量** —— 打错一个字母是 tsc 红,
 * 不是运行时静默失聪),推进一个 FIFO 队列;`for await` 从队列取,队列空就挂在
 * 一个 `Promise` 上等下一条。`signal` 一 abort(或传输 `close()`)就**三条全部
 * 退订**并让迭代器正常结束 —— 漏退一条就是热更/换会话之后两份监听同时活着。
 *
 * ## 为什么不实现 `onConnectionChange`
 *
 * 那口是**可选**的,判据写在包的 `transport/types.ts` 里:一个不会断的传输没有
 * 「断没断」这件事可说,造一个恒 `open` 的桩是在**造假事实**(方案 §4.1)。
 * IPC 桥在渲染进程活着的整个生命期里不会断线重连 —— 真断了(主进程没了)整个
 * 窗口一起没了。所以这里一个字都不说,枢纽退回只看迭代器。
 *
 * ## `id` 恒 `undefined`
 *
 * SSE 的 `id:` 是给 `?after=` 续播用的;IPC 上没有断线重连,也就没有续播这件事。
 * 谎报一个号会让枢纽把它记成 `after` 并在将来某次换传输时从错的地方续 —— 所以
 * 不报。分片自己的坐标一直在载荷里(`SessionEventEnvelope.sequence`)。
 */
import { IPC_CHANNELS } from '@shared/ipc/channels.js'
import type {
  HostCapabilities,
  Transport,
  TransportEvent,
  TransportEventsOptions,
} from '@onething/client'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'
import type { ElectronAPI } from '@/types'

export interface ElectronTransportOptions {
  /**
   * 这个宿主的能力表。IPC 桥上没有「问服务器要能力」这条路 —— 桌面的能力是
   * **静态事实**(`platform/electron.ts` 的 `electronCapabilities`),由调用方
   * 递进来,本文件不认识任何一位。
   */
  capabilities: HostCapabilities
}

/** 一条推送:名字 + 载荷。三条订阅都折成这个形。 */
type Pushed = TransportEvent

export function createElectronTransport(
  electronAPI: ElectronAPI,
  options: ElectronTransportOptions,
): Transport {
  // 传输自己的生命期闸:`close()` 一拉,所有在途的 `events()` 循环收尾。
  const lifetime = new AbortController()

  return {
    // 延迟到调用时取 `electronAPI.rpcInvoke`:preload 在 reload 时会整只换掉方法,
    // 和 `platform/electron.ts` 那条「按访问转发、不快照」的规矩保持一致。
    invoke: (request: RpcRequest): Promise<RpcResponse> => electronAPI.rpcInvoke(request),

    capabilities: async () => options.capabilities,

    events(eventsOptions: TransportEventsOptions = {}): AsyncIterable<Pushed> {
      const signal = eventsOptions.signal
      // `after` 在 IPC 上无意义(没有 ring buffer 可续播),收下即忽略 —— 老实
      // 忽略比假装续播好:调用方拿到的是"从现在开始的每一条",而不是一段假历史。
      return (async function* pump(): AsyncIterable<Pushed> {
        const queue: Pushed[] = []
        let wake: (() => void) | undefined
        let stopped = false

        const push = (name: string, data: unknown): void => {
          if (stopped) return
          queue.push({ name, data })
          wake?.()
        }

        const offs: Array<() => void> = [
          electronAPI.onSessionEvent(envelope => push(IPC_CHANNELS.SESSION_EVENT, envelope)),
          electronAPI.onSessionStream(payload => push(IPC_CHANNELS.SESSION_STREAM, payload)),
          electronAPI.onSettingsChanged(settings => push(IPC_CHANNELS.SETTINGS_CHANGED, settings)),
        ]

        const stop = (): void => {
          if (stopped) return
          stopped = true
          // 三条全退 —— 漏一条就是"热更之后两份监听同时活着"。
          for (const off of offs) {
            try {
              off()
            } catch {
              // 退订本身抛错不该把收尾链打断:剩下两条还得退。
            }
          }
          wake?.()
        }

        const onAbort = (): void => stop()
        signal?.addEventListener('abort', onAbort, { once: true })
        lifetime.signal.addEventListener('abort', onAbort, { once: true })

        try {
          if (signal?.aborted || lifetime.signal.aborted) return
          for (;;) {
            while (queue.length > 0) {
              const next = queue.shift() as Pushed
              yield next
              if (stopped) return
            }
            if (stopped) return
            await new Promise<void>(resolve => {
              wake = resolve
            })
            wake = undefined
          }
        } finally {
          stop()
          signal?.removeEventListener('abort', onAbort)
          lifetime.signal.removeEventListener('abort', onAbort)
        }
      })()
    },

    close(): void {
      if (!lifetime.signal.aborted) lifetime.abort()
    },
  }
}
