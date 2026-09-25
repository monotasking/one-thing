import { useEffect, useMemo } from 'react'
import { acpRouter, type ACPSessionStateRequest, type ACPSessionStateResponse } from '@shared/ipc/acp'
import type { AcpSessionState } from '@shared/contracts/acp'
import { createQuery, createQueryFamily, useQuery } from './kernel'
import type { Query } from './kernel'
import { useCurrentModelSelection } from './models-source'
import type { ModelSelection } from './models-source'
import { LOCAL_MODE_KINDS } from '../providers/families'

/**
 * **一条 ACP 会话此刻的状态**(A2-c 壳侧,正本 `docs/design/acp-integration-2026-09.md`
 * §3.3 / §3.8 / §11.4)。
 *
 * agent 在会话里自己推来的那些「与哪条消息无关」的事实 —— 可用命令、模式、选项、用量、
 * 通知、压缩、进程 —— 后端折成一张表(`AcpSessionState`),变了就把**整张表**当一帧
 * 全局事件 `acp:session-state` 推出来。壳这一侧只做两件事:冷读一次、之后整张替换。
 * composer 上的药丸 / 模式粒 / 思考档 / 命令抽屉 / 读数卡 / 会话横条读的都是这一格,
 * 所以它们对「这条会话此刻用哪个模型」永远说同一句话。
 *
 * ── 一格读,一条推送 ─────────────────────────────────────────────────────
 * | 要什么 | 产地 |
 * | --- | --- |
 * | 冷读(开壳 / 换会话 / 刚绑上这台 agent) | `acpSessionStateQuery`(`acp.sessionState`,只读后端内存,**不起进程、不开会话**) |
 * | agent 推了什么 | 全局事件 `acp:session-state` → **整张替换那一格**(按 `localSessionId` × `agentId`) |
 *
 * ── 为什么一格是「会话 × agent」而不只是会话 ──────────────────────────────
 * 同一条本地会话可以换一台 agent。键只按会话的话,换过去之后那一格早已「问过」,
 * 冷读不会再发,屏上留着上一台的模型名;按两格键控,换 agent 就是换了一格,自然重问。
 * 推送帧自带 `agentId`,落格按同一把键,不会把上一台迟到的一帧写到这一台身上。
 *
 * ── 冷读与推送赛跑 ───────────────────────────────────────────────────────
 * 冷读在飞时推来一帧:推送是**更新的**事实,冷读答回来的却可能是它出发那一刻的旧表
 * (甚至是 null)。所以每一格记一个推送计数,冷读回来时计数变过就交最近那一帧,
 * 不交自己手上那份 —— 否则一次开壳恰好撞上 agent 推命令表,命令表会被冷读抹回空。
 *
 * ── 非 agent 会话零往返 ──────────────────────────────────────────────────
 * `useAcpSessionState` 先问这条会话选的是不是一台 agent(`LOCAL_MODE_KINDS[provider] === 'acp'`,
 * 与模型抽屉认 agent 卡的是同一句判据);不是就直接答 null,**不建格、不发 RPC、不订推送**。
 * 草稿(还没有会话 id)同样答 null:后端那张表按会话记,草稿还没有会话。
 */

export interface AcpSessionStatePort {
  ready(): Promise<unknown>
  sessionState(request: ACPSessionStateRequest): Promise<ACPSessionStateResponse>
  /** `acp:session-state` 的推送面。返回退订函数。 */
  onSessionState(callback: (state: AcpSessionState) => void): () => void
}

let port: AcpSessionStatePort | undefined
let pending: Promise<AcpSessionStatePort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureAcpSessionStatePort(next: AcpSessionStatePort | undefined): void {
  port = next
  pending = undefined
}

/** 一帧 `acp:session-state` 的载荷认不认。形不对就丢(推送面是不可信输入)。 */
export function sessionStateOfFrame(data: unknown): AcpSessionState | null {
  if (!data || typeof data !== 'object') return null
  const state = (data as { state?: unknown }).state
  if (!state || typeof state !== 'object') return null
  const { localSessionId, agentId } = state as { localSessionId?: unknown; agentId?: unknown }
  if (typeof localSessionId !== 'string' || typeof agentId !== 'string') return null
  // 下游按数组读的几格缺了就补空 —— 一帧缺格的推送不该让读数卡或命令抽屉当场抛错。
  const raw = state as Partial<AcpSessionState>
  return {
    ...(state as AcpSessionState),
    configOptions: Array.isArray(raw.configOptions) ? raw.configOptions : [],
    commands: Array.isArray(raw.commands) ? raw.commands : [],
    notices: Array.isArray(raw.notices) ? raw.notices : [],
    process: raw.process && typeof raw.process === 'object' ? raw.process : { status: 'disconnected' },
  }
}

async function realPort(): Promise<AcpSessionStatePort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const acp = client.api(acpRouter)
  return {
    ready: () => whenConnected(),
    sessionState: (request) => acp.sessionState(request),
    onSessionState: (callback) =>
      client.events.onAny((frame) => {
        if (frame.name !== 'acp:session-state') return
        const state = sessionStateOfFrame(frame.data)
        if (state) callback(state)
      }),
  }
}

