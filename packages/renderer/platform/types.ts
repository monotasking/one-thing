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
  SessionStreamPayload,
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

// `PlatformApi` 是 `ElectronAPI` 的交集类型:两边声明的 `onSessionStream` 必须是
// **同一个**类型,否则交集会摊成重载,未标注的回调参数会落回先声明的那一条。
export type { SessionStreamPayload }

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
  /**
   * 音乐电台(P4c 第九批,#13)。电台驱动的是**宿主机器上**的 ncm-cli / mpv,
   * 浏览器点一下只会让服务器那台机器出声 —— 所以 web 默认 `false`,
   * `platform/music-client.ts` 在它为 false 时就地返回迁移前那十四条硬桩的答案。
   */
  music: boolean
  /**
   * agent 提问 → 用户应答(P4c 第九批,#17)。web 上默认 `false`:通道虽然通了,
   * 放开是一次独立的拍板,不搭搬家的便车。`platform/interaction-client.ts` 在它为
   * false 时就地返回迁移前那两条硬桩的答案。
   */
  interactionRespond: boolean
  /**
   * 提示词评估 / 事故工作台(P4c 第十批,#15 续做口径)。评估面读写的是**宿主
   * 机器上**的 evals 仓与 `~/.onething/evals`,跑批还会拿用户配置的 API key 直接
   * 打 provider —— 所以 web 默认 `false`,`platform/evals-client.ts` 与
   * `platform/evals-workbench-client.ts` 在它为 false 时就地返回迁移前那批硬桩
   * 的答案(`Evals is not supported in the web build`)。
   */
  evals: boolean
  /**
   * 插件**写面**(P4 终态批 C2,#16):install / update / uninstall /
   * checkUpdates / configSet / pickFile / request / requestAbort / market /
   * readTarball / footprint / lifecycleInfo。
   *
   * 方案 A(插件设计文档 §6)下**插件只在 Electron 桌面宿主执行**:安装要本机
   * npm、配置要写 `<store>/plugins/<id>/config.json`、file-pick 要原生对话框,
   * 而浏览器里这三样一个都没有。迁到通用通道之后这条路技术上通了,按「续做口径」
   * 必须由一颗能力位挡着 —— web 默认 `false`,`platform/plugins-client.ts` 在它
   * 为 false 时**根本不发请求**,逐条返回与迁移前 `platform/web.ts` 那批硬桩
   * **逐字相同**的答案。**放开是一次独立拍板**,不搭搬家的便车。
   *
   * 读面(list / enable / disable / refresh / commands / executeCommand /
   * configGet)不受这颗位管:它们在 web 上本来就打真路由(`/api/plugins*`),
   * 迁移后打的是同一批闭包。
   */
  pluginsManage: boolean
  clipboardWrite: boolean
  desktopWindows: boolean
  globalMenuEvents: boolean
}

export type PlatformApi = ElectronAPI & {
  readonly environment: PlatformEnvironment
  readonly capabilities: PlatformCapabilities
  getCapabilities: () => Promise<PlatformCapabilities>
  onSessionEvent: (callback: (envelope: SessionEventEnvelope) => void) => () => void
  onSessionStream: (callback: (payload: SessionStreamPayload) => void) => () => void
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
