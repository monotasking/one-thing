/**
 * 发现文件 `<store>/run/http.json` 的**记录形状** —— server 与 client 之间的契约。
 *
 * 产地是 `packages/backend/http-server/http-server-discovery.ts`(A 期,`docs/design/one-core-2026-08.md` §3);
 * C0(`docs/design/client-sdk-2026-09.md` §4.4 / §9)把「记录的形状 + 判活的两段」抽到这里,
 * 因为从此有**两个**问「这个 store 有没有活 core」的人,而他们不能各说各话:
 *
 * | 谁 | 拿它干什么 |
 * |---|---|
 * | `apps/server/src/main.ts` | 拒启:`owner !== 'server'` 且活着 → 让位(`--force` 绕过) |
 * | `@onething/client/node` 的 `readCoreDiscovery()` | CLI / 脚本当 core 的客户端:活着就连上去 |
 *
 * server / client 拆分第②步(2026-10-02,`docs/design/server-client-split-2026-10.md` §6)起,shared
 * 不许碰 node,所以这里只留**纯的一半**:记录形状、白名单式校验与解析(`parseHttpDiscoveryRecord`)、
 * `httpDiscoveryUrl`。碰 node 的那一半(读文件、两段判活、store 根目录的三段解析)按「两边各一份最小实现」
 * 分给 `packages/backend/http-server/http-server-discovery-io.ts` 与 `packages/client/http-discovery-io.ts`
 * (server 不能 import client,client 不能 import server);两份对同一组样例给同一个答案,由
 * `packages/backend/http-server/__tests__/http-server-discovery-io-parity.test.ts` 钉住,不由注释保证。
 *
 * 三件事(原文照搬产地的判例,别再各自重新发现一次):
 *  1. **文件存在 ≠ 活着**。进程被 SIGKILL / 掉电时文件会留下来。判活因此是两段判定:
 *     pid 还在(`kill(pid, 0)`)**且** 端口真的能连上。只看 pid 会被 pid 复用骗,只看端口会被
 *     别的程序占用同一端口骗 —— 两条都过才算数。
 *  2. **token 是秘密**。文件按 0600 写,run 目录按 0700 建(写侧在产地)。
 *  3. 读永远不抛:发现文件是「线索」不是「契约」,坏了就当没有,调用方走回退路径。
 */
export const HTTP_DISCOVERY_FILENAME = 'http.json'

/** `<store>/run` —— 发现文件、`daemon.sock`、`backend.lock` 的那一格。 */
export const ONETHING_RUN_DIR_NAME = 'run'

/** `~/.onething` 的那个尾巴。与 `@onething/backend/storage` 的同名常量必须一致。 */
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

/** `http://host:port` —— 打日志和拼代理目标时别再各写一遍。 */
export function httpDiscoveryUrl(record: HttpDiscoveryRecord): string {
  const host = record.host === '::1' ? '[::1]' : record.host
  return `http://${host}:${record.port}`
}
