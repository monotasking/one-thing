/**
 * **发现文件**(`<store>/run/http.json`)在 Electron 这一侧的读法:读、判活、删自己那份。
 *
 * 谁在服务这个 store,谁写这份文件(`{port, host, token, pid, startedAt, owner}`,0600);客户端靠它找到
 * 后端。第④步批 2b 起 Electron 不再自己当后端,而是读它 —— 拉起子进程之前先看「已经有活的了吗」,拉起之后
 * 轮询它等「活了没有」,子进程死了之后删掉 pid 对得上的那一份(死人删不掉自己的文件)。
 *
 * 从 `main.ts` 原样抽出来(读法与判活两段一个字没改),因为 `backend-process.ts` 也要用,而那只文件必须
 * 零 electron import(门里要脱离窗口驱动它)。这只文件同样零 electron、零后端运行期 import:
 * 写这份文件的是后端(`packages/backend/http-server/http-server-discovery.ts`),两边读同一个形状
 * (`@shared/backend/http-discovery.ts` 的 owner 联合),判活口径与后端的 `isHttpDiscoveryAlive` 同一条。
 */
import { readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'

export type HttpDiscoveryOwner = 'desktop' | 'server' | 'shell' | 'backend'

export interface HttpDiscoveryRecord {
  port: number
  host: string
  token?: string
  pid: number
  startedAt: number
  owner: HttpDiscoveryOwner
}

/**
 * store 根。与 `packages/backend/storage/storage-paths.ts` 的 `getOnethingStorePath()` **同语义**
 * (env 优先,否则 `~/.onething`)。
 */
export function resolveStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

export function discoveryPath(storeRoot: string): string {
  return path.join(storeRoot, 'run', 'http.json')
}

/** 读发现文件。不存在 / 坏了 / 形状不对 → undefined(永不抛)。 */
export function readDiscovery(storeRoot: string): HttpDiscoveryRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(discoveryPath(storeRoot), 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const record = parsed as Partial<HttpDiscoveryRecord>
    if (typeof record.port !== 'number' || !Number.isFinite(record.port) || record.port <= 0) return undefined
    if (typeof record.host !== 'string' || !record.host) return undefined
    if (typeof record.pid !== 'number' || !Number.isFinite(record.pid)) return undefined
    // `backend` = 被拉起的后端进程(第④步批 2a 起,`ONETHING_BACKEND_LAUNCHER` 设了档时写它;决策 D6)。
    if (record.owner !== 'desktop' && record.owner !== 'server' && record.owner !== 'shell' && record.owner !== 'backend') return undefined
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

export function portConnects(host: string, port: number, timeoutMs = 500): Promise<boolean> {
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

/** pid 还在不在(`kill(pid, 0)`)。权限不够(EPERM)也算在:那是一个活着的、别人的进程。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * 「文件存在 ≠ 活着」。判定两段:pid 还在 **且** 端口真能连上 —— 只看 pid 会被
 * pid 复用骗,只看端口会被别的程序占用同一端口骗。与 `backend/http-server/http-server-discovery.ts`
 * 的 `isHttpDiscoveryAlive` 同一条口径。
 */
export async function isAlive(record: HttpDiscoveryRecord): Promise<boolean> {
  if (!pidAlive(record.pid)) return false
  return portConnects(record.host, record.port)
}

/**
 * 删掉**这个 pid** 写的那份发现文件(子进程死了,它自己删不掉)。文件已经被别人重写(pid 对不上)就不动 ——
 * 那是一台新起来的后端的。答删没删。永不抛。
 */
export function removeDiscoveryOf(storeRoot: string, pid: number): boolean {
  const record = readDiscovery(storeRoot)
  if (!record || record.pid !== pid) return false
  try {
    rmSync(discoveryPath(storeRoot), { force: true })
    return true
  } catch {
    return false
  }
}
