/**
 * ncm-cli backed music setup backend.
 *
 * ncm-cli is NetEase's official CLI for individual developers (the only
 * sanctioned personal channel — the open platform's OpenAPI itself is
 * enterprise-only). Every command is an independent process, so driving it as a
 * subprocess is the intended usage.
 *
 * **Setup only.** Playback lives nowhere in this file: the model runs `search`,
 * `queue add`, `next`, `state` itself through bash, guided by the
 * `netease-music-cli` skill. What stays here is what cannot be handed to a chat
 * model — writing the privateKey (never through a message, never through argv)
 * and the QR login, both owned by the settings UI.
 *
 * Constraints established against ncm-cli 0.1.6, still true of this file:
 *
 *  - `config`/`logout` predate `--output json` and answer in prose, so success
 *    is the exit code (see `runCliText`).
 *  - A zero exit is not success: refusals arrive in a JSON envelope with
 *    `success: false` and exit 0.
 *  - Commands that hit the content API take 3-15s and consume a daily quota;
 *    local ones (`config get`) take ~0.2s.
 */

import {
  OnethingMusicQuotaError,
  type OnethingMusicBackend,
  type OnethingMusicEnvStatus,
  type OnethingMusicPlayerBackend,
  type OnethingMusicProcessHandle,
  type OnethingMusicProcessRunner,
  type OnethingMusicToolStatus,
} from './types.js'
import { extractFirstJsonObject } from './cli-json.js'

const NCM_CLI_BIN = 'ncm-cli'
const NCM_CLI_PACKAGE = '@music163/ncm-cli'
const DEFAULT_TIMEOUT_MS = 20_000
const INSTALL_TIMEOUT_MS = 5 * 60_000
const QUOTA_MARKER = '请求总量超限'
const PLAYER_CACHE_MS = 5_000

export interface NcmCliDriverOptions {
  runner: OnethingMusicProcessRunner
  /**
   * Writes `content` to a private temp file and returns its path; the caller
   * deletes it via the returned disposer. Used for privateKey, which ncm-cli
   * accepts as a file path — keeping the secret out of argv (visible to `ps`).
   */
  writeSecretFile(content: string): Promise<{ path: string; dispose(): Promise<void> }>
  logger?: { warn(message: string, ...args: unknown[]): void }
}

interface NcmCliEnvelope {
  success?: boolean
  message?: string
  [key: string]: unknown
}

/** See {@link extractFirstJsonObject}: the envelope sits after stray lines. */
export function extractNcmCliJson(stdout: string): NcmCliEnvelope | null {
  return extractFirstJsonObject<NcmCliEnvelope>(stdout)
}

function parseVersion(stdout: string): string | undefined {
  const match = stdout.match(/\d+\.\d+\.\d+[\w.-]*/)
  return match?.[0]
}

/**
 * `config list` is the one command that prints prose instead of JSON, and it
 * has two shapes: a `尚未配置。…` sentence when nothing is set, or a
 * `appId: 123 (凭证文件)` listing once it is. Require both keys to carry a real
 * value — `privateKey` alone is not enough to sign a request.
 */
export function parseNcmCliConfigured(stdout: string): boolean {
  if (/尚未配置/.test(stdout)) return false

  const readKey = (key: string): string | undefined => {
    const line = stdout.split('\n').find(entry => entry.trim().startsWith(`${key}:`))
    if (!line) return undefined
    const value = line.slice(line.indexOf(':') + 1).trim()
    if (!value || value.includes('未配置')) return undefined
    return value
  }

  return Boolean(readKey('appId') && readKey('privateKey'))
}

export class NcmCliDriver implements OnethingMusicBackend {
  private loginHandle: OnethingMusicProcessHandle | null = null
  private playerCache: { value: OnethingMusicPlayerBackend; at: number } | null = null

  constructor(private readonly options: NcmCliDriverOptions) {}

  // --------------------------------------------------------------------------
  // Environment
  // --------------------------------------------------------------------------

  private async probeTool(command: string, args: string[]): Promise<OnethingMusicToolStatus> {
    try {
      const result = await this.options.runner.run({ command, args, timeoutMs: 10_000 })
      if (result.code !== 0) return { installed: false }
      return { installed: true, version: parseVersion(result.stdout) }
    } catch {
      return { installed: false }
    }
  }

  private async probeAvailable(command: string): Promise<boolean> {
    try {
      const result = await this.options.runner.run({ command, args: ['--version'], timeoutMs: 10_000 })
      return result.code === 0
    } catch {
      return false
    }
  }

  async checkEnv(): Promise<OnethingMusicEnvStatus> {
    const [ncmCli, mpv, npmAvailable, brewAvailable] = await Promise.all([
      this.probeTool(NCM_CLI_BIN, ['--version']),
      this.probeTool('mpv', ['--version']),
      this.probeAvailable('npm'),
      this.probeAvailable('brew'),
    ])
    return { tools: { 'ncm-cli': ncmCli, mpv }, npmAvailable, brewAvailable }
  }

