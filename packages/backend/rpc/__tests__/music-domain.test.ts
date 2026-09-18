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
 *
 * ── 音乐收尾:**断言一个字没改,换的只有 mock** ────────────────────────────
 * 十二条处理器退成了资源投影(`rpc/domains/music.ts` 的文件头),所以这组用例的
 * 底座从「域直接调 `wiring/music/*`」变成「域调一台**真内核**,内核跑**真管线**,
 * 管线落到**真 provider**,provider 才碰到这些 mock」。这正是这组用例存在的方式:
 * 它量的是对外契约,而契约在换了底座之后一个字都不许变 —— 所以下面的 `expect`
 * 一行未动,动的是三样接线:
 *   ① `kernelSlot` —— `beforeEach` 里装一台真内核(真注册表 + 真 `ResourceTool` +
 *      `createMusicResourceProvider()` 那只真 provider,连它那道 `assertMusicOperator`
 *      信任门都是真的),只有 runner 的三个端口是最小实现;
 *   ② `principalOf` 给一个固定主体 —— 主体怎么铸有它自己那门(`rpc-principal`),
 *      这组的题目是「域把端口接对了」;
 *   ③ `radio` 这只 mock 里补上 `radioToolOpen` / `radioToolClose` / `radioToolStatus`
 *      —— 它们是端口真正的入口,而 `radioToolOpen` 的真实现第一件事就是调
 *      `openRadioStation`,所以 mock 也这么做:下面那条「总开关」用例断言的仍是
 *      `openRadioStation` 拿到了什么,而它现在是经整条管线到达的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@shared/ipc/rpc.js'
import { musicRouter } from '@shared/ipc/music.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'

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
const radio = vi.hoisted(() => {
  const openRadioStation = vi.fn()
  const status = { active: true, intent: '深夜', programmeLength: 1 }
  return {
  openRadioStation,
  // 端口真正的入口。真实现(`wiring/music/radio.ts`)第一件事就是调
  // `openRadioStation`,mock 照做 —— 否则下面那条用例断言的东西会凭空消失。
  radioToolOpen: vi.fn(async (intent: string, options: { clearProgramme: boolean }) => {
    openRadioStation(intent, options)
    return { ...status, intent }
  }),
  radioToolClose: vi.fn(async () => ({ ...status, active: false, programmeLength: 0 })),
  radioToolStatus: vi.fn(() => status),
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
  recordRadioSkip: vi.fn(),
  replayCurrentRadioSong: vi.fn(),
  resumeRadioPlayback: vi.fn(),
  skipToNextRadioSong: vi.fn(),
  disposeRadioConductor: vi.fn(),
  startRadioConductor: vi.fn(),
  }
})
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

/**
 * 这个进程当前那台资源内核 + 音乐子系统。域现在问的是前者,provider 问的是后者
 * (`getCurrentBackendInstance()?.music`),所以两样住在同一个句柄上。
 */
const kernelSlot = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock('@onething/runtime/music/process-runner', () => ({
  createElectronMusicProcessRunner: () => runner,
}))
vi.mock('../../current.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../current.js')>(),
  // 只换这一口:`setCurrentBackend` / `createBackendHandle` 仍是真的(那只窄句柄上
  // 没有资源内核这一格 —— 它是 `OnethingBackend` 的实例字段)。
  getCurrentBackendInstance: () => kernelSlot.current,
}))
vi.mock('../principal.js', () => ({
  principalOf: () => ({ kind: 'user', userId: 'local-user' }),
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
  let operations: ReturnType<typeof import('../../wiring/music/operations.js')['createMusicOperationsScope']>
  let unmountResources: (() => Promise<void>) | undefined

  beforeEach(async () => {
    const { createMusicOperationsScope } = await import('../../wiring/music/operations.js')
    const { setCurrentBackend, createBackendHandle } = await import('../../current.js')
    operations = createMusicOperationsScope({ service: { ...service, runner }, radio } as unknown as Parameters<typeof createMusicOperationsScope>[0])
    const music = { operations, radio, service, onNowPlayingChanged: () => () => {} }
    setCurrentBackend(createBackendHandle({ music: music as unknown as import('../../wiring/music/subsystem.js').MusicSubsystem }))

    /*
     * 一台真内核 + 真管线 + 真 provider。**先摆句柄再造 provider**:那几只成品适配器
     * 在装配那一刻就把音乐子系统捕获下来了(`radioAdapters()` 逐字同一句),顺序反了
     * 拿到的会是一个空句柄。
     */
    const [{ createResourceKernel, createMusicResourceProvider }, { ToolRunner }] = await Promise.all([
      import('../../wiring/resource/index.js'),
      import('@onething/core/toolkit'),
    ])
    kernelSlot.current = { music }
    const resourceKernel = createResourceKernel(validator => new ToolRunner({
      authorizer: { decide: async () => ({ kind: 'allow' as const }) },
      observer: { on: () => {} },
      validator,
    }))
    unmountResources = resourceKernel.mount(createMusicResourceProvider())
    kernelSlot.current = {
      music,
      resources: resourceKernel,
      // `dispatchRpc` 自己会问这一口(有实例就把处理器包成一格在途任务)。这里直接
      // 跑 —— 关机账不是这组用例的题目。
      runTask: <T,>(_label: string, run: () => T | Promise<T>) => Promise.resolve(run()),
      own: () => {},
    }

    const [registry, domain] = await Promise.all([
      import('../registry.js'),
      import('../domains/music.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    registry.resetRpcRegistryForTests()
    dispose = registry.registerRouterHandlers(musicRouter, domain.musicRpcHandlers)
    service.getActiveMusicProvider.mockReturnValue(provider as never)
    settings.getSettings.mockReturnValue({ music: { enabled: true, provider: 'ncm-cli' } })
    runner.run.mockReset().mockResolvedValue({ stdout: '{}', stderr: '', code: 0 })
    radio.openRadioStation.mockReset()
  })

  afterEach(async () => {
    await unmountResources?.()
    unmountResources = undefined
    kernelSlot.current = undefined
    await operations.drain()
    const { setCurrentBackend } = await import('../../current.js')
    setCurrentBackend(null)
    dispose?.()
    dispose = undefined
    vi.clearAllMocks()
  })

  const call = (method: string, payload: unknown = {}) =>
    dispatchRpc({ domain: 'music', method, payload })

  it.each(musicRouter.methods)('rejects a foreign operator before %s touches the host player', async method => {
    for (const context of [
      { ...DESKTOP_RPC_CONTEXT, ownerUid: 'alice' },
      { ...DESKTOP_RPC_CONTEXT, workspaceId: 'another-tenant' },
    ]) {
      const response = await dispatchRpc({ domain: 'music', method, payload: {} }, context)
      expect(response).toEqual({ ok: false, error: { message: 'Session not found' } })
    }
    expect(runner.run).not.toHaveBeenCalled()
    expect(settings.getSettings).not.toHaveBeenCalled()
    expect(settings.saveSettings).not.toHaveBeenCalled()
    expect(service.getMusicService).not.toHaveBeenCalled()
    expect(radio.openRadioStation).not.toHaveBeenCalled()
    expect(radio.requestSong).not.toHaveBeenCalled()
    expect(radio.applyProgrammeAction).not.toHaveBeenCalled()
  })

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

  it('opens the radio with no master switch in the way (retired 09-18)', async () => {
    settings.getSettings.mockReturnValue({ music: { enabled: false, provider: 'ncm-cli' } })
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
