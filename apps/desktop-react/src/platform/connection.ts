/**
 * D0 的渲染层连通面(`docs/design/react-shell-2026-08.md` P0)。
 *
 * 三步,一次性:
 *  1. 宿主在场(Electron 壳)→ 问它要 `{ baseUrl, token }`,灌进
 *     `@renderer/platform` 的传输面单槽端口(§5.6 甲案)。浏览器直开
 *     (`npm run dev` 不带 Electron)时这一步整个跳过 —— 同源相对路径照旧成立。
 *  2. 订一条 SSE(`session:event`)。
 *  3. 打一次真 RPC 往返(`sessions.list`,走 `POST /api/rpc`)。
 *
 * 结果落在 `window.__d0` 上,给 `scripts/gate-connect.mjs` 断言 —— 这是**门**的
 * 观测口,不是产品 UI。P1 接真数据时它会被真的会话列表取代。
 */
import { platformApi } from '@renderer/platform'
import { sessionsApi } from '@renderer/platform/sessions-client'
import { configureWebTransport } from '@renderer/platform/transport-config'

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
  error?: string
}

declare global {
  interface Window {
    onethingHost?: { getConnection(): Promise<HostConnectionResult> }
    __d0?: D0Probe
  }
}

const probe: D0Probe = { hosted: false, rpcOk: false, sseEvents: 0 }
if (typeof window !== 'undefined') window.__d0 = probe

let pending: Promise<D0Probe> | undefined

async function connect(): Promise<D0Probe> {
  const host = typeof window === 'undefined' ? undefined : window.onethingHost
  if (host) {
    probe.hosted = true
    const result = await host.getConnection()
    if (!result.ok) {
      probe.error = result.error
      return probe
    }
    configureWebTransport({ baseUrl: result.baseUrl, token: result.token })
    probe.baseUrl = result.baseUrl
  }

  // SSE 先订上再打 RPC:门要在往返之后才造事件,订阅晚了就漏。
  platformApi.onSessionEvent(() => {
    probe.sseEvents += 1
  })

  try {
    const sessions = await sessionsApi.list({})
    probe.rpcOk = sessions.success === true
    if (!sessions.success) probe.error = sessions.error || 'sessions.list 未成功'
  } catch (error) {
    probe.error = error instanceof Error ? error.message : String(error)
  }
  return probe
}

/** 幂等:多次调用共用同一次连通,返回同一个探针对象。 */
export function whenConnected(): Promise<D0Probe> {
  pending ??= connect().catch(error => {
    probe.error = error instanceof Error ? error.message : String(error)
    return probe
  })
  return pending
}

export function d0Probe(): D0Probe {
  return probe
}
