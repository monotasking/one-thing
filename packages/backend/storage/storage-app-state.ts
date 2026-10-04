import {
  readJsonFile,
  writeJsonFile,
} from '@onething/backend/storage/storage-primitives'

export interface OnethingSerializedTab {
  type: 'chat' | 'file' | 'workbench'
  sessionId?: string
  filePath?: string
  initialFilePath?: string
  activeFilePath?: string
  workspaceRoot?: string
  title?: string
}

/** v2 chat workspace: the whole split tree (layout + per-leaf tabs). Mirrors the renderer's PersistedWorkspace shape. */
export interface OnethingPersistedWorkspaceLeaf {
  type: 'leaf'
  id: string
  size: number
  sessions: string[]
  activeIndex: number
}

export interface OnethingPersistedWorkspaceSplit {
  type: 'split'
  id: string
  orientation: 'horizontal' | 'vertical'
  size: number
  children: OnethingPersistedWorkspaceNode[]
}

export type OnethingPersistedWorkspaceNode =
  | OnethingPersistedWorkspaceLeaf
  | OnethingPersistedWorkspaceSplit

export interface OnethingPersistedWorkspace {
  version: 2
  activeLeafId: string
  root: OnethingPersistedWorkspaceNode
}

/**
 * 每会话已读水位(docs/design/agent-im-dm.md P4)。是**阅读状态**,不是会话内容:
 * 放这儿(UI 状态)而不是 session meta.json —— 扫一眼就写一次会话文件等于让阅读
 * 行为去抖动会话索引,而"我读到哪儿"对引擎和 agent 都没有意义。
 * 形状与 renderer 的 `PersistedSessionReadMarks` 一一对应;这一层只透传不解释。
 */
export interface OnethingPersistedSessionReadMark {
  readAt: number
  inboundAt: number
}

export interface OnethingPersistedSessionReadMarks {
  version: 1
  marks: Record<string, OnethingPersistedSessionReadMark>
}

export interface OnethingAppState {
  currentSessionId: string
  currentWorkspaceId: string | null
  /** Legacy (v1) flat tab list; still readable for migration, no longer written. */
  openTabs?: OnethingSerializedTab[]
  activeTabIndex?: number
  workspace?: OnethingPersistedWorkspace
  sidebarCollapsed?: boolean
  sessionReadMarks?: OnethingPersistedSessionReadMarks
}

export interface OnethingUiStatePatch {
  openTabs?: OnethingSerializedTab[]
  activeTabIndex?: number
  workspace?: OnethingPersistedWorkspace
  sidebarCollapsed?: boolean
  sessionReadMarks?: OnethingPersistedSessionReadMarks
}

export const DEFAULT_ONETHING_APP_STATE: OnethingAppState = {
  currentSessionId: '',
  currentWorkspaceId: null,
}

export function readOnethingAppState(appStatePath: string): OnethingAppState {
  return readJsonFile(appStatePath, DEFAULT_ONETHING_APP_STATE)
}

export function writeOnethingAppState(appStatePath: string, state: OnethingAppState): void {
  writeJsonFile(appStatePath, state)
}

export function getOnethingCurrentSessionId(appStatePath: string): string {
  return readOnethingAppState(appStatePath).currentSessionId
}

export function setOnethingCurrentSessionId(appStatePath: string, sessionId: string): OnethingAppState {
  const state = readOnethingAppState(appStatePath)
  const nextState = {
    ...state,
    currentSessionId: sessionId,
  }
  writeOnethingAppState(appStatePath, nextState)
  return nextState
}

export function getOnethingCurrentWorkspaceId(appStatePath: string): string | null {
  return readOnethingAppState(appStatePath).currentWorkspaceId ?? null
}

export function setOnethingCurrentWorkspaceId(appStatePath: string, workspaceId: string | null): OnethingAppState {
  const state = readOnethingAppState(appStatePath)
  const nextState = {
    ...state,
    currentWorkspaceId: workspaceId,
  }
  writeOnethingAppState(appStatePath, nextState)
  return nextState
}

export function mergeOnethingUiState(
  state: OnethingAppState,
  uiState: OnethingUiStatePatch,
): OnethingAppState {
  return {
    ...state,
    ...(uiState.openTabs !== undefined ? { openTabs: uiState.openTabs } : {}),
    ...(uiState.activeTabIndex !== undefined ? { activeTabIndex: uiState.activeTabIndex } : {}),
    ...(uiState.workspace !== undefined ? { workspace: uiState.workspace } : {}),
    ...(uiState.sidebarCollapsed !== undefined ? { sidebarCollapsed: uiState.sidebarCollapsed } : {}),
    ...(uiState.sessionReadMarks !== undefined ? { sessionReadMarks: uiState.sessionReadMarks } : {}),
  }
}

export function saveOnethingUiState(appStatePath: string, uiState: OnethingUiStatePatch): OnethingAppState {
  const state = readOnethingAppState(appStatePath)
  const nextState = mergeOnethingUiState(state, uiState)
  writeOnethingAppState(appStatePath, nextState)
  return nextState
}

export type SaveOnethingUiStateForIpcResult =
  | { success: true; state: OnethingAppState }
  | { success: false; error: string }

export function saveOnethingUiStateForIpc(
  appStatePath: string,
  uiState: OnethingUiStatePatch,
): SaveOnethingUiStateForIpcResult {
  try {
    return {
      success: true,
      state: saveOnethingUiState(appStatePath, uiState),
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error && error.message
        ? error.message
        : 'Failed to save UI state',
    }
  }
}
