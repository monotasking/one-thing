/**
 * `backend-process.ts` 的单元用例(第④步批 2b,决策 D1 / D6 / D11)。
 *
 * 那只类零 electron import,`spawn` 与 `now` 都能注入:这里递一只**假的** `spawn`(不起任何进程,只在临时 store
 * 里写一份发现文件、指向测试自己开的一个回环端口),于是「拉起 → 活了 → 崩了重拉 → 三次封顶 → 停 / 留」整段状态机
 * 都量得到,一个真后端都不用起。真拉起真 `backend.cjs` 的那一半在 `gate:backend-process`(`ELECTRON_RUN_AS_NODE`)。
 *
 * 唯一起的真进程是「借来的那台」用例里一只 `node -e` 的空转子进程(测试自己起、自己收)。
 */
import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BackendProcess, backendStdioPath, type BackendProcessOptions, type BackendProcessSnapshot } from '../backend-process.js'
import { discoveryPath, readDiscovery } from '../discovery.js'

let server: net.Server
let port = 0
let store: string

beforeAll(async () => {
  server = net.createServer(socket => socket.destroy())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as net.AddressInfo).port
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
beforeEach(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-backend-process-')) })
afterEach(() => { fs.rmSync(store, { recursive: true, force: true }) })

function writeDiscovery(record: { pid: number; port: number; token?: string; owner?: string }): void {
  fs.mkdirSync(path.dirname(discoveryPath(store)), { recursive: true })
  fs.writeFileSync(discoveryPath(store), JSON.stringify({ host: '127.0.0.1', startedAt: 1, owner: 'backend', ...record }))
}

/** 一只假的子进程:pid 借测试进程自己的(所以「pid 还在」恒真),信号只记账。 */
class FakeChild extends EventEmitter {
  readonly pid = process.pid
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: string[] = []
  unrefed = false
  /** 收到 SIGTERM 就退(缺省);设成 false 模拟一台卡住的后端。 */
  exitsOnTerm = true
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGKILL' || this.exitsOnTerm) this.exit(null, signal)
    return true
  }
  unref(): void { this.unrefed = true }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', code, signal))
  }
}

interface Harness {
  children: FakeChild[]
  envs: NodeJS.ProcessEnv[]
  options: SpawnOptions[]
  states: BackendProcessSnapshot[]
  /** 下一只子进程起来之后写不写发现文件(false = 起不来)。 */
  ready: boolean[]
  clock: { now: number }
  make(extra?: Partial<BackendProcessOptions>): BackendProcess
}