function sessionStatePort(): Promise<AcpSessionStatePort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

/** 一格 = 一条会话 × 一台 agent。分隔符取一个 id 里不会出现的字。 */
const SEP = '\u0000'

export function acpSessionStateKey(sessionId: string, agentId: string): string {
  return `${sessionId}${SEP}${agentId}`
}

function parseKey(key: string): { sessionId: string; agentId: string } {
  const [sessionId = '', agentId = ''] = key.split(SEP)
  return { sessionId, agentId }
}

/** 每一格最近一帧推送与它的序号(赛跑判据,见文件头第三段)。 */
const pushed = new Map<string, { seq: number; state: AcpSessionState }>()

export const acpSessionStateQuery = createQueryFamily<AcpSessionState | null>('acp.sessionState', async (ctx) => {
  const { sessionId, agentId } = parseKey(ctx.key)
  const before = pushed.get(ctx.key)?.seq ?? 0
  const p = await sessionStatePort()
  await p.ready()
  const answer = await p.sessionState({ sessionId, agentId })
  const latest = pushed.get(ctx.key)
  if (latest && latest.seq !== before) return latest.state
  // 读到的是另一台的表(后端按「正开着它的那台」回答时可能发生):对这一格来说等于没有。
  return answer && answer.agentId === agentId ? answer : null
})

/* ── 推送 ──────────────────────────────────────────────────────────────── */

let unsubscribe: (() => void) | undefined
let starting: Promise<void> | undefined
let pushSeq = 0

/**
 * 订 `acp:session-state`:整张替换那一格。全应用一条订阅,幂等(与
 * `acp-agents-source.startAcpAgentsSource` 同体例)。
 *
 * **不替没人问过的格建格**:一台 agent 为一条此刻没挂在屏上的会话推状态很常见
 * (后台的会话、另一扇窗的会话),为它们各建一格只是拿推送制造缓存;那一格日后
 * 第一次被问时冷读答的就是后端内存里最新那张表。推送序号照记,供赛跑判据用。
 */
export function startAcpSessionStateSource(): Promise<void> {
  starting ??= (async () => {
    const p = await sessionStatePort()
    await p.ready()
    unsubscribe?.()
    unsubscribe = p.onSessionState((state) => {
      const key = acpSessionStateKey(state.localSessionId, state.agentId)
      pushSeq += 1
      pushed.set(key, { seq: pushSeq, state })
      if (!acpSessionStateQuery.keys().includes(key)) return
      acpSessionStateQuery.get(key).patch(state)
    })
  })().catch(() => {
    // 连不上就没有推送面 —— 冷读照旧能答,只是听不见 agent 后来推的。没有一句话是用户此刻在等的。
    starting = undefined
  })
  return starting
}

/* ── 读 ────────────────────────────────────────────────────────────────── */

/** 这一选中是不是一台 agent(provider 属 acp 那一族),是就答 agent id。判据与模型抽屉认 agent 卡同源。 */
export function agentIdOfSelection(selection: ModelSelection | null): string | null {
  if (!selection?.model) return null
  return LOCAL_MODE_KINDS[selection.provider] === 'acp' ? selection.model : null
}

/**
 * **这条会话此刻在 agent 那边的状态**;不是 agent 会话 / 草稿 / agent 还没开过这条会话 = null。
 *
 * 读的是会话的选中(`useCurrentModelSelection`,药丸也读它),所以乐观换 agent 的那一刻
 * 这里就换了一格,不必等会话摘要落地。
 */
export function useAcpSessionState(sessionId: string): AcpSessionState | null {
  const selection = useCurrentModelSelection(sessionId)
  const agentId = agentIdOfSelection(selection)
  const key = sessionId && agentId ? acpSessionStateKey(sessionId, agentId) : null
  const query = useMemo(() => (key ? acpSessionStateQuery.get(key) : null), [key])
  useEffect(() => {
    if (!query) return
    void startAcpSessionStateSource()
    void query.ensure()
  }, [query])
  return useOptionalQueryData(query)
}

/**
 * `useQuery` 要一个真 query;非 agent 会话没有格可订,于是订这一只**永远没人 `ensure`** 的
 * 空格 —— `useQuery` 只 `subscribe` / `get`,fetcher 一次都不会跑,零往返。
 */
const NONE_QUERY = createQuery<AcpSessionState | null>('acp.sessionState.none', async () => null)

function useOptionalQueryData(query: Query<AcpSessionState | null> | null): AcpSessionState | null {
  const snapshot = useQuery(query ?? NONE_QUERY)
  return query ? (snapshot.data ?? null) : null
}

/* ── 拆卸 ──────────────────────────────────────────────────────────────── */

/** 测试与 HMR 用:把模块级状态清干净。**本模块唯一的一口拆卸**。 */
export function resetAcpSessionStateSource(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
  pending = undefined
  pushed.clear()
  pushSeq = 0
  acpSessionStateQuery.reset()
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法):推送订阅、惰性端口、推送序号表。
 * 退役复用上面那一口拆卸。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetAcpSessionStateSource()
  })
}
