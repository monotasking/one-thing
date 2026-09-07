import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { inspectStoreLock } from '@onething/runtime/storage/store-lock'
import { createDesktopShutdownRequest } from '../shutdown.js'

let fixtureDirectory: string
let fixturePath: string
const directories: string[] = []
const children: Array<{ child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> = []

beforeAll(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-shutdown-fixture-'))
  fixturePath = path.join(fixtureDirectory, 'child.cjs')
  buildSync({
    entryPoints: [fileURLToPath(new URL('./fixtures/shutdown-child.ts', import.meta.url))],
    outfile: fixturePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  })
})

afterEach(async () => {
  await Promise.all(children.splice(0).map(async ({ child, closed }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await withDeadline(closed, 'owned child close')
  }))
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})
afterAll(() => { fs.rmSync(fixtureDirectory, { recursive: true, force: true }) })

function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 8_000) }),
  ]).finally(() => clearTimeout(timer))
}

type Message = { event: string; held?: boolean; cleanupCalls?: number; sameRequest?: boolean; signals?: string[] }
function message(child: ChildProcess, event: string): Promise<Message> {
  let onMessage!: (value: Message) => void
  let onClose!: (code: number | null) => void
  const result = new Promise<Message>((resolve, reject) => {
    onMessage = value => { if (value.event === event) resolve(value) }
    onClose = code => reject(new Error(`Child closed before ${event}: ${code}`))
    child.on('message', onMessage)
    child.once('close', onClose)
  })
  return withDeadline(result, event).finally(() => { child.off('message', onMessage); child.off('close', onClose) })
}

async function start(mode = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-shutdown-store-'))
  directories.push(directory)
  const child = fork(fixturePath, [directory, mode], {
    execArgv: [], cwd: directory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, ONETHING_STORE_PATH: directory },
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  children.push({ child, closed })
  let stderr = ''
  child.stdout?.resume()
  child.stderr?.on('data', value => { stderr += String(value) })
  await message(child, 'ready')
  return { directory, child, closed, stderr: () => stderr }
}

it('registers one shutdown before reentrant window/signal requests and exits only after its barrier', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const exit = vi.fn()
  const failure = vi.fn()
  let reentrant: Promise<void> | undefined
  const shutdown = vi.fn(() => { reentrant = request('SIGTERM'); return pending })
  const request = createDesktopShutdownRequest({ shutdown, exit, onFailure: failure })
  const first = request('window closed')
  expect(request('SIGINT')).toBe(first)
  await Promise.resolve()
  expect(reentrant).toBe(first)
  expect(exit).not.toHaveBeenCalled()
  release()
  await first
  expect(shutdown).toHaveBeenCalledExactlyOnceWith('window closed')
  expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(failure).not.toHaveBeenCalled()
  expect(request('SIGTERM')).toBe(first)
})

it('preserves the real cleanup failure despite a failing logger and repeated requests', async () => {
  const error = new Error('save failed')
  const exit = vi.fn()
  const onFailure = vi.fn(() => { throw new Error('logger failed') })
  const request = createDesktopShutdownRequest({ shutdown: () => { throw error }, exit, onFailure })
  const first = request('SIGTERM')
  expect(request('window closed')).toBe(first)
  await expect(first).rejects.toBe(error)
  expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(onFailure).toHaveBeenCalledExactlyOnceWith('SIGTERM', error)
  await expect(request('SIGINT')).rejects.toBe(error)
  expect(exit).toHaveBeenCalledOnce()
})

it.skipIf(process.platform === 'win32')('keeps a real lease through duplicate signals beyond 1.2 seconds, then saves and closes cleanly', async () => {
  const { child, directory, closed } = await start()
  const started = message(child, 'cleanup-started')
  child.kill('SIGTERM')
  await started
  const duplicate = message(child, 'signal')
  child.kill('SIGINT')
  await duplicate
  // Deliberately cross the old launcher's 1.2s escalation point. The IPC barrier,
  // rather than elapsed time, determines when the real pending save can finish.
  await new Promise(resolve => setTimeout(resolve, 1_400))
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBeNull()
  expect(inspectStoreLock({ storePath: directory })).toMatchObject({ status: 'held', holder: { pid: child.pid } })
  const later = message(child, 'signal')
  child.kill('SIGTERM')
  await later
  const status = message(child, 'status')
  child.send('status')
  expect(await status).toMatchObject({ held: true, cleanupCalls: 1, sameRequest: true, signals: ['SIGTERM', 'SIGINT', 'SIGTERM'] })
  child.send('release')
  expect(await withDeadline(closed, 'successful close')).toEqual({ code: 0, signal: null })
  expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(fs.readFileSync(path.join(directory, 'saved.txt'), 'utf8')).toBe('saved before lease release')
  expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'exit.json'), 'utf8'))).toMatchObject({
    code: 0, cleanupCalls: 1, sameRequest: true, held: false,
  })
}, 12_000)

it.skipIf(process.platform === 'win32')('reports a failed real save and still hands the store back after the child actually closes', async () => {
  const { child, directory, closed, stderr } = await start('fail')
  const started = message(child, 'cleanup-started')
  child.kill('SIGTERM')
  await started
  const duplicate = message(child, 'signal')
  child.kill('SIGINT')
  await duplicate
  child.send('release')
  expect(await withDeadline(closed, 'failed close')).toEqual({ code: 1, signal: null })
  expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect(stderr()).toContain('shutdown failed; store lease released anyway')
  // The failure is reported, but a lock left behind by an exiting process only
  // locks the next launch out; the save that failed is honestly still missing.
  expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
  expect(fs.existsSync(path.join(directory, 'saved.txt'))).toBe(false)
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'exit.json'), 'utf8'))).toMatchObject({
    code: 1, cleanupCalls: 1, sameRequest: true, held: false,
  })
})
