import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageOrigin } from '@shared/ipc.js'

let tempDir = ''

vi.mock('@onething/runtime/storage', () => ({
  getOnethingStorePath: () => tempDir,
  readJsonFile: <T>(filePath: string, defaultValue: T): T => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
    } catch {
      return defaultValue
    }
  },
  writeJsonFile: <T>(filePath: string, data: T): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  },
}))

vi.mock('../../wiring/logging/index.js', () => ({
  writeAppLog: vi.fn(),
}))

const { ChannelIdentityService } = await import('../identity-service.js')
const { getChannelIdentityStore } = await import('../identity-store.js')

function imOrigin(workspaceId: string, externalUserId = 'u-1'): MessageOrigin {
  return {
    transport: 'im',
    source: 'slack',
    actor: {
      externalUserId,
      displayName: 'Alice',
      handle: 'alice',
    },
    conversation: {
      connector: 'slack',
      workspaceId,
      externalConversationId: 'dm-1',
      type: 'dm',
    },
    replyTarget: {
      connector: 'slack',
      workspaceId,
      externalConversationId: 'dm-1',
    },
    receivedAt: 123,
  }
}

describe('ChannelIdentityService', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-identity-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('resolves unlinked channel users to isolated channel memory scope', () => {
    const service = new ChannelIdentityService()
    const identity = service.resolve(imOrigin('workspace-a'))

    expect(identity).toMatchObject({
      kind: 'channel-user',
      userId: 'channel-slack-workspace-a-u-1',
      profileId: 'channel-slack-workspace-a-u-1',
      externalUserKey: 'slack:workspace-a:u-1',
    })
    expect(getChannelIdentityStore().listProfiles()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'channel-slack-workspace-a-u-1',
        lastSentAt: 123,
      }),
    ]))
  })

  it('resolves linked channel users to client memory scope', () => {
    getChannelIdentityStore().createLink({
      connector: 'slack',
      workspaceId: 'workspace-a',
      externalUserId: 'u-1',
      clientUserId: 'client-alice',
    })

    const service = new ChannelIdentityService()
    expect(service.resolve(imOrigin('workspace-a'))).toMatchObject({
      kind: 'client-user',
      userId: 'client-alice',
      linkedClientUserId: 'client-alice',
    })
  })

  it('touches trusted client identities as profiles', () => {
    const service = new ChannelIdentityService()
    const identity = service.resolve({
      ...imOrigin('workspace-a'),
      resolvedIdentity: {
        kind: 'client-user',
        userId: 'client-bob',
        profileId: 'client-bob',
        displayName: 'Bob',
        linkedClientUserId: 'client-bob',
      },
    })

    expect(identity).toMatchObject({
      kind: 'client-user',
      userId: 'client-bob',
      profileId: 'client-bob',
    })
    expect(getChannelIdentityStore().listProfiles()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'client-bob',
        lastSentAt: 123,
      }),
    ]))
  })

  it('keeps the same external user isolated across workspaces', () => {
    getChannelIdentityStore().createLink({
      connector: 'slack',
      workspaceId: 'workspace-a',
      externalUserId: 'u-1',
      clientUserId: 'client-alice',
    })

    const service = new ChannelIdentityService()
    expect(service.resolve(imOrigin('workspace-b'))).toMatchObject({
      kind: 'channel-user',
    })
  })
})
