/**
 * S2b:迁移 `--apply` / `--rollback` 的门(§11.2)。
 *
 * 两个脚本住在 `scripts/`(vitest 只扫 packages/apps),按相对路径 import 它们的
 * 纯函数;`main()` 由 `import.meta.url` 守着,import 时不会跑。这里钉住的是三件
 * 事:①谁被迁 / 谁不动(E0 迁、原生覆盖跳过、迁过的 no-op);②迁完 `verify`
 * 必须绿(投影 ≡ messages.jsonl);③备份 + 幂等 + 回滚。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts')
const { verifySession } = await import(path.join(scriptsDir, 'session-verify.ts'))
const { applySession, applyMigration, rollbackSession, rollbackMigration, coverageState } =
  await import(path.join(scriptsDir, 'migrate-sessions-events.mjs'))

let store = ''
let sessionsDir = ''

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-migrate-'))
  sessionsDir = path.join(store, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true })
})

function writeTranscript(sessionId: string, messages: Array<Record<string, unknown>>): void {
  const dir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ t: 'h', v: 1, sessionId })]
  messages.forEach((message, index) => lines.push(JSON.stringify({ t: 'm', seq: index + 1, m: message })))
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`)
}
function writeEvents(sessionId: string, records: Array<Record<string, unknown>>): void {
  const dir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), records.map(record => `${JSON.stringify(record)}\n`).join(''))
}
function readEvents(sessionId: string): Array<Record<string, unknown>> {
  const text = fs.readFileSync(path.join(sessionsDir, sessionId, 'events.jsonl'), 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** (a) legacy:只有 messages.jsonl,一条事件都没有。 */
function legacy(id = 'legacy'): void {
  writeTranscript(id, [
    { id: 'u1', role: 'user', content: 'hello', timestamp: 1000 },
    { id: 'a1', role: 'assistant', content: 'hi there', timestamp: 2000 },
    { id: 'u2', role: 'user', content: 'bye', timestamp: 3000 },
  ])
}

/** (b) mixed:全份 messages + 尾巴的 E0 事件(工具级,折不出任何消息节点)。 */
function mixed(id = 'mixed'): void {
  writeTranscript(id, [
    { id: 'u1', role: 'user', content: 'q1', timestamp: 1000 },
    { id: 'a1', role: 'assistant', content: 'a1', timestamp: 2000 },
    { id: 'u2', role: 'user', content: 'q2', timestamp: 3000 },
    { id: 'a2', role: 'assistant', content: 'a2', timestamp: 4000 },
  ])
  writeEvents(id, [
    { seq: 1, time: 3500, type: 'request/start', data: { requestIndex: 1, messageId: 'a2' } },
    { seq: 2, time: 3600, type: 'tool/call', data: { runId: 'r', callId: 'c1', name: 'bash', args: {} } },
    { seq: 3, time: 3700, type: 'tool/result', data: { runId: 'r', callId: 'c1', isError: false, resultPreview: 'ok', sourceSeq: 2 } },
    { seq: 4, time: 3800, type: 'request/end', data: { requestIndex: 1 } },
  ])
}

/** (c) already-migrated:事件里已有 message/imported(带内幂等标记)。 */
function alreadyMigrated(id = 'done'): void {
  writeTranscript(id, [{ id: 'u1', role: 'user', content: 'x', timestamp: 1000 }])
  writeEvents(id, [
    { seq: 1, time: 1000, type: 'message/imported', data: { message: { id: 'u1', role: 'user', content: 'x', timestamp: 1000 }, synthetic: true }, surfaceOp: 'append' },
  ])
}

/** 原生覆盖:有 user/message + run/start(投影出真消息)—— 迁移不许碰它。 */
function native(id = 'native'): void {
  writeTranscript(id, [
    { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'yo', timestamp: 2 },
  ])
  writeEvents(id, [
    { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2 }, surfaceOp: 'append' },
    { seq: 3, time: 3, type: 'assistant/chunks', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 1, dt: [0], text: ['yo'] } },
    { seq: 4, time: 4, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
  ])
}

describe('coverageState', () => {
  it('reads the coverage shape off the event types', () => {
    expect(coverageState([{ type: 'message/imported' }])).toBe('imported')
    expect(coverageState([{ type: 'user/message' }])).toBe('native')
    expect(coverageState([{ type: 'run/start' }])).toBe('native')
    expect(coverageState([{ type: 'tool/result' }, { type: 'request/end' }])).toBe('none')
    expect(coverageState([])).toBe('none')
  })
})

