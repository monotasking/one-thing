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
    // 驱动把 ncm-cli 的信封重新序列化过一次再交出来(它文件头上写着理由)。
    const envelope = JSON.stringify({ success: true, qrCodeUrl: 'https://music.163.com/login?code=abc' })
    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      onOutput(envelope)
    })
    await harness.service.startLogin()
    expect(harness.events).toContainEqual({ type: 'login-output', chunk: envelope })
  })
})

/**
 * ── 登录那一格的状态机(2026-09-18;正本 `music-panel-2026-09.md` §6.1)────────
 *
 * 判的就是那张表上的六格,以及它们之间**只有**这几条边:
 * start → waiting → ok,以及 start → failed / quota,与任何时候的 cancel → idle。
 * 「已扫码待确认」一格都没有 —— 那是刻意的空,不是漏了(`login --check` 只答成没成)。
 */
describe('MusicSetupService:登录那一格', () => {
  const envelope = (payload: Record<string, unknown>) => JSON.stringify(payload)

  it('出厂是 idle', () => {
    expect(createHarness().service.getState().login).toEqual({ status: 'idle' })
  })

  it('start → waiting,地址从信封里读出来,而且优先 qrCodeUrl', async () => {
    const harness = createHarness()
    const seen: string[] = []
    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      // 这一发之前必须已经是 starting —— 屏幕上那颗钮靠它转圈。
      seen.push(harness.service.getState().login.status)
      onOutput(envelope({
        success: true,
        qrCodeUrl: 'https://music.163.com/login?codekey=abc',
        clickableUrl: 'https://music.163.com/login?codekey=abc&from=cli',
      }))
    })
    await harness.service.startLogin()
    expect(seen).toEqual(['starting'])
    expect(harness.service.getState().login).toEqual({
      status: 'waiting',
      url: 'https://music.163.com/login?codekey=abc',
    })
  })

  it('没有 qrCodeUrl 时退用 clickableUrl', async () => {
    const harness = createHarness()
    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      onOutput(envelope({ success: true, clickableUrl: 'https://music.163.com/login?codekey=zzz' }))
    })
    await harness.service.startLogin()
    expect(harness.service.getState().login.url).toBe('https://music.163.com/login?codekey=zzz')
  })

  it('跑成了却没有地址 = failed,不是一直转圈', async () => {
    const harness = createHarness()
    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      onOutput('一块读不懂的输出')
    })
    await harness.service.startLogin()
    expect(harness.service.getState().login.status).toBe('failed')
  })

  it('启动失败 = failed + 后端原话;额度用完 = 单独一格 quota', async () => {
    const failing = createHarness()
    failing.backend.startLogin.mockRejectedValueOnce(new Error('ncm-cli 退出码 1'))
    await expect(failing.service.startLogin()).rejects.toThrow('ncm-cli 退出码 1')
    expect(failing.service.getState().login).toEqual({ status: 'failed', message: 'ncm-cli 退出码 1' })

    const spent = createHarness()
    spent.backend.startLogin.mockRejectedValueOnce(new OnethingMusicQuotaError('请求总量超限'))
    await expect(spent.service.startLogin()).rejects.toThrow('请求总量超限')
    expect(spent.service.getState().login).toEqual({ status: 'quota', message: '请求总量超限' })
  })

  it('轮询期间的「还没登上」不动地址 —— 那几声正是等待本身', async () => {
    const harness = createHarness()
    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      onOutput(envelope({ success: true, qrCodeUrl: 'https://music.163.com/login?codekey=abc' }))
    })
    await harness.service.startLogin()

    harness.backend.checkLogin.mockResolvedValueOnce(false)
    await harness.service.checkLogin()
    expect(harness.service.getState().login).toEqual({
      status: 'waiting',
      url: 'https://music.163.com/login?codekey=abc',
    })

    await harness.service.checkLogin()
    expect(harness.service.getState().login).toEqual({ status: 'ok' })
  })

  it('一次真的登上之后,向导自己走到 ready', async () => {
    const harness = createHarness()
    harness.backend.checkLogin.mockResolvedValueOnce(false)
    await harness.service.refreshEnv()
    expect(harness.service.getState().setupStage).toBe('login')

    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      onOutput(JSON.stringify({ success: true, qrCodeUrl: 'https://music.163.com/login?codekey=abc' }))
    })
    await harness.service.startLogin()
    await harness.service.checkLogin()
    expect(harness.service.getState().setupStage).toBe('ready')
    expect(harness.service.getState().login).toEqual({ status: 'ok' })
  })

  it('取消 → idle;退出登录 → idle', async () => {
    const harness = createHarness()
    harness.backend.startLogin.mockImplementationOnce(async onOutput => {
      onOutput(envelope({ success: true, qrCodeUrl: 'https://music.163.com/login?codekey=abc' }))
    })
    await harness.service.startLogin()
    harness.service.cancelLogin()
    expect(harness.backend.cancelLogin).toHaveBeenCalled()
    expect(harness.service.getState().login).toEqual({ status: 'idle' })

    await harness.service.checkLogin()
    expect(harness.service.getState().login).toEqual({ status: 'ok' })
    await harness.service.logout()
    expect(harness.service.getState().login).toEqual({ status: 'idle' })
  })

  it('没在登录的时候问一句「登上了没」,不会凭空冒出一个 waiting', async () => {
    const harness = createHarness()
    harness.backend.checkLogin.mockResolvedValueOnce(false)
    await harness.service.checkLogin()
    expect(harness.service.getState().login).toEqual({ status: 'idle' })
  })

  it('checkLogin 撞上额度 → quota,而且原样抛给调用方', async () => {
    const harness = createHarness()
    harness.backend.checkLogin.mockRejectedValueOnce(new OnethingMusicQuotaError('请求总量超限'))
    await expect(harness.service.checkLogin()).rejects.toThrow('请求总量超限')
    expect(harness.service.getState().login).toEqual({ status: 'quota', message: '请求总量超限' })
  })

  it('登录地址一个字都不进日志', async () => {
    const warn = vi.fn()
    const backendHarness = createHarness()
    const service = new MusicSetupService({
      backend: {
        ...backendHarness.backend,
        startLogin: async onOutput => {
          onOutput(JSON.stringify({ success: true, qrCodeUrl: 'https://music.163.com/login?codekey=secret' }))
        },
      },
      emit: () => {},
      getSource: () => 'daily',
      logger: { warn },
    })
    await service.startLogin()
    expect(warn).not.toHaveBeenCalled()
  })
})
