/**
 * Gateways adapt the variable subsystem to the rest of the app.
 *
 *   workdir       → session.workingDirectory in stores/sessions
 *   session vars  → session.variables in stores/sessions
 *   note dirs     → VariablesStore (variables.json)
 *
 * Project directories are owned by their own subsystem
 * (`src/main/project-dirs/`); the workdir gateway calls into it as
 * an explicit cross-module dependency so workdir mutations
 * automatically refresh the project's lastUsedAt.
 */

import type { ContextVariable } from '@shared/ipc.js'
import type { ResourceKernel, StateScope } from '@onething/core/resource'
import { systemPrincipal } from '@onething/core/permission'
import * as store from '../../store.js'
import { getCurrentBackendInstance } from '../../current.js'
import { getEventBus } from '../../events/index.js'
import { getProjectsStore } from '../project-dirs/index.js'
import { resolveSessionSpaceId } from '../../stores/sessions.js'
import { expandPath } from '../tools/core/sandbox.js'
import { getVariablesStore } from '@onething/runtime/variables/store-bound'
import { DEFAULT_ONETHING_AGENT_ID } from '@onething/runtime/agents'
import { canonicalizeProjectRoot, projectIdFromPath } from '@onething/runtime/project-dirs'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import type { GlobalStoreGateway } from '@onething/runtime/variables/providers/global-store'
import type { GoalVariableGateway } from '@onething/runtime/variables/providers/goal'
import type { KeyedStoreGateway } from '@onething/runtime/variables/providers/keyed-store'
import type { MusicRadioGateway } from '@onething/runtime/variables/providers/music-radio'
import type {
  ResourceStateFact,
  ResourceStateVariableGateway,
} from '@onething/runtime/variables/providers/resource-state'
import type { SessionStoreGateway } from '@onething/runtime/variables/providers/session-store'
import type { WorkdirGateway } from '@onething/runtime/variables/providers/core'
import type { NoteVarName, NotesGateway } from '@onething/runtime/variables/providers/notes'
import type {
  NoteVaultsGateway,
  NoteVaultSummary,
} from '@onething/runtime/variables/providers/note-vaults'
import { getGoal, goalLimits } from '../goals/index.js'
import { getMusicNowPlaying } from '../music/service.js'
import { getRadioStore } from '../music/radio.js'
import { getNoteSystemRegistry } from '../notes/index.js'
import { computeAgentPresence } from '@onething/runtime/agents'
import { isAgentPairDmRoom } from '@onething/runtime/collab'
import type {
  AgentSelfCardFact,
  AgentSelfChatFact,
  AgentSelfStateGateway,
} from '@onething/runtime/variables/providers/agent-self'
import { findAgent } from '../agents/index.js'
import { getCollabSelfTaskFacts } from '../collab/board-store.js'
import { resolveUserIdentity } from '../collab/user-identity.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('variables')


// ── Workdir gateway ─────────────────────────────────

const workdirListeners = new Set<(sessionId: string) => void>()

export const workdirGateway: WorkdirGateway = {
  read(sessionId) {
    return store.getSession(sessionId)?.workingDirectory ?? ''
  },
  readRoots(sessionId) {
    return store.getSession(sessionId)?.workingDirectoryRoots ?? []
  },
  write(sessionId, workdir, options) {
    store.updateSessionWorkingDirectory(sessionId, workdir)
    // Auto-link into the global project directories list. Both AI
    // (CoreProvider.set) and UI (UPDATE_SESSION_WORKING_DIRECTORY IPC)
    // workdir mutations land here, so this single funnel keeps
    // project dirs in sync regardless of who initiated the change.
    if (workdir) {
      try {
        // 名册 per-space(批 B4):自动登记必须落进**会话归属的**空间,否则在 B
        // 空间跑的会话会把项目登记进 A —— 那正是「切空间项目也跟着来」的病根。
        const projects = getProjectsStore(resolveSessionSpaceId(sessionId))
        const sessionName = store.getSession(sessionId)?.name ?? ''
        const project = projects.touch(workdir, sessionName)
        // An explicit description names/renames the project entry;
        // the session name above is only a first-touch fallback.
        if (options?.description) {
          projects.update(workdir, { description: options.description })
        }
        syncProjectDerivedRoots(sessionId, project.paths)
      } catch (err) {
        log.error('project-dirs touch failed', { sessionId, workdir }, err)
      }
    }
    notifyWorkdirChanged(sessionId)
  },
  writeRoots(sessionId, roots) {
    store.updateSessionWorkingDirectoryRoots(sessionId, roots)
    notifyWorkdirChanged(sessionId)
  },
  expandPath,
  onChange(callback) {
    workdirListeners.add(callback)
    return () => workdirListeners.delete(callback)
  },
}

