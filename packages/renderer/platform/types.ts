import type { SessionEventEnvelope } from '@shared/events'
import type {
  ElectronAPI,
  GetSessionUsageRequest,
  GetSessionUsageResponse,
  GetUsageSummaryRequest,
  GetUsageSummaryResponse,
  GoalDiffsResponse,
  GoalGetResponse,
  GoalSetRequest,
  GoalSetResponse,
  PromptCreateRequest,
  PromptCreateResponse,
  PromptDeleteRequest,
  PromptDeleteResponse,
  PromptGetResponse,
  PromptListResponse,
  PromptUpdateRequest,
  PromptUpdateResponse,
  TodoPlanCreateRequest,
  TodoPlanCreateResponse,
  TodoPlanDeleteRequest,
  TodoPlanDeleteResponse,
  TodoPlanGetRequest,
  TodoPlanGetResponse,
  TodoPlanRenameRequest,
  TodoPlanRenameResponse,
  TodoPlanUpdateRequest,
  TodoPlanUpdateResponse,
} from '@/types'

export type PlatformEnvironment = 'electron' | 'web'

export interface PlatformCapabilities {
  localFileSystem: boolean
  workspaceFileSystem: boolean
  nativeWindowControls: boolean
  shellTools: boolean
  /** Real PTY terminal available on this host. */
  terminal: boolean
  /** Embedded WebContentsView browser available (Electron only; web falls back to iframe). */
  embeddedBrowser: boolean
  /** Multi-agent collab rooms (需要主进程 RoomCoordinator;desktop only in P0). */
  collabRooms: boolean
  clipboardWrite: boolean
  desktopWindows: boolean
  globalMenuEvents: boolean
}

export type PlatformApi = ElectronAPI & {
  readonly environment: PlatformEnvironment
  readonly capabilities: PlatformCapabilities
  getCapabilities: () => Promise<PlatformCapabilities>
  onSessionEvent: (callback: (envelope: SessionEventEnvelope) => void) => () => void
  /**
   * Token usage / billing (主线 T0 试点域). Not on `ElectronAPI` any more: the
   * preload bridge only exposes the generic `rpcInvoke`, and each platform
   * builds the typed methods from `usageRouter` on top of it. The names are
   * unchanged, so callers never learned that the transport moved.
   */
  getUsageSummary: (request: GetUsageSummaryRequest) => Promise<GetUsageSummaryResponse>
  getSessionUsage: (request: GetSessionUsageRequest) => Promise<GetSessionUsageResponse>

  /**
   * 主线 T1 第一批迁到通用 RPC 通道的三个域。和 usage 同一条道理:它们不再挂在
   * `ElectronAPI` 上(preload 不暴露了),而是各平台从 router 定义现搭的客户端。
   * **方法名一个没改** —— 调用点从来不知道传输面换过。
   */
  listPrompts: () => Promise<PromptListResponse>
  getPrompt: (request: { id: string }) => Promise<PromptGetResponse>
  createPrompt: (request: PromptCreateRequest) => Promise<PromptCreateResponse>
  updatePrompt: (request: PromptUpdateRequest) => Promise<PromptUpdateResponse>
  deletePrompt: (request: PromptDeleteRequest) => Promise<PromptDeleteResponse>

  goalGet: (sessionId: string) => Promise<GoalGetResponse>
  goalSet: (request: GoalSetRequest) => Promise<GoalSetResponse>
  goalDiffs: (sessionId: string) => Promise<GoalDiffsResponse>

  /** todo/plan 的数据面。窗口面(open/hide/toggle/pin)仍在 `ElectronAPI` 上。 */
  getTodoPlan: (request?: TodoPlanGetRequest) => Promise<TodoPlanGetResponse>
  createTodoPlanNote: (request: TodoPlanCreateRequest) => Promise<TodoPlanCreateResponse>
  updateTodoPlan: (request: TodoPlanUpdateRequest) => Promise<TodoPlanUpdateResponse>
  renameTodoPlanNote: (request: TodoPlanRenameRequest) => Promise<TodoPlanRenameResponse>
  deleteTodoPlanNote: (request: TodoPlanDeleteRequest) => Promise<TodoPlanDeleteResponse>
  revealTodoPlanDirectory: () => Promise<{ success: boolean; error?: string }>
}
