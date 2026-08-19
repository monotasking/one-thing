/**
 * web dev 泳道的 `/api` 代理(A 期,docs/design/one-core-2026-08.md §3)。
 *
 * 从前这里是 vite 内置 `server.proxy` 指着写死的 `:8787`。A 期之后 core 服务的
 * 端口是**动态**的(桌面 `listen(0)`),而且带 token —— 所以代理必须做两件内置
 * proxy 做不了的事:
 *
 *  1. **每请求**读发现文件 `<store>/run/http.json` 决定目标。桌面重启换了端口
 *     不必重启 vite(vite 的内置 proxy 在 `createProxyServer` 时就把 target 定死了,
 *     `bypass` 拿到的是一份浅拷贝,改不动它 —— 这就是这里自己写一段的原因)。
 *  2. **注入 Bearer token**。浏览器端(packages/renderer/platform/web.ts)不知道
 *     token;它是本机 core 服务写在发现文件里的,只有能读那个文件的人拿得到。
 *     token 因此止步于 dev 代理,不进浏览器。
 *
 * 发现文件不在(或读不出来)就回退到 `ONETHING_API_URL || http://127.0.0.1:8787`
 * —— 手动起着的 `server:start` 仍然连得上。
 *
 * 路径拼法与 `@onething/app/server/discovery.ts` 同义,这里用裸 node API 重写一遍
 * 是因为 vite.config 由 esbuild 单独打包,`@onething/*` 别名在那个上下文里不成立。
 */
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from 'vite'

interface DiscoveryRecord {
  port: number
  host: string
  token?: string
  pid: number
  owner: 'desktop' | 'server'
}

function laneStorePath(): string {
  return process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function readDiscovery(): DiscoveryRecord | undefined {
  try {
    const raw = readFileSync(path.join(laneStorePath(), 'run', 'http.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DiscoveryRecord>
    if (typeof parsed.port !== 'number' || !parsed.port) return undefined
    if (typeof parsed.host !== 'string' || !parsed.host) return undefined
    if (typeof parsed.pid !== 'number') return undefined
    // 陈旧文件(进程被 SIGKILL)会留在盘上。这里只做便宜的 pid 探活;端口探活
    // 交给转发本身 —— 连不上就是一次 502,dev 环境看得见,而不是每请求一次 TCP 握手。
    try {
      process.kill(parsed.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') return undefined
    }
    return {
      port: parsed.port,
      host: parsed.host,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      pid: parsed.pid,
      owner: parsed.owner === 'desktop' ? 'desktop' : 'server',
    }
  } catch {
    return undefined
  }
}

function fallbackTarget(): { host: string, port: number, token?: string } {
  const url = new URL(process.env.ONETHING_API_URL || 'http://127.0.0.1:8787')
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || '80', 10),
    token: process.env.ONETHING_SERVER_TOKEN,
  }
}

/**
 * `/api` 动态代理。SSE 靠原样 pipe 保活:不缓冲、不改 header、上游断开就断开。
 */
export function onethingDevApiProxy(): Plugin {
  return {
    name: 'onething-dev-api-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api', (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
        const discovered = readDiscovery()
        const target = discovered
          ? { host: discovered.host, port: discovered.port, token: discovered.token }
          : fallbackTarget()
        if (!target.port) {
          next()
          return
        }

        const headers = { ...req.headers }
        delete headers.host
        // token 只在这一跳出现:浏览器不知道它,代理从发现文件里读出来补上。
        if (target.token && !headers.authorization) {
          headers.authorization = `Bearer ${target.token}`
        }

        // middlewares.use('/api', …) 会把 '/api' 从 req.url 上剥掉,转发时要补回去。
        const upstreamPath = `/api${req.url ?? ''}`
        const upstream = httpRequest(
          { host: target.host, port: target.port, method: req.method, path: upstreamPath, headers },
          upstreamResponse => {
            res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
            upstreamResponse.pipe(res)
          },
        )
        upstream.on('error', error => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' })
          }
          res.end(JSON.stringify({
            success: false,
            error: `[dev-proxy] no onething core at ${target.host}:${target.port}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }))
        })
        // 客户端提前断开(SSE 关页面)要把上游一起收掉,否则连接会攒着不放。
        res.on('close', () => upstream.destroy())
        req.pipe(upstream)
      })
    },
  }
}
