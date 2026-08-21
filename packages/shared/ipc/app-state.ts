/**
 * app-state(应用状态:当前会话 / 当前工作区 / UI 持久化)域 —— 结构债 P4c 第三域。
 *
 * 两个方法,两种方向:`get` 读整份 `app-state.json`(渲染层启动时 hydrate 用的
 * 那一份),`saveUiState` 写一个**补丁**(只有出现的键才落盘,合并规则在
 * `@onething/runtime/storage` 的 `mergeOnethingUiState` 里)。
 *
 * **`workspace` / `sessionReadMarks` 在这条通道上是不透明载荷**,故意不给结构:
 * 这两块的形状主人是渲染层(工作区树已经改过 v2→v4→v5 好几版),主进程只按键名
 * 整块读写、从不解释。契约层复述过一次的后果就在仓库里躺着 ——
 * `@onething/runtime/storage` 的 `OnethingPersistedWorkspace` 停在 v2,和渲染层
 * 的 v5 早就对不上了,只是过去被 IPC 边界的 `any` 遮住看不见。谁解释谁转型:
 * 渲染层在自己那侧收窄成 `PersistedWorkspace`,主进程在自己那侧收窄成
 * `OnethingUiStatePatch`。
 *
 * `get` 无入参,所以是 `Record<string, never>`,调用处传 `{}`。
 */
import { defineRouter } from './router.js'

/** v1 遗留的扁平页签列表:只读、只为迁移活着,不再被写。 */
export interface AppStateSerializedTab {
  type: string
  sessionId?: string
  filePath?: string
  initialFilePath?: string
  activeFilePath?: string
  workspaceRoot?: string
  title?: string
}

/** 形状由渲染层拥有 —— 传输面只搬运,见文件头。 */
export type OpaqueUiBlob = unknown

export interface AppState {
  currentSessionId: string
  currentWorkspaceId: string | null
  openTabs?: AppStateSerializedTab[]
  activeTabIndex?: number
  workspace?: OpaqueUiBlob
  sidebarCollapsed?: boolean
  sessionReadMarks?: OpaqueUiBlob
}

export interface UiStatePatch {
  openTabs?: AppStateSerializedTab[]
  activeTabIndex?: number
  workspace?: OpaqueUiBlob
  sidebarCollapsed?: boolean
  sessionReadMarks?: OpaqueUiBlob
}

export interface SaveUiStateResponse {
  success: boolean
  state?: AppState
  error?: string
}

export type AppStateRoutes = {
  get: { input: Record<string, never>; output: AppState }
  saveUiState: { input: UiStatePatch; output: SaveUiStateResponse }
}

export const appStateRouter = defineRouter<AppStateRoutes>('appState', [
  'get',
  'saveUiState',
])