  async installTool(tool: string, onOutput?: (chunk: string) => void): Promise<void> {
    if (tool !== 'ncm-cli' && tool !== 'mpv') {
      throw new Error(`未知的安装目标:${tool}`)
    }
    const spec =
      tool === 'ncm-cli'
        ? { command: 'npm', args: ['install', '-g', NCM_CLI_PACKAGE] }
        : { command: 'brew', args: ['install', 'mpv'] }

    const handle = this.options.runner.spawn({
      ...spec,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onStdout: onOutput,
      onStderr: onOutput,
    })
    const result = await handle.done
    if (result.code !== 0) {
      throw new Error(`${spec.command} ${spec.args.join(' ')} 失败（退出码 ${result.code ?? 'null'}）`)
    }
  }

  // --------------------------------------------------------------------------
  // ncm-cli invocation
  // --------------------------------------------------------------------------

  /**
   * Runs a command that reports in plain text rather than a JSON envelope.
   *
   * `config` and `logout` predate ncm-cli's `--output json` convention and
   * print prose (`✓ 已设置 appId = x`), so success is the exit code, not a
   * parsed `success` field. Passing `--output json` to them is silently
   * ignored, which is exactly what made this worth separating.
   */
  private async runCliText(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
    const result = await this.options.runner.run({
      command: NCM_CLI_BIN,
      args,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    const combined = `${result.stdout}\n${result.stderr}`
    if (combined.includes(QUOTA_MARKER)) throw new OnethingMusicQuotaError(QUOTA_MARKER)

    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim()
      throw new Error(message || `ncm-cli ${args.join(' ')} 失败（退出码 ${result.code ?? 'null'}）`)
    }

    // A zero exit does NOT mean success: ncm-cli refuses commands in a JSON
    // envelope and still exits 0 — e.g. `play` answers "TUI 正在运行，请使用
    // queue add…". Dropping that envelope is what let a refused `play` pose as
    // a successful one, leaving the caller to poll `state` for evidence that
    // was never coming. Never discard a failure the CLI stated outright.
    const envelope = extractNcmCliJson(result.stdout)
    if (envelope?.success === false) {
      throw new Error(envelope.message?.trim() || `ncm-cli ${args.join(' ')} 失败`)
    }
    return result.stdout
  }

  /**
   * @param intent - Required by ncm-cli for every non-playback command; it is
   *   the user-intent summary passed as `--userInput`.
   */
  private async runCli(args: string[], options: { intent?: string; timeoutMs?: number } = {}): Promise<NcmCliEnvelope> {
    const finalArgs = [...args, '--output', 'json']
    if (options.intent) finalArgs.push('--userInput', options.intent)

    const result = await this.options.runner.run({
      command: NCM_CLI_BIN,
      args: finalArgs,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    const combined = `${result.stdout}\n${result.stderr}`
    if (combined.includes(QUOTA_MARKER)) {
      throw new OnethingMusicQuotaError(QUOTA_MARKER)
    }

    const envelope = extractNcmCliJson(result.stdout)
    if (!envelope) {
      // ncm-cli reports hard failures (missing API key, bad args) on stderr
      // with an empty stdout — an expected path, not a parsing defect. Only
      // warn when it produced output we genuinely could not read.
      const stderr = result.stderr.trim()
      if (result.stdout.trim()) {
        this.options.logger?.warn('[music] ncm-cli returned unparsable output', {
          args,
          stdout: result.stdout.slice(0, 400),
        })
      }
      throw new Error(stderr || `ncm-cli ${args[0]} 没有返回可解析的结果`)
    }
    // Two envelope dialects: playback/login answer `{success, message}`, while
    // the data commands proxy the open platform's `{code, subCode, message,
    // data}`. Check both or a non-200 API reply reads as success.
    if (envelope.success === false) {
      throw new Error(typeof envelope.message === 'string' ? envelope.message : `ncm-cli ${args[0]} 执行失败`)
    }
    if (typeof envelope.code === 'number' && envelope.code !== 200) {
      const detail = [envelope.message, envelope.subCode].filter(part => typeof part === 'string' && part).join(' ')
      throw new Error(detail || `ncm-cli ${args.join(' ')} 返回 code ${envelope.code}`)
    }
    return envelope
  }

  // --------------------------------------------------------------------------
  // Credentials & login
  // --------------------------------------------------------------------------

  /**
   * Writes credentials only — deliberately does NOT touch `player`.
   *
   * This used to force `player=mpv`, on the theory that orchestration needs
   * `state` and orpheus rejects it — which silently undid the orpheus setup a
   * user had deliberately chosen, leaving them with no sound again. Saving
   * credentials must never rewrite a setting the user picked.
   */
  async setCredentials(appId: string, privateKey: string): Promise<void> {
    await this.runCliText(['config', 'set', 'appId', appId])

    // ncm-cli accepts a file path for privateKey; prefer it so the key never
    // lands in argv where `ps` would expose it.
    const secret = await this.options.writeSecretFile(privateKey)
    try {
      await this.runCliText(['config', 'set', 'privateKey', secret.path])
    } finally {
      await secret.dispose()
    }
  }

  /**
   * Cached briefly: this is on the hot path — every `play` and every poll tick
   * asks, and each ask is a ~0.2s subprocess, so the radio was spawning a
   * process a second just to re-read a setting that almost never changes. The
   * TTL is short so a `ncm-cli config set player` made outside the app still
   * lands within seconds, rather than needing a restart.
   */
  async getPlayer(): Promise<OnethingMusicPlayerBackend> {
    const cached = this.playerCache
    if (cached && Date.now() - cached.at < PLAYER_CACHE_MS) return cached.value

    // Deliberately not defaulting to mpv on failure. It reads as harmless —
    // mpv is the default — but callers act on it: answering "mpv" for a user
    // who chose orpheus starts an offscreen TUI and plays music at them,
    // because one `config get` happened to fail. Same family as the
    // `setCredentials` bug that forced player=mpv (see setCredentials).
    const stdout = await this.runCliText(['config', 'get', 'player'])
    const value: OnethingMusicPlayerBackend = /orpheus/.test(stdout) ? 'orpheus' : 'mpv'
    this.playerCache = { value, at: Date.now() }
    return value
  }

  async setPlayer(player: OnethingMusicPlayerBackend): Promise<void> {
    await this.runCliText(['config', 'set', 'player', player])
    this.playerCache = { value: player, at: Date.now() }
  }

  /**
   * @throws OnethingMusicQuotaError - Rethrown rather than reported as "not
   *   configured": running out of daily quota says nothing about credentials,
   *   and answering `false` sends the wizard back to the credentials step,
   *   where re-entering a perfectly good privateKey cannot help.
   */
  async isConfigured(): Promise<boolean> {
    try {
      return parseNcmCliConfigured(await this.runCliText(['config', 'list']))
    } catch (error) {
      if (error instanceof OnethingMusicQuotaError) throw error
      return false
    }
  }

  async startLogin(onOutput: (chunk: string) => void): Promise<void> {
    this.cancelLogin()
    // `login --background --output json` prints one JSON blob
    // ({success, qrCodeUrl, clickableUrl, message}) and EXITS immediately,
    // leaving a detached poller to finish on scan. Foreground `login` was
    // unusable through a pipe on two counts (measured, ncm-cli 0.1.6): it
    // only draws its terminal QR when stdout is a TTY (a pipe got zero
    // bytes), and even under a PTY the QR is ANSI colour art, not scannable
    // data. The URL lets the renderer draw its own real QR; login completion
    // is detected by polling `login --check`.
    const result = await this.options.runner.run({
      command: NCM_CLI_BIN,
      args: ['login', '--background', '--output', 'json'],
      timeoutMs: 30_000,
    })

    const combined = `${result.stdout}\n${result.stderr}`
    if (combined.includes(QUOTA_MARKER)) throw new OnethingMusicQuotaError(QUOTA_MARKER)

    // The renderer draws its QR from this blob, so a failed start must throw
    // (and reach the UI as an error) rather than hand over unusable output —
    // that exact silence left the login step showing nothing forever.
    const envelope = extractNcmCliJson(result.stdout)
    if (!envelope || envelope.success === false || result.code !== 0) {
      const message =
        (typeof envelope?.message === 'string' && envelope.message.trim()) ||
        result.stderr.trim() ||
        result.stdout.trim()
      throw new Error(message || `ncm-cli login 启动失败（退出码 ${result.code ?? 'null'}）`)
    }
    // Re-serialize instead of forwarding raw stdout: ncm-cli prints stray
    // non-JSON lines around its envelope, and the renderer JSON.parses this.
    onOutput(JSON.stringify(envelope))
  }

  cancelLogin(): void {
    this.loginHandle?.kill()
    this.loginHandle = null
  }

  /** @throws OnethingMusicQuotaError - See {@link isConfigured}. */
  async checkLogin(): Promise<boolean> {
    try {
      await this.runCli(['login', '--check'])
      return true
    } catch (error) {
      if (error instanceof OnethingMusicQuotaError) throw error
      return false
    }
  }

  async logout(): Promise<void> {
    // Text-mode: we need no payload back, only that it exited cleanly.
    await this.runCliText(['logout'])
  }
}
