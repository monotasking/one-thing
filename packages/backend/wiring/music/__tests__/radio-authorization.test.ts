import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnethingRadioConductorOptions } from '@onething/runtime/music/radio-conductor'

type Meta = { id: string; ownerUserId?: string; ownerWorkspaceId?: string; agentId?: string; updatedAt: number }
const fixture = vi.hoisted(() => ({
  dir: '', metas: new Map<string, Meta>(), conductor: undefined as OnethingRadioConductorOptions | undefined,
  getSession: vi.fn(), createSession: vi.fn(), updateAgent: vi.fn(), emit: vi.fn(), grant: vi.fn(),
  unattended: vi.fn(), variables: vi.fn(), refreshEnv: vi.fn(),
}))
vi.mock('@onething/runtime/storage/index', () => ({ getOnethingStorePath: () => fixture.dir }))
vi.mock('@onething/runtime/music/index', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/runtime/music/index')>(),
  createOnethingRadioConductor: (options: OnethingRadioConductorOptions) => {
    fixture.conductor = options
    return { onSample: vi.fn(), quiesce: vi.fn(), idle: async () => {} }
  },
}))
vi.mock('../../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: id => fixture.metas.get(id) }) }
})
vi.mock('../../../stores/sessions.js', () => ({
  getSession: (id: string) => fixture.getSession(id),
  getSessionsList: () => [...fixture.metas.values()],
  createSession: (...args: unknown[]) => fixture.createSession(...args),
  updateSessionAgent: vi.fn(),
}))
vi.mock('../../../session/reads.js', () => ({ sessionReads: { countMessages: () => 0 } }))
vi.mock('../../../stores/settings.js', () => ({ getSettings: () => ({ music: { enabled: true } }) }))
vi.mock('@onething/runtime/agents/store-bound.wiring', () => ({
  agentExists: () => true,
  createAgent: vi.fn(),
  findAgent: () => ({ systemPrompt: '' }),
  updateAgent: (...args: unknown[]) => fixture.updateAgent(...args),
}))
vi.mock('@onething/core', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/core')>(),
  addGrant: (...args: unknown[]) => fixture.grant(...args),
}))
vi.mock('@onething/runtime/permissions/unattended', () => ({ markSessionUnattended: (...args: unknown[]) => fixture.unattended(...args) }))
vi.mock('@onething/runtime/variables/registry', () => ({ getVariableRegistry: () => ({ list: fixture.variables }) }))
vi.mock('../../engine/index.js', () => ({ getStreamEngineSafe: () => ({ getController: () => undefined }) }))
vi.mock('../../../events/index.js', () => ({ getEventBus: () => ({ emit: fixture.emit }) }))
vi.mock('../service.js', async () => {
  const { ncmMusicProvider } = await import('@onething/runtime/music/index')
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
    expect(fixture.createSession).toHaveBeenCalledWith(expect.any(String), '电台', {
      initialOwner: { userId: 'local-user', workspaceId: 'default' },
    })
    const id = radio.getRadioStore().readBrief().sessionId
    expect(fixture.emit).toHaveBeenCalledWith(id, expect.objectContaining({ source: 'radio' }), {
      executionContext: { userId: 'local-user', workspaceId: 'default' },
    })
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
