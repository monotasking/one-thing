import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appStateRouter } from '@shared/ipc/app-state.js'
import { getOnethingAppStatePath, writeOnethingAppState } from '@onething/runtime/storage'
import { createSessionAccess } from '../../session/access.js'
import { installSessionLayerForTest } from '../../session/testing/session-layer.js'
import { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests } from '../registry.js'
import { appStateRpcHandlers } from '../domains/app-state.js'

const alice = { transport: 'http' as const, ownerUid: 'alice', workspaceId: 'tenant' }
const bob = { transport: 'http' as const, ownerUid: 'bob', workspaceId: 'tenant' }
const rows = new Map([
  ['session-1', {}],
  ['alice-session', { ownerUserId: 'alice', ownerWorkspaceId: 'tenant' }],
])
let root: string
let fixture: ReturnType<typeof installSessionLayerForTest>
let dispose: () => void

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-state-access-'))
  vi.stubEnv('ONETHING_STORE_PATH', root)
  fixture = installSessionLayerForTest({ access: createSessionAccess({ findMeta: id => rows.get(id) }) })
  resetRpcRegistryForTests()
  dispose = registerRouterHandlers(appStateRouter, appStateRpcHandlers)
})

afterEach(async () => {
  dispose()
  await fixture.dispose()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

const getRequest = { domain: 'appState', method: 'get', payload: {} }
const save = (payload: Record<string, unknown>) => ({ domain: 'appState', method: 'saveUiState', payload })

describe('operator-scoped UI persistence through the RPC dispatcher', () => {
  it('preserves the default owner file, opaque layout, and empty patch semantics', async () => {
    const state = {
      currentSessionId: 'session-1', currentWorkspaceId: 'default', sidebarCollapsed: true,
      workspace: { version: 5, spaces: { personal: { tabs: ['session-1'] } } },
    }
    fs.writeFileSync(getOnethingAppStatePath(), JSON.stringify(state))
    expect(await dispatchRpc(getRequest)).toEqual({ ok: true, data: state })
    expect(await dispatchRpc(save({}))).toEqual({ ok: true, data: { success: true, state } })
    expect(JSON.parse(fs.readFileSync(getOnethingAppStatePath(), 'utf8'))).toEqual(state)
  })

  it('isolates complete opaque layouts and read marks across operators and tenants', async () => {
    const first = { workspace: { version: 5, privateLabel: 'Alice layout' }, sessionReadMarks: { version: 1, marks: { 'alice-session': { readAt: 1, inboundAt: 2 } } } }
    const second = { workspace: { version: 6, privateLabel: 'Bob layout' } }
    expect(await dispatchRpc(save(first), alice)).toMatchObject({ ok: true, data: { success: true, state: first } })
    expect(await dispatchRpc(getRequest, bob)).toEqual({ ok: true, data: { currentSessionId: '', currentWorkspaceId: null } })
    expect(await dispatchRpc(getRequest, { ...alice, workspaceId: 'another' })).toEqual({ ok: true, data: { currentSessionId: '', currentWorkspaceId: null } })
    await dispatchRpc(save(second), bob)
    expect(await dispatchRpc(getRequest, alice)).toMatchObject({ ok: true, data: first })
    expect(await dispatchRpc(getRequest, bob)).toMatchObject({ ok: true, data: second })
    expect(fs.existsSync(getOnethingAppStatePath())).toBe(false)
  })

  it('does not expose a foreign globally focused session through get or save responses', async () => {
    writeOnethingAppState(getOnethingAppStatePath(), { currentSessionId: 'alice-session', currentWorkspaceId: null })
    expect(await dispatchRpc(getRequest)).toMatchObject({ ok: true, data: { currentSessionId: '' } })
    expect(await dispatchRpc(save({ sidebarCollapsed: true }))).toMatchObject({ ok: true, data: { success: true, state: { currentSessionId: '' } } })
  })

  it('rejects invalid tenant paths before creating UI state files', async () => {
    expect(await dispatchRpc(save({ sidebarCollapsed: true }), { ...alice, workspaceId: '..' })).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(root, 'ui-state'))).toBe(false)
  })

  it('keeps storage failures in the established response payload', async () => {
    fs.mkdirSync(getOnethingAppStatePath())
    expect(await dispatchRpc(save({ sidebarCollapsed: true }))).toMatchObject({ ok: true, data: { success: false, error: expect.any(String) } })
  })

  it('does not register unknown methods', async () => {
    expect(await dispatchRpc({ domain: 'appState', method: 'nope', payload: {} })).toMatchObject({ ok: false })
  })
})
