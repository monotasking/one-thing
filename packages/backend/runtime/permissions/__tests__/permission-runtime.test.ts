import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addGrant,
  configureOnethingPermissionGrantStorage,
  createOnethingPermissionRuntime,
  listWorkspaceGrants,
  resetPermissionGrantsForTests,
} from '../index.js'

const tempDirs: string[] = []

function createTempPermissionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-permissions-'))
  tempDirs.push(dir)
  return dir
}

function readJsonFile<TValue>(filePath: string, fallback: TValue): TValue {
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TValue
}

function writeJsonFile<TValue>(filePath: string, data: TValue): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

describe('onething permission runtime', () => {
  afterEach(() => {
    resetPermissionGrantsForTests()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('configures grant storage and applies grants through the runtime policy', async () => {
    const permissionsDir = createTempPermissionsDir()
    configureOnethingPermissionGrantStorage({
      getPermissionsDir: () => permissionsDir,
      readJsonFile,
      writeJsonFile,
    })

    const workspaceRoot = path.join(permissionsDir, 'workspace')
    const grant = addGrant({
      scope: 'workspace',
      type: 'bash',
      pattern: ['npm test'],
      workspaceRoot,
      createdFrom: { messageId: 'm1', title: 'Run tests' },
    })
    expect(listWorkspaceGrants(workspaceRoot)).toMatchObject([{ id: grant.id }])

    const permissionBridge = {
      getMode: vi.fn(() => 'normal' as const),
      ask: vi.fn().mockResolvedValue(undefined),
    }
    const runtime = createOnethingPermissionRuntime({ permissionBridge })

    expect(runtime.decide({
      sessionId: 's1',
      mode: 'normal',
      workspaceRoot,
      effects: [{ kind: 'bash', resources: ['npm test'] }],
    })).toMatchObject({ decision: 'allow', grantId: grant.id })

    await runtime.enforce({
      sessionId: 's1',
      messageId: 'm1',
      toolName: 'bash',
      workspaceRoot,
      effects: [{ kind: 'bash', resources: ['npm test'] }],
    })
    expect(permissionBridge.ask).not.toHaveBeenCalled()

    await runtime.enforce({
      sessionId: 's1',
      messageId: 'm1',
      toolName: 'bash',
      workspaceRoot,
      effects: [{ kind: 'bash', resources: ['rm *'] }],
    })
    expect(permissionBridge.ask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bash',
      pattern: ['rm *'],
      sessionId: 's1',
    }))
  })
})
