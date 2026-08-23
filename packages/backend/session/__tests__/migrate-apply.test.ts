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

/**
 * 真·混合覆盖(S1 升级切面):messages.jsonl 有 4 条(u1/a1 头 + u2/a2 尾),
 * events.jsonl 只从升级点起覆盖尾巴(u2 的 user/message + a2 的 run)—— 头未覆盖。
 * 覆盖是干净前缀/后缀,所以合并:导入 u1/a1,尾巴事件整体重编号留后。
 */
function mixedNative(id = 'mixnat'): void {
  writeTranscript(id, [
    { id: 'u1', role: 'user', content: 'q1(升级前,只在 messages)', timestamp: 1000 },
    { id: 'a1', role: 'assistant', content: 'a1(升级前)', timestamp: 2000 },
    { id: 'u2', role: 'user', content: 'q2(升级后)', timestamp: 3000 },
    // a2.timestamp 与 run/start.data.timestamp 一致(投影从后者取助手时刻)。
    { id: 'a2', role: 'assistant', content: 'a2(升级后)', timestamp: 3500 },
  ])
  writeEvents(id, [
    { seq: 1, time: 3000, type: 'user/message', data: { message: { id: 'u2', role: 'user', content: 'q2(升级后)', timestamp: 3000 } }, surfaceOp: 'append' },
    { seq: 2, time: 3500, type: 'run/start', data: { runId: 'r2', kind: 'send', assistantMessageId: 'a2', timestamp: 3500 }, surfaceOp: 'append' },
    { seq: 3, time: 3600, type: 'assistant/chunks', data: { runId: 'r2', requestIndex: 1, messageId: 'a2', partIndex: 0, kind: 'text', time0: 1, dt: [0], text: ['a2(升级后)'] } },
    { seq: 4, time: 4000, type: 'run/end', data: { runId: 'r2', outcome: 'completed' } },
  ])
}

/**
 * 有洞的混合:尾巴里 a2 被 run 覆盖,但它后面的 u3 没有任何事件覆盖 ——
 * 覆盖不是干净后缀。朴素导入会把 a2 导重、撞 id,所以必须跳过(不硬合)。
 */
