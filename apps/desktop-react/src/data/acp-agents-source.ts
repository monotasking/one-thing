import {
  acpRouter,
  type ACPAddAgentResponse,
  type ACPAgentConfig,
  type ACPAgentState,
  type ACPAuthenticateRequest,
  type ACPAuthenticateResponse,
  type ACPDetectResponse,
  type ACPGetAgentsResponse,
  type ACPRemoveAgentResponse,
  type ACPUpdateAgentResponse,
} from '@shared/ipc/acp'
import { createMutation, createQuery, type Mutation } from './kernel'
import { notify } from '../services/notify'
import { t } from '../i18n'

/**
 * **ACP agent 名册**(A1-b,正本 `docs/design/acp-integration-2026-09.md` §3.8 / §3.9 / §11.2)。
 *
 * 设置页「Agent」那一页与模型选择器的 acp 行读的是**同一格**:`acpAgentsQuery`
 * (`acp.getAgents`,每行 = 一台 agent 的生效配置 + 自述 + 来处 + 探测结果 + 进程状态)。
 * 两处不各拉一份 —— 选择器里「未安装置灰」与设置页「未安装」说的是同一件事实,
 * 两份缓存迟早一边说装了一边说没装。
 *
 * ── 一格读,五条写,一条推送 ─────────────────────────────────────────────
 * | 要什么 | 产地 |
 * | --- | --- |
 * | 整张名册 | `acpAgentsQuery`(`acp.getAgents`) |
 * | 某一台的进程状态变了 | 全局事件 `acp:agent-state` → **就地替换那一行**(按 `config.id`) |
 * | 重新探测 / 刷新注册表 | `detectAgentsMutation` / `refreshRegistryMutation`:回答就是整张名册,直接落格 |
 * | 加 / 改 / 删 | `addAgentMutation` / `updateAgentMutation` / `removeAgentMutation`,写完 `invalidate()` 对账 |
 * | 去登录(A3-d) | `authenticateAgentMutation`(`acp.authenticate`):回答原样交回;登上之后的名册变化走推送 |
 *
 * ── 改一台种子 / 注册表 agent 时,发出去的是什么 ───────────────────────────
 * 后端把这类 agent 的覆盖存成**稀疏**的(`sparseOnethingACPRosterOverride`:与
 * manifest 推出来的值相等的格一律丢),而 `updateAgent` 对已有覆盖是**整条替换**。
 * 所以壳不能只发 `{ id, enabled }`:那样会把用户上一次改过的命令 / 参数一起抹掉。
 * 壳发的是「此刻屏上这一台的生效配置 ⊕ 这一次改的那几格」,由后端把没改的那些
 * 格(与种子相等)剥掉 —— 落盘的仍然只有改过的字段。唯一要当心的是 `enabled`:
 * 后端对它「显式给了就存」,而生效配置里的 `enabled` 可能只是缺省(= 探测到已安装)
 * 推出来的。判据写在 `updatePayloadOf` 上。
 */

export interface AcpAgentsPort {
  ready(): Promise<unknown>
  getAgents(): Promise<ACPGetAgentsResponse>
  detect(agentId?: string): Promise<ACPDetectResponse>
  refreshRegistry(): Promise<ACPDetectResponse>
  addAgent(config: ACPAgentConfig): Promise<ACPAddAgentResponse>
  updateAgent(config: ACPAgentConfig): Promise<ACPUpdateAgentResponse>
  removeAgent(agentId: string): Promise<ACPRemoveAgentResponse>
  /** 「去登录」(A3-c 的 `acp.authenticate`;A3-d 壳半边)。 */
  authenticate(request: ACPAuthenticateRequest): Promise<ACPAuthenticateResponse>
  /** `acp:agent-state` 的推送面。返回退订函数。 */
  onAgentState(callback: (state: ACPAgentState) => void): () => void
}

