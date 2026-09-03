/**
 * 壳与 core 之间那一条线(D0 的连通面;C1 起底座换成 `@onething/client`)。
 *
 * 三步,一次性:
 *  1. 宿主在场(Electron 壳)→ 问它要 `{ baseUrl, token }`;浏览器直开
 *     (`web:dev:react`,或 `npm run dev` 不带 Electron)时这一步整个跳过,
 *     `baseUrl` 取**本页 origin**(见 `sameOriginBaseUrl()` 的那段注)。
 *  2. 拿这两格造 **一个** `OnethingClient`(HTTP 传输:`POST /api/rpc` +
 *     `GET /api/events`,token 一律进 `Authorization: Bearer` 头,**不进 URL**)。
 *  3. 订一条推送(`session:event`)、打一次真 RPC 往返(`sessions.list`)。
 *
 * 结果落在 `window.__d0` 上,给 `scripts/gate-connect.mjs` 断言 —— 这是**门**的
 * 观测口,不是产品 UI。
 *
 * ## C1:为什么这里有一个模块级 `client`,而包里没有单例
 *
 * `@onething/client` 刻意不留模块级单例(它要能同时连本机与远端两台 core)。
 * 「这台壳只连一台 core」是**壳**的事实,不是包的事实 —— 所以那一份缺省实例
 * 住在这里,由 `onethingClient()` 交出去。方案 §5.1 原话。
 *
 * ## 状态表一:连接的生命周期(谁触发、这里做什么)
 *
 * | 事件 | 触发者 | 这里做什么 |
 * |---|---|---|
 * | 首连 | 启动时 `main.tsx` 的一次 `whenConnected()` | 问宿主要地址 → 造 client → 订推送 → 一次探针 RPC |
 * | 重连 | 传输自己(SSE 断了就按 `retry:` 指数退避) | 一行不做 —— 重连是传输的活;这里只跟着 `events.status()` 改那一格读数 |
 * | 断开 | core 挂了 / 网断了 | 同上;`status()` 走到 `reconnecting`,续播序号(最后一个 SSE `id`)由传输自己记着 |
 * | 换 core | **今天没有这条路** | 宿主只在启动时给一次 `{baseUrl, token}`;换 core = 重开壳。要支持它就是再 `createOnethingClient` 一个(包已经允许),但那要先有一个「换到哪台」的产品面,本批不造 |
 *
 * ## 状态表二:UI 生命状态(`client.events.status()` 的五格,壳上怎么显)
 *
 * | 状态 | 什么时候 | 壳上怎么显 |
 * |---|---|---|
 * | `idle` | 还没有任何订阅者(推送流按需拉:第一个 `on()` 才连) | 不显 —— 它不是「断了」,是「还没人要听」 |
 * | `connecting` | 流拉起来了,第一条还没到 | 不显 —— 首屏本来就在等数据,再叠一句「连接中」是噪音 |
 * | `live` | 收到过至少一条 | 不显(无消息即好消息) |
 * | `reconnecting` | 流断了,传输在退避重连 | **只落读数**:`window.__d0.status` + `connectionStatus()` / `onConnectionStatusChange()`。**没有横幅、没有 toast** —— 那是用户可感知的新行为,归产品拍板,本批不擅自加(留账见文件末) |
 * | `closed` | `client.close()` 之后,终态 | 不显 —— 今天没有任何一处调 `close()`(壳的生命 = 窗口的生命) |
 *
 * ## 状态表三:交互
 *
 * **一个控件都没有。** 这一层只有读数:`whenConnected()`(一次性、幂等)、
 * `onethingClient()`(拿客户端)、`connectionStatus()` / `onConnectionStatusChange()`
 * (那一格)。没有「重连」按钮 —— 重连是传输自动做的,给一颗按不出新结果的
 * 按钮是假控件;没有「断开」按钮 —— 壳不提供离线模式。
 */
