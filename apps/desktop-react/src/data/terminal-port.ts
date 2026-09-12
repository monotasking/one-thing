import { terminalRouter } from '@shared/ipc/terminal'
import type {
  TerminalAttachResponse,
  TerminalCreateRequest,
  TerminalCreateResponse,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalListResponse,
  TerminalSimpleResponse,
} from '@shared/ipc/terminal'

/**
 * **终端与 core 之间那一层端口**(T1 · 壳半边,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.1)。
 *
 * ── 它为什么**不是** `music-port` 的形状 ─────────────────────────────────
 * `music-port` 是 `resources` 那个域的形状(`read / do / onResourceEvent`,
 * 「一个域,零个 scheme 名」)。终端今天**不是**一个资源 scheme —— 把
 * `terminal:` 自述给 AI 是方案表里的 **T3(待拍)**。所以这一层照的是它真正
 * 骑着的那条路:`terminalRouter` 七条(`create / list / write / resize / kill /
 * attach / ack`),一条不多一条不少。等 T3 落地,这只文件换成资源三口、
 * `terminal-source` 那张表跟着换,别处不动 —— 那正是把往返收在一层里的理由。
 *
 * ── 两条推送骑的是**全局事件**,不是这七条 ───────────────────────────────
 * `terminal:data` / `terminal:exit` 是 `@shared/events` 上的两条全局事件
 * (T0,`GLOBAL_EVENT_LEAVES_PROCESS` 里置 true),走 `GET /api/events`。
 * 帧名就是事件的 `type`,载荷原样(`backend/server/global-event-delivery.ts`
 * 那条纪律 3)。所以这里用 `client.events.onAny` 按名字挑 —— 与
 * `music-port.onResourceEvent` 逐字同一个理由:`EventHub.on` 的键收窄在
 * `TransportEvents` 那三条上,全局事件不在那张表里。
 *
 * ── 判形:名字与形**都**对上才算 ─────────────────────────────────────────
 * SSE 是一条广播,载荷是从网线上来的。`asDataEvent` / `asExitEvent` 把每一帧
 * 逐字段核一遍(`terminalId` 是串、`seq` 是有限数、`data` 是串),核不过就
 * **当没看见** —— 照 `music-port.asResourceEvent` 那条判例。少了这一层,
 * 一条形状不对的帧会以 `undefined` 的样子写进 xterm。
 *
 * ── 惰性建 + 测试口 + HMR 退役 ───────────────────────────────────────────
 * 真实现惰性建(它要那个连通之后才存在的客户端);`configureTerminalPort`
 * 给测试换实现;模块级那格 `pending` 的寿命就是这个模块实例,所以配一口
 * `resetTerminalPort` 并在 `import.meta.hot.dispose` 里复用它(09-01 立法)。
 */

/** 一条到了的终端输出。与 `TerminalDataEvent` 同形 —— 全局事件 `extends` 的就是它。 */
export type TerminalDataFact = TerminalDataEvent

/** 一格 PTY 死了。 */
export type TerminalExitFact = TerminalExitEvent

export interface TerminalPort {
  /** 传输面就绪(D0 的 whenConnected)。 */
  ready(): Promise<unknown>
  create(request: TerminalCreateRequest): Promise<TerminalCreateResponse>
  list(): Promise<TerminalListResponse>
  write(terminalId: string, data: string): Promise<TerminalSimpleResponse>
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalSimpleResponse>
  kill(terminalId: string): Promise<TerminalSimpleResponse>
  attach(terminalId: string): Promise<TerminalAttachResponse>
  /**
   * 流控回执。**渲染侧不等它**(`xterm.write` 的回调里发出去就不管了)——
   * 丢一条只是把恢复推迟一拍,attach 的世代协议本来就会把账本清零
   * (判词在 `@shared/ipc/terminal.ts` 的 `ack` 那一段)。
   */
  ack(terminalId: string, bytes: number, generation: number): Promise<TerminalSimpleResponse>
  /** 订这一格的输出。返回退订。 */
  onData(callback: (fact: TerminalDataFact) => void): () => void
  /** 订「哪一格死了」。返回退订。 */
  onExit(callback: (fact: TerminalExitFact) => void): () => void
}

let port: TerminalPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureTerminalPort(next: TerminalPort | undefined): void {
  port = next
}

/** 一帧 `terminal:data` → 这一条认不认。名字与形都对上才算数(SSE 是广播)。 */
export function asDataEvent(data: unknown): TerminalDataFact | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.terminalId !== 'string') return null
  if (typeof row.seq !== 'number' || !Number.isFinite(row.seq)) return null
  if (typeof row.data !== 'string') return null
  return { terminalId: row.terminalId, seq: row.seq, data: row.data }
}

/** 一帧 `terminal:exit` → 这一条认不认。`exitCode` 可以是 null(被信号杀掉)。 */
export function asExitEvent(data: unknown): TerminalExitFact | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.terminalId !== 'string') return null
  const code = row.exitCode
  if (code !== null && (typeof code !== 'number' || !Number.isFinite(code))) return null
  return { terminalId: row.terminalId, exitCode: code }
}

async function realPort(): Promise<TerminalPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const terminal = client.api(terminalRouter)
  /** 一条按帧名挑的订阅。两条推送共用这一句 —— 判形函数由调用方给。 */
  const onFrame = <T>(name: string, parse: (data: unknown) => T | null, cb: (fact: T) => void) =>
    client.events.onAny((frame) => {
      if (frame.name !== name) return
      const fact = parse(frame.data)
      if (fact) cb(fact)
    })
  return {
    ready: () => whenConnected(),
    create: (request) => terminal.create(request),
    list: () => terminal.list({}),
    write: (terminalId, data) => terminal.write({ terminalId, data }),
    resize: (terminalId, cols, rows) => terminal.resize({ terminalId, cols, rows }),
    kill: (terminalId) => terminal.kill({ terminalId }),
    attach: (terminalId) => terminal.attach({ terminalId }),
    ack: (terminalId, bytes, generation) => terminal.ack({ terminalId, bytes, generation }),
    onData: (cb) => onFrame('terminal:data', asDataEvent, cb),
    onExit: (cb) => onFrame('terminal:exit', asExitEvent, cb),
  }
}

let pending: Promise<TerminalPort> | undefined

export function terminalPort(): Promise<TerminalPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

/** 回到出厂(测试与 HMR 用)。幂等。 */
export function resetTerminalPort(): void {
  port = undefined
  pending = undefined
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法)。这只文件只有 `pending` 那一格
 * (惰性建出来的真实现里攥着 core 客户端),退役复用已有的那一口拆卸。
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetTerminalPort)
}
