/**
 * **桌面拉起后端子进程**(第④步批 2b,`docs/design/two-process-2026-10.md` §2.3 第 1 条与决策 D1 / D6 / D11)。
 *
 * 从这一批起 Electron 主进程不再自己装配后端:它用**同一只 Electron 二进制** + `ELECTRON_RUN_AS_NODE=1`
 * 拉起 `dist-electron/backend.cjs`(`packages/backend/backend-standalone-main.ts` 的桌面档,
 * `ONETHING_BACKEND_LAUNCHER=desktop`),等它把发现文件写好、端口连得上,再把 `{ baseUrl, token }` 交给渲染层。
 * 这只类管那个子进程的一整段生命:
 *
 * | 状态 | 进入 | 离开 |
 * | --- | --- | --- |
 * | `idle` | 构造 | `start()` |
 * | `starting` | 拉起了、发现文件还没活 | 活了 → `running`;先退出 / 超时 → 崩溃那一支 |
 * | `running` | 发现文件活着(自己拉的,或者借来的) | 非预期退出 → `restarting`;`stop()` / `leave()` |
 * | `restarting` | 崩了,还在「60 秒内最多 3 次」的额度里 | 重拉活了 → `running`;额度用完 → `stopped` |
 * | `stopped` | 三次都没起来(或起都没起来) | 用户点「重启」→ `starting` |
 * | `stopping` | `stop()`:SIGTERM 发了,等它退 | 退了 → `idle` |
 *
 * **几条判据,每一条都是有意的**:
 *
 *  · **先借后拉**。`start()` 先读发现文件:有活着的后端(上一次「退出后继续运行」留下的、或者别人起的
 *    `server:start`)就直接连它,不再拉第二台 —— 一个 store 只有一个后端。借来的那台也要监督:每 2 秒问一次
 *    它的 pid 还在不在,死了就按崩溃那一支自己拉一台。
 *  · **重拉之后地址与 token 不变**。渲染层的连接(`host:connection`)是一次性的承诺,传输层把 `baseUrl` 与
 *    token 烤在实例里 —— 重拉若换了端口或 token,渲染层这辈子都连不回去。所以 token 由这一侧铸(或沿用借来
 *    那台的),经 `ONETHING_SERVER_TOKEN` 递进去;第一次端口动态分配,活了之后记下真端口,之后每次重拉都钉进
 *    `ONETHING_SERVER_PORT`。SSE 那一侧因此只是 `reconnecting → live`,渲染层零改动。
 *  · **stdout / stderr 落一份文件,不走管道**(决策见施工记录):桌面档不回显日志,但 MCP SDK 之类的第三方
 *    `console.warn` 还会写 stdout。管道要有人持续读,否则写满就把子进程卡住;而「退出后继续运行」那一档里
 *    父进程一退管道就断,子进程下一次写就是 EPIPE。直接把两路接到 `<store>/run/backend-stdio.log`(每次拉起
 *    截断重写),两件事都不存在了;起不来时把这份文件的尾巴(最多 40 行)交给渲染层显示。
 *  · **永远 `detached`(自己一个进程组)**。终端里 Ctrl+C 打的是 Electron 那一组,后端不跟着挨信号,收尾由
 *    Electron 的 `stop()` 统一做;「退出后继续运行」开着时 Electron 直接走、不发信号,子进程本来就不在它的组里。
 *    代价:Electron 被强杀时后端留着 —— 下次启动「先借后拉」把它接回来,不会多一台。
 *  · **停止 = SIGTERM 一次 → 等(后端自己的 5 秒刷盘期限 + 2 秒)→ 还没退就 SIGKILL 并记日志**。只发一次
 *    SIGTERM:后端对第二个信号是「立刻硬退」,那会把正在落盘的会话截断。
 *  · **只停自己的**。自己拉起的,以及借来的但 owner 是 `backend`(上一次桌面拉起、开着「继续运行」留下的)才停;
 *    owner 是 `server` 的是别人的 `server:start`,不归这里管 —— 不停、也不许「重启」。owner `backend` 但记录上写着
 *    `launcher: 'cli'` 的是 CLI 自己拉起的那台(第④步批 3):同样只借不停,由 `onething backend stop` 去停。
 *  · **崩溃之后删发现文件只删 pid 对得上的那一份**(死人删不掉自己的文件;已经被新实例重写的不碰)。
 *
 * 零 electron import:二进制路径、入口路径(打包态由 `main.ts` 换成 `app.asar.unpacked` 下的真路径)、环境、
 * 日志全由调用方递。于是 `gate:backend-process` 能用 `ELECTRON_RUN_AS_NODE` 起一只不开窗的 node 驱动它
 * (拉起 / 停止 / 崩溃重拉 / 三次封顶 / 继续运行),单测也能注入一只假的 `spawn`。
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, fstatSync } from 'node:fs'
import path from 'node:path'
import {
  isAlive,
  pidAlive,
  readDiscovery,
  removeDiscoveryOf,
  type HttpDiscoveryOwner,
  type HttpDiscoveryRecord,
} from './discovery.js'

/** 渲染层能看到的那几格(设置页的状态行、横幅、重拉提示)。 */
export type BackendProcessPhase = 'idle' | 'starting' | 'running' | 'restarting' | 'stopped' | 'stopping'

