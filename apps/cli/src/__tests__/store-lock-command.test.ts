import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectStoreLock, StoreLock } from '@onething/runtime/storage/store-lock'
import { storeLockCommand } from '../store-lock-command.js'

const output = vi.hoisted(() => [] as string[])
vi.mock('../stdout.js', () => ({ stdout: (line: string) => { output.push(line) } }))

let directory: string
const leases: StoreLock[] = []
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'store-lock-command-'))
  output.length = 0
})
afterEach(() => {
  for (const lease of leases.splice(0)) lease.release()
  fs.rmSync(directory, { recursive: true, force: true })
})

const assertions = { 'all-hosts-stopped': true, 'automatic-restarts-disabled': true }

it('defaults to read-only diagnosis without creating a missing store', () => {
  const storePath = path.join(directory, 'missing', 'store')
  storeLockCommand(undefined, [], storePath, {})
  expect(JSON.parse(output[0]!)).toMatchObject({ status: 'absent', identity: null, holder: null })
  expect(fs.readdirSync(directory)).toEqual([])
})

it.each(['force', 'yes', 'y', 'unknown'])('rejects --%s rather than interpreting it as permission to recover', flag => {
  expect(() => storeLockCommand('recover', [], directory, { ...assertions, [flag]: true }))
    .toThrow(`Unsupported store lock option: --${flag}`)
  expect(fs.readdirSync(directory)).toEqual([])
})

it('requires the explicit recovery action, target and both literal stop assertions before reading a report', () => {
  const flags = { ...assertions, 'identity-file': path.join(directory, 'not-read.json') }
  expect(() => storeLockCommand(undefined, [], directory, flags)).toThrow('Unsupported store lock option')
  expect(() => storeLockCommand('recover', [], undefined, flags)).toThrow('explicit --store')
  for (const overrides of [
    { 'all-hosts-stopped': false }, { 'automatic-restarts-disabled': false },
    { 'all-hosts-stopped': 'true' }, { 'automatic-restarts-disabled': 'true' },
  ]) {
    expect(() => storeLockCommand('recover', [], directory, { ...flags, ...overrides }))
      .toThrow('Offline recovery requires --all-hosts-stopped and --automatic-restarts-disabled')
  }
  expect(fs.readdirSync(directory)).toEqual([])
})

it('rejects a missing value, malformed JSON and incomplete identity with clear errors', () => {
  expect(() => storeLockCommand('inspect', [], directory, { store: true })).toThrow('--store requires')
  expect(() => storeLockCommand('recover', [], directory, assertions)).toThrow('requires --identity-file')
  const file = path.join(directory, 'reviewed.json')
  fs.writeFileSync(file, '{broken')
  expect(() => storeLockCommand('recover', [], directory, { ...assertions, 'identity-file': file }))
    .toThrow('Cannot read reviewed lock diagnostic')
  fs.writeFileSync(file, JSON.stringify({ storePath: directory, lockPath: path.join(directory, 'run/backend.lock'), identity: null }))
  expect(() => storeLockCommand('recover', [], directory, { ...assertions, 'identity-file': file }))
    .toThrow('non-null lock identity')
  expect(fs.readdirSync(directory)).toEqual(['reviewed.json'])
})

it('rejects a reviewed identity from a different target even when the report has a valid identity shape', async () => {
  const source = path.join(directory, 'source')
  const other = path.join(directory, 'other')
  const lease = new StoreLock({ storePath: source })
  await lease.acquire('desktop')
  leases.push(lease)
  const report = inspectStoreLock({ storePath: source })
  const file = path.join(directory, 'reviewed.json')
  fs.writeFileSync(file, JSON.stringify(report))
  expect(() => storeLockCommand('recover', [], other, { ...assertions, 'identity-file': file }))
    .toThrow('different store or lock path')
  expect(inspectStoreLock({ storePath: source })).toEqual(report)
  expect(fs.existsSync(other)).toBe(false)
})

it('accepts the same canonical target through an alias but still refuses its running holder', async () => {
  const source = path.join(directory, 'source')
  const alias = path.join(directory, 'alias')
  const lease = new StoreLock({ storePath: source })
  await lease.acquire('desktop')
  leases.push(lease)
  fs.symlinkSync(source, alias, 'junction')
  const report = inspectStoreLock({ storePath: source })
  const file = path.join(directory, 'reviewed.json')
  fs.writeFileSync(file, JSON.stringify(report))
  expect(() => storeLockCommand('recover', [], alias, { ...assertions, 'identity-file': file }))
    .toThrow('running, reused, or cannot be verified as exited')
  expect(inspectStoreLock({ storePath: source })).toEqual(report)
  expect(fs.readdirSync(path.join(source, 'run'))).toEqual(['backend.lock'])
})
