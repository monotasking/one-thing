/**
 * 把 core 服务的 HTTP/SSE 面**嵌进已有宿主**(A 期,docs/design/one-core-2026-08.md §3)。
 *
 * 这不是"再起一个 server":传进来的是宿主自己那只 backend,HTTP 面因此和宿主的
 * IPC 面共享同一条事件流、同一份内存真相、同一个 seq 分配器。桌面开着时它就是
 * 这个 store 的唯一 core 进程,`server:start` 会读发现文件后让位。
 *
 * 三条与独立进程不同的规矩:
 *  1. `ownsBackend: false` —— 关 HTTP 面不能把宿主的引擎一起关了。
 *  2. `processPorts: 'host'` —— MCP / 授权账页存储那几个进程级单槽端口由宿主拥有。
 *  3. 启动失败**不阻塞宿主**:记一条日志,桌面照常用(这是"锦上添花"的面)。
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { OnethingBackend } from '../backend.js'
import { createOnethingHttpServer } from './http.js'
import {
  createOnethingServerRuntimeOverBackend,
  type OnethingServerRuntime,
} from './runtime.js'
import {
  removeHttpDiscovery,
  writeHttpDiscovery,
  type HttpDiscoveryOwner,
} from './discovery.js'
import { configureHostLocalTrust } from './host-trust.js'

export interface EmbeddedOnethingHttpServerOptions {
  /**
   * 固定端口。给了就固定(被占 = 明确报错,不静默换);不给就 `listen(0)`。
   * 默认取 `ONETHING_SERVER_PORT`。
   */
  port?: number
  /** 只绑回环。默认 `127.0.0.1`。 */
  host?: string
  /** 默认取 `ONETHING_SERVER_TOKEN`,没有就每次启动随机生成一把写进发现文件。 */
  authToken?: string
  /** 允许的浏览器来源(单值)。默认 web dev 泳道那个口,泳道脚本用 env 覆盖。 */
  corsOrigin?: string
  /**
   * 写进发现文件的 owner。默认 `'desktop'` —— 老 Vue 桌面一个字都不必改。
   * React 壳(A1,2026-08-31)传 `'shell'`:同样是「带界面的宿主在自己进程里当家」,
   * 但读发现文件的人能分清是哪个壳。`server:start` 的让位判据(`owner !== 'server'`)
   * 对两者行为逐字相同,所以这只是可读性,不是新语义。
   */
  owner?: HttpDiscoveryOwner
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface EmbeddedOnethingHttpServer {
  port: number
  host: string
  token?: string
  url: string
  runtime: OnethingServerRuntime
  server: Server
  close(): Promise<void>
}

/**
 * web dev 泳道那一个口。`access-control-allow-origin` 只认单值,所以这里就是单值:
 * dev-self 的 B 实例(5274,scripts/lib/dev-self.mjs 的 lanePorts)由泳道脚本用
 * `ONETHING_CORS_ORIGIN` 覆盖 —— 与 `server:start` 今天的口径逐字相同。
 */
const DEFAULT_CORS_ORIGIN = 'http://127.0.0.1:5174'

function resolvePort(explicit: number | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit
  const fromEnv = process.env.ONETHING_SERVER_PORT
  if (!fromEnv) return 0
  const parsed = Number.parseInt(fromEnv, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

let current: EmbeddedOnethingHttpServer | null = null

/**
 * 装配 + 监听 + 写发现文件。抛错的责任在调用方 —— 桌面那边包在 catch 里,
 * 只记日志不打断启动。
 */
export async function startEmbeddedOnethingHttpServer(
  backend: OnethingBackend,
  options: EmbeddedOnethingHttpServerOptions = {},
): Promise<EmbeddedOnethingHttpServer> {
  if (current) return current
  const logger = options.logger ?? console
  const host = options.host ?? process.env.ONETHING_SERVER_HOST ?? '127.0.0.1'
  const requestedPort = resolvePort(options.port)
  const token =
    options.authToken
    ?? process.env.ONETHING_SERVER_TOKEN
    ?? randomBytes(24).toString('base64url')
  const corsOrigin = options.corsOrigin ?? process.env.ONETHING_CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN

  const runtime = await createOnethingServerRuntimeOverBackend(backend, {
    ownsBackend: false,
    processPorts: 'host',
  })
  const server = createOnethingHttpServer({
    runtime: runtime.runtime,
    corsOrigin,
    authToken: token,
    workspaceRoot: runtime.workspaceRoot,
  })

  // 本机宿主可信(2026-08-30 拍板,09-03 B2 起六个域共用):这只面**无条件可信**
  // —— 它跑在桌面主进程里、只服务本机同一个用户,token 写在 0600 的发现文件里。
  // 声明之后 `POST /api/rpc` 的 files / tools / search / evals / mcp / sessions 与
  // 桌面 IPC 同权;`ONETHING_SERVER_FILES_SANDBOX=1` 仍然压得住它(端口每次现读)。
  const restoreFilesTrust = configureHostLocalTrust({
    origin: 'desktop-embedded',
    host,
  })

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError)
        if (error.code === 'EADDRINUSE' && requestedPort !== 0) {
          // 固定端口被占绝不静默换:换了之后客户端会连到一个它没打算连的实例。
          reject(new Error(
            `port ${requestedPort} is already in use — free it, or unset ONETHING_SERVER_PORT `
            + 'to let the core pick a free port',
          ))
          return
        }
        reject(error)
      }
      server.once('error', onError)
      server.listen(requestedPort, host, () => {
        server.removeListener('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : requestedPort)
      })
    })

    writeHttpDiscovery({
      port,
      host,
      token,
      pid: process.pid,
      startedAt: Date.now(),
      owner: options.owner ?? 'desktop',
    })
    const url = `http://${host}:${port}`
    logger.log(`[core-http] embedded HTTP/SSE surface listening on ${url}`)

    const embedded: EmbeddedOnethingHttpServer = {
      port,
      host,
      token,
      url,
      runtime,
      server,
      async close() {
        if (current === embedded) current = null
        restoreFilesTrust()
        removeHttpDiscovery()
        await new Promise<void>(resolve => server.close(() => resolve()))
        // 这只 runtime 不拥有 backend(ownsBackend: false),shutdown 只收自己的
        // 订阅、管理器与串联上去的单槽端口。
        await runtime.shutdown()
      },
    }
    current = embedded
    return embedded
  } catch (error) {
    // 监听失败就把刚建起来的 runtime 收回去,别留一只挂着订阅的僵尸 ——
    // 连同那条还没派上用场的本机可信声明。
    restoreFilesTrust()
    await runtime.shutdown().catch(() => {})
    throw error
  }
}

/** 当前挂着的那只(桌面退出路径用)。 */
export function getEmbeddedOnethingHttpServer(): EmbeddedOnethingHttpServer | null {
  return current
}

/** 退出路径:关端口 + 删发现文件。没挂过就是个 no-op。 */
export async function stopEmbeddedOnethingHttpServer(): Promise<void> {
  const embedded = current
  if (!embedded) return
  await embedded.close()
}