export interface BackendProcessSnapshot {
  readonly phase: BackendProcessPhase
  readonly pid?: number
  readonly port?: number
  /** 发现文件里的 `startedAt`(毫秒时间戳)。 */
  readonly startedAt?: number
  readonly owner?: HttpDiscoveryOwner
  /** 这台是这一程拉起的(而不是借来的)。 */
  readonly launchedHere?: boolean
  /** `stopped` / 起不来时的那句话。 */
  readonly error?: string
  /** 起不来时 stdout / stderr 的尾巴。 */
  readonly tail?: readonly string[]
}

export interface BackendProcessLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>, error?: unknown): void
  error(msg: string, fields?: Record<string, unknown>, error?: unknown): void
}

export interface BackendConnection {
  readonly baseUrl: string
  readonly token?: string
}

export type BackendStartResult =
  | { ok: true; connection: BackendConnection; adopted: boolean }
  | { ok: false; error: string; tail: readonly string[] }

export interface BackendProcessOptions {
  /** 跑后端的那只二进制。生产里是 Electron 自己(`process.execPath`,配 `ELECTRON_RUN_AS_NODE=1`)。 */
  readonly execPath: string
  /** `backend.cjs` 的真路径(打包态在 `app.asar.unpacked` 下)。 */
  readonly entry: string
  readonly storeRoot: string
  /** 继承的环境(生产里是 `process.env`)。 */
  readonly env: NodeJS.ProcessEnv
  /** 打包资源目录 —— **只在打包态给**(dev 下设了反而会让后端去错的地方找内建 skills)。 */
  readonly resourcesPath?: string
  /** 这一程的 token。不给就现铸一把(24 字节 base64url,与后端自己铸的同形)。 */
  readonly token?: string
  readonly log: BackendProcessLogger
  /** 每次状态变了就叫(推给渲染层)。 */
  readonly onChange?: (snapshot: BackendProcessSnapshot) => void
  /** 等发现文件活着的上限。缺省 30s(真店装配 ≈1.7s,登录 shell 没命中缓存另加 1–3s,机器忙时再翻几倍)。 */
  readonly aliveTimeoutMs?: number
  /** 轮询发现文件的粒度。缺省 50ms。 */
  readonly pollMs?: number
  /** SIGTERM 之后等多久再 SIGKILL。缺省 7s = 后端自己的 5s 刷盘期限 + 2s。 */
  readonly stopGraceMs?: number
  /** 崩溃重拉的窗口与额度(D11:60 秒内最多 3 次)。 */
  readonly crashWindowMs?: number
  readonly maxRestarts?: number
  /** 借来的那台多久问一次它还活着没有。缺省 2s。 */
  readonly adoptedPollMs?: number
  /** 测试 / 门注入。 */
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  readonly now?: () => number
}

const TAIL_LINES = 40
const TAIL_BYTES = 16 * 1024

/** 这一程 stdout / stderr 落在哪。`<store>/run/` 是运行期状态的家(发现文件、CDP 旗文件都在那里)。 */
export function backendStdioPath(storeRoot: string): string {
  return path.join(storeRoot, 'run', 'backend-stdio.log')
}

