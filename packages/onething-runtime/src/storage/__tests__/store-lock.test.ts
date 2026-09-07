import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  LockConflictError,
  StoreLock,
  StoreLockInitializationError,
  StoreLockOwnershipError,
  StoreLockRecoveryError,
  UnlockedStoreLease,
  canonicalizeStorePath,
  createStoreLease,
  formatCliLockConflict,
  inspectStoreLock,
  quarantineStoreLockForRecovery,
  readLockMeta,
} from '../store-lock.js'

const tempDirs: string[] = []
const children: ChildProcess[] = []
let fixtureDir: string
let fixturePath: string

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-lock-fixture-'))
  fixturePath = path.join(fixtureDir, 'store-lock-child.cjs')
  buildSync({
    entryPoints: [fileURLToPath(new URL('./fixtures/store-lock-child.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', outfile: fixturePath, logLevel: 'silent',
  })
})

afterAll(() => { fs.rmSync(fixtureDir, { recursive: true, force: true }) })

function makeStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-store-lock-'))
  tempDirs.push(dir)
  return dir
}

/** What a crash reclaim left behind: the bytes of every `lock-recovery-*` entry. */
function quarantinedEntries(lockPath: string): string[] {
  const runDir = path.dirname(lockPath)
  const name = path.basename(lockPath)
  return fs.readdirSync(runDir).filter(entry => entry.startsWith('lock-recovery-')).sort().map(entry => {
    const moved = path.join(runDir, entry, name)
    return fs.statSync(moved).isDirectory()
      ? fs.readFileSync(path.join(moved, 'owner.json'), 'utf8')
      : fs.readFileSync(moved, 'utf8')
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }))
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

type ChildMessage = { type: string; pid?: number; message?: string }

function nextMessage(child: ChildProcess, accepted: string[]): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not report ${accepted.join('/')}`)) }, 5_000)
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit) }
    const onMessage = (message: ChildMessage) => {
      if (message.type === 'error') { cleanup(); reject(new Error(message.message)) }
      else if (accepted.includes(message.type)) { cleanup(); resolve(message) }
    }
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Child exited early: ${code}`)) }
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}

async function startChild(storePath: string, mode = ''): Promise<ChildProcess> {
  const child = fork(fixturePath, [storePath, mode], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [] })
  children.push(child)
  await nextMessage(child, ['ready'])
  return child
}

async function acquireChild(child: ChildProcess): Promise<ChildMessage> {
  const result = nextMessage(child, ['acquired', 'conflict'])
  child.send('acquire')
  return result
}

