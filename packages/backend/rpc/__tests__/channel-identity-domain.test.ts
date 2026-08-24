/**
 * 渠道身份域,端到端穿过 dispatcher(主线 T1 第二批)。
 *
 * 这个域迁移的意义不只是省几条通道:迁移前 server 的 8 条 HTTP 路由读的是
 * `createServerChannelIdentityApi` 自己那份 `<dataRoot>/channel-identity.json`,
 * 而同一个进程里的会话路由 / 出站回投吃的是 `@onething/backend` 的
 * `ChannelIdentityStore`。两本账。所以这里守的是:**每个方法都落到那一个 store 上**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { channelIdentityRouter } from '@shared/ipc/channel-identity.js'

const channel = vi.hoisted(() => ({
  store: {
    listProfiles: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    listLinks: vi.fn(),
    createLink: vi.fn(),
    deleteLink: vi.fn(),
    listDeliveries: vi.fn(),
  },
  service: { resolveOrigin: vi.fn() },
  identitySessionKey: vi.fn(),
}))

vi.mock('../../channel/index.js', () => ({
  getChannelIdentityStore: () => channel.store,
  getChannelIdentityService: () => channel.service,
  identitySessionKey: channel.identitySessionKey,
}))

const PROFILE = { id: 'local-owner', name: 'Local user', isMain: true, createdAt: 1, updatedAt: 1 }
const LINK = {
  id: 'link-1',
  connector: 'wechat',
  workspaceId: 'default',
  externalUserId: 'wechat-1',
  clientUserId: 'local-owner',
  createdAt: 1,
  updatedAt: 1,
}

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { channelIdentityRpcHandlers },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/channel-identity.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, channelIdentityRpcHandlers }
}

describe('channelIdentity RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    channel.store.listProfiles.mockReset().mockReturnValue([PROFILE])
    channel.store.createProfile.mockReset().mockReturnValue(PROFILE)
    channel.store.updateProfile.mockReset().mockReturnValue(PROFILE)
    channel.store.listLinks.mockReset().mockReturnValue([LINK])
    channel.store.createLink.mockReset().mockReturnValue(LINK)
    channel.store.deleteLink.mockReset().mockReturnValue(true)
    channel.store.listDeliveries.mockReset().mockReturnValue([])
    channel.service.resolveOrigin.mockReset()
    channel.identitySessionKey.mockReset()
    const { resetRpcRegistryForTests, registerRouterHandlers, channelIdentityRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(channelIdentityRouter, channelIdentityRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('reads profiles and links off the app-layer store', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'channelIdentity', method: 'listProfiles', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: true, profiles: [PROFILE] } })
    await expect(dispatchRpc({ domain: 'channelIdentity', method: 'listLinks', payload: { connector: 'wechat' } }))
      .resolves.toEqual({ ok: true, data: { success: true, links: [LINK] } })

    expect(channel.store.listLinks).toHaveBeenCalledWith({ connector: 'wechat' })
  })

  it('writes profiles and links through the same store', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'channelIdentity',
      method: 'createProfile',
      payload: { name: 'Local user' },
    })).resolves.toEqual({ ok: true, data: { success: true, profile: PROFILE } })
    expect(channel.store.createProfile).toHaveBeenCalledWith({ name: 'Local user' })

    await expect(dispatchRpc({
      domain: 'channelIdentity',
      method: 'createLink',
      payload: { connector: 'wechat', externalUserId: 'wechat-1', clientUserId: 'local-owner' },
    })).resolves.toEqual({ ok: true, data: { success: true, link: LINK } })
  })

  it('a missing link is a named failure, not a silent success', async () => {
    const { dispatchRpc } = await loadDomain()
    channel.store.deleteLink.mockReturnValue(false)

    await expect(dispatchRpc({ domain: 'channelIdentity', method: 'deleteLink', payload: { id: 'ghost' } }))
      .resolves.toEqual({ ok: true, data: { success: false, error: 'Channel user link not found' } })
  })

  it('resolve returns the identity, the enriched origin and the session key together', async () => {
    const { dispatchRpc } = await loadDomain()
    const origin = { transport: 'im', source: 'text', receivedAt: 1, resolvedIdentity: { kind: 'channel-user', userId: 'u1' } }
    channel.service.resolveOrigin.mockReturnValue(origin)
    channel.identitySessionKey.mockReturnValue('identity:im:wechat:default:u1')

    await expect(dispatchRpc({
      domain: 'channelIdentity',
      method: 'resolve',
      payload: { origin: { transport: 'im', source: 'text', receivedAt: 1 } },
    })).resolves.toEqual({
      ok: true,
      data: {
        success: true,
        identity: origin.resolvedIdentity,
        origin,
        sessionId: 'identity:im:wechat:default:u1',
      },
    })
  })

  it('a store failure comes back as ok:false inside the envelope, not a rejection', async () => {
    const { dispatchRpc } = await loadDomain()
    channel.store.listProfiles.mockImplementation(() => {
      throw new Error('identity store unreadable')
    })

    await expect(dispatchRpc({ domain: 'channelIdentity', method: 'listProfiles', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: false, error: 'identity store unreadable' } })
  })
})
