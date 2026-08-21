/**
 * HTTP 发现文件 —— `<store>/run/http.json`。
 *
 * A 期(docs/design/one-core-2026-08.md §3)之后「一个 store 一个 core」不再靠
 * 固定端口约定:core 服务默认 `listen(0)` 拿一个动态端口,起来后把
 * `{port, host, token, pid, startedAt, owner}` 写在这里,退出时删掉。所有找它的
 * 人(web dev 代理、`server:start` 的共存判定、后续 B 期的 renderer 客户端)一律
 * 读这个文件,而不是猜 8787。
 *
 * 三件事必须说清楚:
 *  1. **文件存在 ≠ 活着**。进程被 SIGKILL / 掉电时文件会留下来。`isHttpDiscoveryAlive`
 *     因此是两段判定:pid 还在(`kill(pid, 0)`)**且** 端口真的能连上。只看 pid
 *     会被 pid 复用骗,只看端口会被别的程序占用同一端口骗 —— 两条都过才算数。
 *  2. **token 是秘密**。文件按 0600 写,run 目录按 0700 建。
 *  3. 读永远不抛:发现文件是"线索"不是"契约",坏了就当没有,调用方走回退路径。
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'
import { getOnethingRunDir, type OnethingStorePathOptions } from '@onething/runtime/storage'

export const HTTP_DISCOVERY_FILENAME = 'http.json'

export type HttpDiscoveryOwner = 'desktop' | 'server'

export interface HttpDiscoveryRecord {
  /** 实际监听到的端口(动态分配时是 listen 之后才知道的那个数)。 */
  port: number
  host: string
  /** Bearer token;env 没给时由 core 服务每次启动随机生成。 */
  token?: string
  pid: number
  /** 毫秒时间戳。 */
  startedAt: number
  owner: HttpDiscoveryOwner
}

export function getHttpDiscoveryPath(options: OnethingStorePathOptions = {}): string {
  return path.join(getOnethingRunDir(options), HTTP_DISCOVERY_FILENAME)
}

function isHttpDiscoveryRecord(value: unknown): value is HttpDiscoveryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<HttpDiscoveryRecord>
  return (
    typeof record.port === 'number'
    && Number.isFinite(record.port)
    && record.port > 0
    && typeof record.host === 'string'
    && record.host.length > 0
    && typeof record.pid === 'number'
    && Number.isFinite(record.pid)
    && (record.owner === 'desktop' || record.owner === 'server')
  )
}

/** 读发现文件。不存在 / 坏了 / 形状不对 → `undefined`(永不抛)。 */
export function readHttpDiscovery(
  options: OnethingStorePathOptions = {},
): HttpDiscoveryRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getHttpDiscoveryPath(options), 'utf-8'))
    if (!isHttpDiscoveryRecord(parsed)) return undefined
    return {
      port: parsed.port,
      host: parsed.host,
      token: typeof parsed.token === 'string' && parsed.token ? parsed.token : undefined,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      owner: parsed.owner,
    }
  } catch {
    return undefined
  }
}

export function writeHttpDiscovery(
  record: HttpDiscoveryRecord,
  options: OnethingStorePathOptions = {},
): string {
  const runDir = getOnethingRunDir(options)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const filePath = path.join(runDir, HTTP_DISCOVERY_FILENAME)
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  // mode 只在**创建**时生效:文件已存在(上一次没删干净)时 writeFileSync 不改权限,
  // 所以补一次 chmod,免得 token 以 0644 躺在盘上。
  try {
    chmodSync(filePath, 0o600)
  } catch {
    /* 只读文件系统等边缘情况:权限收不紧不该让启动失败。 */
  }
  return filePath
}

export function removeHttpDiscovery(options: OnethingStorePathOptions = {}): void {
  try {
    rmSync(getHttpDiscoveryPath(options), { force: true })
  } catch {
    /* 退出路径上不为删不掉一个瞬时文件而报错。 */
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在,只是不归我们管 —— 那也算活着。
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    const socket = connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 发现文件指向的 core 服务是不是真的活着。
 *
 * 两段都要过:pid 存活(挡住 pid 复用之外的所有陈旧文件)+ 端口可连(挡住
 * "进程还在但 HTTP 面已经关了"以及 pid 恰好被复用的那一格)。
 */
export async function isHttpDiscoveryAlive(
  record: HttpDiscoveryRecord | undefined,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!record) return false
  if (!isPidAlive(record.pid)) return false
  return canConnect(record.host, record.port, options.timeoutMs ?? 500)
}

/** `http://host:port` —— 打日志和拼代理目标时别再各写一遍。 */
export function httpDiscoveryUrl(record: HttpDiscoveryRecord): string {
  const host = record.host === '::1' ? '[::1]' : record.host
  return `http://${host}:${record.port}`
}
