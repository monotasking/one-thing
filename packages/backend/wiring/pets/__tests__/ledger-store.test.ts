/**
 * 账本落盘:坏行跳过、坏 `current.json` 当不存在、尾部只取 N 行、追加保序(§9.1 / §9.6)。
 * 全在临时目录里,不碰 `~/.onething`。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PetLedgerLine } from '@onething/runtime/pets'
import { PetLedgerStore } from '../ledger-store.js'

let dir: string
let store: PetLedgerStore

const mutter = (i: number): PetLedgerLine => ({
  kind: 'utterance',
  petId: 'heidou',
  at: i,
  utterance: { id: `u${i}`, petId: 'heidou', mode: 'mutter', text: `第${i}句`, at: i, duck: false },
})

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'onething-pets-ledger-'))
  store = new PetLedgerStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('PetLedgerStore', () => {
  it('reads an absent ledger as empty and an absent current.json as null', async () => {
    expect(await store.readTail('heidou')).toEqual([])
    expect(await store.readCurrent()).toBeNull()
  })

  it('appends in order and reads back only the last N lines', async () => {
    for (let i = 0; i < 70; i += 1) void store.append('heidou', [mutter(i)])
    await store.flush()
    const tail = await store.readTail('heidou', 50)
    expect(tail).toHaveLength(50)
    expect(tail[0]).toEqual(mutter(20))
    expect(tail.at(-1)).toEqual(mutter(69))
  })

  it('skips corrupt, half-written and foreign lines instead of forgetting everything', async () => {
    await mkdir(path.join(dir, 'heidou'), { recursive: true })
    const rows = [
      JSON.stringify(mutter(1)),
      '{"kind":"utterance","petId":"heidou"', // 半截
      'not json at all',
      JSON.stringify({ kind: 'moment', petId: 'heidou', at: 2, scheme: 'demo', event: 'x', weight: 'urgent', gist: 'g' }),
      JSON.stringify({ ...mutter(3), petId: 'parrot' }),
      '',
      JSON.stringify(mutter(4)),
    ]
    await writeFile(store.ledgerPath('heidou'), rows.join('\n'))
    expect(await store.readTail('heidou')).toEqual([mutter(1), mutter(4)])
  })

  it('treats a malformed current.json as absent, and writes a readable one', async () => {
    await writeFile(path.join(dir, 'current.json'), '{"id": ')
    expect(await store.readCurrent()).toBeNull()
    await writeFile(path.join(dir, 'current.json'), '{"id": 7}')
    expect(await store.readCurrent()).toBeNull()
    await store.writeCurrent('heidou')
    expect(await store.readCurrent()).toBe('heidou')
    expect(JSON.parse(await readFile(path.join(dir, 'current.json'), 'utf8'))).toEqual({ id: 'heidou' })
  })

  it('does not throw when the store is not owned; it logs and moves on', async () => {
    const denied = new PetLedgerStore(dir, () => { throw new Error('lease lost') })
    await expect(denied.append('heidou', [mutter(1)])).resolves.toBeUndefined()
    expect(await store.readTail('heidou')).toEqual([])
  })
})
