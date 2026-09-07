import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
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
  for (const script of ['scripts/build-server.mjs', 'scripts/build-cli.mjs']) {
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

function start(kind: 'server' | 'cli', store: string): Host {
  const args = kind === 'server'
    ? ['dist/server/main.js']
    : ['dist/cli/main.cjs', '--daemon-child', '--store-path', store]
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
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

async function cliRequest(store: string, method: string, params?: unknown): Promise<unknown> {
  const socket = net.createConnection(path.join(store, 'run/daemon.sock'))
  return new Promise((resolve, reject) => {
    let buffered = ''
    socket.setTimeout(8_000, () => socket.destroy(new Error('CLI request timed out')))
    socket.on('error', reject)
    socket.once('connect', () => socket.write(JSON.stringify({ id: 'host-test', method, params }) + '\n'))
    socket.on('data', chunk => {
      buffered += String(chunk)
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1)
        if (frame.id !== 'host-test') continue
        if (frame.type === 'error') { socket.destroy(); reject(new Error(JSON.stringify(frame.error))); return }
        if (frame.type === 'result') { socket.end(); resolve(frame.data); return }
      }
    })
  })
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

  it.skipIf(process.platform === 'win32')('elects one CLI daemon per store, aliases included', async () => {
    const store = await newStore()
    const daemon = start('cli', store)
    await waitFor(daemon, async () => {
      try { return (await fs.stat(path.join(store, 'run/daemon.sock'))).isSocket() ? true : undefined }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    })
    const alias = path.join(path.dirname(store), 'alias')
    await fs.symlink(store, alias, 'dir')
    const competitor = start('cli', alias)
    expect((await competitor.done).code, competitor.output).not.toBe(0)
    expect(daemon.exit).toBeUndefined()
    expect((await fs.readdir(path.join(store, 'run'))).some(name => name.startsWith('lock-recovery-'))).toBe(false)
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

  it('saves CLI state and removes its socket/PID before a Server takes over the same store', async () => {
    const store = await newStore()
    const daemon = start('cli', store)
    await waitFor(daemon, async () => {
      try { return (await fs.stat(path.join(store, 'run/daemon.sock'))).isSocket() ? true : undefined }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    })
    const session = await cliRequest(store, 'session.new', { name: 'Saved by CLI' }) as { id: string }
    await stop(daemon)
    await assertSaved(store, session.id)
    for (const name of ['daemon.sock', 'daemon.pid', 'backend.lock']) {
      await expect(fs.stat(path.join(store, 'run', name))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const successor = start('server', store)
    const endpoint = await discovery(successor, store)
    const listed = await request(endpoint, '/api/sessions')
    expect(await listed.text()).toContain(session.id)
  }, 45_000)
})