import { createHttpTransport, createOnethingClient } from '@onething/client'
import type { EventHubStatus, OnethingClient } from '@onething/client'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { sessionsRouter } from '@shared/ipc/sessions'
import { notify } from '../services/notify'
import { t } from '../i18n'

export type HostConnectionResult =
  | { ok: true; baseUrl: string; token?: string }
  | { ok: false; error: string }

export type D0Probe = {
  /** 宿主在场 = 跑在新壳里;false = 浏览器直开。 */
  hosted: boolean
  baseUrl?: string
  /** 一次真 RPC 往返是否成功。 */
  rpcOk: boolean
  /** 收到的 SSE 事件条数(累加)。 */
  sseEvents: number
  /** 推送流那一格(表二)。门据此断言重连态。 */
  status: EventHubStatus
  error?: string
}

declare global {
  interface Window {
    onethingHost?: { getConnection(): Promise<HostConnectionResult> }
    __d0?: D0Probe
  }
}

const probe: D0Probe = { hosted: false, rpcOk: false, sseEvents: 0, status: 'idle' }
if (typeof window !== 'undefined') window.__d0 = probe

let client: OnethingClient | undefined
let pending: Promise<D0Probe> | undefined

/**
 * 状态订阅者住在这里、不直接挂到枢纽上,因为**客户端是连通之后才造出来的**:
 * 早于它订的那些人不该拿到一颗永远不响的 noop 退订(那是最典型的静默失灵)。
 */
const statusListeners = new Set<(status: EventHubStatus) => void>()

/**
 * 无宿主(= 浏览器里直开这台壳)时的基址:**本页 origin**。
 *
 * ── 为什么不是空串 ────────────────────────────────────────────────────
 * 空串 = 同源相对路径,`fetch('/api/rpc')` 确实照打 —— 但推送那一条打不出去:
 * `createHttpTransport` 的 SSE 分支要挂 `?after=`,所以走 `new URL(...)`,而
 * **`new URL('/api/events')` 没有 base 会当场抛 `TypeError: Invalid URL`**
 * (`packages/client/transport/http.ts` 的 `eventLoop`)。那一抛落在它自己的
 * try 里,被记成一次「流断了」然后无限退避重连 —— 表现是浏览器里 RPC 全通、
 * 推送**永远**收不到,而且日志上只有一串看不出根因的 `event stream dropped`。
 *
 * 取 origin 之后打出去的是**同一个请求**(同源、根绝对路径),dev 代理照旧接得住。
 * 这也正是 Vue 渲染层那边的做法(`packages/renderer/platform/client.ts` 的
 * `webBaseUrl()`,原话:「`createHttpTransport` 需要一个能进 `new URL()` 的绝对基址」)
 * —— 两个壳同一条判据,不是这里独创的绕法。
 *
 * 没有 `window` 的环境(node 环境的单测)退到一个占位绝对基址:那种环境里没人
 * 会真去打这条传输,给它一个能过 `new URL()` 的值即可。
 *
 * **token 这里一个字都不给**:补 Bearer 的是 dev 代理(它从发现文件里读),
 * 浏览器不知道 token —— 这是设计,不是缺口。
 */
function sameOriginBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost'
  return window.location?.origin || 'http://localhost'
}

