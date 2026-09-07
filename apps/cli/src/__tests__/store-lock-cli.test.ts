import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build, type BuildOptions } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { inspectStoreLock, type StoreLockDiagnostic } from '@onething/runtime/storage/store-lock'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const directories: string[] = []
const processes: OwnedProcess[] = []
let outdir: string

type ExitResult = { code: number | null; signal: NodeJS.Signals | null; error?: Error }
type OwnedProcess = {
  child: ChildProcess
  closed: Promise<ExitResult>
  finished: boolean
  stdout: string
  stderr: string
}
type Sandbox = { root: string; home: string; cwd: string; store: string; env: NodeJS.ProcessEnv }

beforeAll(async () => {
  const recipePath = '../../../desktop-react/scripts/build-electron.mjs'
  const { shellEsbuildOptions }: {
    shellEsbuildOptions(options: { entryPoints: Record<string, string>; outdir: string }): BuildOptions
  } = await import(recipePath)
  outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-store-lock-cli-build-'))
  // Exercise the actual distributable entry point with its production recipe.
  // No existing dist files, desktop bundle, or mocked command dispatcher is used.
  await build({
    ...shellEsbuildOptions({
      entryPoints: {
        main: path.join(repoRoot, 'apps/cli/src/index.ts'),
        holder: fileURLToPath(new URL('./fixtures/store-lock-cli-child.ts', import.meta.url)),
      },
      outdir,
    }),
    logLevel: 'silent',
  })
}, 60_000)

afterAll(() => { if (outdir) fs.rmSync(outdir, { recursive: true, force: true }) })

afterEach(async () => {
  // A failed assertion still closes every process we created before its files
  // are removed. An exit event alone does not establish closed stdio/IPC.
  const ownedProcesses = processes.splice(0)
  const results = await Promise.allSettled(ownedProcesses.map(async owned => {
    if (!owned.finished) {
      if (owned.child.connected) owned.child.send('crash')
      else owned.child.kill('SIGKILL')
    }
    await waitForClose(owned)
  }))
  if (ownedProcesses.some(owned => !owned.finished)) throw new Error('An owned process has not closed; its test directories are retained.')
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (failures.length) throw new AggregateError(failures, 'Owned test process cleanup failed')
})

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-store-lock-cli-'))
  directories.push(root)
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  const temporary = path.join(root, 'tmp')
  for (const directory of [home, cwd, temporary]) fs.mkdirSync(directory)
  // Never inherit provider credentials, store paths, NODE_OPTIONS, or a daemon
  // environment. NODE_PATH only resolves production external dependencies.
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PATH: path.dirname(process.execPath), NODE_PATH: path.join(repoRoot, 'node_modules'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  }
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { root, home, cwd, store: path.join(root, 'store'), env }
}

function launch(file: string, args: string[], isolated: Sandbox): OwnedProcess {
  const child = fork(path.join(outdir, file), args, {
    cwd: isolated.cwd, env: isolated.env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let spawnError: Error | undefined
  const owned: OwnedProcess = {
    child, finished: false, stdout: '', stderr: '',
    closed: new Promise(resolve => {
      child.once('error', error => { spawnError = error })
      child.once('close', (code, signal) => {
        owned.finished = true
        resolve({ code, signal, ...(spawnError ? { error: spawnError } : {}) })
      })
    }),
  }
  child.stdout?.on('data', chunk => { owned.stdout += String(chunk) })
  child.stderr?.on('data', chunk => { owned.stderr += String(chunk) })
  processes.push(owned)
  return owned
}

async function waitForClose(owned: OwnedProcess): Promise<ExitResult> {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    owned.child.kill('SIGKILL')
  }, 10_000)
  try {
    const result = await owned.closed
    if (timedOut) throw new Error(`Owned CLI/holder did not close naturally. ${owned.stderr}`)
    if (result.error) throw result.error
    return result
  } finally {
    clearTimeout(timer)
  }
}

async function cli(isolated: Sandbox, args: string[]) {
  const owned = launch('main.cjs', args, isolated)
  const exit = await waitForClose(owned)
  return { ...exit, stdout: owned.stdout, stderr: owned.stderr }
}

