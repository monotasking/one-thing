import { describe, expect, it, vi } from 'vitest'
import { MusicSetupService } from '../setup-service.js'
import { OnethingMusicQuotaError } from '../types.js'
import type {
  OnethingMusicBackend,
  OnethingMusicEnvStatus,
  OnethingMusicEvent,
  OnethingMusicPlayerBackend,
} from '../types.js'

function createHarness() {
  const backend: {
    [K in keyof OnethingMusicBackend]: ReturnType<typeof vi.fn>
  } & OnethingMusicBackend = {
    checkEnv: vi.fn(
      async (): Promise<OnethingMusicEnvStatus> => ({
        tools: {
          'ncm-cli': { installed: true, version: '0.1.6' },
          mpv: { installed: true, version: '0.40.0' },
        },
        npmAvailable: true,
        brewAvailable: true,
      }),
    ),
    installTool: vi.fn(async () => {}),
    setCredentials: vi.fn(async () => {}),
    isConfigured: vi.fn(async () => true),
    getPlayer: vi.fn(async (): Promise<OnethingMusicPlayerBackend> => 'mpv'),
    setPlayer: vi.fn(async () => {}),
    startLogin: vi.fn(async (_onOutput: (chunk: string) => void) => {}),
    cancelLogin: vi.fn(() => {}),
    checkLogin: vi.fn(async () => true),
    logout: vi.fn(async () => {}),
  }

  const events: OnethingMusicEvent[] = []
  const service = new MusicSetupService({
    backend,
    emit: event => events.push(event),
    getSource: () => 'daily',
    logger: { warn: () => {} },
  })
  return { backend, service, events }
}

describe('MusicSetupService', () => {
  it('closes admission and drains a real backend promise without late state emissions or new probes', async () => {
    const h = createHarness()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    h.backend.checkEnv.mockImplementationOnce(async () => {
      await pending
      return { tools: { 'ncm-cli': { installed: true } }, npmAvailable: false, brewAvailable: false }
    })
    const probing = h.service.refreshEnv()
    h.service.dispose()
    let drained = false
    const closing = h.service.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(h.service.checkLogin()).rejects.toThrow('shutting down')
    expect(() => h.service.setSource('fm')).toThrow('shutting down')
    release()
    await probing
    await closing
    expect(h.backend.checkLogin).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    expect(h.backend.cancelLogin).toHaveBeenCalledOnce()
  })
  it('walks the setup stages as prerequisites are met', async () => {
    const harness = createHarness()
    harness.backend.checkEnv.mockResolvedValueOnce({
      tools: { 'ncm-cli': { installed: false }, mpv: { installed: false } },
      npmAvailable: true,
      brewAvailable: true,
    })
    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('env')

    // Credentials missing. `login --check` fails too, because ncm-cli cannot
    // sign a request without them ("[错误] API key 未设置") — being logged in
    // without credentials is not a state the CLI can produce.
    harness.backend.isConfigured.mockResolvedValueOnce(false)
    harness.backend.checkLogin.mockResolvedValueOnce(false)
    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('credentials')

    harness.backend.checkLogin.mockResolvedValueOnce(false)
    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('login')

    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('ready')
  })

  it('skips the ~10s `config list` when the cheap login check already answered', async () => {
    // `login --check` costs ~0.25s; `config list` costs ~10s because ncm-cli
    // syncs its server manifest first. A positive login proves credentials
    // exist, so asking again is ten seconds of pure latency on the first music
    // request of every session.
    const harness = createHarness()
    await harness.service.refreshEnv()

    expect(harness.service.getState().setupStage).toBe('ready')
    expect(harness.backend.isConfigured).not.toHaveBeenCalled()
  })

  it('does not probe credentials before ncm-cli exists', async () => {
    const harness = createHarness()
    harness.backend.checkEnv.mockResolvedValueOnce({
      tools: { 'ncm-cli': { installed: false }, mpv: { installed: true } },
      npmAvailable: true,
      brewAvailable: true,
    })
    await harness.service.refreshEnv()
    expect(harness.backend.isConfigured).not.toHaveBeenCalled()
    expect(harness.backend.checkLogin).not.toHaveBeenCalled()
  })

  it('only gates on mpv when mpv is the chosen player', async () => {
    // Demanding mpv under orpheus would strand a working macOS setup on the
    // install step: there the 网易云音乐 App plays and mpv is never involved.
    const harness = createHarness()
    harness.backend.checkEnv.mockResolvedValueOnce({
      tools: { 'ncm-cli': { installed: true, version: '0.1.6' }, mpv: { installed: false } },
      npmAvailable: true,
      brewAvailable: true,
    })
    harness.backend.getPlayer.mockResolvedValueOnce('orpheus')
    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('ready')
  })

  it('stays on the env step when mpv is chosen but missing', async () => {
    const harness = createHarness()
    harness.backend.checkEnv.mockResolvedValueOnce({
      tools: { 'ncm-cli': { installed: true, version: '0.1.6' }, mpv: { installed: false } },
      npmAvailable: true,
      brewAvailable: true,
    })
    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('env')
  })

  it('reports credential failures instead of claiming success', async () => {
    const harness = createHarness()
    harness.backend.setCredentials.mockRejectedValueOnce(new Error('无效的配置项'))
    await expect(harness.service.setCredentials('1', 'k')).rejects.toThrow('无效的配置项')
    expect(harness.service.getState().configured).toBe(false)
  })

  it('keeps a working setup when the daily quota runs out mid-probe', async () => {
    // Quota says nothing about credentials. Treating the failure as
    // "not configured" walks the user back to the credentials step to re-enter
    // a privateKey that was never the problem — and spends more quota trying.
    const harness = createHarness()
    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('ready')

    harness.backend.checkLogin.mockRejectedValueOnce(new OnethingMusicQuotaError('请求总量超限'))
    await harness.service.refreshEnv()

    expect(harness.service.getState().setupStage).toBe('ready')
    expect(harness.service.getState().configured).toBe(true)
    expect(harness.service.getState().lastError).toBe('请求总量超限')
  })

  it('keeps the last known setup when reading the player fails', async () => {
    const harness = createHarness()
    await harness.service.refreshEnv()

    harness.backend.getPlayer.mockRejectedValueOnce(new Error('daemon 无响应（3s 超时）'))
    await harness.service.refreshEnv()

    expect(harness.service.getState().setupStage).toBe('ready')
    expect(harness.service.getState().lastError).toBe('daemon 无响应（3s 超时）')
  })

  it('clears a stale error once the probe succeeds again', async () => {
    const harness = createHarness()
    harness.backend.checkLogin.mockRejectedValueOnce(new OnethingMusicQuotaError('请求总量超限'))
    await harness.service.refreshEnv()
    expect(harness.service.getState().lastError).toBe('请求总量超限')

    await harness.service.refreshEnv()
    expect(harness.service.getState().lastError).toBeUndefined()
  })

  it('emits login output so the settings tab can draw the QR code', async () => {
    const harness = createHarness()
    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      onOutput('https://music.163.com/login?code=abc')
    })
    await harness.service.startLogin()
    expect(harness.events).toContainEqual({ type: 'login-output', chunk: 'https://music.163.com/login?code=abc' })
  })
})