async function crashChild(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

describe('onething store lock runtime', () => {
  it('acquires and releases a lock with metadata', async () => {
    const storePath = makeStore()
    const lock = new StoreLock({ storePath, version: 'test' })

    await lock.acquire('daemon')

    const meta = readLockMeta(lock.lockPath)
    expect(meta).toMatchObject({ pid: process.pid, owner: 'daemon', version: 'test', protocolVersion: 1 })
    expect(meta?.nonce).toEqual(expect.any(String))
    expect(meta?.startedAt).toBeGreaterThan(0)
    expect(meta?.storePath).toBe(fs.realpathSync(storePath))
    expect(lock.held).toBe(true)
    expect(() => lock.assertHeld()).not.toThrow()
    expect(fs.statSync(lock.lockPath).isDirectory()).toBe(true)

    lock.release()
    lock.release()
    expect(lock.held).toBe(false)
    expect(fs.existsSync(lock.lockPath)).toBe(false)
  })

  it('reports a live lock conflict', async () => {
    const storePath = makeStore()
    const first = new StoreLock({ storePath })
    const second = new StoreLock({ storePath })
    await first.acquire('desktop')

    await expect(second.acquire('daemon')).rejects.toBeInstanceOf(LockConflictError)

    try {
      await second.acquire('daemon')
    } catch (error) {
      expect(formatCliLockConflict((error as LockConflictError).holder, storePath))
        .toContain('desktop app is currently using')
    } finally {
      first.release()
    }
  })

  it('reclaims a legacy file whose recorded PID has exited, keeping it aside as evidence', async () => {
    const storePath = makeStore()
    const lock = new StoreLock({ storePath })
    fs.mkdirSync(path.dirname(lock.lockPath), { recursive: true })
    const abandoned = JSON.stringify({
      pid: 99999999,
      owner: 'daemon',
      acquiredAt: Date.now(),
      version: 'old',
    })
    fs.writeFileSync(lock.lockPath, abandoned)

    await lock.acquire('desktop')

    expect(readLockMeta(lock.lockPath)).toMatchObject({ pid: process.pid, owner: 'desktop' })
    expect(fs.statSync(lock.lockPath).isDirectory()).toBe(true)
    expect(quarantinedEntries(lock.lockPath)).toEqual([abandoned])
    lock.release()
  })

  it.each(['', '{invalid', 'null', '{"pid":-1,"owner":"daemon"}'])(
    'fails closed for empty or corrupt legacy metadata: %s', async (raw) => {
      const storePath = makeStore()
      const lock = new StoreLock({ storePath })
      fs.mkdirSync(path.dirname(lock.lockPath), { recursive: true })
      fs.writeFileSync(lock.lockPath, raw)
      await expect(lock.acquire('server')).rejects.toBeInstanceOf(LockConflictError)
      expect(fs.readFileSync(lock.lockPath, 'utf8')).toBe(raw)
    },
  )

  it('keeps incomplete metadata on initialization failure and refuses further writers', async () => {
    const storePath = makeStore()
    const first = new StoreLock({ storePath })
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    })
    await expect(first.acquire('server')).rejects.toBeInstanceOf(StoreLockInitializationError)
    write.mockRestore()
    first.release()
    expect(inspectStoreLock({ storePath }).status).toBe('initializing')
    await expect(new StoreLock({ storePath }).acquire('server')).rejects.toBeInstanceOf(LockConflictError)
  })

  it.each([undefined, '', '{broken'])('refuses acquisition and recovery of an uncertain directory: %s', async (raw) => {
    const storePath = makeStore()
    const lock = new StoreLock({ storePath })
    fs.mkdirSync(lock.lockPath, { recursive: true })
    if (raw !== undefined) fs.writeFileSync(path.join(lock.lockPath, 'owner.json'), raw)
    const diagnostic = inspectStoreLock({ storePath })
    await expect(lock.acquire('server')).rejects.toBeInstanceOf(LockConflictError)
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })).toThrow(StoreLockRecoveryError)
    expect(inspectStoreLock({ storePath }).identity).toEqual(diagnostic.identity)
  })

  it('treats a symbolic link at the lock path as occupied, without following or removing it', async () => {
    const storePath = makeStore()
    const lock = new StoreLock({ storePath })
    fs.mkdirSync(path.dirname(lock.lockPath), { recursive: true })
    const target = path.join(storePath, 'external')
    fs.mkdirSync(target)
    fs.symlinkSync(target, lock.lockPath, 'junction')
    await expect(lock.acquire('server')).rejects.toMatchObject({ diagnostic: { status: 'unsupported-entry' } })
    expect(fs.lstatSync(lock.lockPath).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(target)).toEqual([])
  })

  it('normalizes symlinks and missing descendant paths to one physical store', async () => {
    const root = makeStore()
    fs.mkdirSync(path.join(root, 'actual'))
    fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'alias'), 'junction')
    const first = new StoreLock({ storePath: path.join(root, 'actual', 'nested', 'new') })
    const second = new StoreLock({ storePath: path.join(root, 'alias', 'nested', 'new') })
    expect(first.storePath).toBe(second.storePath)
    await first.acquire('server')
    await expect(second.acquire('server')).rejects.toBeInstanceOf(LockConflictError)
    first.release()
  })

  it('does not let a second acquire lose the first lease identity', async () => {
    const lock = new StoreLock({ storePath: makeStore() })
    await lock.acquire('server')
    await expect(lock.acquire('server')).rejects.toThrow('already acquired')
    lock.release()
    expect(fs.existsSync(lock.lockPath)).toBe(false)
  })

  it('never releases another nonce, including the same PID and owner', async () => {
    const storePath = makeStore()
    const first = new StoreLock({ storePath })
    await first.acquire('server')
    const original = readLockMeta(first.lockPath)!
    fs.writeFileSync(path.join(first.lockPath, 'owner.json'), JSON.stringify({ ...original, nonce: 'replacement' }))
    expect(() => first.release()).toThrow(StoreLockOwnershipError)
    expect(readLockMeta(first.lockPath)?.nonce).toBe('replacement')
  })

  it('never releases a replacement directory even if its metadata was copied', async () => {
    const lock = new StoreLock({ storePath: makeStore() })
    await lock.acquire('server')
    const meta = fs.readFileSync(path.join(lock.lockPath, 'owner.json'))
    fs.renameSync(lock.lockPath, `${lock.lockPath}.original`)
    fs.mkdirSync(lock.lockPath)
    fs.writeFileSync(path.join(lock.lockPath, 'owner.json'), meta)
    expect(() => lock.release()).toThrow(StoreLockOwnershipError)
    expect(fs.existsSync(lock.lockPath)).toBe(true)
  })

  it('refuses to remove unknown contents or unsupported protocol metadata', async () => {
    const storePath = makeStore()
    const lock = new StoreLock({ storePath })
    await lock.acquire('daemon')
    fs.writeFileSync(path.join(lock.lockPath, 'unexpected'), 'diagnostic evidence')
    expect(() => lock.release()).toThrow(StoreLockOwnershipError)
    expect(readLockMeta(lock.lockPath)).not.toBeNull()
    const meta = readLockMeta(lock.lockPath)!
    fs.writeFileSync(path.join(lock.lockPath, 'owner.json'), JSON.stringify({ ...meta, protocolVersion: 99 }))
    expect(inspectStoreLock({ storePath }).status).toBe('unsupported-protocol')
    await expect(new StoreLock({ storePath }).acquire('server')).rejects.toBeInstanceOf(LockConflictError)
  })

  it('does not create the store during read-only diagnosis', () => {
    const storePath = path.join(makeStore(), 'missing')
    expect(inspectStoreLock({ storePath }).status).toBe('absent')
    expect(fs.existsSync(storePath)).toBe(false)
    expect(canonicalizeStorePath(storePath)).toBe(path.join(fs.realpathSync(path.dirname(storePath)), 'missing'))
  })

  it.each(['..', '../other', 'sub/lock', 'sub\\lock'])('rejects non-local lock names: %s', (lockFileName) => {
    expect(() => new StoreLock({ storePath: makeStore(), lockFileName })).toThrow('single path component')
  })
})

