/**
 * 发现文件 `<store>/run/http.json` 的**契约与判活** —— 一把尺子,两个消费者。
 *
 * 产地是 `packages/backend/server/discovery.ts`(A 期,`docs/design/one-core-2026-08.md` §3);
 * C0(`docs/design/client-sdk-2026-09.md` §4.4 / §9)把「记录的形状 + 判活的两段」抽到这里,
 * 因为从此有**两个**问「这个 store 有没有活 core」的人,而他们不能各说各话:
 *
 * | 谁 | 拿它干什么 |
 * |---|---|
 * | `apps/server/src/main.ts` | 拒启:`owner !== 'server'` 且活着 → 让位(`--force` 绕过) |
 * | `@onething/client/node` 的 `readCoreDiscovery()` | CLI / 脚本当 core 的客户端:活着就连上去 |
 *
 * 从前判活只在 backend 那棵树里,而 `packages/client` 禁 import `@onething/backend` 与
 * `@onething/runtime`(它要在浏览器与 Node 两处跑)。照抄一份 = 两把尺子,某天一边改了
 * 超时另一边不知道 —— 所以抽到 `@shared`,两边 import 同一段。
 *
 * **本文件零第三方依赖、零 `@onething/*` 依赖**,只用 `node:` 内建:它被 `packages/client`
 * 的 Node 子路径 import,而那个包的边界规则禁 runtime / backend。这也是为什么
 * store 根目录的三段解析(显式 → `ONETHING_STORE_PATH` → `~/.onething`)在这里又写了一遍
 * 而不是 import `@onething/runtime/storage` 的 `getOnethingStorePath()`:
 * **两份不许分叉这件事由测试钉住**,不是由注释保证 ——
 * `packages/backend/server/__tests__/discovery.test.ts` 里逐条比对两边的答案。
 *
 * 三件事(原文照搬产地的判例,别再各自重新发现一次):
 *  1. **文件存在 ≠ 活着**。进程被 SIGKILL / 掉电时文件会留下来。`isHttpDiscoveryAlive`
 *     因此是两段判定:pid 还在(`kill(pid, 0)`)**且** 端口真的能连上。只看 pid
 *     会被 pid 复用骗,只看端口会被别的程序占用同一端口骗 —— 两条都过才算数。
 *  2. **token 是秘密**。文件按 0600 写,run 目录按 0700 建(写侧在产地)。
 *  3. 读永远不抛:发现文件是「线索」不是「契约」,坏了就当没有,调用方走回退路径。
 */
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const HTTP_DISCOVERY_FILENAME = 'http.json'

/** `<store>/run` —— 发现文件、`daemon.sock`、`backend.lock` 的那一格。 */
export const ONETHING_RUN_DIR_NAME = 'run'

/** `~/.onething` 的那个尾巴。与 `@onething/runtime/storage` 的同名常量必须一致。 */
export const ONETHING_STORE_DIR_NAME = '.onething'

/**
 * 谁在服务这个 store。
 *
 * `shell` 是 React 壳自己内嵌的那只 core(A1,2026-08-31)。它与 `desktop` 是**同一
 * 类**东西 —— 一个带界面的宿主在自己的进程里装配 backend 并把 HTTP/SSE 面挂出来 ——
 * 只是宿主换了个人。之所以要一个自己的名字而不是复用 `desktop`:`server:start` 的
 * 让位判据是 `owner !== 'server'`,两个名字在那条判据下行为逐字相同(都让位),
 * 而运维读发现文件时能一眼看出是哪个壳在当家。
 */
export type HttpDiscoveryOwner = 'desktop' | 'server' | 'shell'

const HTTP_DISCOVERY_OWNERS: readonly HttpDiscoveryOwner[] = ['desktop', 'server', 'shell']

export function isHttpDiscoveryOwner(value: unknown): value is HttpDiscoveryOwner {
  return HTTP_DISCOVERY_OWNERS.includes(value as HttpDiscoveryOwner)
}

/**
 * **宿主能往发现文件里补的那几格**(B2′)。
 *
 * 它们不是 core 服务知道的事实 —— core 不认识 electron,问不出「这个进程的
 * Chromium 调试口开着没有」。所以这一族由**宿主在挂载内嵌面时递进来**
 * (`startEmbeddedOnethingHttpServer(backend, { discoveryExtras })`),写不写由
 * 宿主说了算;`undefined` = 这个 core 没有这一格,键根本不出现在文件里。
 *
 * 是**具名字段**而不是 `Record<string, unknown>`:读侧(`parseHttpDiscoveryRecord`)
 * 是白名单式重建,一个没人认识的键在读回来那一拍就被静默丢掉 —— 「写得进去、
 * 读不出来」比不许写更坏(与 `mergeWithDefaults` 的白名单漏键判例同款)。
 */
export type HttpDiscoveryExtras = Pick<HttpDiscoveryRecord, 'cdp'>

/**
 * 这个 core 进程的 Chromium 调试口(B2′,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.2-5)。
 *
 * **只有真的开着才写**:判据是主进程 `app.commandLine` 上那个开关在不在,不是
 * 设置里那一格 —— 设置改了要重启才生效,按设置写等于说谎。别的客户端
 * (chrome-devtools-mcp 的配置、脚本)按它找口,不必去猜 9222。
 */
export interface HttpDiscoveryCdp {
  port: number
}

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
  /** 宿主补的一格:这个进程的 CDP 口(开着才有)。见 `HttpDiscoveryCdp`。 */
  cdp?: HttpDiscoveryCdp
}

/** `cdp` 那一格合不合法。端口口径与 `cdp-flag.ts` 同款(`0` = 随机口,不收)。 */
export function isHttpDiscoveryCdp(value: unknown): value is HttpDiscoveryCdp {
  if (!value || typeof value !== 'object') return false
  const port = (value as { port?: unknown }).port
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}

export function isHttpDiscoveryRecord(value: unknown): value is HttpDiscoveryRecord {
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
    && isHttpDiscoveryOwner(record.owner)
  )
}

/**
 * store 根目录:显式给的 → `ONETHING_STORE_PATH` → `~/.onething`。
 *
 * 与 `@onething/runtime/storage` 的 `getOnethingStorePath()` 逐条同形(见文件头:
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

/** 把一段文本折成记录。不是合法记录 → `undefined`(永不抛)。 */
export function parseHttpDiscoveryRecord(text: string): HttpDiscoveryRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isHttpDiscoveryRecord(parsed)) return undefined
  return {
    port: parsed.port,
    host: parsed.host,
    token: typeof parsed.token === 'string' && parsed.token ? parsed.token : undefined,
    pid: parsed.pid,
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    owner: parsed.owner,
    // 宿主补的那一格:形状不对就当没有 —— 发现文件是「线索」不是「契约」。
    ...(isHttpDiscoveryCdp(parsed.cdp) ? { cdp: { port: parsed.cdp.port } } : {}),
  }
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

/** `http://host:port` —— 打日志和拼代理目标时别再各写一遍。 */
export function httpDiscoveryUrl(record: HttpDiscoveryRecord): string {
  const host = record.host === '::1' ? '[::1]' : record.host
  return `http://${host}:${record.port}`
}
