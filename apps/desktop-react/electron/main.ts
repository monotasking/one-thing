/**
 * React 壳的 main 进程 —— **薄壳**(`docs/design/react-shell-2026-08.md` §2 / §5.3)。
 *
 * 它做且只做四件事:
 *
 *  1. **发现**这个 store 正在跑的 core(`<store>/run/http.json`)。旧 Vue 桌面在跑
 *     时那份记录的 owner 就是 `desktop` —— 直接连它的内嵌 HTTP 面,这正是 A 期
 *     「一个 core 任何 UI」的设计目标,两个 UI 订同一条事件流。
 *  2. 没有活的 core 时**拉起** `dist/server/main.js` 子进程,等它写出发现文件;
 *     自己拉的自己收尸。`dist/server/main.js` 不在 = 明确报错,**不静默降级**。
 *  3. 开窗口。
 *  4. 一条 IPC:`host:connection` → `{ baseUrl, token }`。发现文件是 0600 的秘密,
 *     渲染层不许自己读盘。
 *
 * 它**不**做的事(边界,别越):不装配 backend、不取任何锁、不注册第二张 IPC 表。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'

type HttpDiscoveryRecord = {
  port: number
  host: string
  token?: string
  pid: number
  startedAt?: number
  owner: 'desktop' | 'server'
}

type HostConnection = { baseUrl: string; token?: string }

/** `host:connection` 的回执:成功给基址与 token,失败给一句人话(启发式⑨)。 */
type HostConnectionResult =
  | { ok: true; baseUrl: string; token?: string }
  | { ok: false; error: string }

/** 打包后是 `.../dist-electron/main.cjs`,dev 时同路径 —— 两跳到 apps/,三跳到仓根。 */
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '../..')

/**
 * store 根。与 `packages/onething-runtime/src/storage/paths.ts` 的
 * `getOnethingStorePath()` **同语义**(env 优先,否则 `~/.onething`)——
 * 薄壳不 import runtime 包,只为这一条路径自己 resolve 一次。
 */
function resolveStoreRoot(): string {
  return process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function discoveryPath(): string {
  return path.join(resolveStoreRoot(), 'run', 'http.json')
}

/** 读发现文件。不存在 / 坏了 / 形状不对 → undefined(永不抛)。 */
function readDiscovery(): HttpDiscoveryRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(discoveryPath(), 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const record = parsed as Partial<HttpDiscoveryRecord>
    if (typeof record.port !== 'number' || !Number.isFinite(record.port) || record.port <= 0) return undefined
    if (typeof record.host !== 'string' || !record.host) return undefined
    if (typeof record.pid !== 'number' || !Number.isFinite(record.pid)) return undefined
    if (record.owner !== 'desktop' && record.owner !== 'server') return undefined
    return {
      port: record.port,
      host: record.host,
      token: typeof record.token === 'string' && record.token ? record.token : undefined,
      pid: record.pid,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      owner: record.owner,
    }
  } catch {
    return undefined
  }
}

function portConnects(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * 「文件存在 ≠ 活着」。判定两段:pid 还在 **且** 端口真能连上 —— 只看 pid 会被
 * pid 复用骗,只看端口会被别的程序占用同一端口骗。与 `backend/server/discovery.ts`
 * 的 `isHttpDiscoveryAlive` 同一条口径。
 */
async function isAlive(record: HttpDiscoveryRecord): Promise<boolean> {
  try {
    process.kill(record.pid, 0)
  } catch {
    return false
  }
  return portConnects(record.host, record.port)
}

function connectionOf(record: HttpDiscoveryRecord): HostConnection {
  return { baseUrl: `http://${record.host}:${record.port}`, token: record.token }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 自己拉起来的 core 子进程(连的是别人的就永远是 undefined —— 不属于我们的不杀)。 */
let ownedCore: ChildProcess | undefined
let connection: HostConnection | undefined
let connectionError: string | undefined

async function ensureCore(): Promise<HostConnection> {
  const existing = readDiscovery()
  if (existing && (await isAlive(existing))) {
    // 旧桌面(owner:'desktop')或别人起的 server —— 直接连,一个字节不动它。
    return connectionOf(existing)
  }

  const serverEntry = path.join(repoRoot, 'dist/server/main.js')
  if (!existsSync(serverEntry)) {
    throw new Error(
      `找不到 core 服务的构建产物:${serverEntry}\n`
      + '  先在仓根跑 `bun run server:build`。\n'
      + '  (这里不静默降级 —— 没有 core 就没有数据面,方案 §5.3。)',
    )
  }

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: resolveStoreRoot(),
      // Electron 的 `process.execPath` 就是 Electron 本体;这一位让它当纯 node
      // 跑那个 bundle —— 壳因此不依赖机器上装没装 node。
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  ownedCore = child

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
  child.once('exit', (code, signal) => {
    exited = { code, signal }
    if (ownedCore === child) ownedCore = undefined
  })
  const stderr: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString())
    if (stderr.length > 40) stderr.shift()
  })

  // 轮询发现文件 ≤10s。等的是「文件出现 **且** 活着」,不是「进程还在」。
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `core 子进程启动即退出(code=${exited.code} signal=${exited.signal})\n`
        + stderr.join(''),
      )
    }
    const record = readDiscovery()
    if (record && record.owner === 'server' && (await isAlive(record))) {
      return connectionOf(record)
    }
    await delay(120)
  }
  killOwnedCore()
  throw new Error('等了 10s 也没等到 core 写出发现文件 <store>/run/http.json')
}

function killOwnedCore(): void {
  const child = ownedCore
  if (!child) return
  ownedCore = undefined
  try {
    child.kill('SIGTERM')
  } catch {
    // 已经没了就算了 —— 收尸是尽力而为,不是断言。
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => window.show())

  const devServerUrl = process.env.ONETHING_REACT_DEV_SERVER_URL
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(path.join(appRoot, 'dist/index.html'))
  return window
}

// 渲染层唯一的宿主口。发现文件是 0600 的秘密,渲染层不许自己读盘。
ipcMain.handle('host:connection', (): HostConnectionResult => (
  connection
    ? { ok: true, baseUrl: connection.baseUrl, token: connection.token }
    : { ok: false, error: connectionError ?? 'core 尚未连接' }
))

void app.whenReady().then(async () => {
  try {
    connection = await ensureCore()
  } catch (error) {
    // 连不上 core 也要开窗:错误交给渲染层显示,比静默白屏强(启发式⑨)。
    connection = undefined
    connectionError = error instanceof Error ? error.message : String(error)
    // eslint-disable-next-line no-console
    console.error('[desktop-react] core 连接失败:', error)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// D0 是单窗薄壳:窗关了就退(mac 上的常驻托盘行为留给 P4 的窗口系批)。
app.on('window-all-closed', () => app.quit())
app.on('will-quit', killOwnedCore)
process.on('exit', killOwnedCore)