/**
 * Multi-root projects extend the session's sandbox roots automatically: when
 * the cwd lands in one, its full root list becomes workingDirectoryRoots.
 * Only roots the session doesn't own are touched — empty roots, or roots that
 * exactly equal some registered project's root set (i.e. a previous derivation),
 * are safe to replace; anything else was set deliberately (AI/user) and is
 * left alone.
 */
function syncProjectDerivedRoots(sessionId: string, projectPaths: readonly string[]): void {
  const current = store.getSession(sessionId)?.workingDirectoryRoots ?? []
  const target = projectPaths.length > 1 ? [...projectPaths] : []
  if (rootSetsEqual(current, target)) return
  const currentIsDerived = current.length === 0
    || getProjectsStore(resolveSessionSpaceId(sessionId))
      .list()
      .some(entry => rootSetsEqual(current, entry.paths))
  if (!currentIsDerived) return
  store.updateSessionWorkingDirectoryRoots(sessionId, target)
}

function rootSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const keys = new Set(a.map(canonicalizeProjectRoot))
  return b.every(root => keys.has(canonicalizeProjectRoot(root)))
}

/** Called from places that mutate workingDirectory outside CoreProvider.set. */
export function notifyWorkdirChanged(sessionId: string): void {
  for (const cb of workdirListeners) {
    try { cb(sessionId) } catch (err) {
      log.error('workdir listener failed', { sessionId }, err)
    }
  }
}

// ── Session-store gateway (per-session) ─────────────

const sessionStoreListeners = new Set<(sessionId: string) => void>()

export const sessionStoreGateway: SessionStoreGateway = {
  read(sessionId) {
    const session = store.getSession(sessionId)
    return (session?.variables ?? []) as ContextVariable[]
  },
  write(sessionId, variables) {
    store.updateSessionVariables(sessionId, variables)
    notifySessionVariablesChanged(sessionId)
  },
  onChange(callback) {
    sessionStoreListeners.add(callback)
    return () => sessionStoreListeners.delete(callback)
  },
}

// ── Global custom variables ─────────────────────────

export const globalStoreGateway: GlobalStoreGateway = {
  read() {
    return getVariablesStore().getGlobalVariables()
  },
  write(variables) {
    getVariablesStore().setGlobalVariables(variables)
  },
  onChange(callback) {
    return getVariablesStore().subscribe(callback)
  },
}

// ── Agent / project scoped variables ─────────────────
// Both persist in variables.json via the VariablesStore; only the key
// derivation differs. Sessions without an explicit agent belong to the
// default agent, so agent scope is always writable; project scope requires
// an active workdir.

export const agentStoreGateway: KeyedStoreGateway = {
  resolveKey(sessionId) {
    const session = store.getSession(sessionId)
    if (!session) return null
    return session.agentId || DEFAULT_ONETHING_AGENT_ID
  },
  read(key) {
    return getVariablesStore().getScopedVariables('agent', key)
  },
  write(key, variables) {
    getVariablesStore().setScopedVariables('agent', key, variables)
  },
  onChange(callback) {
    return getVariablesStore().subscribe(callback)
  },
}

/**
 * project 变量的 scope key(批 B8-3)—— **带空间维度**。
 *
 * 病根(B4 勘误 4 记档的那颗雷):`projectIdFromPath` 是路径的确定性哈希,
 * 所以 `/repo` 在 A、B 两个空间拿到同一个 id;名册 per-space 之后「同一目录在
 * 两个空间是两个项目」已经成立,但 `variables.json` 是全局单文件,两个项目
 * 因此共用同一格项目级变量 —— 空间隔离在这一格上漏了。
 *
 * **零迁移的做法是给 key 加前缀而不是搬文件**:
 *
 *  - default 空间 → `<projectId>`,**与本切片之前逐字一致**。老用户(以及所有
 *    从没建过第二个空间的用户)的 `project_variables` 一个键都不会变,读得回、
 *    写得回,没有任何一次性迁移动作。
 *  - 其余空间 → `<spaceId>:<projectId>`。空间 id 过 `isValidSpaceId` 的门,
 *    项目 id 是 hex 哈希或随机 id,两者都不含 `:`,所以前缀不会与老键撞车。
 *
 * 为什么不是「project 变量跟着 project 记录搬进 `workspaces/<id>/`」:那要给
 * VariablesStore 开第二个持久化根、给 default 留一条特判读路径,并且 agent 级
 * 与全局级变量仍然得留在 `variables.json` —— 一个文件变三个,换来的隔离与前缀
 * 完全等价。前缀是同一份隔离里最小的那个改动。
 *
 * **agent 级与全局级变量有意保持全局**:agent 定义本身(`agents/`)是全空间共享的,
 * 同一个 agent 在哪个空间都是同一个人格,它的变量跟着定义走才自洽;真要按空间
 * 分家,该分的是 agent 定义,不是变量。
 */
