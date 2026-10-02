import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnethingRadioConductorOptions } from '@onething/backend/runtime/music/radio-conductor'

type Meta = { id: string; ownerUserId?: string; ownerWorkspaceId?: string; agentId?: string; kind?: string; app?: string; updatedAt: number }
const fixture = vi.hoisted(() => ({
  dir: '', metas: new Map<string, Meta>(), conductor: undefined as OnethingRadioConductorOptions | undefined,
  getSession: vi.fn(), createSession: vi.fn(), updateAgent: vi.fn(), emit: vi.fn(), grant: vi.fn(),
  unattended: vi.fn(), variables: vi.fn(), refreshEnv: vi.fn(), patch: vi.fn(),
  deletedListener: undefined as ((ids: readonly string[]) => void) | undefined,
}))
vi.mock('@onething/backend/runtime/storage/index', () => ({ getOnethingStorePath: () => fixture.dir }))
vi.mock('@onething/backend/runtime/music/index', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/backend/runtime/music/index')>(),
  createOnethingRadioConductor: (options: OnethingRadioConductorOptions) => {
    fixture.conductor = options
    return { onSample: vi.fn(), quiesce: vi.fn(), idle: async () => {} }
  },
}))
vi.mock('@onething/backend/session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/backend/session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: id => fixture.metas.get(id) }) }
})
vi.mock('@onething/backend/stores/sessions.js', () => ({
  getSession: (id: string) => fixture.getSession(id),
  getSessionsList: () => [...fixture.metas.values()],
  createSession: (...args: unknown[]) => fixture.createSession(...args),
  updateSessionAgent: vi.fn(),
  patchSessionFields: (...args: unknown[]) => fixture.patch(...args),
  onSessionsDeleted: (listener: (ids: readonly string[]) => void) => {
    fixture.deletedListener = listener
    return () => { fixture.deletedListener = undefined }
  },
}))
vi.mock('../../../session/reads.js', () => ({ sessionReads: { countMessages: () => 0 } }))
vi.mock('@onething/backend/stores/settings.js', () => ({ getSettings: () => ({ music: { enabled: true } }) }))
vi.mock('@onething/backend/runtime/agents/store-bound.wiring', () => ({
  agentExists: () => true,
  createAgent: vi.fn(),
  findAgent: () => ({ systemPrompt: '' }),
  updateAgent: (...args: unknown[]) => fixture.updateAgent(...args),
}))
vi.mock('@onething/backend/core', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/backend/core')>(),
  addGrant: (...args: unknown[]) => fixture.grant(...args),
}))
vi.mock('@onething/backend/runtime/permissions/unattended', () => ({ markSessionUnattended: (...args: unknown[]) => fixture.unattended(...args) }))
vi.mock('@onething/backend/runtime/variables/registry', () => ({ getVariableRegistry: () => ({ list: fixture.variables }) }))
vi.mock('@onething/backend/runtime/engine/engine-layer', () => ({ getStreamEngineSafe: () => ({ getController: () => undefined }) }))
vi.mock('@onething/backend/events/index.js', () => ({ getEventBus: () => ({ emit: fixture.emit, on: () => () => {} }) }))
vi.mock('../service.js', async () => {
  const { ncmMusicProvider } = await import('@onething/backend/runtime/music/index')
  return {
    getActiveMusicProvider: () => ncmMusicProvider,
    getMusicNowPlaying: () => null,
    getMusicService: () => ({ refreshEnv: fixture.refreshEnv }),
    nudgeMusicClients: vi.fn(), refreshMusicNowPlaying: vi.fn(async () => {}), setMusicSampleListener: vi.fn(),
  }
})


let activeRadio: ReturnType<typeof import('../radio.js')['createRadioScope']> | undefined
async function loadRadio() {
  const { createRadioScope } = await import('../radio.js')
  activeRadio ??= createRadioScope({
    storePath: fixture.dir,
    service: { ...await import('../service.js'), runner: { run: vi.fn(), spawn: vi.fn() } },
    hostVoice: () => ({ prefetch: vi.fn(), speak: vi.fn(async () => {}) }),
  } as unknown as Parameters<typeof createRadioScope>[0])
  return activeRadio
}