let port: AcpAgentsPort | undefined
let pending: Promise<AcpAgentsPort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureAcpAgentsPort(next: AcpAgentsPort | undefined): void {
  port = next
  pending = undefined
}

/** 一帧 `acp:agent-state` 的载荷认不认。形不对就丢(推送面是不可信输入)。 */
export function agentStateOfFrame(data: unknown): ACPAgentState | null {
  if (!data || typeof data !== 'object') return null
  const state = (data as { state?: unknown }).state
  if (!state || typeof state !== 'object') return null
  const config = (state as { config?: unknown }).config
  if (!config || typeof config !== 'object' || typeof (config as { id?: unknown }).id !== 'string') return null
  return state as ACPAgentState
}

async function realPort(): Promise<AcpAgentsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const acp = client.api(acpRouter)
  return {
    ready: () => whenConnected(),
    getAgents: () => acp.getAgents({}),
    detect: (agentId) => acp.detect(agentId ? { agentId } : {}),
    refreshRegistry: () => acp.refreshRegistry({}),
    addAgent: (config) => acp.addAgent({ config }),
    updateAgent: (config) => acp.updateAgent({ config }),
    removeAgent: (agentId) => acp.removeAgent({ agentId }),
    authenticate: (request) => acp.authenticate(request),
    onAgentState: (callback) =>
      client.events.onAny((frame) => {
        if (frame.name !== 'acp:agent-state') return
        const state = agentStateOfFrame(frame.data)
        if (state) callback(state)
      }),
  }
}

function acpAgentsPort(): Promise<AcpAgentsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

function rowsOf(response: ACPGetAgentsResponse): ACPAgentState[] {
  if (!response.success) throw new Error(response.error || t('agents.loadFailed'))
  return response.agents ?? []
}

export const acpAgentsQuery = createQuery<ACPAgentState[]>('acp.agents', async () => {
  const p = await acpAgentsPort()
  await p.ready()
  return rowsOf(await p.getAgents())
})

/* ── 纯判据 ────────────────────────────────────────────────────────────── */

/** 一行替换进名册(按 `config.id`);没有这一行就接到末尾(新加的那一台先于重拉到达)。 */
export function replaceAgentRow(rows: readonly ACPAgentState[], next: ACPAgentState): ACPAgentState[] {
  const index = rows.findIndex((row) => row.config.id === next.config.id)
  if (index === -1) return [...rows, next]
  const out = rows.slice()
  // 推送帧是进程管家那一侧的状态,名册那三格(manifest / source / detect)装配层补过;
  // 万一哪一帧没带,留着旧行的,不让一帧状态把「装没装」擦成未知。
  out[index] = {
    ...next,
    manifest: next.manifest ?? rows[index]!.manifest,
    source: next.source ?? rows[index]!.source,
    detect: next.detect ?? rows[index]!.detect,
  }
  return out
}

/** 来处:缺席按「用户手加」算 —— 进程管家眼里的行都是 settings 里那一份。 */
export function sourceOf(state: ACPAgentState): 'builtin' | 'registry' | 'user' {
  return state.source ?? 'user'
}

/**
 * **这一次 `updateAgent` 发出去的那一份**(判词在文件头第二段)。
 *
 * · 用户手加的条目:整份存(它没有 manifest 可以相减)→ 生效配置 ⊕ 改动;
 * · 种子 / 注册表来的:生效配置 ⊕ 改动,后端把与 manifest 相等的格剥掉。`enabled`
 *   只在两种情形下带上:这一次改的就是它;或者生效值与缺省(= 探测到已安装)不同
 *   —— 那说明用户上一次**显式**拨过它,这一次改别的格不能把那一拨抹掉。
 *   与缺省相同就不带:带上会把一个本来随探测走的值钉死。
 */
