import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getOnethingCurrentSessionId,
  getOnethingCurrentWorkspaceId,
  mergeOnethingUiState,
  readOnethingAppState,
  saveOnethingUiState,
  saveOnethingUiStateForIpc,
  setOnethingCurrentSessionId,
  setOnethingCurrentWorkspaceId,
} from '../app-state.js'

describe('onething app state storage', () => {
  it('owns app state defaults and current session/workspace updates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-app-state-'))
    const file = path.join(root, 'app-state.json')

    try {
      expect(readOnethingAppState(file)).toEqual({
        currentSessionId: '',
        currentWorkspaceId: null,
      })

      setOnethingCurrentSessionId(file, 'session-1')
      setOnethingCurrentWorkspaceId(file, 'workspace-1')

      expect(getOnethingCurrentSessionId(file)).toBe('session-1')
      expect(getOnethingCurrentWorkspaceId(file)).toBe('workspace-1')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('merges renderer UI state patches without dropping product state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-app-ui-state-'))
    const file = path.join(root, 'app-state.json')

    try {
      saveOnethingUiState(file, {
        openTabs: [{ type: 'chat', sessionId: 'session-1', title: 'Chat' }],
        activeTabIndex: 0,
      })
      const next = saveOnethingUiState(file, {
        sidebarCollapsed: true,
      })

      expect(next).toEqual({
        currentSessionId: '',
        currentWorkspaceId: null,
        openTabs: [{ type: 'chat', sessionId: 'session-1', title: 'Chat' }],
        activeTabIndex: 0,
        sidebarCollapsed: true,
      })
      expect(mergeOnethingUiState(next, { activeTabIndex: 2 })).toMatchObject({
        activeTabIndex: 2,
        sidebarCollapsed: true,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('formats UI state save results for IPC callers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-app-ui-state-ipc-'))
    const file = path.join(root, 'app-state.json')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      expect(saveOnethingUiStateForIpc(file, {
        openTabs: [{ type: 'chat', sessionId: 'session-1' }],
        sidebarCollapsed: true,
      })).toEqual({
        success: true,
        state: {
          currentSessionId: '',
          currentWorkspaceId: null,
          openTabs: [{ type: 'chat', sessionId: 'session-1' }],
          sidebarCollapsed: true,
        },
      })

      const failed = saveOnethingUiStateForIpc(root, { activeTabIndex: 1 })

      expect(failed.success).toBe(false)
      if (!failed.success) {
        expect(failed.error.length).toBeGreaterThan(0)
      }
    } finally {
      consoleError.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
