import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const token = 'isolated-host-lifecycle-test'
const execute = promisify(execFile)
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error }
interface Host { process: ChildProcess; done: Promise<Exit>; exit?: Exit; output: string }
interface Discovery { pid: number; port: number; host: string }
const hosts: Host[] = []
const directories: string[] = []

beforeAll(async () => {
  // Always build the actual entries from this checkout. A stale/missing bundle
  // must not turn a source regression into a skipped or falsely green test.
  // 第④步批 3:CLI 不再有守护进程,CLI 拉起的就是同一只后端进程的 `cli` 档,所以只构建 server 那份产物。
  for (const script of ['scripts/build-server.mjs']) {
    await execute(process.execPath, [script], { cwd: root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
  }
}, 180_000)

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    if (!host.exit) host.process.kill('SIGTERM')
    const exited = await Promise.race([host.done.then(() => true), delay(6_000).then(() => false)])
    if (!exited) { host.process.kill('SIGKILL'); await host.done }
  }
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
}, 30_000)

async function newStore(): Promise<string> {
  // macOS's usual TMPDIR can exceed sockaddr_un's path limit.
  const parent = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'oth-host-'))
  directories.push(parent)
  const store = path.join(parent, 'store')
  await fs.mkdir(path.join(store, 'workspace'), { recursive: true })
  return store
}