function harness(): Harness {
  const h: Harness = {
    children: [],
    envs: [],
    options: [],
    states: [],
    ready: [],
    clock: { now: 0 },
    make(extra = {}) {
      return new BackendProcess({
        execPath: '/fake/electron',
        entry: '/fake/backend.cjs',
        storeRoot: store,
        env: { PATH: '/usr/bin', ONETHING_RESOURCES_PATH: '/should/be/dropped' },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        onChange: state => { h.states.push(state) },
        pollMs: 1,
        stopGraceMs: 30,
        adoptedPollMs: 20,
        now: () => h.clock.now,
        spawn: ((_command: string, _args: readonly string[], options: SpawnOptions) => {
          const child = new FakeChild()
          h.children.push(child)
          h.envs.push(options.env ?? {})
          h.options.push(options)
          const fd = (options.stdio as unknown[])[1] as number
          fs.writeSync(fd, `boot line ${h.children.length}\n`)
          const ready = h.ready.shift() ?? true
          if (ready) {
            const pinned = options.env?.ONETHING_SERVER_PORT
            writeDiscovery({ pid: child.pid, port: pinned ? Number(pinned) : port, token: options.env?.ONETHING_SERVER_TOKEN })
          } else {
            child.exit(1)
          }
          return child as unknown as ChildProcess
        }) as BackendProcessOptions['spawn'],
        ...extra,
      })
    },
  }
  return h
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('BackendProcess', () => {
  it('拉起:桌面档的环境、detached、stdio 落文件;活了交出地址与这一程的 token', async () => {
    const h = harness()
    const backend = h.make({ token: 'tok-1' })
    const result = await backend.start()
    expect(result).toEqual({ ok: true, adopted: false, connection: { baseUrl: `http://127.0.0.1:${port}`, token: 'tok-1' } })
    const env = h.envs[0]!
    expect(env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      ONETHING_BACKEND_LAUNCHER: 'desktop',
      ONETHING_STORE_PATH: store,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_TERMINAL: '1',
      ONETHING_SERVER_TOKEN: 'tok-1',
      PATH: '/usr/bin',
    })
    // dev 下(没给 resourcesPath)继承来的那一格也要摘掉,不然后端去错的地方找内建 skills。
    expect(env.ONETHING_RESOURCES_PATH).toBeUndefined()
    expect(env.ONETHING_SERVER_PORT).toBeUndefined()
    expect(h.options[0]!.detached).toBe(true)
    expect(h.children[0]!.unrefed).toBe(true)
    expect(fs.readFileSync(backendStdioPath(store), 'utf-8')).toContain('boot line 1')
    expect(backend.state).toMatchObject({ phase: 'running', port, launchedHere: true, owner: 'backend' })
    expect(backend.ownsBackend).toBe(true)
    await backend.stop()
  })

  it('打包态递 resourcesPath', async () => {
    const h = harness()
    const backend = h.make({ resourcesPath: '/Applications/onething.app/Contents/Resources' })
    await backend.start()
    expect(h.envs[0]!.ONETHING_RESOURCES_PATH).toBe('/Applications/onething.app/Contents/Resources')
    await backend.stop()
  })

  it('崩了:删掉自己那份发现文件、重拉,端口钉住、token 不变', async () => {
    const h = harness()
    const backend = h.make({ token: 'tok-2' })
    await backend.start()
    h.children[0]!.exit(1)
    await until(() => h.children.length === 2 && backend.state.phase === 'running')
    expect(h.envs[1]!.ONETHING_SERVER_PORT).toBe(String(port))
    expect(h.envs[1]!.ONETHING_SERVER_TOKEN).toBe('tok-2')
    expect(h.states.map(state => state.phase)).toContain('restarting')
    await backend.stop()
  })

  it('60 秒内第四次崩:不再重拉,亮 stopped 并带上 stdio 的尾巴;「重启」清额度再拉', async () => {
    const h = harness()
    const backend = h.make()
    await backend.start()
    for (let crash = 1; crash <= 3; crash += 1) {
      h.clock.now += 1000
      h.children.at(-1)!.exit(1)
      await until(() => h.children.length === crash + 1 && backend.state.phase === 'running')
    }
    h.clock.now += 1000
    h.children.at(-1)!.exit(1)
    await until(() => backend.state.phase === 'stopped')
    expect(h.children).toHaveLength(4)
    expect(backend.state.error).toContain('exited')
    expect(backend.state.tail?.join('\n')).toContain('boot line 4')
    const again = await backend.restart()
    expect(again.ok).toBe(true)
    expect(h.children).toHaveLength(5)
    await backend.stop()
  })

  it('窗口外的崩溃不占额度(60 秒前的那几次过期了)', async () => {
    const h = harness()
    const backend = h.make()
    await backend.start()
    for (let crash = 1; crash <= 5; crash += 1) {
      h.clock.now += 61_000
      h.children.at(-1)!.exit(1)
      await until(() => h.children.length === crash + 1 && backend.state.phase === 'running')
    }
    await backend.stop()
  })

  it('起不来(先退出):额度内连试,额度用完答 ok:false 并带尾巴', async () => {
    const h = harness()
    h.ready.push(false, false, false, false)
    const backend = h.make()
    const result = await backend.start()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('exited before it was ready')
    expect(result.tail.join('\n')).toContain('boot line 4')
    expect(h.children).toHaveLength(4)
    expect(backend.state.phase).toBe('stopped')
  })

  it('stop:SIGTERM 一次,卡住就在宽限期后 SIGKILL;发现文件删掉', async () => {
    const h = harness()
    const backend = h.make()
    await backend.start()
    h.children[0]!.exitsOnTerm = false
    await backend.stop()
    expect(h.children[0]!.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(readDiscovery(store)).toBeUndefined()
    expect(backend.state.phase).toBe('idle')
    // 收尾之后子进程的退出不算崩溃:不重拉。
    expect(h.children).toHaveLength(1)
  })

  it('leave(「退出后继续运行」):不发信号、发现文件留着', async () => {
    const h = harness()
    const backend = h.make()
    await backend.start()
    backend.leave()
    expect(h.children[0]!.signals).toEqual([])
    expect(readDiscovery(store)?.pid).toBe(process.pid)
    h.children[0]!.exit(0)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.children).toHaveLength(1)
  })

  it('起到一半退出:正在起的那一趟收场,刚拉起的子进程被 SIGTERM', async () => {
    const h = harness()
    // 子进程起来了但一直不写发现文件(装配慢):让它不退也不就绪。
    const backend = h.make({
      spawn: ((_c: string, _a: readonly string[], options: SpawnOptions) => {
        const child = new FakeChild()
        h.children.push(child)
        h.options.push(options)
        return child as unknown as ChildProcess
      }) as BackendProcessOptions['spawn'],
    })
    const starting = backend.start()
    await until(() => h.children.length === 1)
    await backend.stop()
    const result = await starting
    expect(result.ok).toBe(false)
    expect(h.children[0]!.signals).toEqual(['SIGTERM'])
  })

  it('崩溃重拉进行中 Quit:stop 等那条链收场,不再生新的子进程,已拉起的都收到信号或已退出', async () => {
    const h = harness()
    const backend = h.make()
    await backend.start()
    // 重拉那一只起不来(先退出),额度内会再试 —— 就在这一段里 Quit。
    h.ready.push(false, false, false)
    h.children[0]!.exit(1)
    await until(() => h.children.length >= 2)
    await backend.stop()
    const settled = h.children.length
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.children.length).toBe(settled)
    for (const child of h.children) {
      expect(child.exitCode !== null || child.signalCode !== null || child.signals.includes('SIGTERM')).toBe(true)
    }
    expect(backend.state.phase).toBe('idle')
  })

  it('崩溃重拉进行中 Quit,而重拉那一只还没就绪(装配慢):它被 SIGTERM,不留孤儿', async () => {
    const h = harness()
    let slow = false
    const backend = h.make({
      spawn: ((_c: string, _a: readonly string[], options: SpawnOptions) => {
        const child = new FakeChild()
        h.children.push(child)
        h.envs.push(options.env ?? {})
        if (!slow) writeDiscovery({ pid: child.pid, port, token: options.env?.ONETHING_SERVER_TOKEN })
        return child as unknown as ChildProcess
      }) as BackendProcessOptions['spawn'],
    })
    await backend.start()
    slow = true
    h.children[0]!.exit(1)
    await until(() => h.children.length === 2)
    await backend.stop()
    expect(h.children[1]!.signals).toEqual(['SIGTERM'])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.children).toHaveLength(2)
  })

  it('先借后拉:发现文件里有活着的就连它,不拉第二台;别人的 server:start 不许重启也不停', async () => {
    const h = harness()
    writeDiscovery({ pid: process.pid, port, token: 'theirs', owner: 'server' })
    const backend = h.make()
    const result = await backend.start()
    expect(result).toMatchObject({ ok: true, adopted: true, connection: { token: 'theirs' } })
    expect(h.children).toHaveLength(0)
    expect(backend.ownsBackend).toBe(false)
    const restarted = await backend.restart()
    expect(restarted.ok).toBe(false)
    await backend.stop()
    // 别人的那台原样留着(发现文件也没删)。
    expect(readDiscovery(store)?.owner).toBe('server')
  })

  it('借来的那台死了:删它的文件,自己拉一台,沿用它的 token', async () => {
    const sleeper = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise(resolve => sleeper.once('spawn', resolve))
      const h = harness()
      writeDiscovery({ pid: sleeper.pid!, port, token: 'left-running', owner: 'backend' })
      const backend = h.make()
      const result = await backend.start()
      expect(result).toMatchObject({ ok: true, adopted: true })
      expect(backend.ownsBackend).toBe(true)
      sleeper.kill('SIGKILL')
      await until(() => h.children.length === 1 && backend.state.phase === 'running')
      expect(h.envs[0]!.ONETHING_SERVER_TOKEN).toBe('left-running')
      expect(h.envs[0]!.ONETHING_SERVER_PORT).toBe(String(port))
      await backend.stop()
    } finally {
      if (sleeper.exitCode === null && sleeper.signalCode === null) sleeper.kill('SIGKILL')
    }
  })

  it('死人的发现文件:先删掉再拉', async () => {
    const h = harness()
    writeDiscovery({ pid: 2 ** 22 + 12345, port })
    const backend = h.make()
    const result = await backend.start()
    expect(result).toMatchObject({ ok: true, adopted: false })
    await backend.stop()
  })
})
