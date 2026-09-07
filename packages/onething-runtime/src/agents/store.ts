import {
  createCoreCachedJsonState,
  getCoreCachedJsonFile,
  initializeCoreCachedJsonFile,
  invalidateCoreCachedJsonFile,
  readJsonFile,
  saveCoreCachedJsonFile,
  withFileLockSync,
  type CoreCachedJsonFileOptions,
} from '@onething/core/storage'
import { agentIdentity, agentTombstoneLabel, type OnethingAgentIdentity } from './model.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('agents')

export const DEFAULT_ONETHING_AGENT_ID = 'default'
export const DEFAULT_ONETHING_AGENT_NAME = 'Default Agent'

/** Per-agent model preference; stamped onto drive commands by the room
 *  coordinator (radio-DJ per-command override pattern) — deliberately NOT part
 *  of getEffectiveProviderConfig's resolution chain. */
export interface OnethingAgentModelBinding {
  providerId?: string
  modelId?: string
  thinking?: string
}

/**
 * Agent 分类(域模型 M2,docs/design/agent-domain-model.md §3.1)。
 * - `colleague`(缺省):人格化同事——进联系人、可私聊、可进群、有履历。
 * - `service`:后台设施角色(radio-dj 等)。有身份面,无社交面。
 *
 * MIRROR NOTE: this type family mirrors `AgentDefinition` in the shared
 * package's IPC contract layer (agents contract file) field-for-field — the
 * product layer must not import that layer (boundary checker), and the app
 * layer's `as AgentDefinition` cast relies on the two staying structurally
 * identical.
 */
export type OnethingAgentKind = 'colleague' | 'service'

/**
 * Agent 生命周期(域模型 M3)。UI 的「删除」= 退休:身份面永久保留(墓碑)。
 * 缺省视为 `active`。A0 只定义类型;退休行为矩阵在 A2 落地。
 */
export type OnethingAgentStatus = 'active' | 'retired'

/**
 * 心智面的驱动方(域模型 M7,前瞻)。缺省视为 `{ type: 'native' }`。
 * `external` 指外部执行体连接器(如 'claude-code-agent')。A0 只定义语义,
 * 不接线任何行为。
 */
export type OnethingAgentExecutor =
  | { type: 'native' }
  | { type: 'external'; connectorId: string }

export interface OnethingAgentDefinition {
  id: string
  name: string
  systemPrompt: string
  /**
   * Tool allowlist (tool ids). Absent = all enabled tools; an agent with a
   * list only ever sees those tools in its requests.
   */
  tools?: string[]
  isDefault?: boolean
  createdAt: number
  updatedAt: number
  /** Job title shown in rosters/signatures (e.g. '产品经理'). */
  title?: string
  /** Emoji avatar for signed messages / member bars. */
  avatar?: string
  /**
   * Picture avatar, as a MEDIA LIBRARY FILE NAME (e.g.
   * `9f1c….png` — the `basename` of the asset's `filePath`), never a dataURL
   * and never an absolute path: agents.json is a small hot file read on every
   * roster lookup, and inlined bytes would blow it up. The host resolves the
   * name to a URL (`media://<name>` on desktop, `/api/media/file/<name>` on
   * the server), which is why a bare name — and not a host-specific URL — is
   * what gets persisted. Absent = fall back to `avatar` (emoji).
   */
  avatarImage?: string
  /** Accent color (CSS color) for the signature chip. */
  color?: string
  /** One-line duty statement, rendered into room rosters. */
  description?: string
  model?: OnethingAgentModelBinding
  /**
   * Capability packs layered on top of `tools` — composition instead of the
   * special-casing the engine adapter used to hard-code. See
   * agents/profile.ts for the grant table and how each pack combines
   * (replace vs union) with the agent's own allowlist.
   */
  toolGrants?: string[]
  /**
   * Permission mode this agent needs. Composed with the session/global mode by
   * STRICTNESS, not by override — an agent that asks to be asked is not
   * silenced by a session that turned approvals off. Absent = does not
   * participate in the composition at all.
   */
  permissionMode?: string
  /** Model round-trips per run; absent falls back to settings.chat.maxTurns. */
  maxTurns?: number
  /** 分类(M2)。缺省 = 'colleague'。判定请走 model.ts 的 `isColleague`。 */
  kind?: OnethingAgentKind
  /** 生命周期(M3)。缺省 = 'active'。判定请走 model.ts 的 `isActiveAgent`。 */
  status?: OnethingAgentStatus
  /** 心智驱动方(M7,前瞻)。缺省 = { type: 'native' }。A0 不接线任何行为。 */
  executor?: OnethingAgentExecutor
}

