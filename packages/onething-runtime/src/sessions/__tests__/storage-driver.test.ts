/**
 * 混合存储驱动 —— **S3w-3 批 6b 之后的形状**
 * (`docs/design/session-event-sourcing-2026-08.md` §15.22)。
 *
 * 这个文件问三件事,对应驱动今天剩下的三半:
 *  - **写**:只写 `meta.json`。`SessionWritePlan` 三档都不再有区别,存量
 *    `messages.jsonl` 一个字节都不许动(裁定 9a:原地只读)。
 *  - **读**:存量抄本的读半边原样活着 —— 整会话读回、崩溃截断自愈、冷尾页、
 *    游标页、锚点页、user marker。
 *  - **legacy 整文件**:首触**同步**迁进 `events.jsonl`(裁定 9b),逐条
 *    `message/imported`,原件进 legacy-backup。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeJsonlHeaderLine, encodeJsonlMessageLine } from '@onething/core/session'
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
  let driver: SessionStorageDriver<TestSession>

  const legacyPath = (id: string) => path.join(dir, `${id}.json`)
  const logPath = (id: string) => path.join(dir, id, 'messages.jsonl')
  const metaPath = (id: string) => path.join(dir, id, 'meta.json')
  const eventsPath = (id: string) => path.join(dir, id, 'events.jsonl')

  const driverOptions = () => ({
    getSessionsDir: () => dir,
    getLegacySessionPath: legacyPath,
    newSessionFormat: () => newFormat,
    readJsonFile: <TValue>(filePath: string, fallback: TValue): TValue => {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      } catch {
        return fallback
      }
    },
    writeJsonFileAsync: async (filePath: string, data: unknown) => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8')
    },
    deleteJsonFile: (filePath: string) => {
      fs.rmSync(filePath, { force: true })
    },
  })

  /** 停写之前留下的那份抄本(存量化石)——直接铺到盘上,驱动不再有路写出它。 */
  function seedTranscript(session: TestSession): void {
    fs.mkdirSync(path.join(dir, session.id), { recursive: true })
    let text = encodeJsonlHeaderLine(session.id)
    session.messages.forEach((message, index) => {
      text += encodeJsonlMessageLine(index + 1, message)
    })
    fs.writeFileSync(logPath(session.id), text, 'utf-8')
    const { messages, ...rest } = session
    fs.writeFileSync(
      metaPath(session.id),
      JSON.stringify({ ...rest, formatVersion: 2, log: { messageCount: messages.length, lastSeq: messages.length } }),
      'utf-8',
    )
  }

  function readEvents(id: string): Array<Record<string, unknown>> {
    return fs.readFileSync(eventsPath(id), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-jsonl-'))
    newFormat = 'jsonl'
    driver = createHybridSessionStorageDriver<TestSession>(driverOptions())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('propagates actual removal errors and retries event-only partial directories', () => {
    fs.mkdirSync(path.join(dir, 'partial'))
    fs.writeFileSync(eventsPath('partial'), 'retained event')
    const failure = Object.assign(new Error('removal failed'), { code: 'EIO' })
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw failure })
    expect(() => driver.delete('partial')).toThrow(failure)
    expect(fs.existsSync(eventsPath('partial'))).toBe(true)
    driver.delete('partial')
    expect(fs.existsSync(path.join(dir, 'partial'))).toBe(false)
  })

  it('rejects a legacy adapter that swallows its deletion failure', () => {
    fs.writeFileSync(legacyPath('legacy'), JSON.stringify(makeSession('legacy', 1)))
    const silentFailure = createHybridSessionStorageDriver<TestSession>({ ...driverOptions(), deleteJsonFile: () => false })
    expect(() => silentFailure.delete('legacy')).toThrow('Failed to delete legacy session file')
    expect(fs.existsSync(legacyPath('legacy'))).toBe(true)
    driver.delete('legacy')
    expect(fs.existsSync(legacyPath('legacy'))).toBe(false)
  })

  // ============ 写:只剩会话外壳 ============

  it('批 6b:新会话只落 meta.json,messages.jsonl 压根不出生', async () => {
    const session = makeSession('s1', 5)
    await driver.write('s1', session, { kind: 'structural' })

    expect(fs.existsSync(metaPath('s1'))).toBe(true)
    expect(fs.existsSync(logPath('s1'))).toBe(false)
    expect(fs.existsSync(legacyPath('s1'))).toBe(false)
    expect(driver.format('s1')).toBe('jsonl')

    // 外壳读得回来;消息那一格由装配层的投影补水填(驱动这里恒为空)。
    const loaded = driver.load('s1')
    expect(loaded?.name).toBe('会话 s1')
    expect(loaded?.messages).toEqual([])

    // 会话外壳照旧更新,`log` 索引跟着内存里的条数走。
    await driver.write('s1', { ...session, name: '改过名字' }, { kind: 'meta' })
    const meta = JSON.parse(fs.readFileSync(metaPath('s1'), 'utf-8'))
    expect(meta.name).toBe('改过名字')
    expect(meta.log.messageCount).toBe(5)
  })

  it('批 6b:三档写计划对存量抄本一视同仁 —— 一个字节都不动(裁定 9a)', async () => {
    const session = makeSession('s1', 4)
    seedTranscript(session)
    const before = fs.readFileSync(logPath('s1'), 'utf-8')

    const grown = {
      ...session,
      name: '改过名字',
      messages: [...session.messages, { id: 's1-m5', role: 'user' as const, content: '停写之后', timestamp: 1 }],
    }
    await driver.write('s1', grown, { kind: 'message', dirtySeq: 5 })
    await driver.write('s1', grown, { kind: 'structural' })
    await driver.write('s1', grown, { kind: 'meta' })

    expect(fs.readFileSync(logPath('s1'), 'utf-8')).toBe(before)
    // 读半边照旧从化石里读回那 4 条(不是 5 条 —— 抄本停在停写那一刻)。
    expect(driver.load('s1')?.messages).toHaveLength(4)
    expect(driver.load('s1')?.name).toBe('改过名字')
  })

  it('新建格式关掉时新会话仍走 legacy,已有 jsonl 会话照旧走 jsonl', async () => {
    await driver.write('s1', makeSession('s1', 2), { kind: 'structural' })

    newFormat = 'legacy-json'
    const legacySession = makeSession('s2', 2)
    await driver.write('s2', legacySession, { kind: 'structural' })

    expect(fs.existsSync(legacyPath('s2'))).toBe(true)
    expect(fs.existsSync(metaPath('s2'))).toBe(false)
    expect(driver.format('s1')).toBe('jsonl')
    expect(driver.load('s1')?.name).toBe('会话 s1')
  })

  // ============ 读:存量抄本的只读半边 ============

  it('存量抄本整会话读得回来', () => {
    const session = makeSession('s1', 5)
    seedTranscript(session)
    expect(driver.load('s1')).toEqual(session)
  })

  it('崩溃截断的抄本在读时自愈(截到最后一条完整行)', () => {
    const session = makeSession('s1', 4)
    seedTranscript(session)

    const raw = fs.readFileSync(logPath('s1'))
    fs.writeFileSync(logPath('s1'), raw.subarray(0, raw.length - 5))

    // 用新驱动实例模拟重启(丢弃内存状态)
    const fresh = createHybridSessionStorageDriver<TestSession>(driverOptions())
    expect(fresh.load('s1')?.messages.map(m => m.id)).toEqual(['s1-m1', 's1-m2', 's1-m3'])
  })

  it('冷尾页不做全量扫描,游标页与锚点页照旧', () => {
    seedTranscript(makeSession('s1', 30))
    const session = makeSession('s1', 30)
    const fresh = createHybridSessionStorageDriver<TestSession>(driverOptions())

    const tail = fresh.getMessagesPage({ sessionId: 's1', limit: 10 })
    expect(tail?.success).toBe(true)
    expect(tail?.totalCount).toBe(30)
    expect(tail?.messages?.map(m => m.id)).toEqual(session.messages.slice(20).map(m => m.id))
    expect(tail?.hasMoreBefore).toBe(true)

    const older = fresh.getMessagesPage({ sessionId: 's1', cursor: tail!.nextCursor!, limit: 10 })
    expect(older?.messages?.map(m => m.id)).toEqual(session.messages.slice(10, 20).map(m => m.id))

    const anchored = fresh.getMessagesPage({ sessionId: 's1', anchor: { messageId: 's1-m5', before: 1, after: 1 } })
    expect(anchored?.messages?.map(m => m.id)).toEqual(['s1-m4', 's1-m5', 's1-m6'])
  })

  it('user marker 仍从存量抄本折出来', () => {
    seedTranscript(makeSession('s1', 6))
    const markers = driver.getUserMessageMarkers('s1')
    expect(markers?.map(m => m.seq)).toEqual([1, 3, 5])
    expect(markers?.[0]).toMatchObject({ id: 's1-m1', preview: '内容 1' })
  })

  it('legacy 会话与停写后出生的会话都给不出分页(调用方降级)', async () => {
    newFormat = 'legacy-json'
    await driver.write('s1', makeSession('s1', 3), { kind: 'structural' })
    expect(driver.getMessagesPage({ sessionId: 's1' })).toBeUndefined()
    expect(driver.getUserMessageMarkers('s1')).toBeUndefined()

    newFormat = 'jsonl'
    await driver.write('s2', makeSession('s2', 3), { kind: 'structural' })
    // 有会话目录、**没有抄本文件**:两口都答"给不出"(`undefined`),让调用方降级。
    // 不许答"理直气壮的空页" —— 那会把调用方的降级链整条短路掉(批 6b 的实测坑,
    // 见 `hasTranscript` 的注释)。冷/热两态都要成立,所以先把状态焐热再问一遍。
    expect(driver.getMessagesPage({ sessionId: 's2' })).toBeUndefined()
    expect(driver.getUserMessageMarkers('s2')).toBeUndefined()
    driver.load('s2')
    expect(driver.getMessagesPage({ sessionId: 's2' })).toBeUndefined()
    expect(driver.getUserMessageMarkers('s2')).toBeUndefined()
  })

  // ============ 裁定 9b:legacy 整文件 → 事件账本 ============

  it('裁定 9b:冷加载 legacy 整文件会话 = 同步迁进 events.jsonl,原件进 legacy-backup', async () => {
    newFormat = 'legacy-json'
    const session = makeSession('s1', 8)
    await driver.write('s1', session, { kind: 'structural' })
    expect(driver.format('s1')).toBe('legacy-json')

    newFormat = 'jsonl'
    // 触发点就是冷加载本身 —— 不再有 1 秒的惰性窗口。
    const loaded = driver.load('s1')

    expect(driver.format('s1')).toBe('jsonl')
    expect(fs.existsSync(legacyPath('s1'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'legacy-backup', 's1.json'))).toBe(true)
    // **迁进的是事件,不是抄本**。
    expect(fs.existsSync(logPath('s1'))).toBe(false)

    const events = readEvents('s1')
    expect(events).toHaveLength(8)
    expect(events.every(record => record.type === 'message/imported')).toBe(true)
    expect(events.map(record => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(events[0]).toMatchObject({
      time: session.messages[0].timestamp,
      surfaceOp: 'append',
      data: { message: session.messages[0], synthetic: true },
    })

    // **这一次仍然交出手里那一份**(带消息)—— 迁移是为了让下一次冷加载能从事件里
    // 折出它,不是为了让这一次读不到(不是每只仓库都装了投影补水)。
    expect(loaded?.name).toBe('会话 s1')
    expect(loaded?.messages.map(m => m.id)).toEqual(session.messages.map(m => m.id))
  })

  it('裁定 9b:已是事件会话 = no-op;坏掉的 legacy 文件安全失败', () => {
    fs.mkdirSync(path.join(dir, 's1'), { recursive: true })
    fs.writeFileSync(eventsPath('s1'), '')
    expect(driver.migrateLegacySessionNow('s1')).toBe(true)

    fs.writeFileSync(legacyPath('s2'), 'not-json{{{')
    expect(driver.migrateLegacySessionNow('s2')).toBe(false)
    expect(fs.existsSync(path.join(dir, 's2'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 's2.migrating'))).toBe(false)
    // 原文件原样保留
    expect(fs.readFileSync(legacyPath('s2'), 'utf-8')).toBe('not-json{{{')
  })

  it('裁定 9b:没有 legacy 文件也没有会话目录 = 无事可迁', () => {
    expect(driver.migrateLegacySessionNow('nope')).toBe(false)
    expect(driver.load('nope')).toBeUndefined()
  })

  it('deletes jsonl session directories', async () => {
    await driver.write('s1', makeSession('s1', 2), { kind: 'structural' })
    driver.delete('s1')
    expect(fs.existsSync(path.join(dir, 's1'))).toBe(false)
    expect(driver.load('s1')).toBeUndefined()
  })
})
