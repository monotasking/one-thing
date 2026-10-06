/**
 * **主进程把自己交给后端当一扇壳**(第④步批 2b,决策 D4 (A),`docs/design/two-process-2026-10.md` §2.3 第 13 条)。
 *
 * 后端出了这个进程之后,住在 Electron 里的能力(今天只有内置浏览器 `browser:`)不能再进程内
 * `backend.resources.mount(provider)`;它们改成与渲染层同一个体例:经主进程那台客户端
 * (`./core-client.ts`)`resources.mountShell` 交一份自述,订 `GET /api/events` 上的
 * `resource:shell-command`,对上自己的 `shellId` 就跑、跑完 `resources.shellResult` 回执,
 * 事实经 `resources.emit` 报回去。体例逐段照 `src/resources/shell-host.ts`(渲染层那一份):
 *
 * | 状态 | 进入 | 离开 | 期间 |
 * | --- | --- | --- | --- |
 * | 未登记 | 还没连上 / 已注销 | `start()` 的那次 `mountShell` | `do(browser:…)` → 没人认领 |
 * | 已登记 | `mountShell` 答 `{ok:true}` | `stop()` / 心跳过期 | AI 工具面、`describe`、渲染层的 `resources.*` 都看得见它 |
 * | 在飞 | 一条 `resource:shell-command` 到了 | 那条 `shellResult` | 后端那边 10 秒没回执 → `ResourceHomeUnavailableError` |
 * | 已注销 | `unmountShell` / 90 秒没续命 | — | 回到「未登记」那一行 |
 *
 * 与渲染层那一份差在两处,都是「主进程比一扇窗活得长」的推论:
 *  · **后端重拉之后立刻重新登记**:SSE 从 `reconnecting` 回到 `live` 那一刻交一遍自述(后端是新进程,登记表是空的),
 *    不等 30 秒那一拍心跳 —— 否则重拉之后的半分钟里内置浏览器对 AI 与渲染层都是「不在」;
 *  · **一张能力表,每行一份自述 + 读法 + 做法**:今天只有 `browser:` 一行;将来主进程里再住一种能力
 *    (例:PDF 阅读器)= 这张表多一行,这只文件零改动。
 *
 * `shellId` 每次运行现铸(`main-<uuid>`),不跨重启复用 —— 判词与渲染层那一份文件头逐字相同。
 * 零 electron import。
 */
import { randomUUID } from 'node:crypto'
import type { OnethingClient } from '@onething/backend-client'
import type { RouteAPI } from '@shared/ipc/router'
import type { ResourcesRoutes, SerializedResourceSpec, ShellCommandResult } from '@shared/ipc/resources'
import { resourcesRouter } from '@shared/ipc/resources'

/** 续命周期。后端 `DEFAULT_SHELL_HEARTBEAT_MS` 是 30s、3 倍没续命就注销 —— 对齐它。 */
export const MAIN_SHELL_HEARTBEAT_MS = 30_000
const HANDLED_CALLS_CAP = 256

/** 一行能力:一份自述 + 它的读法与做法。`path` = 地址里 scheme 之后那一段(命名空间级是空串)。 */
export interface MainShellResourceEntry {
  readonly scheme: string
  readonly spec: SerializedResourceSpec
  read(name: string, path: string, params: Record<string, unknown>): Promise<unknown>
  run(op: string, path: string, params: Record<string, unknown>): Promise<string>
}

export interface MainShellLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>, error?: unknown): void
}

interface ShellCommandFrame {
  shellId: string
  callId: string
  kind: 'op' | 'read'
  scheme: string
  ref: string | null
  op: string
  params: Record<string, unknown>
}

function asCommand(data: unknown): ShellCommandFrame | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.shellId !== 'string' || typeof row.callId !== 'string') return null
  if (row.kind !== 'op' && row.kind !== 'read') return null
  if (typeof row.op !== 'string') return null
  const ref = typeof row.ref === 'string' ? row.ref : null
  const fromRef = ref && ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : ''
  return {
    shellId: row.shellId,
    callId: row.callId,
    kind: row.kind,
    scheme: typeof row.scheme === 'string' && row.scheme ? row.scheme : fromRef,
    ref,
    op: row.op,
    params: row.params && typeof row.params === 'object' ? (row.params as Record<string, unknown>) : {},
  }
}

function pathOf(ref: string | null): string {
  if (!ref) return ''
  const at = ref.indexOf(':')
  return at < 0 ? '' : ref.slice(at + 1)
}