/** 读那份文件的尾巴(最多 40 行、最多 16KB)。读不到答空。 */
export function readStdioTail(storeRoot: string): string[] {
  let fd: number | undefined
  try {
    fd = openSync(backendStdioPath(storeRoot), 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf-8').split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-TAIL_LINES)
  } catch {
    return []
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 关不上不改结论 */ }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export class BackendProcess {
  private readonly options: BackendProcessOptions
  /** 这一程递给子进程的 token。借来一台之后改成它的那把(重拉时沿用,渲染层手里那份才还对得上)。 */
  private token: string
  private readonly spawnFn: NonNullable<BackendProcessOptions['spawn']>
  private readonly now: () => number

  private snapshot: BackendProcessSnapshot = { phase: 'idle' }
  /** 这一程拉起的那只子进程(借来的那台没有句柄)。 */
  private child: ChildProcess | undefined
  /** 此刻服务这个 store 的那份记录(拉起的或借来的)。 */
  private record: HttpDiscoveryRecord | undefined
  /** 第一次活了之后记下的端口:之后每次重拉都钉进 `ONETHING_SERVER_PORT`。 */
  private pinnedPort: number | undefined
  /** 最近几次非预期退出的时刻(D11 的额度)。 */
  private crashes: number[] = []
  private adoptedTimer: ReturnType<typeof setInterval> | undefined
  /** `stop()` / `leave()` 之后,子进程的退出都不再算崩溃。 */
  private intentional = false
  private starting: Promise<BackendStartResult> | undefined
  private stopping: Promise<void> | undefined

  constructor(options: BackendProcessOptions) {
    this.options = options
    this.token = options.token ?? randomBytes(24).toString('base64url')
    this.spawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions))
    this.now = options.now ?? Date.now
  }

  /** 此刻的样子(设置页状态行、横幅读它)。 */
  get state(): BackendProcessSnapshot {
    return this.snapshot
  }

  /** 此刻的地址(只有 `running` 才有)。 */
  get connection(): BackendConnection | undefined {
    if (this.snapshot.phase !== 'running' || !this.record) return undefined
    return connectionOf(this.record)
  }

  /** 这一台归不归这里停 / 重启(见文件头「只停自己的」)。 */
  get ownsBackend(): boolean {
    if (this.child) return true
    // CLI 拉起的那台(`launcher: 'cli'`)借来照用,但不归桌面停 —— 它的拉起者是那条命令(第④步批 3)。
    return this.record?.owner === 'backend' && this.record.launcher !== 'cli'
  }

  /**
   * 先借后拉。幂等:正在起就交回同一个承诺。
   */
  start(): Promise<BackendStartResult> {
    if (this.starting) return this.starting
    this.intentional = false
    this.starting = this.startOnce().finally(() => { this.starting = undefined })
    return this.starting
  }

  /**
   * 用户点「重启」:停掉现在这台(只停自己的),清掉崩溃额度,再拉一台。借来的 `server:start` 拒绝。
   */
  async restart(): Promise<BackendStartResult> {
    if (this.record && !this.ownsBackend) {
      return { ok: false, error: `this store is served by a ${this.record.owner} backend that this app did not start`, tail: [] }
    }
    await this.stop()
    this.crashes = []
    return this.start()
  }

  /**
   * 收尾(缺省档的退出、或者「重启」的前一半)。只停自己的:借来的 `server:start` 原样留着,只是不再盯它。
   * SIGTERM 一次,等 `stopGraceMs`,没退就 SIGKILL 并记一行日志。幂等。
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopOnce().finally(() => { this.stopping = undefined })
    return this.stopping
  }

  /**
   * 「退出后继续运行」:不发信号,不再监督,子进程留在世上(它本来就是 detached 的、stdio 是文件)。
   * 下次启动走「先借后拉」接回它。
   */
  leave(): void {
    this.intentional = true
    this.clearAdoptedTimer()
    this.child?.unref()
    this.log('info', 'backend left running after quit', { pid: this.record?.pid ?? this.child?.pid })
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private async startOnce(): Promise<BackendStartResult> {
    const existing = readDiscovery(this.options.storeRoot)
    if (existing && await isAlive(existing)) return this.adopt(existing)
    // 一份死人的记录:删掉(只删 pid 对得上的那一份),不然读者会被它骗半秒。
    if (existing) removeDiscoveryOf(this.options.storeRoot, existing.pid)
    return this.launch('starting')
  }

  private adopt(record: HttpDiscoveryRecord): BackendStartResult {
    this.record = record
    this.pinnedPort ??= record.port
    if (record.token) this.token = record.token
    this.update({ phase: 'running', pid: record.pid, port: record.port, startedAt: record.startedAt, owner: record.owner, launchedHere: false })
    this.log('info', 'adopted a live backend', { pid: record.pid, port: record.port, owner: record.owner })
    this.watchAdopted(record)
    return { ok: true, connection: connectionOf(record), adopted: true }
  }

  private watchAdopted(record: HttpDiscoveryRecord): void {
    this.clearAdoptedTimer()
    this.adoptedTimer = setInterval(() => {
      if (this.intentional || this.record !== record) return
      if (pidAlive(record.pid)) return
      this.clearAdoptedTimer()
      removeDiscoveryOf(this.options.storeRoot, record.pid)
      this.onUnexpectedExit(`the backend (pid ${record.pid}) went away`)
    }, this.options.adoptedPollMs ?? 2000)
    this.adoptedTimer.unref?.()
  }

  private clearAdoptedTimer(): void {
    if (this.adoptedTimer !== undefined) clearInterval(this.adoptedTimer)
    this.adoptedTimer = undefined
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...this.options.env,
      ELECTRON_RUN_AS_NODE: '1',
      ONETHING_STORE_PATH: this.options.storeRoot,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_TERMINAL: '1',
      ONETHING_BACKEND_LAUNCHER: 'desktop',
      ONETHING_SERVER_TOKEN: this.token,
    }
    if (this.options.resourcesPath) env.ONETHING_RESOURCES_PATH = this.options.resourcesPath
    else delete env.ONETHING_RESOURCES_PATH
    if (this.pinnedPort !== undefined) env.ONETHING_SERVER_PORT = String(this.pinnedPort)
    return env
  }

  private async launch(phase: 'starting' | 'restarting'): Promise<BackendStartResult> {
    // 收尾已经开始(`stop()` / `leave()`):不再拉 —— 否则崩溃重拉那条链会在退出途中再生一只孤儿。
    if (this.intentional) return { ok: false, error: 'the app is quitting', tail: [] }
    this.record = undefined
    this.update({ phase })
    const storeRoot = this.options.storeRoot
    const stdioPath = backendStdioPath(storeRoot)
    let fd: number | undefined
    let child: ChildProcess
    try {
      mkdirSync(path.dirname(stdioPath), { recursive: true })
      // 每次拉起截断重写:这份文件只装这一程的输出,尾巴才说得清「这一次为什么没起来」。
      fd = openSync(stdioPath, 'w', 0o600)
      child = this.spawnFn(this.options.execPath, [this.options.entry], {
        env: this.childEnv(),
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
    } catch (error) {
      return this.failStart(`could not start the backend: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // 子进程已经拿到了自己那一份描述符,父进程这一份关掉。
      if (fd !== undefined) try { closeSync(fd) } catch { /* 关不上不改结论 */ }
    }
    this.child = child
    child.unref()
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    child.once('error', error => { this.log('error', 'backend process error', { pid: child.pid }, error) })
    this.log('info', 'backend process spawned', { pid: child.pid, pinnedPort: this.pinnedPort ?? null })

    const startedAt = this.now()
    let early: { code: number | null; signal: NodeJS.Signals | null } | undefined
    void exited.then(result => { early = result })
    const deadline = startedAt + (this.options.aliveTimeoutMs ?? 30_000)
    while (this.now() < deadline) {
      if (early || this.intentional) break
      const record = readDiscovery(storeRoot)
      if (record && record.pid === child.pid && await isAlive(record)) {
        this.record = record
        this.pinnedPort ??= record.port
        void exited.then(result => this.onChildExit(child, result))
        this.update({ phase: 'running', pid: record.pid, port: record.port, startedAt: record.startedAt, owner: record.owner, launchedHere: true })
        this.log('info', 'backend alive', { pid: record.pid, port: record.port, ms: this.now() - startedAt })
        return { ok: true, connection: connectionOf(record), adopted: false }
      }
      await delay(this.options.pollMs ?? 50)
    }
    if (this.intentional) {
      return { ok: false, error: 'the app is quitting', tail: [] }
    }
    if (!early) {
      // 超时:没起来也没退,收掉它再算一次失败。
      this.log('warn', 'backend did not come alive in time; stopping it', { pid: child.pid })
      await this.terminate(child, exited)
    }
    if (this.child === child) this.child = undefined
    if (child.pid !== undefined) removeDiscoveryOf(storeRoot, child.pid)
    const why = early
      ? `the backend exited before it was ready (code ${early.code ?? 'null'}${early.signal ? `, signal ${early.signal}` : ''})`
      : 'the backend did not become ready in time'
    return this.failStart(why)
  }

  /** 起不来:记一次崩溃,额度内重拉,额度用完亮 `stopped`。 */
  private async failStart(why: string): Promise<BackendStartResult> {
    if (this.intentional) return { ok: false, error: 'the app is quitting', tail: [] }
    const tail = readStdioTail(this.options.storeRoot)
    this.log('error', 'backend failed to start', { why, tail: tail.slice(-10) })
    if (this.withinRestartBudget()) {
      await delay(this.options.pollMs ?? 50)
      return this.launch('restarting')
    }
    this.update({ phase: 'stopped', error: why, tail })
    return { ok: false, error: why, tail }
  }

  /** 额度:记下这一次,数窗口里一共几次;没超过就答真。 */
  private withinRestartBudget(): boolean {
    const now = this.now()
    const windowMs = this.options.crashWindowMs ?? 60_000
    this.crashes = [...this.crashes.filter(at => now - at < windowMs), now]
    return this.crashes.length <= (this.options.maxRestarts ?? 3)
  }

  private onChildExit(child: ChildProcess, result: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.child === child) this.child = undefined
    if (this.intentional) return
    if (child.pid !== undefined) removeDiscoveryOf(this.options.storeRoot, child.pid)
    this.onUnexpectedExit(`the backend exited (code ${result.code ?? 'null'}${result.signal ? `, signal ${result.signal}` : ''})`)
  }

  private onUnexpectedExit(why: string): void {
    this.record = undefined
    if (!this.withinRestartBudget()) {
      const tail = readStdioTail(this.options.storeRoot)
      this.log('error', 'backend keeps stopping; giving up until the user restarts it', { why, crashes: this.crashes.length, tail: tail.slice(-10) })
      this.update({ phase: 'stopped', error: why, tail })
      return
    }
    this.log('warn', 'backend stopped unexpectedly; restarting it', { why, attempt: this.crashes.length })
    // 重拉那条链挂在 `starting` 上:`stop()` 先等它收场(它看见 `intentional` 就停手、刚拉起的那只由 `stopOnce` 收),
    // 而不是让它在退出途中跑完、再生一只没人管的子进程。
    if (this.starting) return
    this.starting = this.launch('restarting').finally(() => { this.starting = undefined })
  }

  private async stopOnce(): Promise<void> {
    this.intentional = true
    this.clearAdoptedTimer()
    // 正在起的那一趟:让它看见 `intentional` 自己收场(它会停掉自己拉起的那只)。
    if (this.starting) await this.starting.catch(() => undefined)
    if (!this.ownsBackend) {
      this.record = undefined
      this.update({ phase: 'idle' })
      return
    }
    this.update({ ...this.snapshot, phase: 'stopping' })
    const child = this.child
    const pid = child?.pid ?? this.record?.pid
    if (child) {
      const exited = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>(resolve => { child.once('exit', () => resolve()) })
      await this.terminate(child, exited)
    } else if (pid !== undefined) {
      await this.terminatePid(pid)
    }
    if (pid !== undefined) removeDiscoveryOf(this.options.storeRoot, pid)
    this.child = undefined
    this.record = undefined
    this.update({ phase: 'idle' })
  }

  /** SIGTERM 一次 → 等 → SIGKILL。 */
  private async terminate(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    try { child.kill('SIGTERM') } catch { /* 已经没了 */ }
    const grace = this.options.stopGraceMs ?? 7000
    const done = await Promise.race([exited.then(() => true), delay(grace).then(() => false)])
    if (done) return
    this.log('error', 'backend did not exit after SIGTERM; killing it', { pid: child.pid, graceMs: grace })
    try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
    await Promise.race([exited, delay(1000)])
  }

  /** 借来的那台没有句柄:按 pid 发信号、轮询它退了没有。 */
  private async terminatePid(pid: number): Promise<void> {
    if (!pidAlive(pid)) return
    try { process.kill(pid, 'SIGTERM') } catch { return }
    const grace = this.options.stopGraceMs ?? 7000
    const deadline = this.now() + grace
    while (this.now() < deadline) {
      if (!pidAlive(pid)) return
      await delay(100)
    }
    this.log('error', 'backend did not exit after SIGTERM; killing it', { pid, graceMs: grace })
    try { process.kill(pid, 'SIGKILL') } catch { /* 已经没了 */ }
  }

  private update(next: BackendProcessSnapshot): void {
    this.snapshot = next
    try {
      this.options.onChange?.(next)
    } catch (error) {
      this.log('warn', 'backend state listener failed', undefined, error)
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>, error?: unknown): void {
    try {
      if (level === 'info') this.options.log.info(msg, fields)
      else this.options.log[level](msg, fields, error)
    } catch { /* 日志坏了不该拦住进程监督 */ }
  }
}

function connectionOf(record: { host: string; port: number; token?: string }): BackendConnection {
  return { baseUrl: `http://${record.host}:${record.port}`, ...(record.token ? { token: record.token } : {}) }
}
