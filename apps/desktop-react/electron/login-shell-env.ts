import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * 登录 shell 环境补水 —— 从退役的 Vue 宿主(`apps/electron/src/app/login-shell-env.ts`,
 * 50ff9cbdf 随宿主一起删掉)原样搬回来。那次删完 React 壳就再没人做这件事:
 * 从 Dock / Finder 起的 app 只拿到 launchd 给的 `/usr/bin:/bin:/usr/sbin:/sbin`,
 * 于是 ACP 适配器(`claude-agent-acp` / `pi-acp`)、MCP stdio、bash 工具里的
 * Homebrew / nvm / bun 命令全都 ENOENT —— 终端里 `bun run dev` 起的却一切正常,
 * 两边行为分叉,排障时最难看出来的那种。
 *
 * 必须在装配**之前**跑:`ACPClient` / MCP / bash 都在 spawn 那一刻读 `process.env`。
 */

/** `getLogger(ns)` 的那一小截形状;本文件不直接 import 日志门面,测试可注入。 */
export interface LoginShellEnvLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>, err?: unknown): void
}

const ENV_START_MARKER = '__ONETHING_LOGIN_SHELL_ENV_START__'
const DEFAULT_TIMEOUT_MS = 3500
const MAX_ENV_OUTPUT_BYTES = 1024 * 1024
const CACHE_FORMAT_VERSION = 1

export interface HydrateLoginShellEnvOptions {
  env?: NodeJS.ProcessEnv
  logger?: LoginShellEnvLogger
  platform?: NodeJS.Platform
  shell?: string
  timeoutMs?: number
  /**
   * 登录 shell 环境缓存文件;undefined 用默认(~/.onething/login-shell-env.json),
   * null 禁用缓存。命中缓存时同步注入(0ms),后台仍跑一次真实 shell 校正差异。
   */
  cacheFilePath?: string | null
  /** 测试用:禁掉缓存命中后的后台校正。 */
  disableBackgroundRefresh?: boolean
}

export interface LoginShellEnvCacheFingerprint {
  version: number
  shell: string
  configMtimes: Record<string, number | null>
}

interface LoginShellEnvCacheFile {
  fingerprint: LoginShellEnvCacheFingerprint
  env: Record<string, string>
}

/**
 * 以 shell 配置文件的 mtime 为缓存指纹:任何 rc/profile 变化都会失效。
 * 无法覆盖 rc 内部 `source` 的其他文件——后台校正兜底这类漂移。
 */
export function computeShellConfigFingerprint(
  shell: string,
  homedir: string = os.homedir(),
): LoginShellEnvCacheFingerprint {
  const shellName = path.basename(shell).replace(/^-/, '')
  const candidates = shellName === 'bash'
    ? ['/etc/profile', path.join(homedir, '.bash_profile'), path.join(homedir, '.bashrc'), path.join(homedir, '.profile')]
    : shellName === 'zsh'
      ? ['/etc/zshenv', '/etc/zprofile', '/etc/zshrc', path.join(homedir, '.zshenv'), path.join(homedir, '.zprofile'), path.join(homedir, '.zshrc')]
      : ['/etc/profile', path.join(homedir, '.profile')]

  const configMtimes: Record<string, number | null> = {}
  for (const filePath of candidates) {
    try {
      configMtimes[filePath] = fs.statSync(filePath).mtimeMs
    } catch {
      configMtimes[filePath] = null
    }
  }
  return { version: CACHE_FORMAT_VERSION, shell, configMtimes }
}

