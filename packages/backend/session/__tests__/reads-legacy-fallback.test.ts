/**
 * 读路的取数顺序:**投影优先,旧抄本只兜空**(工单 4 A4)。
 *
 * 2026-09-06/07 那轮把 `messagesForRead` 写成 `legacyMessages(id) ?? 投影` ——
 * 一份只读化石排在今天唯一的账本前面。这里把顺序钉死,并顺带钉住那条
 * 「这条会话没有旧抄本」的否定缓存(每次列消息白拍 1–3 次 `existsSync`)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeJsonlHeaderLine, encodeJsonlMessageLine } from '@onething/core/session'
import { createSessionReads } from '../reads.js'

let sessionsDir = ''

function writeFossil(sessionId: string, content: string): void {
  const dir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    encodeJsonlHeaderLine(sessionId) +
      encodeJsonlMessageLine(1, { id: 'f1', role: 'assistant', content, timestamp: 1 }),
  )
}

function createReads(projection: (id: string) => unknown[] | undefined) {
  return createSessionReads({
    store: {} as never,
    events: { eventsListMessages: (id: string) => projection(id) } as never,
    getProjection: (() => undefined) as never,
    materializeOptions: (() => ({})) as never,
    getSessionsDir: () => sessionsDir,
  })
}

beforeEach(() => {
  sessionsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-reads-legacy-')), 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(path.dirname(sessionsDir), { recursive: true, force: true })
})

describe('listMessages 的取数顺序', () => {
  it('投影折得出内容时,盘上的旧抄本一个字也读不到', () => {
    writeFossil('s1', 'FOSSIL')
    const reads = createReads(() => [{ id: 'a1', role: 'assistant', content: 'LEDGER', timestamp: 2 }])

    const { messages } = reads.listMessages('s1')

    expect(messages.map(m => m.content)).toEqual(['LEDGER'])
    reads.dispose()
  })

  it('投影为空时才轮到旧抄本(尚未有 events.jsonl 的历史会话)', () => {
    writeFossil('s2', 'FOSSIL')
    const reads = createReads(() => [])

    expect(reads.listMessages('s2').messages.map(m => m.content)).toEqual(['FOSSIL'])
    reads.dispose()
  })

  it('两边都空就是空,不报错', () => {
    const reads = createReads(() => [])
    expect(reads.listMessages('s3').messages).toEqual([])
    reads.dispose()
  })

  it('「这条会话没有旧抄本」只问盘一次', () => {
    const reads = createReads(() => [])
    const existsSync = vi.spyOn(fs, 'existsSync')

    reads.listMessages('s4')
    const first = existsSync.mock.calls.length
    expect(first).toBeGreaterThan(0)
    reads.listMessages('s4')
    reads.listMessages('s4')

    expect(existsSync.mock.calls.length).toBe(first)

    // 会话删除时那一格记忆跟着丢:同一个 id 重新出现要重新问盘。
    reads.forgetSession('s4')
    reads.listMessages('s4')
    expect(existsSync.mock.calls.length).toBe(first * 2)
    reads.dispose()
  })
})
