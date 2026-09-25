import {
  acpRouter,
  type ACPAdoptSessionResponse,
  type ACPAgentState,
  type ACPForkSessionResponse,
  type ACPListRemoteSessionsResponse,
  type ACPReconnectAgentResponse,
  type AcpReconnectBackoff,
  type AcpRemoteSessionInfo,
} from '@shared/ipc/acp'
import { createMutation, createQueryFamily, type Mutation } from './kernel'
import { acpAgentsQuery, replaceAgentRow } from './acp-agents-source'

/**
 * **ACP 会话生命的壳半边**(A5-b,正本 `docs/design/acp-integration-2026-09.md` §3.7 / §11.6 A5)。
 *
 * | 要什么 | 产地 |
 * | --- | --- |
 * | 某台 agent 在某个目录下存着哪些会话 | `remoteSessionsFamily`(`acp.listRemoteSessions`,键 = agent × 目录)|
 * | 把其中一条认领成本地会话 | `adoptSessionMutation`(`acp.adoptSession`;忙态按 agent × 远端 id 分)|
 * | 从一条 ACP 会话分叉出一条新的 | `forkSessionMutation`(`acp.forkSession`;忙态按会话 id 分)|
 * | 退避闩上之后手动重连 | `reconnectAgentMutation`(`acp.reconnectAgent`;忙态按 agent id 分)|
 *
 * ── `ok: false` 不是失败 ─────────────────────────────────────────────────
 * 四条 RPC 的回答都是「成 / 不成 + 机器码」两种形。`unsupported`(这台 agent 没自报那个能力位)、
 * `unavailable`(连不上 / 停用 / 退避锁着)是**这台 agent 的事实**,归调用方就地查字典说成人话 ——
 * 与 `authenticateAgentMutation` 同一条判例;只有传输层断了才走 kernel 的失败路(query 的
 * `error` / mutation 返回 undefined)。
 */

export type AcpRemoteSession = AcpRemoteSessionInfo
export type AcpListRemoteSessionsResponse = ACPListRemoteSessionsResponse
export type AcpAdoptSessionResponse = ACPAdoptSessionResponse
export type AcpForkSessionResponse = ACPForkSessionResponse
export type AcpReconnectAgentResponse = ACPReconnectAgentResponse
export type AcpAgentBackoff = AcpReconnectBackoff
export type AcpLifeFailCode = 'unsupported' | 'unavailable' | 'failed'

/* ── 端口 ──────────────────────────────────────────────────────────────── */

export interface AcpSessionsPort {
  ready(): Promise<unknown>
  listRemoteSessions(agentId: string, cwd: string | undefined): Promise<AcpListRemoteSessionsResponse>
  adoptSession(input: { agentId: string; acpSessionId: string; cwd: string }): Promise<AcpAdoptSessionResponse>
  forkSession(input: { sessionId: string; agentId?: string }): Promise<AcpForkSessionResponse>
  reconnectAgent(agentId: string): Promise<AcpReconnectAgentResponse>
}

let port: AcpSessionsPort | undefined
let pending: Promise<AcpSessionsPort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureAcpSessionsPort(next: AcpSessionsPort | undefined): void {
  port = next
  pending = undefined
}

async function realPort(): Promise<AcpSessionsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const acp = client.api(acpRouter)
  return {
    ready: () => whenConnected(),
    listRemoteSessions: (agentId, cwd) => acp.listRemoteSessions(cwd ? { agentId, cwd } : { agentId }),
    adoptSession: (input) => acp.adoptSession(input),
    forkSession: (input) => acp.forkSession(input),
    reconnectAgent: (agentId) => acp.reconnectAgent({ agentId }),
  }
}

function acpSessionsPort(): Promise<AcpSessionsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

/* ── 纯判据 ────────────────────────────────────────────────────────────── */

/**
 * 这台 agent 在握手里自报了 `sessionCapabilities.<cap>` 没有。
 *  · `true`  = 报了(协议里能力位是一个对象,在场即有);
 *  · `false` = 握手过、没报;
 *  · `undefined` = **不知道** —— 还没连过(`capabilities` 缺席)。
 * 「不知道」与「没有」分开:导入入口对前者照样画那一台,让 RPC 的 `unsupported` 当场说话。
 */
export function sessionCapabilityOf(state: ACPAgentState, cap: 'list' | 'fork'): boolean | undefined {
  const caps = state.capabilities
  if (!caps) return undefined
  const session = (caps as Record<string, unknown>).sessionCapabilities
  if (!session || typeof session !== 'object') return false
  const value = (session as Record<string, unknown>)[cap]
  return value !== undefined && value !== null && value !== false
}

/** 能拿来「导入」的那几台:启用、装着、没明说不会列。名册顺序不动。 */
export function importCandidatesOf(rows: readonly ACPAgentState[] | undefined): ACPAgentState[] {
  return (rows ?? []).filter(
    (row) => row.config.enabled && Boolean(row.detect?.installed) && sessionCapabilityOf(row, 'list') !== false,
  )
}

