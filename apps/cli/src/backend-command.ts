/**
 * `onething backend start|stop|status|restart|logs` —— 这个 store 的后端进程(第④步批 3,取代 `onething daemon …`)。
 *
 * - `start`:总是「拉起」档(`backend-connect.ts` 的 `spawnBackend`)。已经有活的(桌面开着、或上一次拉起的还在)
 *   就不拉第二台,打它的状态。
 * - `status`:读发现文件 + 判活,打 pid / 端口 / 拉起者 / 已运行时长;没有活的打 `backend stopped`。
 * - `stop`:**只停 CLI 自己拉起的那台**(发现文件上 owner `backend` 且 `launcher: 'cli'`),经 `backend.shutdown`
 *   请它收尾(与 SIGTERM 同一条路),等它退出、发现文件删掉。桌面拉起的、别人 `server:start` 起的,一律拒并说明
 *   该去哪儿停 —— 停掉桌面的后端会让桌面那一侧以为后端崩了、自己再拉一台。
 * - `restart`:`stop` + `start`(同样只对 CLI 拉起的那台)。
 * - `logs`:后端进程的结构化日志 `<store>/log/app.jsonl` 的尾巴(从前守护进程写 `daemon.jsonl`,升级过来的机器上
 *   它可能还在,`app.jsonl` 不在时退回它)。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHttpTransport, createOnethingClient } from '@onething/backend-client'
import { backendRouter } from '@shared/ipc/backend.js'
import { readLiveBackend, spawnBackend, storeRootOf, type LiveBackend } from './backend-connect.js'
import { stdout, stderr } from './stdout.js'

export interface BackendCommandOptions {
  storePath?: string
  /** `logs` 打几行(缺省 200)。 */
  lines?: number
}

/** 谁拉起了这台:`cli` / `desktop` / `server:start` / `unknown`。 */
export function launchedByOf(backend: Pick<LiveBackend, 'record'>): 'cli' | 'desktop' | 'server:start' | 'unknown' {
  const { owner, launcher } = backend.record
  if (owner === 'server') return 'server:start'
  if (owner === 'backend') return launcher === 'cli' ? 'cli' : launcher === 'desktop' ? 'desktop' : 'unknown'
  if (owner === 'shell' || owner === 'desktop') return 'desktop'
  return 'unknown'
}

/** 「已运行时长」的人读形:`2h 03m`、`4m 10s`、`12s`。 */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export function backendStatusOf(backend: LiveBackend, now = Date.now()) {
  const startedAt = backend.record.startedAt
  return {
    pid: backend.pid,
    port: backend.record.port,
    launchedBy: launchedByOf(backend),
    uptime: startedAt > 0 ? formatUptime(now - startedAt) : 'unknown',
    startedAt: startedAt > 0 ? new Date(startedAt).toISOString() : null,
    url: backend.baseUrl,
  }
}

/** 停不得时的那句话(按拉起者)。`undefined` = 可以停。 */
export function refusalToStop(backend: Pick<LiveBackend, 'record'>): string | undefined {
  switch (launchedByOf(backend)) {
    case 'cli':
      return undefined
    case 'server:start':
      return 'This backend was started with `server:start`; stop it where it was started.'
    default:
      return 'This backend was started by the desktop app; quit or restart it from the desktop.'
  }
}

export async function backendCommand(command = 'status', options: BackendCommandOptions = {}): Promise<number> {
  switch (command) {
    case 'start': {
      const result = await spawnBackend(options.storePath ? { storePath: options.storePath } : {})
      stdout(JSON.stringify(backendStatusOf(result.backend), null, 2))
      return 0
    }
    case 'status': {
      const backend = await readLiveBackend(options.storePath)
      if (!backend) {
        stdout('backend stopped')
        return 0
      }
      stdout(JSON.stringify(backendStatusOf(backend), null, 2))
      return 0
    }
    case 'stop':
      return stopBackend(options)
    case 'restart': {
      const code = await stopBackend(options)
      if (code !== 0) return code
      return backendCommand('start', options)
    }
    case 'logs': {
      const logDir = path.join(storeRootOf(options.storePath), 'log')
      const candidates = [path.join(logDir, 'app.jsonl'), path.join(logDir, 'daemon.jsonl')]
      const logFile = candidates.find(file => fs.existsSync(file))
      if (!logFile) {
        stdout(`No backend log found at ${candidates[0]}`)
        return 0
      }
      const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/)
      const count = options.lines ?? 200
      stdout(lines.slice(Math.max(0, lines.length - count)).join('\n'))
      return 0
    }
    default:
      throw new Error(`Unknown backend command: ${command}`)
  }
}

async function stopBackend(options: BackendCommandOptions): Promise<number> {
  const backend = await readLiveBackend(options.storePath)
  if (!backend) {
    stdout('backend already stopped')
    return 0
  }
  const refusal = refusalToStop(backend)
  if (refusal) {
    stderr(refusal)
    return 1
  }
  const client = createOnethingClient({
    transport: createHttpTransport({ baseUrl: backend.baseUrl, ...(backend.token ? { token: backend.token } : {}) }),
  })
  try {
    await client.api(backendRouter).shutdown({})
  } finally {
    client.close()
  }
  // 等它真的退出、发现文件删掉(后端自己的刷盘期限是 5 秒,再多给一点)。
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const still = await readLiveBackend(options.storePath)
    if (!still || still.pid !== backend.pid) {
      stdout('backend stopped')
      return 0
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  stderr(`The backend (pid ${backend.pid}) did not exit within 10s.`)
  return 1
}
