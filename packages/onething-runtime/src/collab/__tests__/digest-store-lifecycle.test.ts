import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createCollabDigestStore, configureCollabDigestStore, saveCollabDigest, getCollabDigests,
} from '../digest-store.js'

let directory: string
let release: (() => void) | undefined
let previous: string | undefined
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-store-'))
  previous = process.env.ONETHING_STORE_PATH
})
afterEach(() => {
  release?.()
  release = undefined
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  fs.rmSync(directory, { recursive: true, force: true })
})
const digest = { day: '2026-09-03', summary: '', messageCount: 4, generatedAt: 123 }

it('pins the directory, preserves examined empty summaries and rejects closed A handles after binding B', () => {
  const a = createCollabDigestStore({ storePath: path.join(directory, 'a') })
  const releaseA = configureCollabDigestStore(a)
  release = releaseA
  process.env.ONETHING_STORE_PATH = path.join(directory, 'b')
  saveCollabDigest('room', digest)
  expect(a.getCollabDigestsForDays('room', [digest.day])).toEqual([digest])
  expect(a.needsCollabDigest('room', digest.day, 4)).toBe(false)
  expect(a.needsCollabDigest('room', digest.day, 5)).toBe(true)
  expect(fs.existsSync(path.join(directory, 'a', 'collab', 'room', 'digests.json'))).toBe(true)
  expect(fs.existsSync(path.join(directory, 'b'))).toBe(false)
  a.quiesce()
  releaseA()
  const b = createCollabDigestStore({ storePath: path.join(directory, 'b') })
  release = configureCollabDigestStore(b)
  releaseA()
  expect(() => a.saveCollabDigest('room', digest)).toThrow('shutting down')
  expect(() => a.forgetCollabDigests('room')).toThrow('shutting down')
  expect(() => a.getCollabDigestsForDays('room', [])).toThrow('shutting down')
  expect(getCollabDigests('room')).toEqual([])
  saveCollabDigest('room', { ...digest, summary: 'B only' })
  expect(getCollabDigests('room')[0].summary).toBe('B only')
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'a', 'collab', 'room', 'digests.json'), 'utf8')).days[digest.day]).toEqual(digest)
})

it('retains the newest sixty days and deletes a room without changing another room', () => {
  const store = createCollabDigestStore({ storePath: directory })
  for (let index = 0; index < 65; index++) {
    const day = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)
    store.saveCollabDigest('room', { ...digest, day })
  }
  store.saveCollabDigest('other', digest)
  expect(store.getCollabDigests('room')).toHaveLength(60)
  expect(store.getCollabDigests('room')[0].day).toBe('2026-01-06')
  store.forgetCollabDigests('room')
  expect(store.getCollabDigests('room')).toEqual([])
  expect(store.getCollabDigests('other')).toEqual([digest])
})

it('checks ownership before reads or writes and rejects paths outside the fixed store', () => {
  let owned = true
  const store = createCollabDigestStore({ storePath: directory, assertOwned() { if (!owned) throw new Error('Lease lost') } })
  for (const id of ['../other', '..', 'a/b', 'a\\b', '']) {
    expect(() => store.saveCollabDigest(id, digest)).toThrow('Invalid digest room id')
  }
  owned = false
  expect(() => store.getCollabDigests('room')).toThrow('Lease lost')
  expect(() => store.saveCollabDigest('room', digest)).toThrow('Lease lost')
  expect(fs.readdirSync(directory)).toEqual([])
})