describe('lease for a host that takes no lock', () => {
  it('answers the lease questions without writing anything', async () => {
    const storePath = makeStore()
    const lease = new UnlockedStoreLease({ storePath })
    await lease.acquire()
    expect([lease.storePath, lease.lockPath, lease.held]).toEqual([fs.realpathSync(storePath), '', true])
    lease.assertHeld()
    lease.release()
    expect(fs.existsSync(path.join(storePath, 'run'))).toBe(false)
  })

  it('picks the mutex only for an owner that asked for one', async () => {
    const storePath = makeStore()
    expect(createStoreLease({ storePath })).toBeInstanceOf(UnlockedStoreLease)
    const owned = createStoreLease({ storePath, owner: 'daemon' })
    expect(owned).toBeInstanceOf(StoreLock)
    await owned.acquire('daemon')
    // An unlocked host never contends for the store an owner is holding.
    expect(new UnlockedStoreLease({ storePath }).held).toBe(true)
    owned.release()
  })
})

describe('store lease across real processes', () => {
  it('elects exactly one simultaneous writer of the same host kind', async () => {
    const storePath = makeStore()
    const contenders = await Promise.all(Array.from({ length: 6 }, () => startChild(storePath)))
    const results = await Promise.all(contenders.map(acquireChild))
    expect(results.filter((r) => r.type === 'acquired')).toHaveLength(1)
    expect(results.filter((r) => r.type === 'conflict')).toHaveLength(5)
    const winner = contenders[results.findIndex((r) => r.type === 'acquired')]
    const released = nextMessage(winner, ['released'])
    winner.send('release')
    await released
    const next = new StoreLock({ storePath })
    await next.acquire('desktop')
    next.release()
  }, 15_000)

  it('cannot steal ownership while the elected process has not written metadata', async () => {
    const storePath = makeStore()
    const first = await startChild(storePath, 'pause-after-election')
    const initializing = nextMessage(first, ['initializing'])
    first.send('acquire')
    await initializing
    const second = await startChild(storePath)
    expect(await acquireChild(second)).toMatchObject({ type: 'conflict' })
    expect(inspectStoreLock({ storePath }).status).toBe('initializing')
    const acquired = nextMessage(first, ['acquired'])
    first.stdin!.write('x')
    await acquired
    expect(inspectStoreLock({ storePath }).holder?.pid).toBe(first.pid)
  })

  it('coordinates aliased paths across processes and permits separate stores', async () => {
    const root = makeStore()
    fs.mkdirSync(path.join(root, 'real'))
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'junction')
    const first = await startChild(path.join(root, 'real'))
    const alias = await startChild(path.join(root, 'alias'))
    const independent = await startChild(path.join(root, 'independent'))
    expect(await acquireChild(first)).toMatchObject({ type: 'acquired' })
    expect(await acquireChild(alias)).toMatchObject({ type: 'conflict' })
    expect(await acquireChild(independent)).toMatchObject({ type: 'acquired' })
  })

  it('reclaims a crashed holder on the next acquire and keeps its evidence aside', async () => {
    const storePath = makeStore()
    const child = await startChild(storePath)
    expect(await acquireChild(child)).toMatchObject({ type: 'acquired' })
    await crashChild(child)
    const diagnostic = inspectStoreLock({ storePath })
    expect(diagnostic.processState).toBe('not-running')
    const before = fs.readFileSync(path.join(diagnostic.lockPath, 'owner.json'), 'utf8')

    // Force-quitting a desktop app is routine: the next launch must open.
    const next = new StoreLock({ storePath })
    await next.acquire('server')

    expect(readLockMeta(next.lockPath)).toMatchObject({ pid: process.pid, owner: 'server' })
    expect(quarantinedEntries(next.lockPath)).toEqual([before])
    next.release()
  })

  it('still refuses a live holder while reclaiming only a provably exited one', async () => {
    const storePath = makeStore()
    const child = await startChild(storePath)
    expect(await acquireChild(child)).toMatchObject({ type: 'acquired' })
    await expect(new StoreLock({ storePath }).acquire('server')).rejects.toBeInstanceOf(LockConflictError)
    expect(quarantinedEntries(inspectStoreLock({ storePath }).lockPath)).toEqual([])
  })

  it('refuses recovery of a still-running or possibly reused PID', async () => {
    const storePath = makeStore()
    const child = await startChild(storePath)
    await acquireChild(child)
    const diagnostic = inspectStoreLock({ storePath })
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })).toThrow('running, reused')
    expect(inspectStoreLock({ storePath }).identity).toEqual(diagnostic.identity)
  })
})