export interface OnethingAgentsFile {
  version: 1
  agents: OnethingAgentDefinition[]
}

export interface CreateOnethingAgentStoreOptions {
  /**
   * Pass a function when the store root is only known after boot — resolving
   * eagerly would freeze `~/.onething` in before ONETHING_STORE_PATH lands
   * (same shape as the settings repository).
   */
  agentsPath: string | (() => string)
  now?: () => number
}

export interface CreateOnethingAgentInput {
  id: string
  name: string
  systemPrompt?: string
  tools?: string[]
  title?: string
  avatar?: string
  avatarImage?: string
  color?: string
  description?: string
  model?: OnethingAgentModelBinding
  toolGrants?: string[]
  permissionMode?: string
  maxTurns?: number
  kind?: OnethingAgentKind
  status?: OnethingAgentStatus
  executor?: OnethingAgentExecutor
}

export interface UpdateOnethingAgentInput {
  agentId: string
  name?: string
  systemPrompt?: string
  /** Array replaces the allowlist; null clears it (agent sees all tools). */
  tools?: string[] | null
  /** For the optional display/model fields: value sets, null clears. */
  title?: string | null
  avatar?: string | null
  /** Media file name sets it; null clears it (back to the emoji). */
  avatarImage?: string | null
  color?: string | null
  description?: string | null
  model?: OnethingAgentModelBinding | null
  toolGrants?: string[] | null
  permissionMode?: string | null
  maxTurns?: number | null
  /** Value sets, null clears (back to the colleague/active/native defaults). */
  kind?: OnethingAgentKind | null
  status?: OnethingAgentStatus | null
  executor?: OnethingAgentExecutor | null
}

export interface OnethingAgentStore {
  /**
   * Load agents.json into the in-memory cache once, persisting the normalized
   * shape when the file on disk differs (the migration write the read path no
   * longer performs). Every later read is served from memory.
   */
  initialize(): Promise<OnethingAgentsFile>
  /** Drop the cache — the escape hatch after an external edit of agents.json. */
  invalidate(): void
  listAgents(): OnethingAgentDefinition[]
  /**
   * 解析纪律(域模型 M4,docs/design/agent-domain-model.md §4)三态 API。
   * 严格查找:查无此人(含空 id)返回 null,绝不冒充 default。
   */
  findAgent(agentId: string | undefined | null): OnethingAgentDefinition | null
  /** 执行链用:查无此人即 throw(错误信息带 agentId)。 */
  requireAgent(agentId: string | undefined | null): OnethingAgentDefinition
  /**
   * 渲染用:找得到(无论 active/retired)返回身份投影;未知 id 返回占位墓碑
   * `{ id, name: '已注销', kind: 'colleague', status: 'retired' }`。渲染永不炸。
   */
  displayAgent(agentId: string | undefined | null): OnethingAgentIdentity
  /** 功能兜底显式化:default agent(缺失时按同一规则现造)。 */
  defaultAgent(): OnethingAgentDefinition
  /**
   * @deprecated 过渡期兼容(M4):= `findAgent(id) ?? defaultAgent()`,真发生
   * fallback 时打 warn 埋点。新代码禁用,按语义归位到
   * findAgent / requireAgent / displayAgent / defaultAgent 之一。
   *
   * 删除判据(清点于架构审查 B8,别再写"调用点烧完"这种无法验收的话):产品侧
   * **唯一**存活点是 `app/agents/store.ts` 的同名 wrapper 及其在
   * `app/agents/index.ts` 里的 re-export,其余引用全在测试里。那两处一摘,这个
   * 方法连同实现里的 warn 埋点一起删。
   */
  getAgent(agentId: string | undefined | null): OnethingAgentDefinition
  agentExists(agentId: string | undefined | null): boolean
  createAgent(input: CreateOnethingAgentInput): OnethingAgentDefinition
  updateAgent(input: UpdateOnethingAgentInput): OnethingAgentDefinition
  /**
   * 退休(域模型 M3,§3.2):`status` → 'retired',身份面一字不动(墓碑)。
   *
   * 这是 `status` 的**唯一**合法写入路径之一(另一条是 restoreAgent)。普通
   * update 的请求形状里没有 status,正是为了让生命周期只能经这两个语义动作变更
   * ——「退休」是一个决定,不是一个可以顺手改的字段。default agent 硬拒(M5)。
   */
  retireAgent(agentId: string): OnethingAgentDefinition
  /** 恢复(§8「重新入职」):`status` → 'active'。入口只在 Agents 管理页。 */
  restoreAgent(agentId: string): OnethingAgentDefinition
  /**
   * 真硬删。调用方必须先确认「从未被引用过」(`hasAgentReference` 为假),
   * 被引用过的 agent 只能退休——删除链路的分支在 ipc-operations.ts。
   */
  deleteAgent(agentId: string): void
}