describe('radio system session authorization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    fixture.dir = mkdtempSync(path.join(os.tmpdir(), 'radio-access-'))
    fixture.metas.clear()
    fixture.conductor = undefined
    fixture.getSession.mockImplementation((id: string) => fixture.metas.get(id))
    fixture.createSession.mockImplementation((id: string, _name: string, options: { initialOwner: { userId: string; workspaceId: string } }) => {
      fixture.metas.set(id, { id, updatedAt: 1, ownerUserId: options.initialOwner.userId, ownerWorkspaceId: options.initialOwner.workspaceId })
      return fixture.metas.get(id)
    })
    fixture.variables.mockResolvedValue([])
    fixture.emit.mockResolvedValue(undefined)
    fixture.refreshEnv.mockResolvedValue(undefined)
  })
  afterEach(async () => {
    await activeRadio?.drain()
    activeRadio = undefined
    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('refuses a persisted foreign DJ target before transcript reads, grants or station changes', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ ...store.readBrief(), active: true, intent: 'keep me', sessionId: 'foreign' })
    fixture.metas.set('foreign', { id: 'foreign', ownerUserId: 'alice', updatedAt: 1 })
    const before = readFileSync(store.briefPath, 'utf8')
    expect(() => radio.openRadioStation('replace', { clearProgramme: true })).toThrow('Session not found')
    expect(() => radio.startRadioConductor()).toThrow('Session not found')
    expect(readFileSync(store.briefPath, 'utf8')).toBe(before)
    expect(fixture.getSession).not.toHaveBeenCalled()
    expect(fixture.createSession).not.toHaveBeenCalled()
    expect(fixture.updateAgent).not.toHaveBeenCalled()
    expect(fixture.refreshEnv).not.toHaveBeenCalled()
    expect(fixture.grant).not.toHaveBeenCalled()
    expect(fixture.emit).not.toHaveBeenCalled()
  })

  it('creates the default owner atomically and sends a separate trusted execution context', async () => {
    const radio = await loadRadio()
    radio.startRadioConductor()
    await fixture.conductor!.wakeDj()
    // 09-26:DJ 会话是音乐 app 自己的(`app: 'music'`),列表不列、检索不给。
    expect(fixture.createSession).toHaveBeenCalledWith(expect.any(String), '电台', {
      initialOwner: { userId: 'local-user', workspaceId: 'default' },
      app: 'music',
    })
    const id = radio.getRadioStore().readBrief().sessionId
    expect(fixture.emit).toHaveBeenCalledWith(id, expect.objectContaining({ source: 'radio' }), {
      executionContext: { userId: 'local-user', workspaceId: 'default' },
    })
  })

  it('a brief pointing at a collab room (the DJ DM) is not driven: the wake moves to a plain radio-dj session (09-26)', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    fixture.metas.set('agent-dm-radio-dj', { id: 'agent-dm-radio-dj', agentId: 'radio-dj', kind: 'room', updatedAt: 9 })
    fixture.metas.set('plain', { id: 'plain', agentId: 'radio-dj', updatedAt: 1 })
    store.writeBrief({ ...store.readBrief(), sessionId: 'agent-dm-radio-dj' })
    radio.startRadioConductor()
    await fixture.conductor!.wakeDj()
    expect(store.readBrief().sessionId).toBe('plain')
    expect(fixture.emit).toHaveBeenCalledWith('plain', expect.objectContaining({ source: 'radio' }), expect.anything())
    // 房不归音乐 app;普通那条才盖章。
    expect(fixture.patch).not.toHaveBeenCalledWith('agent-dm-radio-dj', { app: 'music' }, expect.any(Function))
    expect(fixture.patch).toHaveBeenCalledWith('plain', { app: 'music' }, expect.any(Function))
  })

  it('claims every legacy radio-dj session in the index for the music app when the conductor starts (09-26)', async () => {
    const radio = await loadRadio()
    fixture.metas.set('old', { id: 'old', agentId: 'radio-dj', updatedAt: 1 })
    fixture.metas.set('chat', { id: 'chat', agentId: 'default', updatedAt: 2 })
    fixture.metas.set('dm', { id: 'dm', agentId: 'radio-dj', kind: 'room', app: 'music', updatedAt: 3 })
    radio.startRadioConductor()
    expect(fixture.patch).toHaveBeenCalledTimes(2)
    expect(fixture.patch).toHaveBeenCalledWith('old', { app: 'music' }, expect.any(Function))
    // 09-26 那一版误盖在私聊房上的戳摘回来。
    expect(fixture.patch).toHaveBeenCalledWith('dm', { app: undefined }, expect.any(Function))
  })

  it('unlinks the brief when the DJ session is deleted, so the panel never points at a session that is gone (09-26)', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    fixture.metas.set('dj', { id: 'dj', agentId: 'radio-dj', updatedAt: 1 })
    store.writeBrief({ ...store.readBrief(), active: true, intent: 'x', sessionId: 'dj' })
    radio.startRadioConductor()
    expect(fixture.deletedListener).toBeDefined()
    fixture.deletedListener!(['other'])
    expect(store.readBrief().sessionId).toBe('dj')
    fixture.deletedListener!(['dj'])
    expect(store.readBrief().sessionId).toBeUndefined()
    // 收尾把订阅拆掉:下一代作用域再接。
    await radio.drain()
    expect(fixture.deletedListener).toBeUndefined()
  })

  it('filters foreign and different-tenant candidates before reusing a deleted DJ session', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ ...store.readBrief(), sessionId: 'deleted' })
    fixture.metas.set('ours', { id: 'ours', agentId: 'radio-dj', updatedAt: 1 })
    fixture.metas.set('foreign', { id: 'foreign', agentId: 'radio-dj', ownerUserId: 'alice', updatedAt: 3 })
    fixture.metas.set('tenant', { id: 'tenant', agentId: 'radio-dj', ownerWorkspaceId: 'other', updatedAt: 4 })
    radio.startRadioConductor()
    await fixture.conductor!.wakeDj()
    expect(store.readBrief().sessionId).toBe('ours')
    expect(fixture.createSession).not.toHaveBeenCalled()
    expect(fixture.emit).toHaveBeenCalledWith('ours', expect.anything(), expect.anything())
    expect(fixture.getSession.mock.calls.some(([id]) => id === 'foreign' || id === 'tenant')).toBe(false)
  })

  it('rechecks ownership after awaiting opening context and does not send a late command', async () => {
    const radio = await loadRadio()
    fixture.variables.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      const meta = fixture.metas.get(sessionId)!
      fixture.metas.set(sessionId, { ...meta, ownerUserId: 'alice' })
      return []
    })
    radio.startRadioConductor()
    await expect(fixture.conductor!.wakeDj()).rejects.toThrow('Session not found')
    expect(fixture.emit).not.toHaveBeenCalled()
  })
})