describe('migrate --apply', () => {
  it('migrates a legacy session to full message/imported and leaves messages.jsonl in legacy-backup', () => {
    legacy()
    const result = applySession(sessionsDir, 'legacy')
    expect(result.status).toBe('migrated')
    expect(result.imported).toBe(3)

    const events = readEvents('legacy')
    expect(events.map(e => e.type)).toEqual(['message/imported', 'message/imported', 'message/imported'])
    expect(events.map(e => e.seq)).toEqual([1, 2, 3])
    // 逐字段带原样消息 + synthetic + append + 时间戳用消息自己的。
    expect(events[0]).toMatchObject({ time: 1000, surfaceOp: 'append', data: { synthetic: true, message: { id: 'u1' } } })

    // 备份:messages.jsonl 复制进 legacy-backup/(原地那份还在)。
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'messages.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'legacy-backup', 'messages.jsonl'))).toBe(true)
    // 迁移前没有事件 = 没有 events 备份。
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'legacy-backup', 'events.jsonl'))).toBe(false)

    expect(verifySession(sessionsDir, 'legacy').issues).toEqual([])
  })

  it('inserts imported before existing E0 events and renumbers them + their seq references', () => {
    mixed()
    const result = applySession(sessionsDir, 'mixed')
    expect(result.status).toBe('migrated')
    expect(result).toMatchObject({ imported: 4, existingEvents: 4, shiftedBy: 4 })

    const events = readEvents('mixed')
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // imported 在前 4 条,E0 整体 +4。
    expect(events.slice(0, 4).every(e => e.type === 'message/imported')).toBe(true)
    const toolCall = events.find(e => e.type === 'tool/call')!
    const toolResult = events.find(e => e.type === 'tool/result')!
    expect(toolCall.seq).toBe(6)
    // sourceSeq 从 2 平移到 6,仍指向 tool/call。
    expect((toolResult.data as { sourceSeq: number }).sourceSeq).toBe(6)
    expect((toolResult.data as { sourceSeq: number }).sourceSeq).toBe(toolCall.seq)

    // events.jsonl 也备份了(迁移前有事件)。
    expect(fs.existsSync(path.join(sessionsDir, 'mixed', 'legacy-backup', 'events.jsonl'))).toBe(true)
    expect(verifySession(sessionsDir, 'mixed').issues).toEqual([])
  })

  it('remaps a tool/result sourceSeq when it renumbers the E0 events', () => {
    // 纯 E0(工具级,折不出消息节点)带一处 seq 引用:tool/result.sourceSeq → tool/call。
    writeTranscript('refs', [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }])
    writeEvents('refs', [
      { seq: 1, time: 1, type: 'tool/call', data: { runId: 'r', callId: 'c', name: 'x', args: {} } },
      { seq: 2, time: 2, type: 'tool/result', data: { runId: 'r', callId: 'c', isError: false, resultPreview: 'p', sourceSeq: 1 } },
    ])
    const result = applySession(sessionsDir, 'refs')
    expect(result.status).toBe('migrated')
    const events = readEvents('refs')
    // imported(1)+ E0(2,3)。sourceSeq 从 1 → 2。
    expect(events.map(e => e.seq)).toEqual([1, 2, 3])
    expect((events[2].data as { sourceSeq: number }).sourceSeq).toBe(2)
    expect(events[1].seq).toBe(2) // tool/call
    expect(verifySession(sessionsDir, 'refs').issues).toEqual([])
  })

  it('is a no-op on an already-migrated session (in-band marker)', () => {
    alreadyMigrated()
    const before = fs.readFileSync(path.join(sessionsDir, 'done', 'events.jsonl'), 'utf8')
    const result = applySession(sessionsDir, 'done')
    expect(result.status).toBe('noop')
    expect(fs.readFileSync(path.join(sessionsDir, 'done', 'events.jsonl'), 'utf8')).toBe(before)
    // 没写备份 / 标记。
    expect(fs.existsSync(path.join(sessionsDir, 'done', 'legacy-backup'))).toBe(false)
  })

  it('skips a session that already has native surface coverage instead of duplicating it', () => {
    native()
    const before = fs.readFileSync(path.join(sessionsDir, 'native', 'events.jsonl'), 'utf8')
    const result = applySession(sessionsDir, 'native')
    expect(result.status).toBe('skipped')
    // 一个字节都没动。
    expect(fs.readFileSync(path.join(sessionsDir, 'native', 'events.jsonl'), 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(sessionsDir, 'native', 'legacy-backup'))).toBe(false)
  })

  it('running --apply twice is idempotent (second pass is all no-op)', () => {
    legacy()
    mixed()
    const first = applyMigration(store)
    expect(first.tally).toMatchObject({ migrated: 2, noop: 0 })
    const second = applyMigration(store)
    expect(second.tally).toMatchObject({ migrated: 0, noop: 2 })
    expect(verifySession(sessionsDir, 'legacy').issues).toEqual([])
    expect(verifySession(sessionsDir, 'mixed').issues).toEqual([])
  })

  it('tallies mixed categories across the store', () => {
    legacy()
    mixed()
    alreadyMigrated()
    native()
    const summary = applyMigration(store)
    expect(summary.tally).toMatchObject({ migrated: 2, noop: 1, skipped: 1, error: 0 })
    // 迁完全绿。
    for (const id of ['legacy', 'mixed', 'done', 'native']) {
      expect(verifySession(sessionsDir, id).issues).toEqual([])
    }
  })

  it('refuses to clobber an existing backup', () => {
    legacy()
    fs.mkdirSync(path.join(sessionsDir, 'legacy', 'legacy-backup'), { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, 'legacy', 'legacy-backup', 'messages.jsonl'), 'earlier original')
    const result = applySession(sessionsDir, 'legacy')
    expect(result.status).toBe('error')
    // 没写坏正本 events.jsonl(迁移前压根没有)。
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'events.jsonl'))).toBe(false)
    expect(fs.readFileSync(path.join(sessionsDir, 'legacy', 'legacy-backup', 'messages.jsonl'), 'utf8')).toBe('earlier original')
  })
})