function holeyMixed(id = 'holey'): void {
  writeTranscript(id, [
    { id: 'u1', role: 'user', content: 'q1', timestamp: 1000 },
    { id: 'a1', role: 'assistant', content: 'a1', timestamp: 2000 },
    { id: 'u2', role: 'user', content: 'q2', timestamp: 3000 },
    { id: 'a2', role: 'assistant', content: 'a2', timestamp: 4000 },
    { id: 'u3', role: 'user', content: 'q3(尾巴里没被事件覆盖 = 洞)', timestamp: 5000 },
  ])
  writeEvents(id, [
    { seq: 1, time: 3500, type: 'run/start', data: { runId: 'r2', kind: 'send', assistantMessageId: 'a2', timestamp: 3500 }, surfaceOp: 'append' },
    { seq: 2, time: 3600, type: 'assistant/chunks', data: { runId: 'r2', requestIndex: 1, messageId: 'a2', partIndex: 0, kind: 'text', time0: 1, dt: [0], text: ['a2'] } },
    { seq: 3, time: 4000, type: 'run/end', data: { runId: 'r2', outcome: 'completed' } },
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

  it('leaves a fully event-covered native session untouched (status covered, no head to import)', () => {
    native()
    const before = fs.readFileSync(path.join(sessionsDir, 'native', 'events.jsonl'), 'utf8')
    const result = applySession(sessionsDir, 'native')
    expect(result.status).toBe('covered')
    // 一个字节都没动 —— 事件已全覆盖,不需要迁移(切读后照样读回全部)。
    expect(fs.readFileSync(path.join(sessionsDir, 'native', 'events.jsonl'), 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(sessionsDir, 'native', 'legacy-backup'))).toBe(false)
  })

  it('merges a truly-mixed session: imports only the uncovered head, keeps+renumbers the covered tail', () => {
    mixedNative()
    const result = applySession(sessionsDir, 'mixnat')
    // 头 2 条(u1/a1)未被事件覆盖 → 导入;尾 4 条事件(u2/a2 的 run)整体 +2 重编号。
    expect(result.status).toBe('merged')
    expect(result).toMatchObject({ imported: 2, existingEvents: 4, shiftedBy: 2, firstCoveredIndex: 2 })

    const events = readEvents('mixnat')
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    // 前 2 条是 imported 头(u1/a1),后 4 条是原生尾(u2 的 user/message + a2 的 run)。
    expect(events.slice(0, 2).every(e => e.type === 'message/imported')).toBe(true)
    expect((events[0].data as { message: { id: string } }).message.id).toBe('u1')
    expect((events[1].data as { message: { id: string } }).message.id).toBe('a1')
    expect(events[2].type).toBe('user/message')
    // 投影 = 头 + 尾 = 全份 messages.jsonl(切读后不再丢头)。
    expect(verifySession(sessionsDir, 'mixnat').issues).toEqual([])
    // 备份:messages + 迁移前的 events 都进 legacy-backup/。
    expect(fs.existsSync(path.join(sessionsDir, 'mixnat', 'legacy-backup', 'messages.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(sessionsDir, 'mixnat', 'legacy-backup', 'events.jsonl'))).toBe(true)
  })

  it('re-merging a merged session is a no-op (in-band imported marker)', () => {
    mixedNative()
    applySession(sessionsDir, 'mixnat')
    const before = fs.readFileSync(path.join(sessionsDir, 'mixnat', 'events.jsonl'), 'utf8')
    const second = applySession(sessionsDir, 'mixnat')
    expect(second.status).toBe('noop')
    expect(fs.readFileSync(path.join(sessionsDir, 'mixnat', 'events.jsonl'), 'utf8')).toBe(before)
  })

  it('skips a mixed session whose coverage is not a clean suffix (hole in the tail)', () => {
    // 尾巴里 a2 被覆盖但 u3 没有 —— 有洞,朴素导入会撞 id,须人工处理。
    holeyMixed()
    const before = fs.readFileSync(path.join(sessionsDir, 'holey', 'events.jsonl'), 'utf8')
    const result = applySession(sessionsDir, 'holey')
    expect(result.status).toBe('skipped')
    // 一个字节都没动,不硬合。
    expect(fs.readFileSync(path.join(sessionsDir, 'holey', 'events.jsonl'), 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(sessionsDir, 'holey', 'legacy-backup'))).toBe(false)
  })

  it('skips a session (native) where a run/start has NO covered assistant id fallback — but merges when it does', () => {
    // 这条钉住覆盖 id 的提取:run/start → assistantMessageId 必须被认作已覆盖,
    // 否则 a2 会被当成未覆盖、落进洞里而错误跳过。
    mixedNative('mixnat2')
    expect(applySession(sessionsDir, 'mixnat2').status).toBe('merged')
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
    mixedNative()
    const summary = applyMigration(store)
    // native 已全覆盖 → covered;mixnat 混合 → merged;legacy/mixed → migrated;done → noop。
    expect(summary.tally).toMatchObject({ migrated: 2, merged: 1, covered: 1, noop: 1, skipped: 0, error: 0 })
    // 迁完全绿。
    for (const id of ['legacy', 'mixed', 'done', 'native', 'mixnat']) {
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

  it('restores a merged (mixed-coverage) session back to its pre-merge tail events', () => {
    mixedNative()
    const before = fs.readFileSync(path.join(sessionsDir, 'mixnat', 'events.jsonl'), 'utf8')
    expect(applySession(sessionsDir, 'mixnat').status).toBe('merged')
    const result = rollbackSession(sessionsDir, 'mixnat')
    expect(result.status).toBe('rolled-back')
    expect(result.restoredEvents).toBe(true)
    // 尾巴事件逐字节复原,messages.jsonl 从未被动过。
    expect(fs.readFileSync(path.join(sessionsDir, 'mixnat', 'events.jsonl'), 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(sessionsDir, 'mixnat', 'legacy-backup', 'events-migration.json'))).toBe(false)
    // 复原后可再合并。
    expect(applySession(sessionsDir, 'mixnat').status).toBe('merged')
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