/** `cli` = CLI 拉起的那一档(`ONETHING_BACKEND_LAUNCHER=cli`,从前的 CLI 守护进程);`server` = `server:start`。 */
function start(kind: 'server' | 'cli', store: string): Host {
  const child = spawn(process.execPath, ['dist/server/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...(kind === 'cli' ? { ONETHING_BACKEND_LAUNCHER: 'cli' } : {}),
      ONETHING_STORE_PATH: store,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_PORT: '0',
      ONETHING_SERVER_TOKEN: token,
      ONETHING_SERVER_WORKSPACE_ROOT: path.join(store, 'workspace'),
      ONETHING_SERVER_DATA_ROOT: path.join(store, 'server-data'),
      ONETHING_SERVER_SETTINGS_ROOT: path.join(store, 'server-settings'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let resolve!: (exit: Exit) => void
  const host: Host = { process: child, done: new Promise(done => { resolve = done }), output: '' }
  child.stdout!.on('data', chunk => { host.output = (host.output + String(chunk)).slice(-32_000) })
  child.stderr!.on('data', chunk => { host.output = (host.output + String(chunk)).slice(-32_000) })
  child.once('error', error => { host.exit = { code: null, signal: null, error }; resolve(host.exit) })
  child.once('exit', (code, signal) => { host.exit = { code, signal }; resolve(host.exit) })
  hosts.push(host)
  return host
}

async function waitFor<T>(host: Host, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (host.exit) throw new Error(`Host exited before ready: ${JSON.stringify(host.exit)}\n${host.output}`)
    const value = await read()
    if (value !== undefined) return value
    await delay(25)
  }
  throw new Error(`Host did not become ready\n${host.output}`)
}

async function discovery(host: Host, store: string): Promise<Discovery> {
  return waitFor(host, async () => {
    try {
      const value = JSON.parse(await fs.readFile(path.join(store, 'run/http.json'), 'utf8')) as Discovery
      return value.pid === host.process.pid ? value : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  })
}

async function stop(host: Host): Promise<void> {
  host.process.kill('SIGTERM')
  const result = await Promise.race([
    host.done,
    delay(10_000).then(() => { throw new Error(`Host shutdown timed out\n${host.output}`) }),
  ])
  expect(result, host.output).toEqual({ code: 0, signal: null })
}

async function request(info: Discovery, route: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${info.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  })
}

async function assertSaved(store: string, sessionId: string): Promise<void> {
  const records = (await fs.readFile(path.join(store, 'sessions', sessionId, 'events.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line))
  expect(records.some(record => record.type === 'session/created'), JSON.stringify(records)).toBe(true)
  const index = JSON.parse(await fs.readFile(path.join(store, 'sessions/index.json'), 'utf8')) as { id: string }[]
  expect(index.some(meta => meta.id === sessionId)).toBe(true)
}

describe('actual host store ownership', () => {
  // 2026-08-24 ruling: only the CLI daemon takes a mutex. Every other host is
  // kept single-writer by `<store>/run/http.json` — it steps aside for a live
  // foreign core instead of racing for a lock file a crash would leave behind.
  it('defers to a live foreign core without replacing its discovery', async () => {
    const store = await newStore()
    const first = start('server', store)
    const info = await discovery(first, store)
    const record = path.join(store, 'run/http.json')
    // Same pid and port, so the liveness probe still passes: this is a desktop
    // core serving the store, which is exactly what `server:start` must refuse.
    await fs.writeFile(record, JSON.stringify({ ...info, owner: 'shell' }))
    const before = await fs.readFile(record, 'utf8')
    const second = start('server', store)
    expect((await second.done).code, second.output).not.toBe(0)
    expect(second.output).toContain('connect to it instead')
    expect(await fs.readFile(record, 'utf8')).toBe(before)
    expect(first.exit).toBeUndefined()
  }, 45_000)

  // 第④步批 3:从前这里证「每个 store 只选出一台 CLI 守护进程(连别名一起)」,靠的是守护进程那把锁;守护进程退役后
  // CLI 拉起的是 `cli` 档后端,单写者靠发现文件让位(D6),别名指到同一个 store 的第二台照样让位。
  it.skipIf(process.platform === 'win32')('a CLI-launched backend makes a second one on an alias of the same store defer', async () => {
    const store = await newStore()
    const first = start('cli', store)
    const info = await discovery(first, store)
    const alias = path.join(path.dirname(store), 'alias')
    await fs.symlink(store, alias, 'dir')
    const competitor = start('cli', alias)
    expect((await competitor.done).code, competitor.output).not.toBe(0)
    expect(first.exit).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(store, 'run/http.json'), 'utf8'))).toMatchObject({ pid: info.pid, owner: 'backend', launcher: 'cli' })
  }, 45_000)

  it('allows independent stores to serve concurrently', async () => {
    const stores = await Promise.all([newStore(), newStore()])
    const children = stores.map(store => start('server', store))
    const endpoints = await Promise.all(children.map((child, i) => discovery(child, stores[i])))
    expect(endpoints[0].pid).not.toBe(endpoints[1].pid)
    for (const endpoint of endpoints) expect((await request(endpoint, '/api/sessions')).status).toBe(200)
  }, 45_000)
})

describe.skipIf(process.platform === 'win32')('actual POSIX host signals', () => {
  it('ends active SSE and saves a newly accepted session before releasing the store', async () => {
    const store = await newStore()
    const host = start('server', store)
    const info = await discovery(host, store)
    const events = await request(info, '/api/events')
    expect(events.status).toBe(200)
    const streamEnded = events.text()
    const response = await request(info, '/api/sessions', { name: 'Saved at signal exit' })
    expect(response.status).toBe(200)
    const { session } = await response.json() as { session: { id: string } }
    await stop(host)
    await streamEnded
    await assertSaved(store, session.id)
    await expect(fs.stat(path.join(store, 'run/http.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(store, 'run/backend.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 40_000)

  // 第④步批 3:从前证的是守护进程收到 SIGTERM 时落盘并删掉 socket / pid / 锁;今天 CLI 拉起的那台是 `cli` 档后端,
  // 证同一件事:会话落盘、发现文件删掉、不留锁,然后另一台后端接得上这个 store。
  it('saves state from a CLI-launched backend and removes its discovery before a Server takes over the same store', async () => {
    const store = await newStore()
    const cli = start('cli', store)
    const info = await discovery(cli, store)
    const response = await request(info, '/api/sessions', { name: 'Saved by CLI' })
    expect(response.status).toBe(200)
    const { session } = await response.json() as { session: { id: string } }
    await stop(cli)
    await assertSaved(store, session.id)
    for (const name of ['http.json', 'backend.lock']) {
      await expect(fs.stat(path.join(store, 'run', name))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const successor = start('server', store)
    const endpoint = await discovery(successor, store)
    const listed = await request(endpoint, '/api/sessions')
    expect(await listed.text()).toContain(session.id)
  }, 45_000)
})
