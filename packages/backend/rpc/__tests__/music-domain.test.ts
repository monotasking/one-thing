/**
 * music 域,端到端穿过 dispatcher(结构债 P4c 第九批)。
 *
 * 接的是被删掉的两处转发的测试位:`apps/electron/src/music/ipc.ts` 的六条透传工厂
 * 与 `@main/ipc/music.ts` 里那八条裸 `ipcMain.handle`。值得钉的是:
 *  - 十四条方法都在 router 的白名单上,四条推送**不在**这里(它们走
 *    `broadcastVoiceHostMessage` 端口);
 *  - 参数校验(空 query / 缺 action / 缺 providerId)与迁移前逐字相同;
 *  - `openRadio` 的总开关前置检查还在,文案逐字相同;
 *  - `search` 经 process-runner 桩跑通,拿的是 provider 的解析结果;
 *  - `setProvider` 的「未知 CLI」与「同一个 provider 直接成功」两条早退还在。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@shared/ipc/rpc.js'

const runner = vi.hoisted(() => ({ run: vi.fn() }))
const provider = vi.hoisted(() => ({
  descriptor: { id: 'ncm-cli', binary: 'ncm-cli' },
  reliability: { volumeSource: 'none' as string, probePaths: undefined as unknown },
  cli: {
    build: { search: vi.fn((query: string, limit: number) => ['search', query, String(limit)]) },
    parse: {
      envelope: vi.fn(() => ({ ok: true, message: '' })),
      searchRecords: vi.fn(() => [{ title: '可惜没如果', artist: '林俊杰', playFlag: true }]),
    },
  },
}))
const settings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ music: { enabled: true, provider: 'ncm-cli' } })),
  saveSettings: vi.fn(),
}))
const radio = vi.hoisted(() => ({
  openRadioStation: vi.fn(),
  requestSong: vi.fn(async () => ({ success: true, title: '可惜没如果 - 林俊杰' })),
  getProgrammeSnapshot: vi.fn(() => ({ entries: [{ encryptedId: '1', title: 'a' }], onDeck: 'a' })),
  applyProgrammeAction: vi.fn(() => ({ success: true })),
  getMusicLyrics: vi.fn(() => null),
  getRadioStartingTitle: vi.fn(() => undefined),
  getRadioStore: vi.fn(() => ({
    readBrief: () => ({ active: true, intent: '深夜', onDeck: 'a' }),
    readProgramme: () => ({ entries: [{ title: 'a' }] }),
    writeBrief: vi.fn(),
    writeProgramme: vi.fn(),
  })),
  isRadioActive: vi.fn(() => false),
  likeCurrentSong: vi.fn(),
  markRadioGesture: vi.fn(),
  radioToolClose: vi.fn(),
  recordRadioSkip: vi.fn(),
  replayCurrentRadioSong: vi.fn(),
  resumeRadioPlayback: vi.fn(),
  skipToNextRadioSong: vi.fn(),
  disposeRadioConductor: vi.fn(),
  startRadioConductor: vi.fn(),
}))
const service = vi.hoisted(() => ({
  getActiveMusicProvider: vi.fn(),
  getMusicNowPlaying: vi.fn(() => ({ status: 'playing', title: 'a', position: 3, queueLength: 1, currentIndex: 0 })),
  getMusicService: vi.fn(() => ({
    getState: () => ({
      setupStage: 'ready',
      configured: true,
      loggedIn: true,
      playerBackend: 'mpv',
      source: 'fm',
    }),
  })),
  refreshMusicNowPlaying: vi.fn(async () => {}),
  resetMusicServiceForProviderSwitch: vi.fn(),
  stopMusicPlayerKeepalive: vi.fn(),
}))

vi.mock('@onething/runtime/music/process-runner', () => ({
  createElectronMusicProcessRunner: () => runner,
}))
vi.mock('../../stores/settings.js', () => settings)
vi.mock('../../wiring/music/radio.js', () => radio)
vi.mock('../../wiring/music/service.js', () => service)
vi.mock('../../wiring/music/dj-voice.js', () => ({ resolveDjSpeakDone: vi.fn() }))

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('music RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    const [registry, domain] = await Promise.all([
      import('../registry.js'),
      import('../domains/music.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    registry.resetRpcRegistryForTests()
    dispose = domain.registerMusicRpcDomain()
    service.getActiveMusicProvider.mockReturnValue(provider as never)
    settings.getSettings.mockReturnValue({ music: { enabled: true, provider: 'ncm-cli' } })
    runner.run.mockReset().mockResolvedValue({ stdout: '{}', stderr: '', code: 0 })
    radio.openRadioStation.mockReset()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    vi.clearAllMocks()
  })

  const call = (method: string, payload: unknown = {}) =>
    dispatchRpc({ domain: 'music', method, payload })

  it('reports the wizard state and the radio brief', async () => {
    const state = unwrap(await call('getState'))
    expect(state.success).toBe(true)
    expect((state.state as { setupStage: string }).setupStage).toBe('ready')

    expect(unwrap(await call('getRadio'))).toEqual({
      active: true,
      intent: '深夜',
      lastError: undefined,
      starting: undefined,
      programmeLength: 1,
      canResume: true,
      upNext: 'a',
      volume: undefined,
    })
  })

  it('searches through the injected process runner and projects the CLI records', async () => {
    runner.run.mockResolvedValue({ stdout: 'RAW', stderr: '', code: 0 })

    const data = unwrap(await call('search', { query: ' 林俊杰 ' }))
    expect(runner.run).toHaveBeenCalledWith({
      command: 'ncm-cli',
      args: ['search', '林俊杰', '10'],
      timeoutMs: 20_000,
    })
    expect(data).toEqual({
      success: true,
      records: [{ title: '可惜没如果', artist: '林俊杰', playFlag: true }],
    })
  })

  it('keeps the per-method argument guards (empty query / missing action / missing providerId)', async () => {
    expect(unwrap(await call('search', { query: '   ' }))).toEqual({
      success: false,
      error: 'query is required',
    })
    expect(unwrap(await call('requestSong', { query: '' }))).toEqual({
      success: false,
      error: 'query is required',
    })
    expect(unwrap(await call('programmeAction', {}))).toEqual({
      success: false,
      error: 'action is required',
    })
    expect(unwrap(await call('setProvider', {}))).toEqual({
      success: false,
      error: 'providerId is required',
    })
  })

  it('keeps the radio master switch in front of openRadio', async () => {
    settings.getSettings.mockReturnValue({ music: { enabled: false, provider: 'ncm-cli' } })
    expect(unwrap(await call('openRadio', { intent: ' 深夜 ', clearProgramme: true }))).toEqual({
      success: false,
      error: '音乐电台未启用:请在 设置 → 音乐 打开总开关',
    })
    expect(radio.openRadioStation).not.toHaveBeenCalled()

    settings.getSettings.mockReturnValue({ music: { enabled: true, provider: 'ncm-cli' } })
    expect(unwrap(await call('openRadio', { intent: ' 深夜 ', clearProgramme: true }))).toEqual({
      success: true,
    })
    expect(radio.openRadioStation).toHaveBeenCalledWith('深夜', { clearProgramme: true })
  })

  it('refuses an unknown CLI and short-circuits a no-op provider switch', async () => {
    expect(unwrap(await call('setProvider', { providerId: 'spotify' }))).toEqual({
      success: false,
      error: '未知的音乐 CLI:spotify',
    })
    expect(settings.saveSettings).not.toHaveBeenCalled()

    expect(unwrap(await call('setProvider', { providerId: 'ncm-cli' }))).toEqual({ success: true })
    expect(settings.saveSettings).not.toHaveBeenCalled()
    expect(service.stopMusicPlayerKeepalive).not.toHaveBeenCalled()
  })

  it('runs a transport command through the CLI and reads the player back', async () => {
    const data = unwrap(await call('command', { command: 'pause' }))
    expect(runner.run).toHaveBeenCalledWith({
      command: 'ncm-cli',
      args: ['pause'],
      timeoutMs: 10_000,
    })
    expect(service.refreshMusicNowPlaying).toHaveBeenCalled()
    expect(data.success).toBe(true)
  })

  it('keeps only the fourteen router methods on the allowlist', async () => {
    const response = await dispatchRpc({ domain: 'music', method: 'wipeLibrary', payload: {} })
    expect(response.ok).toBe(false)
  })
})