export function updatePayloadOf(state: ACPAgentState, patch: Partial<ACPAgentConfig>): ACPAgentConfig {
  const base: Partial<ACPAgentConfig> = { ...state.config }
  if (sourceOf(state) !== 'user' && !('enabled' in patch)) {
    const defaultEnabled = state.detect?.installed ?? false
    if (state.config.enabled === defaultEnabled) delete base.enabled
  }
  return { ...base, ...patch, id: state.config.id } as ACPAgentConfig
}

/** 一个名字 → 一个 id(`[a-z0-9-]`)。拼不出(全是汉字)就用前缀加时间戳,**不跟已有的撞**。 */
export function agentIdFromName(name: string, taken: readonly string[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = slug || `custom-${Date.now().toString(36)}`
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/** 「参数」那一格的一行字 ↔ 数组。按空白切,引号不认(与 MCP 表单同一口径:要空格的参数走高级区的环境变量)。 */
export function argsFromLine(line: string): string[] {
  return line.split(/\s+/).filter(Boolean)
}

export function argsToLine(args: readonly string[] | undefined): string {
  return (args ?? []).join(' ')
}

/* ── 写 ────────────────────────────────────────────────────────────────── */

function failed(error: Error, title: string, source: string): void {
  notify({ level: 'error', source, title, body: error.message, detail: error.message })
}

/**
 * 「重新探测」/「刷新注册表」。回答就是整张名册 —— 直接落格,不再拉一遍。
 *
 * 失败**不弹通知**(派工单:这两颗钮就地给结果):错在 mutation 快照的 `error` 上,
 * 页头那一行读它。
 */
function rosterWrite(name: string, call: (p: AcpAgentsPort) => Promise<ACPDetectResponse>): Mutation<void, void> {
  return createMutation<void, void>(name, {
    run: async () => {
      const rows = rowsOf(await call(await acpAgentsPort()))
      acpAgentsQuery.patch(rows)
    },
  })
}

export const detectAgentsMutation: Mutation<void, void> = rosterWrite('acp.detect', (p) => p.detect())
export const refreshRegistryMutation: Mutation<void, void> = rosterWrite('acp.refreshRegistry', (p) =>
  p.refreshRegistry(),
)

export interface UpdateAgentInput {
  state: ACPAgentState
  patch: Partial<ACPAgentConfig>
}

/**
 * 改一台。忙态按 **agent id + 改的那几格** 分(律③:拨启用开关不该把高级区的「保存」一起禁掉)。
 * 乐观补丁先把那几格翻过去,失败由 kernel 回滚 + 一条通知。
 */
export function updatePendingKey(agentId: string, part: UpdatePart): string {
  return `${agentId}\u0000${part}`
}

/**
 * 这一次改的是哪一格。三格各自一把忙态(律③):拨「无人值守」不该把启用开关与
 * 高级区的「保存」一起禁掉。
 */
export type UpdatePart = 'enabled' | 'unattended' | 'advanced'

function updatePartOf(patch: Partial<ACPAgentConfig>): UpdatePart {
  if ('enabled' in patch) return 'enabled'
  if ('unattended' in patch) return 'unattended'
  return 'advanced'
}

export const updateAgentMutation: Mutation<UpdateAgentInput, void> = createMutation<UpdateAgentInput, void>(
  'acp.updateAgent',
  {
    key: (input) => updatePendingKey(input.state.config.id, updatePartOf(input.patch)),
    optimistic: (input) =>
      acpAgentsQuery.patch((prev) =>
        prev
          ? prev.map((row) =>
              row.config.id === input.state.config.id
                ? { ...row, config: { ...row.config, ...input.patch } as ACPAgentConfig }
                : row,
            )
          : prev,
      ),
    run: async (input) => {
      const response = await (await acpAgentsPort()).updateAgent(updatePayloadOf(input.state, input.patch))
      if (!response.success) throw new Error(response.error || t('agents.saveFailed'))
    },
    onError: (error) => failed(error, t('agents.saveFailed'), 'settings.agents'),
    settle: () => acpAgentsQuery.invalidate(),
  },
)

export const addAgentMutation: Mutation<ACPAgentConfig, void> = createMutation<ACPAgentConfig, void>(
  'acp.addAgent',
  {
    run: async (config) => {
      const response = await (await acpAgentsPort()).addAgent(config)
      if (!response.success) throw new Error(response.error || t('agents.saveFailed'))
      if (response.agent) acpAgentsQuery.patch((prev) => replaceAgentRow(prev ?? [], response.agent!))
    },
    onError: (error) => failed(error, t('agents.saveFailed'), 'settings.agents'),
    settle: () => acpAgentsQuery.invalidate(),
  },
)

export const removeAgentMutation: Mutation<string, void> = createMutation<string, void>('acp.removeAgent', {
  key: (agentId) => agentId,
  optimistic: (agentId) => acpAgentsQuery.patch((prev) => prev?.filter((row) => row.config.id !== agentId)),
  run: async (agentId) => {
    const response = await (await acpAgentsPort()).removeAgent(agentId)
    if (!response.success) throw new Error(response.error || t('agents.saveFailed'))
  },
  onError: (error) => failed(error, t('agents.removeFailed'), 'settings.agents'),
  settle: () => acpAgentsQuery.invalidate(),
})

/**
 * 「去登录」(A3-d)。忙态按 agent id 分 —— 两台可以同时各登各的。
 *
 * **回答原样交回**,`ok: false` 也不当失败抛:那是一句「为什么没登上」的机器码
 * (`unavailable` / `no-terminal` / …),归调用方就地查字典说成人话;只有传输层
 * 断了才走 kernel 的失败路(返回 undefined)。不弹通知:结果就在按钮旁边一行字里。
 * 成功不必手动改名册:后端清掉 `auth.required` 之后经 `acp:agent-state` 推过来。
 */
export const authenticateAgentMutation: Mutation<ACPAuthenticateRequest, ACPAuthenticateResponse> = createMutation<
  ACPAuthenticateRequest,
  ACPAuthenticateResponse
>('acp.authenticate', {
  key: (request) => request.agentId,
  run: async (request) => (await acpAgentsPort()).authenticate(request),
})

/* ── 推送 ──────────────────────────────────────────────────────────────── */

/**
 * 订 `acp:agent-state`:某一台连上 / 断开 / 出错,就地换掉那一行。
 *
 * 订阅挂在模块级、全应用一条(设置页与选择器可能同时开着),幂等 ——
 * 与 `notes-source.startNotesSource` 同体例。
 */
let unsubscribe: (() => void) | undefined
let starting: Promise<void> | undefined

export function startAcpAgentsSource(): Promise<void> {
  starting ??= (async () => {
    const p = await acpAgentsPort()
    await p.ready()
    unsubscribe?.()
    unsubscribe = p.onAgentState((state) => {
      // 还一行都没拉到时不凭一帧推送造一张名册:那会让首载骨架跳过、屏上只剩一台。
      if (acpAgentsQuery.get().data === undefined) return
      acpAgentsQuery.patch((prev) => (prev ? replaceAgentRow(prev, state) : prev))
    })
  })().catch(() => {
    // 连不上就没有推送面 —— 名册照旧可读可写,只是听不见进程状态变。没有一句话是用户此刻在等的。
  })
  return starting
}

/** 测试与 HMR 用:把模块级状态清干净。**本模块唯一的一口拆卸**。 */
export function resetAcpAgentsSource(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
  pending = undefined
  acpAgentsQuery.reset()
  detectAgentsMutation.reset()
  refreshRegistryMutation.reset()
  updateAgentMutation.reset()
  addAgentMutation.reset()
  removeAgentMutation.reset()
  authenticateAgentMutation.reset()
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法):推送订阅与惰性端口。
 * 退役复用上面那一口拆卸。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetAcpAgentsSource()
  })
}
