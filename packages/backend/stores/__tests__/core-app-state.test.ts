import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ONETHING_APP_STATE,
  getOnethingCurrentSessionId,
  getOnethingCurrentWorkspaceId,
  readOnethingAppState,
  setOnethingCurrentSessionId,
  setOnethingCurrentWorkspaceId,
  writeOnethingAppState,
} from '@onething/runtime/storage'

const tempDirs: string[] = []

function tempAppStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-app-state-'))
  tempDirs.push(dir)
  return path.join(dir, 'app-state.json')
}

describe('onething app state storage', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads defaults when no app state file exists', () => {
    const filePath = tempAppStatePath()

    expect(readOnethingAppState(filePath)).toEqual(DEFAULT_ONETHING_APP_STATE)
    expect(getOnethingCurrentSessionId(filePath)).toBe('')
    expect(getOnethingCurrentWorkspaceId(filePath)).toBeNull()
  })

  it('persists and updates current session and workspace ids', () => {
    const filePath = tempAppStatePath()

    writeOnethingAppState(filePath, {
      currentSessionId: 'session-1',
      currentWorkspaceId: null,
      openTabs: [{ type: 'chat', sessionId: 'session-1' }],
    })
    expect(readOnethingAppState(filePath)).toMatchObject({
      currentSessionId: 'session-1',
      currentWorkspaceId: null,
      openTabs: [{ type: 'chat', sessionId: 'session-1' }],
    })

    expect(setOnethingCurrentSessionId(filePath, 'session-2')).toMatchObject({
      currentSessionId: 'session-2',
      currentWorkspaceId: null,
      openTabs: [{ type: 'chat', sessionId: 'session-1' }],
    })
    expect(getOnethingCurrentSessionId(filePath)).toBe('session-2')

    expect(setOnethingCurrentWorkspaceId(filePath, 'workspace-1')).toMatchObject({
      currentSessionId: 'session-2',
      currentWorkspaceId: 'workspace-1',
    })
    expect(getOnethingCurrentWorkspaceId(filePath)).toBe('workspace-1')

    setOnethingCurrentWorkspaceId(filePath, null)
    expect(getOnethingCurrentWorkspaceId(filePath)).toBeNull()
  })
})
