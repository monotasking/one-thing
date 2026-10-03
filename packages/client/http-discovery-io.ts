/**
 * 发现文件的**读与判活**,client SDK 这一份(server / client 拆分第②步,2026-10-02)。
 *
 * 记录形状与白名单式解析在 `@shared/backend/http-discovery.ts`(那是契约,两边共用);shared 不许碰 node,
 * 所以碰 node 的这一半「两边各一份最小实现」:这一份给 `@onething/client/node`(CLI / 脚本找活着的 core),
 * 另一份在 `packages/backend/http-server/http-server-discovery-io.ts` 给后端。client 不能 import server、server 不能
 * import client,所以没法只留一份;**两份逐字同形,对同一组样例给同一个答案**,由
 * `packages/backend/http-server/__tests__/http-server-discovery-io-parity.test.ts` 钉住。改这里的任何一行,就要同样改那一份。
 *
 * 只被 `node.ts` 引:它 import `node:fs` / `node:net` / `node:os` / `node:path`,浏览器入口永远不经过它。
 * 比 server 那份多两样:store 根目录的三段解析(server 侧走 `getOnethingRunDir()`,client 不能 import 它;
 * 两边同形由 `packages/backend/http-server/__tests__/http-server-discovery.test.ts` 逐条比对)与 `httpDiscoveryPathIn`。
 */
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  HTTP_DISCOVERY_FILENAME,
  ONETHING_RUN_DIR_NAME,
  ONETHING_STORE_DIR_NAME,
  parseHttpDiscoveryRecord,
  type HttpDiscoveryRecord,
} from '@shared/backend/http-discovery.js'

/**
 * store 根目录:显式给的 → `ONETHING_STORE_PATH` → `~/.onething`。
 *
 * 与 `@onething/backend/storage` 的 `getOnethingStorePath()` 逐条同形(见文件头:
 * 那边不能被本文件 import,分叉由测试挡)。
 */
export function resolveOnethingStoreRoot(storePath?: string): string {
  return (
    storePath
    || process.env.ONETHING_STORE_PATH
    || path.join(os.homedir(), ONETHING_STORE_DIR_NAME)
  )
}

/** `<store>/run/http.json`。 */
export function httpDiscoveryPathIn(storeRoot: string): string {
  return path.join(storeRoot, ONETHING_RUN_DIR_NAME, HTTP_DISCOVERY_FILENAME)
}

/** 按绝对路径读发现文件。不存在 / 坏了 / 形状不对 → `undefined`(永不抛)。 */
export function readHttpDiscoveryAt(filePath: string): HttpDiscoveryRecord | undefined {
  try {
    return parseHttpDiscoveryRecord(readFileSync(filePath, 'utf-8'))
  } catch {
    return undefined
  }
}

export function isPidAlive(pid: number): boolean {
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