describe('offline store lease recovery refuses uncertain state', () => {
  function legacyStore(): string {
    const storePath = makeStore()
    const lock = new StoreLock({ storePath })
    fs.mkdirSync(path.dirname(lock.lockPath), { recursive: true })
    fs.writeFileSync(lock.lockPath, JSON.stringify({ pid: 99999999, owner: 'daemon', version: 'old' }))
    return storePath
  }

  it('requires explicit shutdown and restart prevention before any mutation', () => {
    const storePath = legacyStore()
    const diagnostic = inspectStoreLock({ storePath })
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true,
    } as Parameters<typeof quarantineStoreLockForRecovery>[0])).toThrow('automatic restarts disabled')
    expect(inspectStoreLock({ storePath }).identity).toEqual(diagnostic.identity)
    expect(fs.readdirSync(path.dirname(diagnostic.lockPath))).toEqual(['backend.lock'])
  })

  it('refuses changed metadata and preserves the current lock', () => {
    const storePath = legacyStore()
    const diagnostic = inspectStoreLock({ storePath })
    fs.writeFileSync(diagnostic.lockPath, JSON.stringify({ pid: 99999999, owner: 'daemon', version: 'changed' }))
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })).toThrow('identity changed')
    expect(readLockMeta(diagnostic.lockPath)?.version).toBe('changed')
  })

  it('never removes unknown corrupt ownership', () => {
    const storePath = legacyStore()
    const lockPath = inspectStoreLock({ storePath }).lockPath
    fs.writeFileSync(lockPath, '{broken')
    const diagnostic = inspectStoreLock({ storePath })
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })).toThrow(StoreLockRecoveryError)
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('{broken')
  })

  it('keeps the original entry if quarantine rename fails', () => {
    const storePath = legacyStore()
    const diagnostic = inspectStoreLock({ storePath })
    const original = fs.readFileSync(diagnostic.lockPath, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename failure') })
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })).toThrow('rename failure')
    expect(fs.readFileSync(diagnostic.lockPath, 'utf8')).toBe(original)
  })

  it('rechecks identity immediately before rename and preserves a changed lock', () => {
    const storePath = legacyStore()
    const diagnostic = inspectStoreLock({ storePath })
    const mkdir = fs.mkdirSync
    vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(((...args: Parameters<typeof fs.mkdirSync>) => {
      const result = Reflect.apply(mkdir, fs, args)
      fs.writeFileSync(diagnostic.lockPath, JSON.stringify({ pid: 99999999, owner: 'daemon', version: 'replaced' }))
      return result
    }) as typeof fs.mkdirSync)
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })).toThrow('changed during offline recovery')
    expect(readLockMeta(diagnostic.lockPath)?.version).toBe('replaced')
  })

  it('refuses unknown process liveness instead of interpreting every probe error as death', () => {
    const storePath = legacyStore()
    const diagnostic = inspectStoreLock({ storePath })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process probe unavailable'), { code: 'EIO' })
    })
    expect(() => quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })).toThrow('cannot be verified as exited')
    expect(fs.existsSync(diagnostic.lockPath)).toBe(true)
  })

  it('quarantines a reviewed legacy file without deleting its contents', () => {
    const storePath = legacyStore()
    const diagnostic = inspectStoreLock({ storePath })
    const destination = quarantineStoreLockForRecovery({
      storePath, expectedIdentity: diagnostic.identity!, allHostsStopped: true, automaticRestartsDisabled: true,
    })
    expect(readLockMeta(destination)?.version).toBe('old')
    expect(inspectStoreLock({ storePath }).status).toBe('absent')
  })
})