export function scopedProjectVariableKey(spaceId: string, projectId: string): string {
  return spaceId === DEFAULT_SPACE_ID ? projectId : `${spaceId}:${projectId}`
}

export const projectStoreGateway: KeyedStoreGateway = {
  resolveKey(sessionId) {
    const workdir = store.getSession(sessionId)?.workingDirectory
    if (!workdir) return null
    const spaceId = resolveSessionSpaceId(sessionId)
    // Registered projects key by their stable id so every root of a
    // multi-root project shares one variable scope; unregistered workdirs
    // keep the legacy path-derived key.
    try {
      const project = getProjectsStore(spaceId).get(workdir)
      if (project) return scopedProjectVariableKey(spaceId, project.id)
    } catch {
      // fall through to the derived key
    }
    return scopedProjectVariableKey(spaceId, projectIdFromPath(workdir))
  },
  read(key) {
    return getVariablesStore().getScopedVariables('project', key)
  },
  write(key, variables) {
    getVariablesStore().setScopedVariables('project', key, variables)
  },
  onChange(callback) {
    return getVariablesStore().subscribe(callback)
  },
}

export function notifySessionVariablesChanged(sessionId: string): void {
  for (const cb of sessionStoreListeners) {
    try { cb(sessionId) } catch (err) {
      log.error('session-store listener failed', { sessionId }, err)
    }
  }
}

// ── Notes gateway (read from store) ─────────────────

export const notesGateway: NotesGateway = {
  read(which) {
    const raw = readNoteFromStore(which)
    return raw ? expandPath(raw) : ''
  },
  write(which, path) {
    if (which === 'user_note_dir') {
      getVariablesStore().setUserNoteDir(path)
    } else {
      getVariablesStore().setWorkNoteDir(path)
    }
    // Store fires its own change event via subscribe(); no redundant
    // notifyNotesDirChanged here.
  },
  expandPath,
  onChange(callback) {
    return getVariablesStore().subscribe(callback)
  },
}

function readNoteFromStore(which: NoteVarName): string {
  const s = getVariablesStore()
  if (which === 'user_note_dir') return s.getUserNoteDir()
  return s.getWorkNoteDir()
}

/**
 * Retained as a typed shim for any external caller that still
 * imports it; the store now broadcasts internally and this is a
 * no-op forward.
 */
export function notifyNotesDirChanged(): void {
  // intentionally empty
}

// ── Goal gateway ────────────────────────────────────
// Read-only view for the GoalProvider; all writes go through the
// GoalManager (src/main/goals), which is the single writer.

export const goalVariableGateway: GoalVariableGateway = {
  read: sessionId => getGoal(sessionId),
  limits: () => goalLimits(),
}

// ── Music/radio gateway ─────────────────────────────
// Cache-backed only: the watcher's snapshot and the radio store's files. A
// provider runs on every turn and must never cost a subprocess.

// ── Agent 自我状态(my_cards / my_rooms / my_dms)─────
// 全部现算,零新增存储:在场面从会话索引推(agents/presence.ts 的纯函数),
// 卡从各房看板读。与「在场面永不落库」那条铁律同源 —— 落一份库就有两份真相。