describe('migrate --rollback', () => {
  it('restores a legacy session by removing the synthesized events.jsonl', () => {
    legacy()
    applySession(sessionsDir, 'legacy')
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'events.jsonl'))).toBe(true)

    const result = rollbackSession(sessionsDir, 'legacy')
    expect(result.status).toBe('rolled-back')
    expect(result.restoredEvents).toBe(false)
    // 合成的 events.jsonl 删掉,messages.jsonl 原样还在,标记清掉。
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'events.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'messages.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(sessionsDir, 'legacy', 'legacy-backup', 'events-migration.json'))).toBe(false)
  })

  it('restores a mixed session back to its pre-migration E0 events', () => {
    mixed()
    const before = fs.readFileSync(path.join(sessionsDir, 'mixed', 'events.jsonl'), 'utf8')
    applySession(sessionsDir, 'mixed')
    const result = rollbackSession(sessionsDir, 'mixed')
    expect(result.status).toBe('rolled-back')
    expect(result.restoredEvents).toBe(true)
    expect(fs.readFileSync(path.join(sessionsDir, 'mixed', 'events.jsonl'), 'utf8')).toBe(before)
  })

  it('re-applying after a rollback works again', () => {
    legacy()
    applySession(sessionsDir, 'legacy')
    rollbackSession(sessionsDir, 'legacy')
    const again = applySession(sessionsDir, 'legacy')
    expect(again.status).toBe('migrated')
    expect(verifySession(sessionsDir, 'legacy').issues).toEqual([])
  })

  it('--all only touches sessions this script migrated (marker-guarded)', () => {
    legacy()
    mixed()
    alreadyMigrated() // seeded imported, no marker → not ours to roll back
    applyMigration(store)
    const summary = rollbackMigration(store, { all: true })
    const rolled = summary.results.filter((r: { status: string }) => r.status === 'rolled-back').map((r: { sessionId: string }) => r.sessionId).sort()
    expect(rolled).toEqual(['legacy', 'mixed'])
    // done 没被碰(它没有迁移标记)。
    expect(fs.existsSync(path.join(sessionsDir, 'done', 'events.jsonl'))).toBe(true)
  })

  it('reports not-migrated for a session without a marker', () => {
    legacy()
    expect(rollbackSession(sessionsDir, 'legacy').status).toBe('not-migrated')
  })
})