function fingerprintEquals(a: LoginShellEnvCacheFingerprint, b: LoginShellEnvCacheFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function defaultLoginShellEnvCachePath(): string {
  return path.join(os.homedir(), '.onething', 'login-shell-env.json')
}

function readLoginShellEnvCache(cachePath: string): LoginShellEnvCacheFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as LoginShellEnvCacheFile
    if (!parsed?.fingerprint || parsed.fingerprint.version !== CACHE_FORMAT_VERSION) return undefined
    if (!parsed.env || typeof parsed.env !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function writeLoginShellEnvCache(
  cachePath: string,
  fingerprint: LoginShellEnvCacheFingerprint,
  env: Record<string, string>,
  logger?: LoginShellEnvLogger,
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    // 缓存包含完整登录 shell 环境(可能含密钥),收紧到仅属主可读写。
    fs.writeFileSync(cachePath, JSON.stringify({ fingerprint, env }), { mode: 0o600 })
  } catch (error: unknown) {
    logger?.warn('login shell env cache write failed', { cachePath }, error)
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getDefaultShell(platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return '/bin/zsh'
  return undefined
}

function getShellArgs(shell: string, command: string): string[] {
  const shellName = path.basename(shell).replace(/^-/, '')
  if (shellName === 'sh' || shellName === 'dash') return ['-i', '-c', command]
  return ['-l', '-i', '-c', command]
}

export function parseLoginShellEnvOutput(output: Buffer | string): Record<string, string> {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : output
  const parts = text.split('\0')
  const markerIndex = parts.indexOf(ENV_START_MARKER)
  if (markerIndex < 0) return {}

  const result: Record<string, string> = {}
  for (const part of parts.slice(markerIndex + 1)) {
    const equalsIndex = part.indexOf('=')
    if (equalsIndex <= 0) continue

    const name = part.slice(0, equalsIndex)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    result[name] = part.slice(equalsIndex + 1)
  }
  return result
}

export function mergeMissingEnv(
  target: NodeJS.ProcessEnv,
  source: Record<string, string>,
): string[] {
  const merged: string[] = []

  for (const [name, value] of Object.entries(source)) {
    if (!value) continue
    if (name === 'PATH') continue // Never "missing" — see mergePathEnv.
    if (target[name]) continue
    target[name] = value
    merged.push(name)
  }

  return merged
}

/**
 * Unions the login shell's PATH into the target, login-shell entries first.
 *
 * PATH is the one variable `mergeMissingEnv` can never repair, and the only one
 * that really matters here: a GUI-launched app is always handed a PATH by
 * launchd (`/usr/bin:/bin:/usr/sbin:/sbin`), so "fill in what's missing" always
 * skips it — leaving every Homebrew/nvm/pipx binary invisible to a
 * double-clicked build while working fine in a terminal-launched dev run.
 *
 * A union rather than a replacement: the login shell's order carries the user's
 * intent (their nvm shim before /usr/bin), while keeping the inherited entries
 * means we can only ever add resolvable commands, never take one away.
 *
 * @returns whether PATH changed.
 */
export function mergePathEnv(
  target: NodeJS.ProcessEnv,
  source: Record<string, string>,
): boolean {
  const incoming = source.PATH
  if (!incoming) return false

  const existing = target.PATH ?? ''
  const seen = new Set<string>()
  const entries: string[] = []
  for (const entry of [...incoming.split(path.delimiter), ...existing.split(path.delimiter)]) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }

  const merged = entries.join(path.delimiter)
  if (merged === existing) return false
  target.PATH = merged
  return true
}

async function readLoginShellEnv(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const command = `printf '\\0%s\\0' ${quoteShellArg(ENV_START_MARKER)}; /usr/bin/env -0`

  return new Promise((resolve, reject) => {
    const child = spawn(shell, getShellArgs(shell, command), {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const stdoutChunks: Buffer[] = []
    let stdoutLength = 0
    let failure: Error | undefined
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutLength += buffer.length
      if (stdoutLength > MAX_ENV_OUTPUT_BYTES) {
        failure = new Error('login shell environment output exceeded limit')
        child.kill('SIGTERM')
        return
      }
      stdoutChunks.push(buffer)
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) {
        reject(failure)
        return
      }
      if (timedOut) {
        reject(new Error('login shell environment timed out'))
        return
      }
      if (code !== 0) {
        reject(new Error(`login shell exited with code ${code}`))
        return
      }

      resolve(parseLoginShellEnvOutput(Buffer.concat(stdoutChunks, stdoutLength)))
    })
  })
}

export async function hydrateProcessEnvFromLoginShell(
  options: HydrateLoginShellEnvOptions = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return []

  const targetEnv = options.env ?? process.env
  const shell = options.shell || targetEnv.SHELL || getDefaultShell(platform)
  if (!shell) return []

  const cachePath = options.cacheFilePath === undefined
    ? defaultLoginShellEnvCachePath()
    : options.cacheFilePath
  const fingerprint = cachePath ? computeShellConfigFingerprint(shell) : undefined

  const readAndCacheShellEnv = async (): Promise<Record<string, string>> => {
    const shellEnv = await readLoginShellEnv(
      shell,
      targetEnv,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (cachePath && fingerprint) {
      writeLoginShellEnvCache(cachePath, fingerprint, shellEnv, options.logger)
    }
    return shellEnv
  }

  /**
   * PATH gets its own log line on purpose. When a packaged app cannot find a
   * globally installed CLI, this line is the whole diagnosis — a variable count
   * tells you nothing, and the failure otherwise surfaces as an unrelated
   * "command not found" somewhere far away.
   */
  const apply = (shellEnv: Record<string, string>, source: string): string[] => {
    const merged = mergeMissingEnv(targetEnv, shellEnv)
    if (mergePathEnv(targetEnv, shellEnv)) {
      merged.push('PATH')
      options.logger?.info('PATH repaired from login shell', { source, path: targetEnv.PATH })
    }
    if (merged.length > 0) {
      options.logger?.info('login shell env merged', { source, count: merged.length })
    }
    return merged
  }

  // 缓存命中:同步注入(省掉 0.5~3.5s 的登录 shell),后台仍跑一次真实
  // shell 校正 rc 内部 source 等指纹覆盖不到的漂移。
  if (cachePath && fingerprint) {
    const cached = readLoginShellEnvCache(cachePath)
    if (cached && fingerprintEquals(cached.fingerprint, fingerprint)) {
      const merged = apply(cached.env, 'login shell cache')
      if (!options.disableBackgroundRefresh) {
        void readAndCacheShellEnv()
          .then(shellEnv => {
            apply(shellEnv, 'background shell refresh')
          })
          .catch((error: unknown) => {
            options.logger?.warn('login shell env background refresh failed', {}, error)
          })
      }
      return merged
    }
  }

  try {
    return apply(await readAndCacheShellEnv(), 'login shell')
  } catch (error: unknown) {
    options.logger?.warn('login shell env load failed', { shell }, error)
    return []
  }
}
