/**
 * HTTP 发现文件 —— `<store>/run/http.json`(**写侧与路径解析**)。
 *
 * A 期(docs/design/one-core-2026-08.md §3)之后「一个 store 一个 core」不再靠
 * 固定端口约定:core 服务默认 `listen(0)` 拿一个动态端口,起来后把
 * `{port, host, token, pid, startedAt, owner}` 写在这里,退出时删掉。所有找它的
 * 人(web dev 代理、`server:start` 的共存判定、React 壳的挂靠探活)一律读这个文件,
 * 而不是猜 8787。
 *
 * **契约与判活已经不在本文件**(C0,`docs/design/client-sdk-2026-09.md` §4.4):
 * 记录形状 / 校验 / 两段判活 / `httpDiscoveryUrl` 搬去了
 * `@shared/backend/http-discovery.ts`,因为 `@onething/client` 的 Node 子路径要问
 * **同一个**「这个 store 有没有活 core」,而它禁 import backend / runtime。
 * 本文件保留的是「需要知道 store 在哪」的那一半 —— 路径解析走
 * `getOnethingRunDir()`(CLAUDE.md:所有 app 层路径必须经它),以及写 / 删。
 * 下面的 `export` 面一字未变,所有调用点原样。
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  HTTP_DISCOVERY_FILENAME,
  readHttpDiscoveryAt,
} from '@shared/backend/http-discovery.js'
import type { HttpDiscoveryRecord } from '@shared/backend/http-discovery.js'
import { getOnethingRunDir, type OnethingStorePathOptions } from '@onething/runtime/storage'

export {
  HTTP_DISCOVERY_FILENAME,
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
} from '@shared/backend/http-discovery.js'
export type {
  HttpDiscoveryOwner,
  HttpDiscoveryRecord,
} from '@shared/backend/http-discovery.js'

export function getHttpDiscoveryPath(options: OnethingStorePathOptions = {}): string {
  return path.join(getOnethingRunDir(options), HTTP_DISCOVERY_FILENAME)
}

/** 读发现文件。不存在 / 坏了 / 形状不对 → `undefined`(永不抛)。 */
export function readHttpDiscovery(
  options: OnethingStorePathOptions = {},
): HttpDiscoveryRecord | undefined {
  return readHttpDiscoveryAt(getHttpDiscoveryPath(options))
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

/**
 * 删发现文件 —— **只删自己写的那一份**(C0 R5,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §1.3)。
 *
 * 从前它无条件 `rmSync`,于是一条真实的路会删掉别人的宣告:React 壳启动时先探活,
 * 发现有一台活 core 就挂上去(不写发现文件);可它退出时那句
 * `if (backend) removeHttpDiscovery()` 只问"我有没有自己的 backend",不问"盘上这份
 * 是不是我写的"。同型的还有内嵌 HTTP 面**挂载失败**那条兜底路 —— 面没挂上,发现
 * 文件也就没写过,而那时盘上躺着的正是先起的那台 core 的宣告。被删之后,后来的
 * 客户端就找不到那台还活着的 core 了。
 *
 * 判据是文件里的 `pid === process.pid`:读不到、解析不了、pid 对不上,一律**不删**。
 * 陈旧记录不靠这里清 —— `isHttpDiscoveryAlive` 的两段探活(pid 活着 ∧ 端口连得上)
 * 才是判"这份宣告还算不算数"的地方,而写一份新的会直接覆盖旧的。
 */
export function removeHttpDiscovery(options: OnethingStorePathOptions = {}): void {
  try {
    const record = readHttpDiscovery(options)
    if (record?.pid !== process.pid) return
    rmSync(getHttpDiscoveryPath(options), { force: true })
  } catch {
    /* 退出路径上不为删不掉一个瞬时文件而报错。 */
  }
}
