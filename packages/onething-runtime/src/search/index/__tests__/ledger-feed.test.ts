/**
 * ④ 改名 / 归档 / 删除三件事**不经账本**,靠指纹与目录监视认出来(拍点甲 b)。
 *
 * 反证之一(§11 S3):「检查点不比 metaRev → 改名后标题搜不到」——
 * 这里守的是指纹的那一半(`fingerprint` 认不认 meta 的 mtime),
 * 折进索引那一半在 `worker-core.test.ts`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { LedgerFeed, readLastSeq, readSessionMeta } from '../ledger-feed.js'
import {
  BASE_TIME,
  createTempStore,
  writeMeta,
  writeTypicalSession,
} from './helpers.js'
import type { TempStore } from './helpers.js'

const stores: TempStore[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const store of stores.splice(0)) store.dispose()
})

function newStore(): TempStore {
  const store = createTempStore()
  stores.push(store)
  return store
}

async function collectKeys(feed: LedgerFeed): Promise<string[]> {
  const keys: string[] = []
  for await (const key of feed.keys()) keys.push(key)
  return keys.sort()
}

/** meta.json 的 mtime 只有毫秒精度,连着写两次可能同一刻 —— 显式推一下。 */
function touchMeta(dir: string, offsetMs: number): void {
  const at = new Date(Date.now() + offsetMs)
  fs.utimesSync(path.join(dir, 'meta.json'), at, at)
}

describe('LedgerFeed 枚举与指纹', () => {
  it('keys() 只给有 events.jsonl 的目录(legacy-backup 之类天然被挡)', async () => {
    const store = newStore()
    writeTypicalSession(store, { sessionId: 's1' })
    writeTypicalSession(store, { sessionId: 's2' })
    fs.mkdirSync(path.join(store.sessionsDir, 'legacy-backup'), { recursive: true })
    fs.writeFileSync(path.join(store.sessionsDir, 'index.json'), '{}')

    const feed = new LedgerFeed({ sessionsDir: store.sessionsDir })
    expect(await collectKeys(feed)).toEqual(['s1', 's2'])
  })

  it('指纹 = lastSeq:metaMtime —— 追一条事件,前半变', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: '原名' })
    const feed = new LedgerFeed({ sessionsDir: store.sessionsDir })

    const before = feed.fingerprint('s1')!
    expect(before.split(':')[0]).toBe(String(writer.lastSeq))

    writer.appendToFile({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'm9', role: 'user', content: '新来的', timestamp: BASE_TIME } } })
    const after = feed.fingerprint('s1')!
    expect(after).not.toBe(before)
    expect(after.split(':')[0]).toBe(String(writer.lastSeq))
    // 账本变了,meta 那半没动。
    expect(after.split(':')[1]).toBe(before.split(':')[1])
  })

  it('改名 → 账本一个字节不动,指纹后半变(拍点甲 b 的全部机关)', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: '原名' })
    const feed = new LedgerFeed({ sessionsDir: store.sessionsDir })
    const before = feed.fingerprint('s1')!
    const ledgerBytes = fs.readFileSync(path.join(dir, 'events.jsonl'))

    writeMeta(dir, 's1', { name: '改过的名字' })
    touchMeta(dir, 5000)
    const after = feed.fingerprint('s1')!

    expect(fs.readFileSync(path.join(dir, 'events.jsonl'))).toEqual(ledgerBytes)
    expect(after).not.toBe(before)
    expect(after.split(':')[0]).toBe(before.split(':')[0])
    expect(readSessionMeta(path.join(dir, 'meta.json'))?.name).toBe('改过的名字')
  })

  it('归档同理 —— 也只动 meta,指纹跟着变', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: 'x' })
    const feed = new LedgerFeed({ sessionsDir: store.sessionsDir })
    const before = feed.fingerprint('s1')!

    writeMeta(dir, 's1', { name: 'x', isArchived: true })
    touchMeta(dir, 5000)
    expect(feed.fingerprint('s1')).not.toBe(before)
    expect(readSessionMeta(path.join(dir, 'meta.json'))?.isArchived).toBe(true)
  })

  it('删目录 → 指纹 undefined = 墓碑(`session/deleted` 要写进的那本账自己没了)', () => {
    const store = newStore()
    writeTypicalSession(store, { sessionId: 's1' })
    const feed = new LedgerFeed({ sessionsDir: store.sessionsDir })
    expect(feed.fingerprint('s1')).toBeDefined()
    fs.rmSync(path.join(store.sessionsDir, 's1'), { recursive: true, force: true })
    expect(feed.fingerprint('s1')).toBeUndefined()
  })

  it('readLastSeq 从尾巴上读,不读整份文件', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = writeTypicalSession(store, { sessionId: 's1' })
    const file = path.join(dir, 'events.jsonl')
    const size = fs.statSync(file).size
    expect(readLastSeq(file, size)).toBe(writer.lastSeq)
    // 空文件 / 不存在都答 0,不抛。
    expect(readLastSeq(file, 0)).toBe(0)
    expect(readLastSeq(path.join(dir, 'nope.jsonl'), 10)).toBe(0)
  })
})

describe('LedgerFeed 订阅', () => {
  it('注入的 append / meta 适配器都接上了,退订把两条都撤掉', () => {
    const store = newStore()
    const appendListeners: Array<(key: string) => void> = []
    const metaListeners: Array<(key: string) => void> = []
    let appendDisposed = 0
    let metaDisposed = 0

    const feed = new LedgerFeed({
      sessionsDir: store.sessionsDir,
      subscribeAppend: cb => {
        appendListeners.push(cb)
        return () => { appendDisposed += 1 }
      },
      subscribeMeta: cb => {
        metaListeners.push(cb)
        return () => { metaDisposed += 1 }
      },
    })

    const seen: string[] = []
    const unsubscribe = feed.subscribe(key => seen.push(key))
    for (const listener of appendListeners) listener('from-append')
    for (const listener of metaListeners) listener('from-meta')
    expect(seen).toEqual(['from-append', 'from-meta'])

    unsubscribe()
    expect(appendDisposed).toBe(1)
    expect(metaDisposed).toBe(1)
  })

  it('policy 是 eager —— 账本是产品主路,不等第一次查询才建', () => {
    const store = newStore()
    expect(new LedgerFeed({ sessionsDir: store.sessionsDir }).policy).toEqual({ build: 'eager' })
  })
})