async function connect(): Promise<D0Probe> {
  const host = typeof window === 'undefined' ? undefined : window.onethingHost
  let baseUrl = sameOriginBaseUrl()
  let token: string | undefined
  if (host) {
    probe.hosted = true
    const result = await host.getConnection()
    if (result.ok) {
      baseUrl = result.baseUrl
      token = result.token
      probe.baseUrl = result.baseUrl
    } else {
      probe.error = result.error
    }
  }

  // 宿主说连不上时**也**把客户端造出来(基址退回本页 origin)——
  // 与从前 `configureWebTransport` 没被调到时的形逐字相同:各端口照旧拿得到
  // 一个客户端,只是它打出去的请求会失败。没有客户端会让它们卡在 await 上。
  client = createOnethingClient({
    transport: createHttpTransport({ baseUrl, ...(token ? { token } : {}) }),
  })
  const hub = client.events
  probe.status = hub.status()
  hub.onStatusChange(next => {
    probe.status = next
    for (const listener of [...statusListeners]) listener(next)
  })

  if (probe.error) return probe

  // SSE 先订上再打 RPC:门要在往返之后才造事件,订阅晚了就漏。
  // (这一条订阅也是推送流的**第一个**订阅者 —— 枢纽按需拉流,没人订就不连。)
  hub.on(IPC_CHANNELS.SESSION_EVENT, () => {
    probe.sseEvents += 1
  })

  try {
    const sessions = await client.api(sessionsRouter).list({})
    probe.rpcOk = sessions.success === true
    if (!sessions.success) probe.error = sessions.error || 'sessions.list 未成功'
  } catch (error) {
    probe.error = error instanceof Error ? error.message : String(error)
  }
  return probe
}

/**
 * 幂等:多次调用共用同一次连通,返回同一个探针对象。
 *
 * 连不通要**说出来**:在这之前它只落在 `window.__d0.error` 上(那是门的观测口,
 * 用户看不见),会话总览里那句「没连上 core」也只有开着总览的人才撞得见。
 * 报一条 warn —— 弹 8s、不拦路、进通知中心存档,过后还翻得到那句错误原文。
 *
 * ── 留账:重连那一档现在**有产地了**,但仍然不报 ────────────────────────
 * 从前这里写着「重连成功那一半没有产地」,理由是传输面不长连接状态事件。
 * C1 之后它长出来了(`client.events.status()` / `onStatusChange`,表二),
 * 所以那条留账的前提没了。**可是本批仍然不报**:弹一句「重连中」/「已恢复」
 * 是用户可感知的新行为(而且重连在弱网下会反复发生,报法要么节流要么静音,
 * 那是一次产品拍板)。本批只把那一格**读数**接出来,谁来显、显不显、怎么显
 * 留给下一次拍板。
 */
export function whenConnected(): Promise<D0Probe> {
  pending ??= connect()
    .catch(error => {
      probe.error = error instanceof Error ? error.message : String(error)
      return probe
    })
    .then(result => {
      if (result.error) {
        notify({
          level: 'warn',
          source: 'platform.connection',
          title: t('notify.disconnected'),
          body: result.error,
        })
      }
      return result
    })
  return pending
}

/**
 * 这台壳的那一个客户端。第一次调会顺带把连通跑完(幂等)。
 *
 * 各 `data/*-port.ts` 的真实现从这里取 `client.api(xxxRouter)` /
 * `client.events.on(...)`。**没有按域的客户端文件** —— 要短名字就在用它的那个
 * 端口里写一行 `const sessionsApi = client.api(sessionsRouter)`(方案 §4.2)。
 */
export async function onethingClient(): Promise<OnethingClient> {
  await whenConnected()
  // `connect()` 无论成败都会把它造出来(见上面那段注)。
  if (!client) throw new Error('onething client was not created')
  return client
}

/** 推送流那一格(表二)。同步读,给门与将来的产品面用。 */
export function connectionStatus(): EventHubStatus {
  return client?.events.status() ?? probe.status
}

/**
 * 订那一格的变化。返回退订函数。
 *
 * **连通之前订也算数**:订阅者住在本模块的表里,客户端造出来之后由那一条
 * `onStatusChange` 统一转发(见 `connect()`)—— 不会因为订早了就永远收不到。
 */
export function onConnectionStatusChange(
  callback: (status: EventHubStatus) => void,
): () => void {
  statusListeners.add(callback)
  return () => statusListeners.delete(callback)
}

export function d0Probe(): D0Probe {
  return probe
}
