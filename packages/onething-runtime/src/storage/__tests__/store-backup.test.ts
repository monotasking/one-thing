import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStoreBackup, restoreStoreBackup, verifyStoreBackup, STORE_RESTORE_PENDING } from '../store-backup.js'
import { inspectStoreLock, StoreLock } from '../store-lock.js'

let root: string
let source: string
let backup: string
let restored: string
const write = (name: string, content: string | Buffer) => {
  const file = path.join(source, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const json = (name: string, value: unknown) => write(name, JSON.stringify(value))
function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (relative: string) => {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      if (!relative && (name === 'run' || name === STORE_RESTORE_PENDING)) continue
      const key = relative ? `${relative}/${name}` : name
      const file = path.join(directory, key)
      const stat = fs.lstatSync(file)
      if (stat.isDirectory()) { result[key] = 'directory'; visit(key) }
      else if (stat.isSymbolicLink()) result[key] = `link:${fs.readlinkSync(file)}`
      else result[key] = fs.readFileSync(file).toString('base64')
    }
  }
  visit('')
  return result
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-backup-'))
  source = path.join(root, 'source')
  backup = path.join(root, 'backup')
  restored = path.join(root, 'restored')
  fs.mkdirSync(source)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function currentStore() {
  json('sessions/one/meta.json', { id: 'one', ownerUserId: 'alice', ownerWorkspaceId: 'tenant', storageGeneration: 'generation-2' })
  json('sessions/index.json', [{ id: 'one', ownerUserId: 'alice', ownerWorkspaceId: 'tenant', storageGeneration: 'generation-2' }])
  write('sessions/one/events.jsonl', '{"seq":1,"type":"user/message"}\n')
  write('sessions/one/blobs/body.bin', Buffer.from([0, 1, 2, 255]))
  json('sessions/.deletions/pending/intent.json', { version: 1, id: 'pending', targets: [{ id: 'old', generation: 'generation-1' }] })
  json('sessions/.deletions/complete/intent.json', { version: 1, id: 'complete' })
  json('sessions/.deletions/complete/complete.json', { version: 1 })
  json('workspaces/default/notes.json', { version: 1, notes: ['fixture'] })
  write('media/images/image.png', Buffer.from([137, 80, 78, 71]))
  json('media/index.json', { version: 2, assets: [{ id: 'image', filePath: path.join(source, 'media/images/image.png') }] })
  write('settings.json', '{"fixture":true}')
  fs.mkdirSync(path.join(source, 'empty-directory'))
}

it('backs up all durable state and restores byte-identically without copying discovery or leases', async () => {
  currentStore()
  write('run/server.json', '{"staleDiscovery":true}')
  const before = snapshot(source)
  const manifest = await createStoreBackup({ storePath: source, backupPath: backup })
  expect(manifest.entries.some(entry => entry.path.startsWith('run'))).toBe(false)
  expect(verifyStoreBackup({ backupPath: backup })).toEqual(manifest)
  expect(snapshot(source)).toEqual(before)
  expect(inspectStoreLock({ storePath: source }).status).toBe('absent')
  await restoreStoreBackup({ backupPath: backup, storePath: restored })
  expect(snapshot(restored)).toEqual(before)
  expect(snapshot(source)).toEqual(before)
  expect(fs.readdirSync(path.join(restored, 'run'))).toEqual([])
  expect(JSON.parse(fs.readFileSync(path.join(restored, STORE_RESTORE_PENDING), 'utf8')))
    .toMatchObject({ version: 1, state: 'complete', activationStorePath: manifest.activationStorePath })
  // Preserve the original and activate while all fixture hosts are stopped.
  fs.renameSync(source, path.join(root, 'preserved-original'))
  fs.renameSync(restored, source)
  const image = JSON.parse(fs.readFileSync(path.join(source, 'media/index.json'), 'utf8')).assets[0]
  expect(fs.readFileSync(image.filePath)).toEqual(Buffer.from([137, 80, 78, 71]))
  // A completed restore can itself be backed up without treating its completed
  // diagnostic as business data or blessing a staging-path relocation.
  await createStoreBackup({ storePath: source, backupPath: path.join(root, 'next-backup') })
})

it('restores a complete backup taken from a store an earlier version produced', async () => {
  const legacy = path.join(root, 'legacy')
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"priorVersion":true}')
  const oldBackup = path.join(root, 'old-backup')
  await createStoreBackup({ storePath: legacy, backupPath: oldBackup })
  await restoreStoreBackup({ backupPath: oldBackup, storePath: restored })
  expect(snapshot(restored)).toEqual(snapshot(legacy))
})

