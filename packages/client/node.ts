/**
 * `@onething/client/node` —— **Node 专用面**,浏览器构建永远不引(§4.4)。
 *
 * 它只干一件事:回答「这台机器的这个 store,有没有一台活着的 core?地址和 token 是
 * 什么?」。CLI(下一批 C3)拿到就 `createHttpTransport` 当 core 的客户端,拿不到
 * 再走今天的自装配路。
 *
 * **判活与 `apps/server/src/main.ts` 的拒启判据是同一份代码**
 * (`@shared/backend/http-discovery.ts`,C0 抽出来的;§9 留账那条):pid 活着
 * **且**端口连得上。两边各写一份的话,CLI 与 server 会对「core 活没活」各说各话。
 *
 * 单列成子路径而不是并进 `index.ts`,是因为它 import `node:fs` / `node:net` ——
 * 并进去会让浏览器打包器在一个根本不会走到的分支上炸,或者更糟:静默塞进一个
 * polyfill。子路径让「引没引 Node 面」在 import 语句上一眼看得见。
 */
import {
  httpDiscoveryPathIn,
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  readHttpDiscoveryAt,
  resolveOnethingStoreRoot,
} from '@shared/backend/http-discovery.js'
import type { HttpDiscoveryOwner, HttpDiscoveryRecord } from '@shared/backend/http-discovery.js'

export type { HttpDiscoveryOwner, HttpDiscoveryRecord }

export interface CoreDiscovery {
  /** `http://127.0.0.1:53211` —— 直接喂 `createHttpTransport({ baseUrl })`。 */
  baseUrl: string
  /** Bearer token;core 没配 token 时缺席(那台 core 不认证)。 */
  token?: string
  owner: HttpDiscoveryOwner
  pid: number
  /** 两段探活(pid ∧ 端口)都过了才是 `true`。 */
  alive: boolean
  /** 盘上那条原始记录,给要打日志 / 报错的调用方。 */
  record: HttpDiscoveryRecord
}

export interface ReadCoreDiscoveryOptions {
  /** 不给就走 `ONETHING_STORE_PATH` → `~/.onething`(与 store 的三段解析同形)。 */
  storePath?: string
  /** 端口探活的超时,缺省 500ms(与 server 侧同值)。 */
  timeoutMs?: number
}

/**
 * 读 `<store>/run/http.json` 并探活。
 *
 * 三态,调用方必须分开处理:
 *  - **没有文件 / 文件坏了 / 形状不对** → `undefined`(发现文件是线索不是契约,永不抛)
 *  - **有记录但探活没过**(pid 没了 / 端口不通)→ `{ …, alive: false }`,陈旧宣告。
 *    **不在这里删它** —— 删只由写它的那个进程按 pid 做(`removeHttpDiscovery`),
 *    否则一个探活失败(比如刚好在重启的窗口里)就会抹掉别人的宣告。
 *  - **活着** → `{ …, alive: true }`
 */
export async function readCoreDiscovery(
  options: ReadCoreDiscoveryOptions = {},
): Promise<CoreDiscovery | undefined> {
  const storeRoot = resolveOnethingStoreRoot(options.storePath)
  const record = readHttpDiscoveryAt(httpDiscoveryPathIn(storeRoot))
  if (!record) return undefined
  const alive = await isHttpDiscoveryAlive(record, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return {
    baseUrl: httpDiscoveryUrl(record),
    ...(record.token ? { token: record.token } : {}),
    owner: record.owner,
    pid: record.pid,
    alive,
    record,
  }
}

export {
  httpDiscoveryPathIn,
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  resolveOnethingStoreRoot,
} from '@shared/backend/http-discovery.js'