export class MainShellResources {
  readonly shellId: string
  private readonly entries: readonly MainShellResourceEntry[]
  private readonly log: MainShellLogger
  private resources: RouteAPI<ResourcesRoutes> | undefined
  private readonly mounted = new Set<string>()
  private readonly teardown: Array<() => void> = []
  private readonly handled = new Set<string>()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private started = false
  private stopping = false

  constructor(entries: readonly MainShellResourceEntry[], log: MainShellLogger, shellId: string = `main-${randomUUID()}`) {
    this.entries = entries
    this.log = log
    this.shellId = shellId
  }

  /** 交自述、订命令、开续命。幂等。 */
  async start(client: OnethingClient): Promise<void> {
    if (this.started || this.stopping) return
    this.started = true
    this.resources = client.api(resourcesRouter)
    // 先订命令再登记:登记那一刻起后端就可能发命令给这个 id。
    this.own(client.events.onAny(event => {
      if (event.name !== 'resource:shell-command') return
      const command = asCommand(event.data)
      // **别扇壳的当没看见** —— SSE 是广播,这一句是这条通道唯一的归属判定。
      if (!command || command.shellId !== this.shellId) return
      this.schedule(command)
    }))
    let previous = client.events.status()
    this.own(client.events.onStatusChange(status => {
      // 后端重拉过(新进程、空登记表):回到 live 那一刻立刻再交一遍。
      if (status === 'live' && previous === 'reconnecting') void this.mount()
      previous = status
    }))
    await this.mount()
    this.heartbeat = setInterval(() => { void this.mount() }, MAIN_SHELL_HEARTBEAT_MS)
    this.heartbeat.unref?.()
    this.log.info('main-process shell resources mounted', { shellId: this.shellId, schemes: [...this.mounted] })
  }

  /** 报一条事实。地址是自己认领的命名空间;发不出去只记一行(它是转发,不是真身)。 */
  emit(scheme: string, path: string, event: string, payload: unknown): void {
    if (this.stopping || !this.resources || !this.mounted.has(scheme)) return
    void this.resources.emit({ shellId: this.shellId, ref: `${scheme}:${path}`, event, payload })
      .catch((error: unknown) => { this.log.warn('emitting a shell resource fact failed', { scheme, event }, error) })
  }

  /** 注销、退订、停表。幂等。 */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const undo of this.teardown.splice(0)) {
      try { undo() } catch { /* 一条退订炸了不该拦住后面那些 */ }
    }
    await this.resources?.unmountShell({ shellId: this.shellId }).catch(() => undefined)
    this.mounted.clear()
  }

  private own(undo: () => void): void {
    if (this.stopping) { undo(); return }
    this.teardown.push(undo)
  }

  /** 交一遍自述(续命走的是同一句,后端按自述的字面判「变没变」)。被拒不重试 —— 重试答案还是同一个。 */
  private async mount(): Promise<void> {
    if (this.stopping || !this.resources) return
    for (const entry of this.entries) {
      try {
        const answer = await this.resources.mountShell({ shellId: this.shellId, spec: entry.spec })
        if (answer.ok) this.mounted.add(entry.scheme)
        else {
          this.mounted.delete(entry.scheme)
          this.log.warn('main-process shell resources were refused', { scheme: entry.scheme, reason: answer.reason })
        }
      } catch (error) {
        this.log.warn('mounting main-process shell resources failed', { scheme: entry.scheme }, error)
      }
    }
  }

  private schedule(command: ShellCommandFrame): void {
    if (this.handled.has(command.callId)) return
    this.handled.add(command.callId)
    if (this.handled.size > HANDLED_CALLS_CAP) {
      const oldest = this.handled.values().next()
      if (!oldest.done) this.handled.delete(oldest.value)
    }
    queueMicrotask(() => { void this.run(command) })
  }

  private async run(command: ShellCommandFrame): Promise<void> {
    if (this.stopping) return
    let result: ShellCommandResult
    try {
      const entry = this.entries.find(row => row.scheme === command.scheme)
      if (!entry || !this.mounted.has(entry.scheme)) throw new Error(`this client does not run ${command.scheme}:`)
      const path = pathOf(command.ref)
      result = command.kind === 'read'
        // 读法的答案 `JSON.stringify` 进那一格文本 —— 回执契约只有一格文本,后端 `parseShellPayload` 解回来。
        ? { kind: 'ok', text: JSON.stringify(await entry.read(command.op, path, command.params)) }
        : { kind: 'ok', text: await entry.run(command.op, path, command.params) }
    } catch (error) {
      result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    try {
      await this.resources?.shellResult({ shellId: this.shellId, callId: command.callId, result })
    } catch (error) {
      this.log.warn('sending a shell result failed', { callId: command.callId }, error)
    }
  }
}
