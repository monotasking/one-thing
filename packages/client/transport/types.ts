/**
 * `Transport` —— 本包**唯一的可换点**(C0,`docs/design/client-sdk-2026-09.md` §4.1)。
 *
 * 上面三段(rpc 域客户端 / 事件枢纽 / 纯判据)对「怎么把一条信封送出去」一无所知,
 * 只认这三个方法。于是「换传输」= 再写一个实现这个接口的文件:
 * `http.ts`(fetch + 自解析 SSE,浏览器与 Node 同一份)、`memory.ts`(测试替身)、
 * 将来 Vue 桌面的 `electron-transport.ts`(IPC 桥,住在 renderer 那边,因为它要
 * `window.electronAPI` —— 本包禁碰浏览器全局)。
 */
import { IPC_CHANNELS } from '@shared/ipc/channels.js'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'
import type { SessionEventEnvelope, SessionStreamPayload } from '@shared/events/index.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import type { RuntimeHostCapabilities } from '@onething/core/runtime-facade'

/**
 * `GET /api/capabilities` 的形。
 *
 * **不新造一个类型**:server 侧 `backend/server/runtime.ts` 的
 * `currentServerCapabilities()` 出的就是这个,它住在 `@onething/core/runtime-facade`
 * (纯类型文件,零依赖)。客户端照抄一份 = 两个形状,某天服务器加一位而客户端
 * 不知道 —— 所以这里只是起个本地名字。
 */
export type HostCapabilities = RuntimeHostCapabilities

/** 推送流上的一条:名字 + 载荷 + 续播用的序号。 */
export interface TransportEvent {
  name: string
  data: unknown
  /**
   * SSE 的 **last event id**,用来 `?after=` 续播。
   *
   * 注意它是**粘的**(SSE 规范如此,`data` / `event` 每条重置而 `id` 跨条保留):
   * server 只在 `session:event` 上盖号(= 账本 sequence),所以紧随其后的
   * `session:stream` / `settings:changed` 带的是**上一条会话事件的**号。
   * 这对续播恰好是对的 —— 断线重连要问的就是"最后一条会话事件到哪儿了";
   * 但它**不是**"这条分片的序号",别拿它当分片的身份。分片自己的坐标在载荷里
   * (`SessionEventEnvelope.sequence`)。
   */
  id?: number
}

/**
 * 事件名 → 载荷类型。**从 `@shared` 派生,不手抄**(§4.2)。
 *
 * 名字取自 `IPC_CHANNELS`(所以打错一个字母是 tsc 红,不是运行时静默),载荷取自
 * `@shared/events` 与 `@shared/ipc/settings`。这三条就是 `GET /api/events` 今天真会
 * 发出来的全部(`backend/server/http.ts` 的 `handleEvents`:会话事件 + 合批后的流分片
 * + 骑同一条 SSE 的设置变更)—— 别把 `/api/voice/events`、`/api/oauth/events` 那些
 * **另外的** SSE 路由的词混进来,它们不在这条流上。
 *
 * **加一条推送 = 在 `@shared` 加一条 + 这张表加一行**,本包其余零改动。
 */
export interface TransportEvents {
  [IPC_CHANNELS.SESSION_EVENT]: SessionEventEnvelope
  [IPC_CHANNELS.SESSION_STREAM]: SessionStreamPayload
  [IPC_CHANNELS.SETTINGS_CHANGED]: AppSettings
}

export type TransportEventName = Extract<keyof TransportEvents, string>

export interface TransportEventsOptions {
  /** 从这个序号**之后**续播(server 侧 `?after=`,与 `Last-Event-ID` 同义)。 */
  after?: number
  signal?: AbortSignal
}

export interface Transport {
  /** 一条 RPC 信封(`@shared/ipc/rpc`)。失败是 `{ ok:false }`,不是 reject。 */
  invoke(request: RpcRequest): Promise<RpcResponse>
  /** 推送流。实现负责断线重连;消费者只管 `for await`。 */
  events(options?: TransportEventsOptions): AsyncIterable<TransportEvent>
  capabilities(): Promise<HostCapabilities>
  /** 停掉这条传输的一切在途工作(在途的 `events()` 循环会正常结束)。 */
  close(): void
}

/**
 * 本包唯一的"往外说话"口子。
 *
 * 不 import `@onething/runtime/logging` 的 `getLogger` —— 那会把整条日志机制
 * (文件 sink / janitor / 崩溃钩子)拖进浏览器构建,而且 runtime 在本包的禁令表上。
 * 宿主想要日志就注一个进来;不注 = 一行不打。
 */
export interface ClientLogger {
  debug?(message: string, fields?: Record<string, unknown>): void
  warn?(message: string, fields?: Record<string, unknown>): void
  error?(message: string, fields?: Record<string, unknown>): void
}
