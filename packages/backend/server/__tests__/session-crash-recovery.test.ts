import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { build, type BuildOptions } from 'esbuild'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
let outdir: string
beforeAll(async () => {
  const recipePath = '../../../../apps/desktop-react/scripts/build-electron.mjs'
  const { shellEsbuildOptions, searchWorkerEsbuildOptions }: {
    shellEsbuildOptions(options: { entryPoints: Record<string, string>; outdir: string }): BuildOptions
    searchWorkerEsbuildOptions(options: { outdir: string; repoRoot: string }): BuildOptions
  } = await import(recipePath)
  // Use the actual host recipe and a private output, never a shared/stale CLI bundle.
  outdir = await fs.mkdtemp(path.join(repoRoot, '.session-crash-build-'))
  const fixture = fileURLToPath(new URL('./fixtures/session-crash.ts', import.meta.url))
  await build(shellEsbuildOptions({ entryPoints: { fixture }, outdir }))
  await build(searchWorkerEsbuildOptions({ outdir, repoRoot }))
}, 60000)
afterAll(async () => { if (outdir) await fs.rm(outdir, { recursive: true, force: true }) })

it.each(['create', 'branch', 'delete'])('opens a real Backend after an abrupt %s without exposing the wrong owner or deleted targets', { timeout: 60000 }, async mode => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-session-crash-'))
  const previous = process.env.ONETHING_STORE_PATH
  const parent = randomUUID()
  const child = randomUUID()
  let runtime: { shutdown(): Promise<void> } | undefined
  try {
    const result = spawnSync(process.execPath, [path.join(outdir, 'fixture.cjs'), mode, directory, parent, child], { encoding: 'utf8', timeout: 30000 })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(73)
    if (mode !== 'delete') {
      // Inspect before any recovery/repair can cover up a missing initial owner.
      const saved = JSON.parse(await fs.readFile(path.join(directory, 'sessions', mode === 'branch' ? child : parent, 'meta.json'), 'utf8'))
      expect(saved).toMatchObject({ ownerUserId: 'alice', ownerWorkspaceId: 'tenant' })
      expect(saved.storageGeneration).toMatch(/^[a-f0-9-]{36}$/)
    }
    process.env.ONETHING_STORE_PATH = directory
    vi.resetModules()
    // The crashed host took no mutex (2026-08-24 ruling: only the CLI daemon
    // does), so reopening is not gated on operator recovery — the point of this
    // test is what the reopened Backend then shows.
    const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
    expect(inspectStoreLock({ storePath: directory }).status).toBe('absent')
    const { createAppServerRuntime } = await import('./test-helpers.js')
    const opened = await createAppServerRuntime({ storePath: directory, workspaceRoot: path.join(directory, 'workspace') })
    runtime = opened
    const alice = await opened.runtime.sessions.list({ userId: 'alice', workspaceId: 'tenant' }) as { sessions: Array<{ id: string }> }
    expect((await opened.runtime.sessions.list({ userId: 'bob', workspaceId: 'tenant' })) as object).toMatchObject({ sessions: [] })
    expect((await opened.runtime.sessions.list()) as object).toMatchObject({ sessions: [] })
    if (mode === 'delete') {
      // The very first observable index follows recovery, with no intermediate
      // list in which a surviving cascade member is visible.
      expect(alice.sessions).toEqual([])
      await expect(fs.stat(path.join(directory, 'sessions', parent))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.join(directory, 'sessions', child))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await fs.readFile(path.join(directory, 'sessions', 'index.json'), 'utf8'))).toEqual([])
    } else {
      expect(alice.sessions.map(item => item.id)).toContain(mode === 'branch' ? child : parent)
    }
  } finally {
    await runtime?.shutdown()
    if (previous === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previous
    await fs.rm(directory, { recursive: true, force: true })
  }
})