export const agentSelfGateway: AgentSelfStateGateway = {
  read(sessionId) {
    const session = store.getSession(sessionId)
    const agentId = session?.agentId
    // 没绑 agent = 没有"我"可谈,三个变量一个都不产出。
    if (!agentId) return null

    // 会话索引只取一次:presence 与房名/时间/形态判定共用同一份快照,免得
    // 一个变量组遍历三遍索引。
    const sessions = store.getSessionsList()
    const presence = computeAgentPresence(agentId, sessions)
    const byId = new Map(sessions.map(meta => [meta.id, meta]))

    const cards: AgentSelfCardFact[] = []
    const rooms: AgentSelfChatFact[] = []
    const dms: AgentSelfChatFact[] = []

    if (presence.dmRoomId) {
      const meta = byId.get(presence.dmRoomId)
      dms.push({ name: resolveUserIdentity().label, lastActiveAt: meta?.updatedAt })
    }

    // 一个房一次 board.json 读取(小文件,同步)。此前 `<your_cards>` 是一次;
    // 现在是"这个 agent 在的房"的条数 —— 在场面本来就是它的活动半径,而卡只
    // 可能挂在这些房的板上。
    for (const roomId of [...(presence.dmRoomId ? [presence.dmRoomId] : []), ...presence.roomSessionIds]) {
      for (const fact of getCollabSelfTaskFacts(roomId, agentId)) {
        cards.push({ id: fact.id, title: fact.title, status: fact.status })
      }
    }

    for (const roomId of presence.roomSessionIds) {
      const meta = byId.get(roomId)
      if (!meta) continue
      // 双成员 dm 房在 presence 里算"房"(它确实是 kind='room'),但对 agent
      // 而言那是私聊 —— 归到 my_dms,并且写对面那个人而不是房名。
      if (isAgentPairDmRoom(meta.room)) {
        const peerId = meta.room?.memberAgentIds?.find(id => id !== agentId)
        const peerName = peerId ? findAgent(peerId)?.name : undefined
        dms.push({ name: peerName || '另一位同事', lastActiveAt: meta.updatedAt })
        continue
      }
      rooms.push({ name: meta.name, lastActiveAt: meta.updatedAt })
    }

    return { cards, rooms, dms }
  },
}

// ── 资源自述 state → 变量(K4-a)──────────────────────
// 它住在装配层因为只有这里认识那台资源内核;它**不认识任何命名空间** —— 名单、
// 读法名、取址规则三样全从注册表上的自述现读。

/**
 * 这一格状态该读哪个地址。规则由自述的 `scope` 说(`core/resource/spec.ts` 的
 * `StateScope`),这里只是把那句话拼成地址:
 *
 *   · `turn-origin` → `<scheme>:<这一回合的 sessionId>`;
 *   · `singleton`(缺省)→ **拿不出地址**,回 `null`。单例的地址是那种资源自己取的
 *     名字(`music:player`),不是一条能推导的规则,而 `ResourceKernel.read` 要一个
 *     完整地址(`parseRef` 拒绝空路径)。今天零个 `singleton` + `turn` 的状态,所以
 *     这条路是留账不是缺口 —— 见 `StateScope` 的注释。
 */
function stateRef(scheme: string, scope: StateScope | undefined, sessionId: string): string | null {
  if (scope !== 'turn-origin') return null
  return sessionId ? `${scheme}:${sessionId}` : null
}

/**
 * 当前进程那台资源内核,或 `null`。
 *
 * **晚绑定是硬要求**:变量系统在 `backend.ts` 里装配于资源内核**之前**
 * (`bootstrapVariableSystem()` 在 :806,`createResourceKernel` 在 :852),所以在
 * 注册这只 gateway 的那一刻内核还不存在。装配期抓一次句柄 = 永远抓到 `undefined`。
 */
function resourceKernelOrNull(): ResourceKernel | null {
  const backend = getCurrentBackendInstance()
  if (!backend) return null
  try {
    return backend.resources
  } catch {
    // 装配还没走到那一步(或者已经 dispose 了)。变量板照常出,少这一批而已。
    return null
  }
}

