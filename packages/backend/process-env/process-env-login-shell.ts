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
 * 必须赶在**第一次 spawn 之前**落定:`ACPClient` / MCP / bash 都在 spawn 那一刻读 `process.env`。
 *
 * 第④步批 2a(2026-10-06)从 `apps/desktop-react/electron/login-shell-env.ts` 原样搬进后端:ACP / MCP stdio /
 * bash 都在后端 spawn,拆进程之后 PATH 必须补在后端进程里。今天有两个调用者 —— Electron 主进程
 * (与装配并行跑、第一次 spawn 之前等它)与不带界面的后端进程的桌面档(`backend-launcher.ts`,装配前起、
 * 建 server runtime 之前等它,因为 MCP stdio 在那一步里就会 spawn)。函数体一行没改。
 *
 * ── 09-26 事故:缓存把一台门的临时 store 灌进了用户的桌面 ─────────────────────
 * 从前这里起登录 shell 时把**本进程的整份环境**递给它当底,于是 shell 报回来的
 * 「登录环境」里混着启动它的那个人递的变量。一台真机门(`gate-providers-squeeze`)
 * 以 `ONETHING_STORE_PATH=/var/folders/…/pv-squeeze-store-…` 起壳跑了一遍,壳把这句
 * 连同 `ONETHING_GATE_HEADLESS` / `ONETHING_REACT_DEV_SERVER_URL=…5194` 一起写进了
 * **用户真 store 旁边**的缓存(缓存路径写死 `~/.onething`,门的隔离 store 隔离不到它);
 * 用户下一次起桌面,缓存命中、`mergeMissingEnv` 把缺席的 `ONETHING_STORE_PATH` 补上,
 * 整台后端就装在那个已被删掉又被 `mkdir -p` 重建的空临时目录里 —— 屏上是「原来的
 * 会话没了 / 模型没了」。而且它自我延续:后台校正再起 shell 时底是已被污染的
 * `process.env`,又把那句抄回缓存。三条修法,缺一条都堵不死:
 *  ① 登录 shell 的底只给身份与区域那几格({@link loginShellSeedEnv}),它报回来的
 *    才真是 rc 文件立起来的环境,不是启动者递的;
 *  ② 「这个进程住哪、怎么起的」是启动者的话,shell 说了不算:`ONETHING_*` / `npm_*` /
 *    `ELECTRON_*` 永不从登录环境注入({@link isLauncherOwnedEnvKey});
 *  ③ 缓存跟 store 走(`ONETHING_STORE_PATH` 优先,与 `storage` 的 `getOnethingStorePath()` 同语义;
 *    这个功能在 L0,不引 storage,所以自己读这一个环境变量),门的隔离 store 于是也隔离了这份缓存;
 *    格式版本抬到 2,旧法抓的缓存作废。
 */

/** `getLogger(ns)` 的那一小截形状;本文件不直接 import 日志门面,测试可注入。 */
export interface LoginShellEnvLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>, err?: unknown): void
}

const ENV_START_MARKER = '__ONETHING_LOGIN_SHELL_ENV_START__'
const DEFAULT_TIMEOUT_MS = 3500
const MAX_ENV_OUTPUT_BYTES = 1024 * 1024
/** 2(09-26):抓取改成只给身份底 —— 用整份进程环境当底抓出来的缓存一律作废。 */
const CACHE_FORMAT_VERSION = 2

/**
 * 登录 shell 的**底**:只有这几格从本进程递过去。shell 报回来的其余每一格因此都
 * 出自它自己的 rc / profile,而不是出自启动这个进程的那个人。
 * `PATH` 留着是因为它只会被**并集**(`mergePathEnv`),多一截绝不会少一截;
 * `LC_*` 整族与 `LANG` 一起给,rc 里按区域分支的判断才与用户终端里一致。
 */
const LOGIN_SHELL_SEED_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TZ', 'TMPDIR', 'PATH'] as const

export function loginShellSeedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const seed: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue
    if ((LOGIN_SHELL_SEED_KEYS as readonly string[]).includes(name) || name.startsWith('LC_')) seed[name] = value
  }
  return seed
}

/**
 * 启动者独占的键:这个进程用哪个 store、开哪个口、连哪台 dev server、是不是在一台
 * 门里跑、npm / Electron 怎么起的它 —— 这些只能由启动它的那一方说,登录 shell
 * (以及从它抓来的缓存)永远不许补。
 */
export function isLauncherOwnedEnvKey(name: string): boolean {
  return name.startsWith('ONETHING_') || name.startsWith('npm_') || name.startsWith('ELECTRON_')
}

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

/**
 * 缓存住在 **store** 里(`ONETHING_STORE_PATH` 优先,否则 `~/.onething`,与
 * `main.ts` 的 `resolveStoreRoot` 同语义)。从前写死 `~/.onething`:一台拿隔离
 * store 起壳的门照样写用户的这一份 —— 09-26 事故的第三条腿。
 */
export function defaultLoginShellEnvCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething'), 'login-shell-env.json')
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
    if (isLauncherOwnedEnvKey(name)) continue // The launcher's word, never the shell's.
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
      // 只给身份底(文件头 ①):递整份 `env` 过去,shell 报回来的就是它自己。
      env: loginShellSeedEnv(env),
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
    ? defaultLoginShellEnvCachePath(targetEnv)
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
