import { describe, expect, it } from 'vitest'
import { NcmCliDriver, extractNcmCliJson, parseNcmCliConfigured } from '../ncm-cli-driver.js'
import { OnethingMusicQuotaError, type OnethingMusicProcessRunner } from '../types.js'

function createRunner(
  respond: (args: string[]) => { code?: number; stdout?: string; stderr?: string },
): { runner: OnethingMusicProcessRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: OnethingMusicProcessRunner = {
    run: async ({ command, args }) => {
      calls.push([command, ...args])
      const result = respond(args)
      return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
    spawn: ({ command, args }) => {
      calls.push([command, ...args])
      return { done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill: () => {} }
    },
  }
  return { runner, calls }
}

function createDriver(respond: (args: string[]) => { code?: number; stdout?: string; stderr?: string }) {
  const { runner, calls } = createRunner(respond)
  const disposed: string[] = []
  const driver = new NcmCliDriver({
    runner,
    writeSecretFile: async content => ({
      path: `/tmp/secret-${content.length}`,
      dispose: async () => {
        disposed.push(content)
      },
    }),
    logger: { warn: () => {} },
  })
  return { driver, calls, disposed }
}

describe('extractNcmCliJson', () => {
  it('skips the non-JSON preamble ncm-cli prints before its envelope', () => {
    const stdout = '[orpheus] orpheus://eyJjbWQiOiJwYXVzZSJ9\n{\n  "success": true,\n  "message": "已暂停播放"\n}\n'
    expect(extractNcmCliJson(stdout)).toEqual({ success: true, message: '已暂停播放' })
  })

  it('does not stop at a brace inside a string value', () => {
    const stdout = '{"message":"a } b","success":true}'
    expect(extractNcmCliJson(stdout)).toEqual({ message: 'a } b', success: true })
  })

  it('returns null when there is no parsable object', () => {
    expect(extractNcmCliJson('command not found')).toBeNull()
    expect(extractNcmCliJson('{"broken": ')).toBeNull()
  })
})

describe('parseNcmCliConfigured', () => {
  it('reads the real "not configured yet" sentence', () => {
    // Captured from ncm-cli 0.1.6 on a machine with no credentials set.
    expect(parseNcmCliConfigured(
      '尚未配置。运行 ncm-cli configure 进行交互式配置，或使用 ncm-cli config set <key> <value>。\n',
    )).toBe(false)
  })

  it('reads the listing shape once credentials exist', () => {
    expect(parseNcmCliConfigured('appId: 123456 (凭证文件)\nprivateKey: *** (凭证文件)\nplayer: mpv\n')).toBe(true)
  })

  it('requires both keys, since privateKey alone cannot sign a request', () => {
    expect(parseNcmCliConfigured('appId: (未配置)\nprivateKey: *** (凭证文件)\n')).toBe(false)
  })
})

describe('NcmCliDriver', () => {
  it('passes privateKey as a file path and cleans it up', async () => {
    // The whole reason setup cannot be handed to the model: a privateKey in a
    // chat message lives in the session history forever, and in argv it is
    // visible to every process on the machine via `ps`.
    const { driver, calls, disposed } = createDriver(() => ({ stdout: '✓ 已设置 appId = 123456\n' }))
    await driver.setCredentials('123456', 'PRIVATE')

    const flatCalls = calls.map(call => call.join(' '))
    expect(flatCalls.some(call => call.includes('PRIVATE'))).toBe(false)
    expect(flatCalls.some(call => call.includes('config set privateKey /tmp/secret-7'))).toBe(true)
    // Saving credentials must not touch `player`. This used to force mpv (for
    // the sake of `state` polling) and silently undid a working orpheus setup
    // the user had chosen deliberately.
    expect(flatCalls.some(call => call.includes('config set player'))).toBe(false)
    expect(disposed).toEqual(['PRIVATE'])
  })

  it('does not demand a JSON envelope from the text-mode config commands', async () => {
    // `config set` predates --output json and answers "✓ 已设置 appId = x";
    // requiring JSON here is what broke credential entry.
    const { driver, calls } = createDriver(() => ({ stdout: '✓ 已设置 appId = 123456\n' }))
    await expect(driver.setCredentials('123456', 'PRIVATE')).resolves.toBeUndefined()
    expect(calls.every(call => !call.includes('--output'))).toBe(true)
  })

  it('fails credential entry when ncm-cli rejects the value', async () => {
    // Observed: invalid input prints prose and exits 1.
    const { driver } = createDriver(() => ({
      code: 1,
      stdout: '无效的配置项: bogusKey\n可用配置项: appId, privateKey, player',
    }))
    await expect(driver.setCredentials('123456', 'PRIVATE')).rejects.toThrow('无效的配置项')
  })

  it('reports not-configured when config list exits non-zero', async () => {
    const { driver } = createDriver(() => ({ code: 1, stderr: '[错误] PRIVATE_KEY 未设置' }))
    await expect(driver.isConfigured()).resolves.toBe(false)
  })

  it('surfaces a refusal that ncm-cli reports with a zero exit code', async () => {
    // A zero exit is not success. ncm-cli refuses in a JSON envelope and still
    // exits 0 — this is the shape that let a refused `play` pose as a working
    // one for an entire evening, because only the exit code was checked.
    const { driver } = createDriver(() => ({
      code: 0,
      stdout: JSON.stringify({ success: false, message: '无效的配置项: bogusKey' }),
    }))
    await expect(driver.setCredentials('123456', 'PRIVATE')).rejects.toThrow('无效的配置项')
  })

  it('raises a quota error so callers can degrade instead of failing hard', async () => {
    const { driver } = createDriver(() => ({ stdout: '{"success":false,"message":"请求总量超限"}' }))
    await expect(driver.logout()).rejects.toBeInstanceOf(OnethingMusicQuotaError)
  })

  it('reads configuration from the human-formatted config list output', async () => {
    const { driver } = createDriver(() => ({
      stdout: 'appId: 123456 (凭证文件)\nprivateKey: *** (凭证文件)\nplayer: mpv (配置文件)\n',
    }))
    await expect(driver.isConfigured()).resolves.toBe(true)
  })

  it('detects a missing ncm-cli rather than throwing', async () => {
    const { driver } = createDriver(() => ({ code: 127, stderr: 'command not found: ncm-cli' }))
    const env = await driver.checkEnv()
    expect(env.tools['ncm-cli']?.installed).toBe(false)
  })

  it('reads the player from config', async () => {
    const { driver } = createDriver(() => ({ stdout: 'player: orpheus (配置文件)\n' }))
    await expect(driver.getPlayer()).resolves.toBe('orpheus')
  })

  it('caches the player, which sits on the hot path', async () => {
    // `config get player` is a ~0.2s subprocess and was being re-run on every
    // play and every poll tick — a process a second to re-read a setting that
    // almost never changes.
    const { driver, calls } = createDriver(() => ({ stdout: 'player: mpv\n' }))
    await driver.getPlayer()
    await driver.getPlayer()
    await driver.getPlayer()
    expect(calls.filter(call => call.includes('get')).length).toBe(1)
  })

  it('does not go back to the CLI for a player it just set', async () => {
    const { driver, calls } = createDriver(() => ({ stdout: '✓ 已设置 player = orpheus\n' }))
    await driver.setPlayer('orpheus')
    await expect(driver.getPlayer()).resolves.toBe('orpheus')
    expect(calls.some(call => call.includes('get'))).toBe(false)
  })

  it('surfaces a failed player read instead of answering "mpv"', async () => {
    // Defaulting to mpv here reads as harmless, but callers act on it: for a
    // user who chose orpheus it starts an offscreen TUI and plays music at
    // them, because one `config get` happened to fail.
    const { driver } = createDriver(() => ({ code: 1, stderr: 'daemon 无响应（3s 超时）' }))
    await expect(driver.getPlayer()).rejects.toThrow('daemon 无响应')
  })

  it('does not report spent quota as "not logged in" or "not configured"', async () => {
    // Both answers send the wizard back to re-enter credentials that were
    // never the problem — and spend more quota doing it.
    const quota = () => ({ stdout: '{"success":false,"message":"请求总量超限"}' })
    const login = createDriver(quota)
    await expect(login.driver.checkLogin()).rejects.toBeInstanceOf(OnethingMusicQuotaError)

    const configured = createDriver(quota)
    await expect(configured.driver.isConfigured()).rejects.toBeInstanceOf(OnethingMusicQuotaError)
  })

  it('still reports a genuine logged-out answer as false', async () => {
    const { driver } = createDriver(() => ({ stdout: '{"success":false,"message":"未登录"}' }))
    await expect(driver.checkLogin()).resolves.toBe(false)
  })

  it('emits the background-login JSON (with the QR URL) to the caller', async () => {
    const payload = '{"success":true,"qrCodeUrl":"https://163cn.tv/x","clickableUrl":"https://163cn.tv/x"}'
    const { runner, calls } = createRunner(() => ({ stdout: payload }))
    const driver = new NcmCliDriver({
      runner,
      writeSecretFile: async () => ({ path: '/tmp/x', dispose: async () => {} }),
      logger: { warn: () => {} },
    })

    let emitted = ''
    await driver.startLogin(chunk => (emitted += chunk))
    expect(emitted).toBe(payload)
    // Background mode is what makes the piped QR URL reach us at all.
    expect(calls.some(call => call.includes('--background') && call.includes('login'))).toBe(true)
  })

  it('emits only the JSON envelope even when ncm-cli prints stray lines around it', async () => {
    const { driver } = createDriver(() => ({
      stdout: 'npm warn something\n{"success":true,"qrCodeUrl":"https://163cn.tv/x"}\ntrailing noise\n',
    }))
    let emitted = ''
    await driver.startLogin(chunk => (emitted += chunk))
    // The renderer JSON.parses this verbatim — noise must never reach it.
    expect(JSON.parse(emitted)).toEqual({ success: true, qrCodeUrl: 'https://163cn.tv/x' })
  })

  it('throws instead of emitting when the login start fails', async () => {
    // A failed start used to hand unusable stdout to the renderer, which
    // left the login step silently QR-less forever.
    const exitFail = createDriver(() => ({ code: 1, stderr: 'ncm-cli: command failed' }))
    await expect(exitFail.driver.startLogin(() => {})).rejects.toThrow('ncm-cli: command failed')

    const refused = createDriver(() => ({ stdout: '{"success":false,"message":"未配置凭证"}' }))
    await expect(refused.driver.startLogin(() => {})).rejects.toThrow('未配置凭证')

    const quota = createDriver(() => ({ stdout: '{"success":false,"message":"请求总量超限"}' }))
    await expect(quota.driver.startLogin(() => {})).rejects.toBeInstanceOf(OnethingMusicQuotaError)

    const garbage = createDriver(() => ({ stdout: 'not json at all' }))
    await expect(garbage.driver.startLogin(() => {})).rejects.toThrow('not json at all')
  })
})