it('does not back up a store with a live writer or replace an existing destination', async () => {
  currentStore()
  const lease = new StoreLock({ storePath: source })
  await lease.acquire('server')
  await expect(createStoreBackup({ storePath: source, backupPath: backup })).rejects.toMatchObject({ name: 'LockConflictError' })
  expect(fs.existsSync(backup)).toBe(false)
  lease.release()
  await createStoreBackup({ storePath: source, backupPath: backup })
  const saved = snapshot(backup)
  await expect(createStoreBackup({ storePath: source, backupPath: backup })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(snapshot(backup)).toEqual(saved)
  fs.mkdirSync(restored)
  fs.writeFileSync(path.join(restored, 'keep'), 'untouched')
  await expect(restoreStoreBackup({ backupPath: backup, storePath: restored })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(fs.readFileSync(path.join(restored, 'keep'), 'utf8')).toBe('untouched')
})

it('rejects nested destinations including directory aliases before modifying business data', async () => {
  currentStore()
  const before = snapshot(source)
  await expect(createStoreBackup({ storePath: source, backupPath: path.join(source, 'nested') })).rejects.toMatchObject({ code: 'STORE_BACKUP_INVALID' })
  const alias = path.join(root, 'alias')
  fs.symlinkSync(source, alias, 'junction')
  await expect(createStoreBackup({ storePath: source, backupPath: path.join(alias, 'nested') })).rejects.toMatchObject({ code: 'STORE_BACKUP_INVALID' })
  expect(snapshot(source)).toEqual(before)
})

it.each(['missing', 'changed', 'extra', 'truncated-manifest', 'false-entries'] as const)('refuses a %s backup before any restore writes', async failure => {
  currentStore()
  await createStoreBackup({ storePath: source, backupPath: backup })
  const body = path.join(backup, 'data/sessions/one/blobs/body.bin')
  if (failure === 'missing') fs.unlinkSync(body)
  if (failure === 'changed') fs.writeFileSync(body, 'damaged')
  if (failure === 'extra') fs.writeFileSync(path.join(backup, 'data/undeclared'), 'extra')
  if (failure === 'truncated-manifest') fs.writeFileSync(path.join(backup, 'manifest.json'), '{')
  if (failure === 'false-entries') {
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'))
    manifest.entries = manifest.entries.slice(0, -1)
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest))
  }
  await expect(restoreStoreBackup({ backupPath: backup, storePath: restored })).rejects.toMatchObject({ code: 'STORE_BACKUP_INVALID' })
  expect(fs.existsSync(restored)).toBe(false)
})

it('retains owner executable permission and internal file links while refusing external links', async () => {
  write('tools/tool', '#!/bin/sh\nexit 0\n')
  fs.chmodSync(path.join(source, 'tools/tool'), 0o700)
  fs.symlinkSync('tool', path.join(source, 'tools/current'), 'file')
  await createStoreBackup({ storePath: source, backupPath: backup })
  await restoreStoreBackup({ backupPath: backup, storePath: restored })
  expect(fs.readlinkSync(path.join(restored, 'tools/current'))).toBe('tool')
  expect(fs.readFileSync(path.join(restored, 'tools/current'), 'utf8')).toContain('exit 0')
  if (process.platform !== 'win32') expect(fs.statSync(path.join(restored, 'tools/tool')).mode & 0o777).toBe(0o700)
  fs.symlinkSync('../../external', path.join(source, 'tools/unsafe'), 'file')
  await expect(createStoreBackup({ storePath: source, backupPath: path.join(root, 'bad-backup') })).rejects.toMatchObject({ code: 'STORE_BACKUP_INCOMPLETE' })
  expect(inspectStoreLock({ storePath: source }).status).toBe('absent')
})

it('keeps an interrupted restore closed even after its lock is removed for offline diagnosis', async () => {
  currentStore()
  const before = snapshot(source)
  await createStoreBackup({ storePath: source, backupPath: backup })
  const original = fs.openSync
  const injected = Object.assign(new Error('restore disk unavailable'), { code: 'EIO' })
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes(`${path.sep}restored${path.sep}media${path.sep}images${path.sep}image.png`) && args[1] === 'wx') throw injected
    return original(...args)
  })
  await expect(restoreStoreBackup({ backupPath: backup, storePath: restored }))
    .rejects.toMatchObject({ code: 'STORE_RESTORE_INCOMPLETE', cause: injected })
  vi.restoreAllMocks()
  expect(inspectStoreLock({ storePath: restored }).status).toBe('held')
  expect(fs.existsSync(path.join(restored, STORE_RESTORE_PENDING))).toBe(true)
  // The marker is an independent barrier, including if an operator later
  // quarantines the abandoned lock. This test never opens a partial Backend.
  fs.renameSync(path.join(restored, 'run/backend.lock'), path.join(restored, 'run/test-quarantined-lock'))
  expect(JSON.parse(fs.readFileSync(path.join(restored, STORE_RESTORE_PENDING), 'utf8')).state).not.toBe('complete')
  expect(snapshot(source)).toEqual(before)
  expect(verifyStoreBackup({ backupPath: backup }).entries.length).toBeGreaterThan(0)
})

it('refuses an interrupted source instead of blessing it as a new complete backup', async () => {
  currentStore()
  write(STORE_RESTORE_PENDING, '{')
  await expect(createStoreBackup({ storePath: source, backupPath: backup })).rejects.toMatchObject({ code: 'STORE_BACKUP_INVALID' })
  expect(fs.existsSync(backup)).toBe(false)
})
