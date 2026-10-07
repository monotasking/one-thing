/**
 * CLI 怎么找到它要连的那台后端(第④步批 3,`docs/design/two-process-2026-10.md` §2.4 第 1 条)。
 *
 * CLI 从这一批起是一个纯客户端:它读 `<store>/run/http.json`(谁在服务这个 store,谁写这份发现文件),判活
 * (pid 还在 ∧ 端口连得上,与后端的拒启判据同一把尺子),然后经 `@onething/backend-client` 的 HTTP 传输说话。
 * 没有活着的后端时分两档:
 *
 *   - **`attach`(缺省)**:只连,不拉。报「后端没在运行」并以非零码退出 —— 用户开着桌面时 CLI 用的就是桌面那台
 *     (同一份会话、一个写者),没开时由用户决定要不要起一台。
 *   - **`spawn`**:命令行 `--spawn` 或环境变量 `ONETHING_CLI_BACKEND=spawn` 打开(两者等价,命令行优先);
 *     `onething backend start` 总是这一档。先等 2 秒再读一次发现文件(桌面可能正在崩溃重拉的窗口里,旧记录刚删、
 *     新记录还没写),还是没有就自己拉起一台:`ONETHING_BACKEND_LAUNCHER=cli`、`detached`、`unref()`,stdout / stderr
 *     接到 `<store>/run/backend-stdio.log`。拉起的后端自己照 D6 让位 —— 要是桌面抢先写了活记录,它就退出,这里
 *     改连桌面那台。
 *
 * 拉起哪份产物(决策 D12):先找本机装的 onething.app(macOS `/Applications/onething.app` 与
 * `~/Applications/onething.app`),用它的 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 跑 `app.asar.unpacked` 里的
 * `backend.cjs`(与桌面拉起的是同一份);找不到再退到 CLI 包自带的 `dist/server/main.js`,用当前 node 跑。
 *
 * 交出:`backendModeOf`(读档位)、`readLiveBackend`(读发现文件 + 判活)、`connectBackend`(按档位连 / 拉)、
 * `spawnBackend`(拉起并等它活过来)、`findBackendArtifact`(D12 的两条路)、`BackendNotRunningError`。
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readCoreDiscovery, type CoreDiscovery } from '@onething/backend-client/node'

export type CliBackendMode = 'attach' | 'spawn'

/** 后端没在运行时那句话(`onething` 所有要连后端的命令共用)。 */
export const BACKEND_NOT_RUNNING_MESSAGE = 'The backend is not running. Open onething, or run `onething backend start`.'

export class BackendNotRunningError extends Error {
  constructor(message = BACKEND_NOT_RUNNING_MESSAGE) {
    super(message)
    this.name = 'ERR_BACKEND_NOT_RUNNING'
  }
}

export class BackendStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ERR_BACKEND_START_FAILED'
  }
}

/** 一台活着的后端:地址、token、以及盘上那条记录(owner / launcher / pid / startedAt)。 */
export type LiveBackend = CoreDiscovery & { alive: true }

/** 档位:命令行 `--spawn` 优先,其次 `ONETHING_CLI_BACKEND=spawn`,缺省 `attach`。 */
export function backendModeOf(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv = process.env): CliBackendMode {
  if (flags.spawn === true || flags.spawn === 'true') return 'spawn'
  return env.ONETHING_CLI_BACKEND === 'spawn' ? 'spawn' : 'attach'
}