async function holder(isolated: Sandbox): Promise<OwnedProcess> {
  const owned = launch('holder.cjs', [isolated.store], isolated)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Holder did not acquire: ${owned.stderr}`)) }, 10_000)
    const cleanup = () => { clearTimeout(timer); owned.child.off('message', onMessage); owned.child.off('close', onClose) }
    const onClose = () => { cleanup(); reject(new Error(`Holder closed before acquiring: ${owned.stderr}`)) }
    const onMessage = (message: unknown) => {
      const data = message as { type?: string; message?: string }
      if (data.type === 'locked') { cleanup(); resolve() }
      else if (data.type === 'error') { cleanup(); reject(new Error(data.message)) }
    }
    owned.child.on('message', onMessage)
    owned.child.once('close', onClose)
  })
  return owned
}

async function crash(owned: OwnedProcess): Promise<void> {
  owned.child.send('crash')
  expect(await waitForClose(owned)).toEqual({ code: 0, signal: null })
}

// File bytes, inode identity and directory mtimes make accidental startup or
// repair writes visible, including log/, discovery files and lock replacement.
function tree(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const visit = (relative: string) => {
    const filename = path.join(root, relative)
    const stat = fs.lstatSync(filename)
    result[relative] = {
      mode: stat.mode, inode: stat.ino, modifiedAt: stat.mtimeMs,
      ...(stat.isFile() ? { bytes: fs.readFileSync(filename).toString('base64') } : {}),
      ...(stat.isSymbolicLink() ? { target: fs.readlinkSync(filename) } : {}),
    }
    if (stat.isDirectory()) for (const name of fs.readdirSync(filename).sort()) visit(path.join(relative, name))
  }
  visit('')
  return result
}

async function inspect(isolated: Sandbox, store = isolated.store): Promise<StoreLockDiagnostic> {
  const result = await cli(isolated, ['store', 'lock', 'inspect', '--store', store])
  expect(result.code, result.stderr).toBe(0)
  expect(result.signal).toBeNull()
  const diagnostic = JSON.parse(result.stdout) as StoreLockDiagnostic
  expect(diagnostic).toEqual(inspectStoreLock({ storePath: path.resolve(isolated.cwd, store) }))
  return diagnostic
}

function reviewFile(isolated: Sandbox, diagnostic: StoreLockDiagnostic): string {
  const filename = path.join(isolated.cwd, 'reviewed.json')
  fs.writeFileSync(filename, JSON.stringify(diagnostic, null, 2))
  return filename
}

const assertions = ['--all-hosts-stopped', '--automatic-restarts-disabled']
function recover(isolated: Sandbox, identityFile: string, flags = assertions) {
  return cli(isolated, ['store', 'lock', 'recover', '--store', isolated.store, '--identity-file', identityFile, ...flags])
}

function refused(result: Awaited<ReturnType<typeof cli>>, message: RegExp): void {
  expect(result.code).toBe(1)
  expect(result.signal).toBeNull()
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(message)
}

describe('actual onething store lock CLI', () => {
  it('defaults to a complete JSON diagnostic without creating a missing default or explicit store', async () => {
    const isolated = sandbox()
    const before = tree(isolated.root)
    const result = await cli(isolated, ['store', 'lock'])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(inspectStoreLock({ storePath: path.join(isolated.home, '.onething') }))
    const missing = path.join(isolated.store, 'not-created')
    expect(await inspect(isolated, missing)).toMatchObject({ status: 'absent', identity: null, holder: null, processState: 'unknown' })
    refused(await cli(isolated, ['store', 'lock', '--daemon-child']), /daemon.child|internal|store/i)
    expect(tree(isolated.root)).toEqual(before)
  }, 30_000)

  it('diagnoses a real live holder through a relative alias without assembling a Backend or writing daemon files', async () => {
    const isolated = sandbox()
    const owned = await holder(isolated)
    const alias = path.join(isolated.root, 'store-alias')
    fs.symlinkSync(isolated.store, alias, 'junction')
    const before = tree(isolated.root)
    const result = await inspect(isolated, path.relative(isolated.cwd, alias))
    expect(result).toMatchObject({
      status: 'held', processState: 'running', storePath: fs.realpathSync(isolated.store),
      holder: { pid: owned.child.pid, owner: 'server', version: 'store-lock-cli-fixture', protocolVersion: 1 },
    })
    expect(tree(isolated.root)).toEqual(before)
    expect(owned.finished).toBe(false)
  }, 30_000)

  it('requires both explicit offline assertions and rejects force/yes without changing an exited holder lock', async () => {
    const isolated = sandbox()
    const owned = await holder(isolated)
    await crash(owned)
    const reviewed = reviewFile(isolated, await inspect(isolated))
    const before = tree(isolated.root)
    for (const flags of [[], [assertions[0]!], [assertions[1]!]]) {
      refused(await recover(isolated, reviewed, flags), /all.hosts.stopped|automatic.restarts.disabled|offline/i)
      expect(tree(isolated.root)).toEqual(before)
    }
    for (const unsupported of ['--force', '--yes']) {
      refused(await recover(isolated, reviewed, [...assertions, unsupported]), /force|yes|unsupported|unknown|not.support/i)
      expect(tree(isolated.root)).toEqual(before)
    }
  }, 30_000)

  it('refuses a live PID, then archives that exact reviewed identity after actual holder close and preserves metadata bytes', async () => {
    const isolated = sandbox()
    const owned = await holder(isolated)
    const diagnostic = await inspect(isolated)
    const reviewed = reviewFile(isolated, diagnostic)
    const metadata = fs.readFileSync(path.join(diagnostic.lockPath, 'owner.json'))
    const before = tree(isolated.root)
    refused(await recover(isolated, reviewed), /running|reused|exited/i)
    expect(tree(isolated.root)).toEqual(before)
    await crash(owned)
    expect(inspectStoreLock({ storePath: isolated.store }).processState).toBe('not-running')
    // Keep the original reviewed file. Recovery must not substitute a fresh
    // identity; the diagnostic processState is allowed to change after review.
    const homeBefore = tree(isolated.home)
    const cwdBefore = tree(isolated.cwd)
    const result = await recover(isolated, reviewed)
    expect(result.code, result.stderr).toBe(0)
    const recovered = JSON.parse(result.stdout) as { storePath: string; quarantinePath: string }
    expect(recovered.storePath).toBe(diagnostic.storePath)
    expect(path.dirname(path.dirname(recovered.quarantinePath))).toBe(path.dirname(diagnostic.lockPath))
    expect(path.basename(path.dirname(recovered.quarantinePath))).toMatch(/^lock-recovery-/)
    expect(path.basename(recovered.quarantinePath)).toBe('backend.lock')
    expect(fs.existsSync(diagnostic.lockPath)).toBe(false)
    expect(fs.readFileSync(path.join(recovered.quarantinePath, 'owner.json'))).toEqual(metadata)
    expect(fs.lstatSync(recovered.quarantinePath).ino).toBe(diagnostic.identity!.inode)
    expect(fs.readdirSync(isolated.store)).toEqual(['run'])
    expect(fs.readdirSync(path.join(isolated.store, 'run'))).toEqual([path.basename(path.dirname(recovered.quarantinePath))])
    expect(tree(isolated.home)).toEqual(homeBefore)
    expect(tree(isolated.cwd)).toEqual(cwdBefore)
  }, 30_000)

  it('refuses a changed lock instead of replacing the reviewed identity with a new inspection', async () => {
    const isolated = sandbox()
    const owned = await holder(isolated)
    await crash(owned)
    const diagnostic = await inspect(isolated)
    const reviewed = reviewFile(isolated, diagnostic)
    const metaPath = path.join(diagnostic.lockPath, 'owner.json')
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(metaPath, JSON.stringify({ ...metadata, nonce: 'changed-after-review' }))
    const before = tree(isolated.root)
    refused(await recover(isolated, reviewed), /identity.*changed|lock.*changed|inspect.again/i)
    expect(tree(isolated.root)).toEqual(before)
  }, 30_000)

  it('refuses unknown ownership and a reviewed report for another canonical store, retaining every entry', async () => {
    const isolated = sandbox()
    const lockPath = path.join(isolated.store, 'run', 'backend.lock')
    fs.mkdirSync(lockPath, { recursive: true })
    fs.writeFileSync(path.join(lockPath, 'owner.json'), '{unreadable owner metadata')
    const diagnostic = await inspect(isolated)
    expect(diagnostic).toMatchObject({ status: 'invalid-metadata', processState: 'unknown', holder: null })
    const reviewed = reviewFile(isolated, diagnostic)
    let before = tree(isolated.root)
    refused(await recover(isolated, reviewed), /unknown|ownership|protocol|invalid/i)
    expect(tree(isolated.root)).toEqual(before)
    fs.writeFileSync(reviewed, JSON.stringify({ ...diagnostic, storePath: path.join(isolated.root, 'another-store') }))
    before = tree(isolated.root)
    refused(await recover(isolated, reviewed), /store.*match|store.*different|store.*path|canonical/i)
    expect(tree(isolated.root)).toEqual(before)
  }, 30_000)

  it('reports missing recovery parameters and malformed reviewed JSON without touching the lock', async () => {
    const isolated = sandbox()
    const owned = await holder(isolated)
    await crash(owned)
    const reviewed = reviewFile(isolated, await inspect(isolated))
    let before = tree(isolated.root)
    refused(await cli(isolated, ['store', 'lock', 'recover', '--identity-file', reviewed, ...assertions]), /explicit.*--store|requires.*--store/i)
    refused(await cli(isolated, ['store', 'lock', 'recover', '--store', isolated.store, ...assertions]), /--identity-file/i)
    refused(await recover(isolated, path.join(isolated.cwd, 'missing.json')), /cannot.read.*diagnostic|ENOENT/i)
    expect(tree(isolated.root)).toEqual(before)
    fs.writeFileSync(reviewed, '{broken reviewed JSON')
    before = tree(isolated.root)
    refused(await recover(isolated, reviewed), /cannot.read.*diagnostic|JSON/i)
    expect(tree(isolated.root)).toEqual(before)
  }, 30_000)
})
