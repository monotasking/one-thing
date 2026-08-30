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

/**
 * 幂等:多次调用共用同一次连通,返回同一个探针对象。
 *
 * 连不通要**说出来**:在这之前它只落在 `window.__d0.error` 上(那是门的观测口,
 * 用户看不见),会话总览里那句「没连上 core」也只有开着总览的人才撞得见。
 * 报一条 warn —— 弹 8s、不拦路、进通知中心存档,过后还翻得到那句错误原文。
 *
 * ── 留账:重连成功这一半没有产地 ──────────────────────────────────────────
 * 本批只做「一次性连通失败」这一处。SSE 断线重连住在 packages/renderer 的传输面里
 * (apps/desktop-react 之外,本批改动范围限本应用),那一侧今天既不上报断线也不上报
 * 重连成功 —— 新壳这边没有一个**干净的挂点**能观察到它,硬造一个轮询探针就是为了
 * 报一句话再引进一个负载。所以 success '重连成功' 那一档暂缺,补它的前提是传输面
 * 先长出连接状态事件。
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

export function d0Probe(): D0Probe {
  return probe
}
