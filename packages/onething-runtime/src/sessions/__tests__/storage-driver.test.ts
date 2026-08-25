import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHybridSessionStorageDriver, type SessionStorageDriver } from '../storage-driver.js'

interface TestMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface TestSession {
  id: string
  name: string
  updatedAt: number
  messages: TestMessage[]
}

function makeSession(id: string, count: number): TestSession {
  return {
    id,
    name: `会话 ${id}`,
    updatedAt: 1700000000000,
    messages: Array.from({ length: count }, (_, i) => ({
      id: `${id}-m${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `内容 ${i + 1}`,
      timestamp: 1700000000000 + i,
    })),
  }
}

describe('hybrid session storage driver', () => {
  let dir: string
  let newFormat: 'legacy-json' | 'jsonl'
  /** S3w-2:抄本停写档(`ONETHING_SESSION_TRANSCRIPT=off` 在装配层的落点)。 */
  let skipMessages: boolean
  let driver: SessionStorageDriver<TestSession>

  const legacyPath = (id: string) => path.join(dir, `${id}.json`)
  const logPath = (id: string) => path.join(dir, id, 'messages.jsonl')
  const metaPath = (id: string) => path.join(dir, id, 'meta.json')

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-jsonl-'))
    newFormat = 'jsonl'
    skipMessages = false
    driver = createHybridSessionStorageDriver<TestSession>({
      getSessionsDir: () => dir,
      getLegacySessionPath: legacyPath,
      newSessionFormat: () => newFormat,
      skipMessageWrites: () => skipMessages,
      readJsonFile: (filePath, fallback) => {
        try {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        } catch {
          return fallback
        }
      },
      writeJsonFileAsync: async (filePath, data) => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
        await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8')
      },
      deleteJsonFile: filePath => {
        fs.rmSync(filePath, { force: true })
      },
    })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes new sessions as jsonl and round-trips through load', async () => {
    const session = makeSession('s1', 5)
    await driver.write('s1', session, { kind: 'structural' })

    expect(fs.existsSync(logPath('s1'))).toBe(true)
    expect(fs.existsSync(metaPath('s1'))).toBe(true)
    expect(fs.existsSync(legacyPath('s1'))).toBe(false)
    expect(driver.format('s1')).toBe('jsonl')

    const loaded = driver.load('s1')
    expect(loaded).toEqual(session)
  })

  it('routes new sessions to legacy when flag is off, and keeps jsonl sessions readable', async () => {
    const jsonlSession = makeSession('s1', 2)
    await driver.write('s1', jsonlSession, { kind: 'structural' })

    newFormat = 'legacy-json'
    const legacySession = makeSession('s2', 2)
    await driver.write('s2', legacySession, { kind: 'structural' })

    expect(fs.existsSync(legacyPath('s2'))).toBe(true)
    expect(fs.existsSync(metaPath('s2'))).toBe(false)
    // 回滚后 jsonl 会话仍走 jsonl 读写
    expect(driver.format('s1')).toBe('jsonl')
    expect(driver.load('s1')).toEqual(jsonlSession)
    expect(driver.load('s2')).toEqual(legacySession)
  })

  it('message plan appends without rewriting the prefix', async () => {
    const session = makeSession('s1', 3)
    await driver.write('s1', session, { kind: 'structural' })
    const before = fs.readFileSync(logPath('s1'), 'utf-8')

    session.messages.push({ id: 's1-m4', role: 'assistant', content: '第四条', timestamp: 1700000000100 })
    await driver.write('s1', session, { kind: 'message', dirtySeq: 4 })

    const after = fs.readFileSync(logPath('s1'), 'utf-8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
    expect(driver.load('s1')).toEqual(session)
  })

  it('message plan suffix-rewrites from the dirty seq', async () => {
    const session = makeSession('s1', 4)
    await driver.write('s1', session, { kind: 'structural' })
    const before = fs.readFileSync(logPath('s1'), 'utf-8')

    session.messages[2] = { ...session.messages[2], content: '改写第三条' }
    await driver.write('s1', session, { kind: 'message', dirtySeq: 3 })

    const after = fs.readFileSync(logPath('s1'), 'utf-8')
    const prefixEnd = before.indexOf('"seq":3')
    expect(after.slice(0, prefixEnd)).toBe(before.slice(0, prefixEnd))
    expect(after).toContain('改写第三条')
    expect(driver.load('s1')).toEqual(session)
  })

  it('meta plan only touches meta.json', async () => {
    const session = makeSession('s1', 3)
    await driver.write('s1', session, { kind: 'structural' })
    const logBefore = fs.statSync(logPath('s1')).mtimeMs
    const contentBefore = fs.readFileSync(logPath('s1'), 'utf-8')

    const renamed = { ...session, name: '新名字' }
    await driver.write('s1', renamed, { kind: 'meta' })

    expect(fs.readFileSync(logPath('s1'), 'utf-8')).toBe(contentBefore)
    expect(fs.statSync(logPath('s1')).mtimeMs).toBe(logBefore)
    expect(driver.load('s1')?.name).toBe('新名字')
  })

  it('recovers from a crash-truncated log on load', async () => {
    const session = makeSession('s1', 4)
    await driver.write('s1', session, { kind: 'structural' })

    const raw = fs.readFileSync(logPath('s1'))
    fs.writeFileSync(logPath('s1'), raw.subarray(0, raw.length - 5))

    // 用新驱动实例模拟重启(丢弃内存状态)
    const fresh = createHybridSessionStorageDriver<TestSession>({
      getSessionsDir: () => dir,
      getLegacySessionPath: legacyPath,
      newSessionFormat: () => 'jsonl',
      readJsonFile: (filePath, fallback) => {
        try {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        } catch {
          return fallback
        }
      },
      writeJsonFileAsync: async (filePath, data) => {
        await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8')
      },
      deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
    })

    const loaded = fresh.load('s1')
    expect(loaded?.messages.map(m => m.id)).toEqual(['s1-m1', 's1-m2', 's1-m3'])

    // 修复后可以继续追加
    const repaired = { ...loaded!, messages: [...loaded!.messages, session.messages[3]] }
    await fresh.write('s1', repaired, { kind: 'message', dirtySeq: 4 })
    expect(fresh.load('s1')?.messages).toHaveLength(4)
  })

  it('serves tail pages cold without full scan and cursor pages warm', async () => {
    const session = makeSession('s1', 30)
    await driver.write('s1', session, { kind: 'structural' })

    const fresh = createHybridSessionStorageDriver<TestSession>({
      getSessionsDir: () => dir,
      getLegacySessionPath: legacyPath,
      newSessionFormat: () => 'jsonl',
      readJsonFile: (filePath, fallback) => {
        try {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        } catch {
          return fallback
        }
      },
      writeJsonFileAsync: async (filePath, data) => {
        await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8')
      },
      deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
    })

    const tail = fresh.getMessagesPage({ sessionId: 's1', limit: 10 })
    expect(tail?.success).toBe(true)
    expect(tail?.totalCount).toBe(30)
    expect(tail?.messages?.map(m => m.id)).toEqual(
      session.messages.slice(20).map(m => m.id),
    )
    expect(tail?.hasMoreBefore).toBe(true)

    const older = fresh.getMessagesPage({ sessionId: 's1', cursor: tail!.nextCursor!, limit: 10 })
    expect(older?.messages?.map(m => m.id)).toEqual(
      session.messages.slice(10, 20).map(m => m.id),
    )

    const anchored = fresh.getMessagesPage({ sessionId: 's1', anchor: { messageId: 's1-m5', before: 1, after: 1 } })
    expect(anchored?.messages?.map(m => m.id)).toEqual(['s1-m4', 's1-m5', 's1-m6'])
  })

  it('builds user message markers from the log', async () => {
    const session = makeSession('s1', 6)
    await driver.write('s1', session, { kind: 'structural' })

    const markers = driver.getUserMessageMarkers('s1')
    expect(markers?.map(m => m.seq)).toEqual([1, 3, 5])
    expect(markers?.[0]).toMatchObject({ id: 's1-m1', preview: '内容 1' })
  })

  it('returns undefined page for legacy sessions so callers fall back', async () => {
    newFormat = 'legacy-json'
    await driver.write('s1', makeSession('s1', 3), { kind: 'structural' })
    expect(driver.getMessagesPage({ sessionId: 's1' })).toBeUndefined()
    expect(driver.getUserMessageMarkers('s1')).toBeUndefined()
  })

  it('migrates a legacy session to jsonl with backup and round-trip', async () => {
    newFormat = 'legacy-json'
    const session = makeSession('s1', 8)
    await driver.write('s1', session, { kind: 'structural' })
    expect(driver.format('s1')).toBe('legacy-json')

    newFormat = 'jsonl'
    const migrated = await driver.migrateToJsonlNow('s1')
    expect(migrated).toBe(true)

    expect(driver.format('s1')).toBe('jsonl')
    expect(fs.existsSync(legacyPath('s1'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'legacy-backup', 's1.json'))).toBe(true)
    expect(driver.load('s1')).toEqual(session)

    // 迁移后继续追加走后缀写
    const next = { ...session, messages: [...session.messages, { id: 's1-m9', role: 'assistant' as const, content: '新增', timestamp: 1 }] }
    await driver.write('s1', next, { kind: 'message', dirtySeq: 9 })
    expect(driver.load('s1')?.messages).toHaveLength(9)
  })

  it('migration is a no-op for jsonl sessions and fails safely on corrupt legacy', async () => {
    await driver.write('s1', makeSession('s1', 2), { kind: 'structural' })
    expect(await driver.migrateToJsonlNow('s1')).toBe(true)

    fs.writeFileSync(legacyPath('s2'), 'not-json{{{')
    expect(await driver.migrateToJsonlNow('s2')).toBe(false)
    expect(fs.existsSync(path.join(dir, 's2'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 's2.migrating'))).toBe(false)
    // 原文件原样保留
    expect(fs.readFileSync(legacyPath('s2'), 'utf-8')).toBe('not-json{{{')
  })

  /**
   * S3w-2(§14.3-A / §14.6 S3w-3 行):`skipMessageWrites()` 为真时**消息写半边
   * 跳过,`meta.json` 照写**。
   *
   * 三条一起验,因为它们是同一件事的三面:抄本一个字节都不长、会话外壳仍然
   * 在更新、扳回去之后照写(这一档是开关,不是单程票)。
   */
  it('S3w-2: the off gear stops message writes but keeps meta.json', async () => {
    const first = makeSession('s1', 2)
    await driver.write('s1', first, { kind: 'structural' })
    const bytes = fs.statSync(logPath('s1')).size

    skipMessages = true
    const grown = { ...first, name: '改过名字', messages: [...first.messages, {
      id: 's1-m3', role: 'user' as const, content: '停写之后写的这一条', timestamp: 1700000000099,
    }] }
    await driver.write('s1', grown, { kind: 'message', dirtySeq: 3 })

    // 抄本一个字节都没长。
    expect(fs.statSync(logPath('s1')).size).toBe(bytes)
    expect(driver.load('s1')?.messages).toHaveLength(2)
    // 会话外壳照旧更新(名字与 log 索引都住 meta.json)。
    const meta = JSON.parse(fs.readFileSync(metaPath('s1'), 'utf-8'))
    expect(meta.name).toBe('改过名字')
    expect(meta.log.messageCount).toBe(3)

    // 全新会话:目录与 meta 立得起来,`messages.jsonl` 压根不出生。
    await driver.write('s2', makeSession('s2', 2), { kind: 'structural' })
    expect(fs.existsSync(metaPath('s2'))).toBe(true)
    expect(fs.existsSync(logPath('s2'))).toBe(false)

    // 反向:扳回去就照写(回滚零损伤)。
    skipMessages = false
    await driver.write('s1', grown, { kind: 'structural' })
    expect(driver.load('s1')?.messages).toHaveLength(3)
  })

  it('deletes jsonl session directories', async () => {
    await driver.write('s1', makeSession('s1', 2), { kind: 'structural' })
    driver.delete('s1')
    expect(fs.existsSync(path.join(dir, 's1'))).toBe(false)
    expect(driver.load('s1')).toBeUndefined()
  })
})
