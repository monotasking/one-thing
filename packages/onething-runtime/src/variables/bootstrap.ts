import { AgentSelfProvider, type AgentSelfStateGateway } from './providers/agent-self.js'
import { BackgroundJobsProvider, type BackgroundJobsProviderDeps } from './providers/background-jobs.js'
import { CoreProvider, type CoreProviderAdapters, type WorkdirGateway } from './providers/core.js'
import { DateTimeProvider } from './providers/datetime.js'
import { GitBranchProvider } from './providers/git-branch.js'
import { GlobalStoreProvider, type GlobalStoreGateway } from './providers/global-store.js'
import { GoalProvider, type GoalVariableGateway } from './providers/goal.js'
import { KeyedStoreProvider, type KeyedStoreGateway } from './providers/keyed-store.js'
import { MusicRadioProvider, type MusicRadioGateway } from './providers/music-radio.js'
import { NotesProvider, type NotesGateway } from './providers/notes.js'
import {
  ResourceStateProvider,
  type ResourceStateVariableGateway,
} from './providers/resource-state.js'
import { SessionStoreProvider, type SessionStoreGateway } from './providers/session-store.js'
import type { VariableRegistry } from './registry.js'

export interface StandardVariableProviderGateways {
  workdir: WorkdirGateway
  notes: NotesGateway
  globalStore: GlobalStoreGateway
  sessionStore: SessionStoreGateway
  /** Extra host adapters for the core (workdir) provider, e.g. permission enforcement. */
  core?: CoreProviderAdapters
  /** Dependency overrides for the background-jobs board (tests). */
  backgroundJobs?: BackgroundJobsProviderDeps
  /** Session goal reader; hosts without a goal subsystem simply omit it. */
  goal?: GoalVariableGateway
  /** Music/radio status reader; hosts without a music subsystem simply omit it. */
  musicRadio?: MusicRadioGateway
  /** Agent 自我状态(卡/房/私聊);宿主没有协作子系统就不给,三个变量随之消失。 */
  agentSelf?: AgentSelfStateGateway
  /**
   * 资源自述 `state` 的投影(K4-a)。宿主没有资源内核就不给,那批变量随之消失 ——
   * 与 goal / musicRadio 同一条「gateway 在才装」。
   */
  resourceState?: ResourceStateVariableGateway
  /** Agent-scoped custom variables (keyed by the session's agent id). */
  agentStore?: KeyedStoreGateway
  /** Project-scoped custom variables (keyed by the active workdir's project id). */
  projectStore?: KeyedStoreGateway
}

/**
 * Register the canonical provider set on a registry. Every host (Electron
 * main process, headless server) assembles through this function so hosts
 * cannot drift apart on which providers exist — adding a provider here adds
 * it everywhere.
 */
export function registerStandardVariableProviders(
  registry: VariableRegistry,
  gateways: StandardVariableProviderGateways,
): void {
  registry.register(new CoreProvider(gateways.workdir, gateways.core ?? {}))
  registry.register(new BackgroundJobsProvider(gateways.backgroundJobs))
  registry.register(new DateTimeProvider())
  registry.register(new GitBranchProvider(gateways.workdir))
  if (gateways.goal) {
    registry.register(new GoalProvider(gateways.goal))
  }
  if (gateways.musicRadio) {
    registry.register(new MusicRadioProvider(gateways.musicRadio))
  }
  if (gateways.agentSelf) {
    registry.register(new AgentSelfProvider(gateways.agentSelf))
  }
  if (gateways.resourceState) {
    registry.register(new ResourceStateProvider(gateways.resourceState))
  }
  registry.register(new NotesProvider(gateways.notes))
  registry.register(new GlobalStoreProvider(gateways.globalStore))
  if (gateways.agentStore) {
    registry.register(new KeyedStoreProvider(gateways.agentStore, {
      id: 'agent-store',
      scope: 'agent',
      priority: 920,
      unresolvedHint: 'This session is not bound to an agent, so agent-scoped variables are unavailable.',
    }))
  }
  if (gateways.projectStore) {
    registry.register(new KeyedStoreProvider(gateways.projectStore, {
      id: 'project-store',
      scope: 'project',
      priority: 940,
      unresolvedHint: 'No active workdir. Set the workdir variable first, then project-scoped variables attach to that project.',
    }))
  }
  registry.register(new SessionStoreProvider(gateways.sessionStore))
}
