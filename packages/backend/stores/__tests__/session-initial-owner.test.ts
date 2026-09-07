import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let directory: string
let previousStorePath: string | undefined
let fixture: Awaited<ReturnType<typeof import('../../session/testing/store-layer.js').installStoreSessionLayerForTest>> | undefined
let store: typeof import('../sessions.js')

beforeEach(async () => {
  previousStorePath = process.env.ONETHING_STORE_PATH
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-initial-owner-'))
  process.env.ONETHING_STORE_PATH = directory
  vi.resetModules()
  store = await import('../sessions.js')
  const { installStoreSessionLayerForTest } = await import('../../session/testing/store-layer.js')
  fixture = await installStoreSessionLayerForTest()
})

afterEach(async () => {
  await fixture?.dispose()
  fixture = undefined
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(directory, { recursive: true, force: true })
})

function initialMetadata(id: string): Record<string, unknown> {
  // Read immediately after the synchronous creation call, before any flush or
  // metadata patch can close the crash window under test.
  return JSON.parse(fs.readFileSync(path.join(directory, 'sessions', id, 'meta.json'), 'utf8'))
}

describe('first published session ownership', () => {
  it.each(['focused', 'background'] as const)('publishes trusted owner with %s session metadata', mode => {
    const create = mode === 'focused' ? store.createSession : store.createSessionWithoutFocus
    create('new-session', 'New', {
      workspaceId: 'product-space',
      initialOwner: { userId: 'alice', workspaceId: 'tenant-a' },
    })
    expect(initialMetadata('new-session')).toMatchObject({
      ownerUserId: 'alice', ownerWorkspaceId: 'tenant-a', workspaceId: 'product-space',
    })
    expect(store.getSessionsList().find(session => session.id === 'new-session')).toMatchObject({
      ownerUserId: 'alice', ownerWorkspaceId: 'tenant-a',
    })
  })

  it('inherits an authorized parent owner in the first branch publication', () => {
    store.createSession('parent', 'Parent', {
      workspaceId: 'product-space', initialOwner: { userId: 'alice', workspaceId: 'tenant-a' },
    })
    store.createBranchSession('branch', 'Branch', 'parent', 'message-1', [])
    expect(initialMetadata('branch')).toMatchObject({ ownerUserId: 'alice', ownerWorkspaceId: 'tenant-a' })
  })

  it('keeps ordinary local creation independent of the product workspace', () => {
    store.createSession('local', 'Local', { workspaceId: 'product-space' })
    expect(initialMetadata('local')).toMatchObject({ ownerUserId: 'local-user', ownerWorkspaceId: 'default' })
  })
})
