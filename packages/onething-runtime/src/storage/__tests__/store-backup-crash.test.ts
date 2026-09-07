import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'
import { createStoreBackup, restoreStoreBackup, verifyStoreBackup, STORE_RESTORE_PENDING } from '../store-backup.js'
import { inspectStoreLock, quarantineStoreLockForRecovery } from '../store-lock.js'

it.each(['copied-file', 'before-complete', 'after-complete'] as const)('preserves restore barriers when a real child dies at %s', { timeout: 20000 }, async phase => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-restore-crash-'))
  const source = path.join(root, 'source')
  const backup = path.join(root, 'backup')
  const target = path.join(root, 'target')
  const fixture = path.join(root, 'restore.cjs')
  let child: ReturnType<typeof spawn> | undefined
  let exited: Promise<unknown> | undefined
  try {
    fs.mkdirSync(path.join(source, 'media/images'), { recursive: true })
    fs.mkdirSync(path.join(source, 'sessions/owned'), { recursive: true })
    fs.writeFileSync(path.join(source, 'media/images/image.bin'), Buffer.from([0, 1, 128, 255]))
    fs.writeFileSync(path.join(source, 'sessions/owned/meta.json'), JSON.stringify({ id: 'owned', ownerUserId: 'alice', ownerWorkspaceId: 'tenant', storageGeneration: 'generation' }))
    await createStoreBackup({ storePath: source, backupPath: backup })
    const manifest = verifyStoreBackup({ backupPath: backup })
    buildSync({ entryPoints: [fileURLToPath(new URL('./fixtures/store-restore-child.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'cjs', outfile: fixture, logLevel: 'silent' })
    child = spawn(process.execPath, [fixture, backup, target, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
    exited = new Promise(resolve => child!.once('exit', (code, signal) => resolve({ code, signal })))
    await new Promise<void>((resolve, reject) => {
      let output = ''
      let diagnostic = ''
      child!.stderr!.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2000) })
      const timer = setTimeout(() => reject(new Error('Restore child did not reach copied-file barrier')), 10000)
      const fail = (error: Error) => { clearTimeout(timer); reject(error) }
      child!.once('error', fail)
      child!.once('exit', () => fail(new Error(`Restore child exited before copied-file barrier: ${diagnostic}`)))
      child!.stdout!.on('data', chunk => {
        output += String(chunk)
        if (output.includes('COPIED\n')) { clearTimeout(timer); resolve() }
      })
    })
    expect(fs.existsSync(path.join(target, 'media/images/image.bin'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'sessions/owned/meta.json'))).toBe(phase !== 'copied-file')
    child.kill('SIGKILL')
    await exited
    const lock = inspectStoreLock({ storePath: target })
    expect(lock.status).toBe('held')
    expect(lock.processState).toBe('not-running')
    quarantineStoreLockForRecovery({ storePath: target, allHostsStopped: true, automaticRestartsDisabled: true, expectedIdentity: lock.identity! })
    expect(JSON.parse(fs.readFileSync(path.join(target, STORE_RESTORE_PENDING), 'utf8')).state)
      .toBe(phase === 'after-complete' ? 'complete' : undefined)
    expect(verifyStoreBackup({ backupPath: backup })).toEqual(manifest)
    const retry = path.join(root, 'retry')
    await restoreStoreBackup({ backupPath: backup, storePath: retry })
    expect(fs.readFileSync(path.join(retry, 'sessions/owned/meta.json'))).toEqual(fs.readFileSync(path.join(source, 'sessions/owned/meta.json')))
    expect(fs.readFileSync(path.join(retry, 'media/images/image.bin'))).toEqual(fs.readFileSync(path.join(source, 'media/images/image.bin')))
    expect(inspectStoreLock({ storePath: retry }).status).toBe('absent')
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    fs.rmSync(root, { recursive: true, force: true })
  }
})
