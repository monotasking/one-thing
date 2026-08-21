import { getOnethingAppStatePath } from '@onething/runtime/storage'
import {
  getOnethingCurrentSessionId,
  getOnethingCurrentWorkspaceId,
  readOnethingAppState,
  setOnethingCurrentSessionId,
  setOnethingCurrentWorkspaceId,
  writeOnethingAppState,
  type OnethingAppState,
  type OnethingSerializedTab,
} from '@onething/runtime/storage'

export interface SerializedTab extends OnethingSerializedTab {}
export interface AppState extends OnethingAppState {}

export function getAppState(): AppState {
  return readOnethingAppState(getOnethingAppStatePath()) as AppState
}

export function saveAppState(state: AppState): void {
  writeOnethingAppState(getOnethingAppStatePath(), state)
}

export function getCurrentSessionId(): string {
  return getOnethingCurrentSessionId(getOnethingAppStatePath())
}

export function setCurrentSessionId(sessionId: string): void {
  setOnethingCurrentSessionId(getOnethingAppStatePath(), sessionId)
}

export function getCurrentWorkspaceId(): string | null {
  return getOnethingCurrentWorkspaceId(getOnethingAppStatePath())
}

export function setCurrentWorkspaceId(workspaceId: string | null): void {
  setOnethingCurrentWorkspaceId(getOnethingAppStatePath(), workspaceId)
}