/** 这个 store 的根:与后端同一套三段解析(`--store` → `ONETHING_STORE_PATH` → `~/.onething`)。 */
export function storeRootOf(storePath?: string): string {
  return storePath || process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

/** 读发现文件并判活。没有文件 / 坏了 / 死了 → `undefined`。 */
export async function readLiveBackend(storePath?: string): Promise<LiveBackend | undefined> {
  const found = await readCoreDiscovery({ storePath: storeRootOf(storePath) })
  return found?.alive ? found as LiveBackend : undefined
}

export interface ConnectBackendOptions {
  storePath?: string
  mode: CliBackendMode
  /** 拉起之前等多久再读一次发现文件(缺省 2 秒;测试调小)。 */
  settleMs?: number
}

/** 按档位拿到一台活着的后端:有就连;没有时 `attach` 报错,`spawn` 自己拉起。 */
export async function connectBackend(options: ConnectBackendOptions): Promise<LiveBackend> {
  const existing = await readLiveBackend(options.storePath)
  if (existing) return existing
  if (options.mode === 'attach') throw new BackendNotRunningError()
  return (await spawnBackend({
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
  })).backend
}

/** D12 的两条路之一。`kind: 'app'` = 装好的桌面 app;`kind: 'node'` = CLI 包自带的 server 产物。 */
export type BackendArtifact =
  | { kind: 'app'; appPath: string; execPath: string; entry: string; resourcesPath: string }
  | { kind: 'node'; execPath: string; entry: string }

/**
 * 找拉起用的那份产物。`env.ONETHING_CLI_APP_PATH` 可以指一只 `.app`(门用它证「装好的 app」那条路,
 * 不必真装到 `/Applications`);没有时按 macOS 的两个安装位置找。
 */
export function findBackendArtifact(env: NodeJS.ProcessEnv = process.env): BackendArtifact | undefined {
  const appCandidates = env.ONETHING_CLI_APP_PATH
    ? [env.ONETHING_CLI_APP_PATH]
    : process.platform === 'darwin'
      ? ['/Applications/onething.app', path.join(os.homedir(), 'Applications', 'onething.app')]
      : []
  for (const appPath of appCandidates) {
    const resourcesPath = path.join(appPath, 'Contents', 'Resources')
    const execPath = path.join(appPath, 'Contents', 'MacOS', 'onething')
    const entry = path.join(resourcesPath, 'app.asar.unpacked', 'apps', 'desktop-react', 'dist-electron', 'backend.cjs')
    if (existsSync(execPath) && existsSync(entry)) return { kind: 'app', appPath, execPath, entry, resourcesPath }
  }
  for (const entry of bundledServerCandidates()) {
    if (existsSync(entry)) return { kind: 'node', execPath: process.execPath, entry }
  }
  return undefined
}

/**
 * CLI 包自带的 `dist/server/main.js`。打包后 CLI 是 `dist/cli/main.cjs`,它就在隔壁目录;源码直跑(测试)时
 * 从 `apps/cli/src` 往上找仓根。
 */
function bundledServerCandidates(): string[] {
  const here = moduleDir()
  return [
    path.resolve(here, '..', 'server', 'main.js'),
    path.resolve(here, '..', '..', '..', 'dist', 'server', 'main.js'),
  ]
}

function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.argv[1] ? path.dirname(process.argv[1]) : process.cwd()
  }
}

export interface SpawnBackendOptions {
  storePath?: string
  /** 拉起之前等多久再读一次发现文件(缺省 2 秒)。 */
  settleMs?: number
  /** 等它活过来的上限(缺省 30 秒)。 */
  readyTimeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface SpawnBackendResult {
  backend: LiveBackend
  /** `true` = 这一次真的拉起了一台;`false` = 等待途中发现别人(桌面)已经有一台活的,改连它。 */
  launched: boolean
  artifact?: BackendArtifact
}

const READY_POLL_MS = 100

/** 拉起一台 `cli` 档的后端并等它的发现文件活过来。见文件头。 */
export async function spawnBackend(options: SpawnBackendOptions = {}): Promise<SpawnBackendResult> {
  const env = options.env ?? process.env
  const storeRoot = storeRootOf(options.storePath)
  await sleep(options.settleMs ?? 2_000)
  const settled = await readLiveBackend(storeRoot)
  if (settled) return { backend: settled, launched: false }

  const artifact = findBackendArtifact(env)
  if (!artifact) {
    throw new BackendStartError(
      'Cannot start a backend: no onething.app is installed and dist/server/main.js is missing (run `bun run build:cli`).',
    )
  }
  const runDir = path.join(storeRoot, 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const stdioPath = path.join(runDir, 'backend-stdio.log')
  // 每次拉起截断重写:起不来时这份文件的尾巴就是「为什么」。
  const stdio = openSync(stdioPath, 'w', 0o600)
  const child = spawn(artifact.execPath, [artifact.entry], {
    detached: true,
    stdio: ['ignore', stdio, stdio],
    env: {
      ...env,
      ONETHING_STORE_PATH: storeRoot,
      ONETHING_BACKEND_LAUNCHER: 'cli',
      ...(artifact.kind === 'app'
        ? { ELECTRON_RUN_AS_NODE: '1', ONETHING_RESOURCES_PATH: artifact.resourcesPath }
        : {}),
    },
  })
  closeSync(stdio)
  let exited: { code: number | null } | undefined
  child.once('exit', code => { exited = { code } })
  child.once('error', () => { exited = { code: null } })
  child.unref()

  const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    await sleep(READY_POLL_MS)
    const live = await readLiveBackend(storeRoot)
    if (live && live.pid === child.pid) return { backend: live, launched: true, artifact }
    // 它让位了(发现文件上是别人的活记录,多半是桌面抢先了):改连那一台。
    if (exited && live) return { backend: live, launched: false, artifact }
    if (exited) break
  }
  throw new BackendStartError(
    `The backend did not start${exited ? ` (exit code ${exited.code ?? 'unknown'})` : ' within the time limit'}. `
    + `Last output from ${stdioPath}:\n${tailOf(stdioPath, 20)}`,
  )
}

/** 一份文件的最后几行(读不到就是空串)。 */
function tailOf(filePath: string, lines: number): string {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, 16 * 1024)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8').split(/\r?\n/).slice(-lines).join('\n')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