/**
 * 一条会话能不能「分叉」:它是 ACP 会话(`provider === 'acp'`,`model` = agent id),那台 agent
 * 在名册里且**明确**报了 `fork`。不知道就不画 —— 菜单里一行点了才说「不支持」是在撒谎。
 * 回答那台 agent 的 id(调用方递给 `forkSession`),不能分叉 = `undefined`。
 */
export function forkAgentOf(
  session: { provider?: string | null; model?: string | null } | undefined,
  rows: readonly ACPAgentState[] | undefined,
): string | undefined {
  if (!session || session.provider !== 'acp' || !session.model) return undefined
  const row = rows?.find((r) => r.config.id === session.model)
  if (!row) return undefined
  return sessionCapabilityOf(row, 'fork') === true ? row.config.id : undefined
}

/** 这一行的退避读数(A5-a 给;缺席 = 没退避过)。 */
export function backoffOf(state: ACPAgentState): AcpAgentBackoff | undefined {
  return state.backoff
}

/** 退避闩上了没有:连崩三次、自动重连已停。 */
export function backoffLatched(state: ACPAgentState): boolean {
  return backoffOf(state)?.latched === true
}

/** 协议给的 `updatedAt`(ISO 或毫秒)→ 毫秒;认不出 = undefined。 */
export function remoteUpdatedAtMs(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** 族键:agent × 目录。`\u0000` 分隔(id 只收 `[a-z0-9-]`,路径里不会有 NUL)。 */
export function remoteSessionsKey(agentId: string, cwd: string): string {
  return `${agentId}\u0000${cwd}`
}

function parseRemoteKey(key: string): { agentId: string; cwd: string } {
  const at = key.indexOf('\u0000')
  return at === -1 ? { agentId: key, cwd: '' } : { agentId: key.slice(0, at), cwd: key.slice(at + 1) }
}

/* ── 读 ────────────────────────────────────────────────────────────────── */

/**
 * 某台 agent 在某个目录下存着的会话。**一格 = 一次「从 X 导入」**;重开对话框时旧答案留在屏上
 * 并后台对账(律②),认领之后那一格 `invalidate` 让「已导入」标记跟上。
 */
export const remoteSessionsFamily = createQueryFamily<AcpListRemoteSessionsResponse>(
  'acp.remoteSessions',
  async (context) => {
    const { agentId, cwd } = parseRemoteKey(context.key)
    const p = await acpSessionsPort()
    await p.ready()
    return p.listRemoteSessions(agentId, cwd || undefined)
  },
)

/* ── 写 ────────────────────────────────────────────────────────────────── */

export interface AdoptInput {
  agentId: string
  acpSessionId: string
  cwd: string
}

export function adoptPendingKey(agentId: string, acpSessionId: string): string {
  return `${agentId}\u0000${acpSessionId}`
}

/**
 * 认领一条。回答原样交回(`ok: false` 由调用方就地说);成功之后那一格名单后台对账,
 * 让这一行换成「已导入」。**会话列表的对账不在这里** —— 调用方紧接着要进那条会话,
 * 它自己 `await refresh()`(与新建会话同一条链,判词在 `sessions-source.create`)。
 */
export const adoptSessionMutation: Mutation<AdoptInput, AcpAdoptSessionResponse> = createMutation<
  AdoptInput,
  AcpAdoptSessionResponse
>('acp.adoptSession', {
  key: (input) => adoptPendingKey(input.agentId, input.acpSessionId),
  run: async (input) => (await acpSessionsPort()).adoptSession(input),
  settle: (_result, input) => remoteSessionsFamily.invalidate(remoteSessionsKey(input.agentId, input.cwd)),
})

export const forkSessionMutation: Mutation<{ sessionId: string; agentId?: string }, AcpForkSessionResponse> =
  createMutation<{ sessionId: string; agentId?: string }, AcpForkSessionResponse>('acp.forkSession', {
    key: (input) => input.sessionId,
    run: async (input) => (await acpSessionsPort()).forkSession(input),
  })

/**
 * 「重新连接」。回答里带着那一行的新状态就当场换进名册(与推送同一口 `replaceAgentRow`);
 * 不管带没带,都对账一次 —— 退避闩是后端的账,壳不自己把它翻回去。
 */
export const reconnectAgentMutation: Mutation<string, AcpReconnectAgentResponse> = createMutation<
  string,
  AcpReconnectAgentResponse
>('acp.reconnectAgent', {
  key: (agentId) => agentId,
  run: async (agentId) => (await acpSessionsPort()).reconnectAgent(agentId),
  settle: (result) => {
    if (result.ok && result.state?.config) {
      const next = result.state
      acpAgentsQuery.patch((prev) => (prev ? replaceAgentRow(prev, next) : prev))
    }
    acpAgentsQuery.invalidate()
  },
})

/** 测试与 HMR 用:本模块唯一的一口拆卸。 */
export function resetAcpSessionsSource(): void {
  pending = undefined
  remoteSessionsFamily.reset()
  adoptSessionMutation.reset()
  forkSessionMutation.reset()
  reconnectAgentMutation.reset()
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法):惰性端口与四格缓存。
 * 退役复用上面那一口拆卸。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetAcpSessionsSource()
  })
}