function createDefaultAgent(timestamp: number): OnethingAgentDefinition {
  return {
    id: DEFAULT_ONETHING_AGENT_ID,
    name: DEFAULT_ONETHING_AGENT_NAME,
    systemPrompt: '',
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function normalizeToolAllowlist(tools: unknown): string[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const normalized = Array.from(new Set(
    tools.filter((tool): tool is string => typeof tool === 'string')
      .map(tool => tool.trim())
      .filter(Boolean),
  ))
  return normalized.length > 0 ? normalized : undefined
}

/**
 * Write-path variant of normalizeToolAllowlist.
 *
 * An explicit `[]` is the one input whose stored meaning is the *opposite* of
 * how it reads: it normalizes to `undefined`, and `undefined` means "no
 * allowlist" — which resolveAgentToolSurface reads as "every registered tool"
 * (agents/profile.ts). So "give this agent no tools" silently became "give it
 * all of them". The renderer guards against it, but IPC and HTTP write here
 * directly, so the guard has to live at the store.
 *
 * `null` remains the documented way to clear an allowlist.
 */
function requireWritableToolAllowlist(tools: unknown, field: string): string[] | undefined {
  const normalized = normalizeToolAllowlist(tools)
  if (Array.isArray(tools) && !normalized) {
    throw new Error(
      `Agent "${field}" cannot be an empty list — an empty allowlist would grant every tool. `
      + 'Send null to clear the allowlist, or name at least one tool.',
    )
  }
  return normalized
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function normalizeModelBinding(value: unknown): OnethingAgentModelBinding | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as OnethingAgentModelBinding
  const binding: OnethingAgentModelBinding = {}
  const providerId = normalizeOptionalText(raw.providerId)
  const modelId = normalizeOptionalText(raw.modelId)
  const thinking = normalizeOptionalText(raw.thinking)
  if (providerId) binding.providerId = providerId
  if (modelId) binding.modelId = modelId
  if (thinking) binding.thinking = thinking
  return Object.keys(binding).length > 0 ? binding : undefined
}

function normalizeAgentKind(value: unknown): OnethingAgentKind | undefined {
  // Absent/unknown values stay absent — the default interpretation
  // ('colleague') lives in the predicates, not in the stored shape.
  return value === 'colleague' || value === 'service' ? value : undefined
}

function normalizeAgentStatus(value: unknown): OnethingAgentStatus | undefined {
  return value === 'active' || value === 'retired' ? value : undefined
}

function normalizeAgentExecutor(value: unknown): OnethingAgentExecutor | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { type?: unknown; connectorId?: unknown }
  if (raw.type === 'native') return { type: 'native' }
  if (raw.type === 'external') {
    const connectorId = normalizeOptionalText(raw.connectorId)
    // An external executor without a connector cannot drive anything —
    // dropping it falls back to the native default instead of persisting a
    // half-formed value.
    return connectorId ? { type: 'external', connectorId } : undefined
  }
  return undefined
}

function normalizeMaxTurns(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const turns = Math.floor(value)
  return turns > 0 ? turns : undefined
}

function normalizeAgent(
  agent: Partial<OnethingAgentDefinition>,
  fallbackTimestamp: number,
): OnethingAgentDefinition | null {
  const id = typeof agent.id === 'string' ? agent.id.trim() : ''
  if (!id) return null

  const isDefault = id === DEFAULT_ONETHING_AGENT_ID || agent.isDefault === true
  return {
    id,
    name: typeof agent.name === 'string' && agent.name.trim()
      ? agent.name.trim()
      : isDefault ? DEFAULT_ONETHING_AGENT_NAME : 'Untitled Agent',
    systemPrompt: typeof agent.systemPrompt === 'string' ? agent.systemPrompt : '',
    tools: normalizeToolAllowlist(agent.tools),
    isDefault: isDefault || undefined,
    createdAt: typeof agent.createdAt === 'number' ? agent.createdAt : fallbackTimestamp,
    updatedAt: typeof agent.updatedAt === 'number' ? agent.updatedAt : fallbackTimestamp,
    title: normalizeOptionalText(agent.title),
    avatar: normalizeOptionalText(agent.avatar),
    avatarImage: normalizeOptionalText(agent.avatarImage),
    color: normalizeOptionalText(agent.color),
    description: normalizeOptionalText(agent.description),
    model: normalizeModelBinding(agent.model),
    toolGrants: normalizeToolAllowlist(agent.toolGrants),
    permissionMode: normalizeOptionalText(agent.permissionMode),
    maxTurns: normalizeMaxTurns(agent.maxTurns),
    kind: normalizeAgentKind(agent.kind),
    status: normalizeAgentStatus(agent.status),
    executor: normalizeAgentExecutor(agent.executor),
  }
}

function normalizeFile(raw: unknown, timestamp: number): OnethingAgentsFile {
  const rawAgents = Array.isArray((raw as OnethingAgentsFile | undefined)?.agents)
    ? (raw as OnethingAgentsFile).agents
    : []
  const agents = rawAgents
    .map(agent => normalizeAgent(agent, timestamp))
    .filter((agent): agent is OnethingAgentDefinition => agent !== null)

  const defaultIndex = agents.findIndex(agent => agent.id === DEFAULT_ONETHING_AGENT_ID)
  if (defaultIndex >= 0) {
    agents[defaultIndex] = {
      ...agents[defaultIndex],
      name: agents[defaultIndex].name || DEFAULT_ONETHING_AGENT_NAME,
      isDefault: true,
    }
  } else {
    agents.unshift(createDefaultAgent(timestamp))
  }

  return {
    version: 1,
    agents,
  }
}

export function createOnethingAgentStore(options: CreateOnethingAgentStoreOptions): OnethingAgentStore {
  const now = options.now ?? (() => Date.now())
  // The compatibility facade resolves its root after boot and can be reused
  // by another Backend. Cache values and initialization promises belong to
  // the resolved file, never to that process-wide facade alone.
  let current: ReturnType<typeof createBinding> | undefined

  function resolvePath(): string {
    return typeof options.agentsPath === 'function' ? options.agentsPath() : options.agentsPath
  }

  function createBinding(filePath: string) {
    const target: CoreCachedJsonFileOptions<OnethingAgentsFile> = {
      filePath,
      defaultValue: () => normalizeFile(null, now()),
      normalize: raw => normalizeFile(raw, now()),
    }
    return { target, state: createCoreCachedJsonState<OnethingAgentsFile>() }
  }

  function binding() {
    const filePath = resolvePath()
    if (!current || current.target.filePath !== filePath) current = createBinding(filePath)
    return current
  }

  function loadFile(): OnethingAgentsFile {
    const owner = binding()
    return getCoreCachedJsonFile(owner.state, owner.target)
  }

  function saveFile(file: OnethingAgentsFile, owner = binding()): void {
    // Cross-process mutex: desktop / daemon / server may all hold a store over
    // the same agents.json. Same trade-off the settings repository makes.
    const { target, state } = owner
    // `target.normalize` runs inside saveCoreCachedJsonFile, so what lands on
    // disk and what lands in the cache are the same normalized object.
    withFileLockSync(`${target.filePath}.lock`, () =>
      saveCoreCachedJsonFile(state, target, file),
    )
  }

  function findAgent(agentId: string | undefined | null): OnethingAgentDefinition | null {
    if (!agentId) return null
    return loadFile().agents.find(agent => agent.id === agentId) ?? null
  }

  function defaultAgent(): OnethingAgentDefinition {
    // normalizeFile guarantees the default row exists in the cached file, so
    // the createDefaultAgent arm is a pure defensive fallback.
    return loadFile().agents.find(agent => agent.id === DEFAULT_ONETHING_AGENT_ID)
      ?? createDefaultAgent(now())
  }

  function applyUpdate(input: UpdateOnethingAgentInput): OnethingAgentDefinition {
    const file = loadFile()
    const index = file.agents.findIndex(agent => agent.id === input.agentId)
    if (index < 0) throw new Error('Agent not found')

    const current = file.agents[index]
    const patchOptional = <T, R>(
      patch: T | null | undefined,
      currentValue: R | undefined,
      normalize: (value: T) => R | undefined,
    ): R | undefined => patch === undefined ? currentValue : patch === null ? undefined : normalize(patch)
    const next: OnethingAgentDefinition = {
      ...current,
      name: input.name !== undefined ? (input.name.trim() || current.name) : current.name,
      systemPrompt: input.systemPrompt !== undefined ? input.systemPrompt : current.systemPrompt,
      tools: input.tools === undefined
        ? current.tools
        : input.tools === null
          ? undefined
          : requireWritableToolAllowlist(input.tools, 'tools'),
      title: patchOptional(input.title, current.title, normalizeOptionalText),
      avatar: patchOptional(input.avatar, current.avatar, normalizeOptionalText),
      avatarImage: patchOptional(input.avatarImage, current.avatarImage, normalizeOptionalText),
      color: patchOptional(input.color, current.color, normalizeOptionalText),
      description: patchOptional(input.description, current.description, normalizeOptionalText),
      model: patchOptional(input.model, current.model, normalizeModelBinding),
      toolGrants: patchOptional(input.toolGrants, current.toolGrants, normalizeToolAllowlist),
      permissionMode: patchOptional(input.permissionMode, current.permissionMode, normalizeOptionalText),
      maxTurns: patchOptional(input.maxTurns, current.maxTurns, normalizeMaxTurns),
      kind: patchOptional(input.kind, current.kind, normalizeAgentKind),
      status: patchOptional(input.status, current.status, normalizeAgentStatus),
      executor: patchOptional(input.executor, current.executor, normalizeAgentExecutor),
      updatedAt: now(),
    }
    const nextAgents = [...file.agents]
    nextAgents[index] = next
    saveFile({ ...file, agents: nextAgents })
    return next
  }

  /** 生命周期迁移(M3):status 只经退休/恢复变更,故写入收在这一个函数里。 */
  function setStatus(agentId: string, status: OnethingAgentStatus): OnethingAgentDefinition {
    if (agentId === DEFAULT_ONETHING_AGENT_ID) {
      // 主助理是「这个 app 本人」(M5):没有它,无 agentId 的会话就没有人格。
      throw new Error('Default Agent cannot be retired')
    }
    return applyUpdate({ agentId, status })
  }

  return {
    async initialize() {
      // Capture before asynchronous IO: a late normalization belongs to the
      // original file even if another root has become current meanwhile.
      const owner = binding()
      const { target, state } = owner
      const raw = readJsonFile<unknown | null>(target.filePath, null)
      const file = await initializeCoreCachedJsonFile(state, target)
      // Normalization used to land on disk as a side effect of reading. It is
      // now an explicit boot-time migration: a missing file was already written
      // by the initializer, so only a present-but-stale file needs the write.
      if (raw !== null && JSON.stringify(raw) !== JSON.stringify(file)) {
        saveFile(file, owner)
      }
      return file
    },

    invalidate() {
      if (current) invalidateCoreCachedJsonFile(current.state)
    },

    listAgents() {
      return loadFile().agents
    },

    findAgent,

    requireAgent(agentId) {
      const agent = findAgent(agentId)
      if (!agent) throw new Error(`Agent not found: ${agentId ?? '(empty id)'}`)
      return agent
    },

    displayAgent(agentId) {
      const agent = findAgent(agentId)
      if (agent) return agentIdentity(agent)
      // 墓碑占位(M4):未知 id 也要能渲染,但绝不套 default 的名字头像。
      // 文案走 model.ts 的属主 —— 这是渲染面,取 'ui' 口径。
      return {
        id: agentId ?? '',
        name: agentTombstoneLabel('ui'),
        kind: 'colleague',
        status: 'retired',
      }
    },

    defaultAgent,

    getAgent(agentId) {
      const found = findAgent(agentId)
      // 只有真的发生「查无此人→default」fallback 才埋点;空 id 是既有的功能
      // 兜底语义(无 agentId 会话的 persona),不算冒充,不刷屏。
      if (!found && agentId) {
        log.warn('deprecated getAgent fallback hit', { agentId })
      }
      return found ?? defaultAgent()
    },

    agentExists(agentId) {
      if (!agentId) return false
      return loadFile().agents.some(agent => agent.id === agentId)
    },

    createAgent(input) {
      const file = loadFile()
      const id = input.id.trim()
      if (!id || id === DEFAULT_ONETHING_AGENT_ID) {
        throw new Error('Invalid agent id')
      }
      if (file.agents.some(agent => agent.id === id)) {
        throw new Error('Agent already exists')
      }

      const timestamp = now()
      const agent: OnethingAgentDefinition = {
        id,
        name: input.name.trim() || 'Untitled Agent',
        systemPrompt: input.systemPrompt ?? '',
        tools: requireWritableToolAllowlist(input.tools, 'tools'),
        createdAt: timestamp,
        updatedAt: timestamp,
        title: normalizeOptionalText(input.title),
        avatar: normalizeOptionalText(input.avatar),
        avatarImage: normalizeOptionalText(input.avatarImage),
        color: normalizeOptionalText(input.color),
        description: normalizeOptionalText(input.description),
        model: normalizeModelBinding(input.model),
        toolGrants: normalizeToolAllowlist(input.toolGrants),
        permissionMode: normalizeOptionalText(input.permissionMode),
        maxTurns: normalizeMaxTurns(input.maxTurns),
        kind: normalizeAgentKind(input.kind),
        status: normalizeAgentStatus(input.status),
        executor: normalizeAgentExecutor(input.executor),
      }
      // Never mutate the cached file in place: a failed write would otherwise
      // leave the in-memory truth ahead of the disk.
      saveFile({ ...file, agents: [...file.agents, agent] })
      return agent
    },

    updateAgent: applyUpdate,

    retireAgent(agentId) {
      return setStatus(agentId, 'retired')
    },

    restoreAgent(agentId) {
      return setStatus(agentId, 'active')
    },

    deleteAgent(agentId) {
      if (agentId === DEFAULT_ONETHING_AGENT_ID) {
        throw new Error('Default Agent cannot be deleted')
      }

      const file = loadFile()
      const nextAgents = file.agents.filter(agent => agent.id !== agentId)
      if (nextAgents.length === file.agents.length) {
        throw new Error('Agent not found')
      }
      saveFile({ ...file, agents: nextAgents })
    },
  }
}