export const resourceStateVariableGateway: ResourceStateVariableGateway = {
  async listStates(sessionId) {
    const kernel = resourceKernelOrNull()
    if (!kernel) return []
    const facts: ResourceStateFact[] = []
    // `registry.list()` 已按 scheme 字典序;状态名再排一次 —— 同一台机器上这批变量
    // 的产出顺序必须与装配顺序、与对象字面量的书写顺序都无关(变量板的逐字去重
    // 是按整块比字节的)。
    for (const spec of kernel.registry.list()) {
      const states = spec.state
      if (!states) continue
      for (const name of Object.keys(states).sort()) {
        const state = states[name]
        // `schema` 原样转述:它是这格状态**进提示词的键集**,投影按它减
        // (`projectDeclaredState`)。这里不读它、不解释它 —— 键名归自述,不归接线。
        const base = {
          scheme: spec.scheme,
          name,
          title: state.title,
          volatility: state.volatility,
          schema: state.schema,
        }
        const ref = state.volatility === 'turn' ? stateRef(spec.scheme, state.scope, sessionId) : null
        if (!ref) {
          // 值一格都不读:非 turn 的读法未必是纯内存的(`music.nowPlaying`),而
          // 「provider 每回合跑,绝不能花一次子进程」是那条硬约束。声明照样交上去,
          // 哪一档进提示词由 provider 判 —— 两处过滤各管一件事,不是同一条写了两遍。
          facts.push(base)
          continue
        }
        const outcome = await kernel.read(ref, state.read ?? name, {}, {
          principal: systemPrincipal('variables'),
          sessionId,
        })
        // 读不到就不投这一格(会话刚被删、守卫拒了、实现抛了)。一格读失败不该把
        // 整块变量板连坐掉,所以这里既不抛也不落 error —— `ReadOutcome` 已经把
        // 「为什么没有」说清楚了,而变量板要的答案只是「有没有」。
        facts.push(outcome.kind === 'ok' ? { ...base, value: outcome.value } : base)
      }
    }
    return facts
  },

  /**
   * 状态变了就叫一声。
   *
   * 订的是**总线上的 `resource:event`**,不是内核那只 hub:注册这只 gateway 的时刻
   * 内核还不存在(见 `resourceKernelOrNull`),而事件总线已经在了。事实是同一份 ——
   * `wiring/resource/event-bridge.ts` 把 hub 上每一条原样转发上总线。
   *
   * 谁要重算,由**自述**说:地址的 scheme 上如果有 `turn-origin` 的 turn 状态,
   * 那条地址的 path 就是会话 id(那正是 `turn-origin` 的定义),只重算那一条会话;
   * 否则广播。这里因此仍然没有一个 scheme 名。
   */
  onChange(emit) {
    let bus: ReturnType<typeof getEventBus> | undefined
    try { bus = getEventBus() } catch { return () => {} }
    return bus.onGlobal('resource:event', envelope => {
      const ref = envelope.event.ref
      const at = typeof ref === 'string' ? ref.indexOf(':') : -1
      if (at <= 0) return
      const scheme = ref.slice(0, at)
      const path = ref.slice(at + 1)
      const states = resourceKernelOrNull()?.registry.get(scheme)?.state
      if (!states) return
      const turnStates = Object.values(states).filter(state => state.volatility === 'turn')
      if (turnStates.length === 0) return
      emit(turnStates.every(state => state.scope === 'turn-origin') && path ? path : undefined)
    })
  },
}

export const musicRadioGateway: MusicRadioGateway = {
  getNowPlaying: () => {
    const nowPlaying = getMusicNowPlaying()
    return nowPlaying ? { status: nowPlaying.status, title: nowPlaying.title } : null
  },
  getRadio: () => {
    const brief = getRadioStore().readBrief()
    return { active: brief.active, intent: brief.intent, lastError: brief.lastError }
  },
  getProgrammeLength: () => getRadioStore().readProgramme().entries.length,
}

/**
 * 只读派生变量 `note_vaults` 的产地(P1)。
 *
 * **它一条 CLI 命令都不发。** 库表是 `NoteSystemRegistry` 内存里的东西(装配时
 * 与每次设置变更时各问一次驱动),今日日记那一格走领域的 **offline 读** ——
 * `dailyNote(undefined, { offline: true })` 只用快照 / 本地计算,答不出来就把那
 * 一格省掉。变量板每回合都渲染一次,在那条路上起子进程 = 给每一轮对话加一次
 * 进程启动。
 *
 * registry 是**晚绑定**的:这个网关造出来时笔记子系统还没装(`bootstrapVariableSystem`
 * 排在 `bootstrapNotes` 之前),所以句柄在每次 `list()` 里现取 —— 与
 * `resourceStateVariableGateway` 同一条判例。
 */
export const noteVaultsGateway: NoteVaultsGateway = {
  async list(): Promise<NoteVaultSummary[]> {
    let registry: ReturnType<typeof getNoteSystemRegistry>
    try {
      registry = getNoteSystemRegistry()
    } catch {
      // 还没装配 / 这台宿主没有笔记领域:变量随之消失,不是错误。
      return []
    }
    const vaults = registry.vaults()
    if (vaults.length === 0) return []
    const primary = registry.primaryVault()
    const today = primary
      ? await primary.dailyNote(undefined, { offline: true }).then(
          ref => ref.path,
          () => undefined,
        )
      : undefined
    return vaults.map(vault => ({
      name: vault.name,
      root: vault.root,
      system: vault.system,
      primary: primary?.id === vault.id,
      ...(today !== undefined && primary?.id === vault.id ? { today } : {}),
    }))
  },
}
