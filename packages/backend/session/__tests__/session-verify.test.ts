/**
 * S2a:`sessions:verify` 与迁移 `--dry-run` 的门。
 *
 * 两个脚本都住在 `scripts/`(vitest 的 include 只扫 packages/apps),所以按相对
 * 路径 import 它们的纯函数;`main()` 由 `import.meta.url` 守着,不会在 import
 * 时跑。用例喂的是真的 fixture 目录 —— 脚本读的就是那些文件。
 *
 * 迁移那一半最该被钉住的是**它什么都不写**:一条 `--apply` 的路都不许存在,
 * dry-run 跑完目录的字节数与文件数必须一模一样。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts')
const { verifySession, listSessionIds } = await import(path.join(scriptsDir, 'session-verify.ts'))
const { buildPlan, planSession, detectLiveness, blockingLivenessReason } =
  await import(path.join(scriptsDir, 'migrate-sessions-events.mjs'))

let store = ''
let sessionsDir = ''

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-verify-'))
  sessionsDir = path.join(store, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true })
})

function writeEvents(sessionId: string, records: Array<Record<string, unknown>>): void {
  const dir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), records.map(record => `${JSON.stringify(record)}\n`).join(''))
}

function writeTranscript(sessionId: string, messages: Array<Record<string, unknown>>): void {
  const dir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ t: 'h', v: 1, sessionId })]
  messages.forEach((message, index) => lines.push(JSON.stringify({ t: 'm', seq: index + 1, m: message })))
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`)
}

/** 一条健康的会话:两条消息,seq 连续,surface 自洽。 */
function healthy(sessionId = 'ok'): void {
  writeEvents(sessionId, [
    { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2 }, surfaceOp: 'append' },
    { seq: 3, time: 3, type: 'assistant/chunks', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 1, dt: [0], text: ['yo'] } },
    { seq: 4, time: 4, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
  ])
  writeTranscript(sessionId, [
    { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'yo', timestamp: 2 },
  ])
}

describe('sessions:verify', () => {
  it('passes a healthy session and counts what it folded', () => {
    healthy()
    const report = verifySession(sessionsDir, 'ok')
    expect(report.issues).toEqual([])
    expect(report).toMatchObject({ events: 4, messages: 2, noEventHistory: false })
  })

  it('flags a seq hole, an unclosed run, a missing blob and a surface violation', () => {
    writeEvents('broken', [
      { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1, attachments: [{ id: 'x', fileName: 'a.png', mimeType: 'image/png', base64Data: { hash: 'deadbeef', bytes: 4 } }] } }, surfaceOp: 'append' },
      { seq: 3, time: 3, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' },
      { seq: 4, time: 4, type: 'session/compacted', data: { summary: 's', messageId: 'k1', compactedMessageCount: 1, status: 'completed' }, surfaceOp: { op: 'replace', start: 99, end: 99 }, sourceEventSeqs: [99] },
    ])
    const kinds = verifySession(sessionsDir, 'broken').issues.map((issue: { kind: string }) => issue.kind)
    expect(kinds).toContain('seq')
    expect(kinds).toContain('surface')
    expect(kinds).toContain('blob')
    expect(kinds).toContain('unclosed-run')
  })

  it('does not blame an old session that has no event history yet', () => {
    writeEvents('legacy', [
      { seq: 1, time: 1, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
    ])
    writeTranscript('legacy', [{ id: 'm1', role: 'user', content: 'old', timestamp: 1 }])
    const report = verifySession(sessionsDir, 'legacy')
    expect(report.noEventHistory).toBe(true)
    expect(report.issues).toEqual([])
  })

  it('reports a transcript that tells a different story', () => {
    healthy('drift')
    writeTranscript('drift', [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }])
    expect(verifySession(sessionsDir, 'drift').issues.map((issue: { kind: string }) => issue.kind)).toContain('messages')
  })

  /**
   * §13.17 裁定三 反向用例:老形态(stepOnly)会话 —— `toolCall.changes` 只在
   * `steps[].toolCall`,顶层 `toolCalls[]` 没有。迁移把整条消息合成
   * `message/imported`(逐字带着 stepOnly 形态);投影侧过
   * `dehydrateProjectedMessages` 把 changes 归并到顶层。counterpart(磁盘)侧
   * 若只走 `rehydrateSessionFromStorage`,changes 留在 step 上、顶层空 → canonical
   * 在 `toolCalls[].changes` 上分叉 → 'messages' 红。两侧同走
   * `dehydrateProjectedMessages` 后归一,消失。
   */
  it('does not blame a stepOnly legacy session once both sides normalize the same way', () => {
    const stepOnlyMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'edited',
      timestamp: 2,
      // stepOnly: 顶层没有 changes
      toolCalls: [{ id: 'tc1', toolName: 'edit', status: 'completed', result: 'ok' }],
      steps: [{
        type: 'tool-call',
        toolCallId: 'tc1',
        status: 'completed',
        timestamp: 2,
        toolCall: {
          id: 'tc1',
          toolName: 'edit',
          status: 'completed',
          result: 'ok',
          changes: { hunks: [{ a: 1, b: 2 }], summary: 'edited' },
        },
      }],
    }
    const userMessage = { id: 'u1', role: 'user', content: 'edit it', timestamp: 1 }
    // 迁移形态:一条消息 = 一条 message/imported，surfaceOp append，seq 连续。
    writeEvents('steponly', [
      { seq: 1, time: 1, type: 'message/imported', data: { message: userMessage }, surfaceOp: 'append' },
      { seq: 2, time: 2, type: 'message/imported', data: { message: stepOnlyMessage }, surfaceOp: 'append' },
    ])
    writeTranscript('steponly', [userMessage, stepOnlyMessage])

    const kinds = verifySession(sessionsDir, 'steponly').issues.map((issue: { kind: string }) => issue.kind)
    expect(kinds).not.toContain('messages')
  })

  it('lists session directories but never legacy-backup', () => {
    healthy('a')
    healthy('b')
    fs.mkdirSync(path.join(sessionsDir, 'legacy-backup'), { recursive: true })
    expect(listSessionIds(sessionsDir)).toEqual(['a', 'b'])
  })
})

describe('migrate --dry-run', () => {
  it('estimates imported events, bytes and the renumbering plan', () => {
    healthy('with-events')
    writeTranscript('plain', [
      { id: 'u1', role: 'user', content: 'a', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'b', timestamp: 2 },
      { id: 'u2', role: 'user', content: 'c', timestamp: 3 },
    ])

    const withEvents = planSession(sessionsDir, 'with-events')
    expect(withEvents.imported).toBe(2)
    expect(withEvents.renumber).toEqual({ shift: 2, events: 4, references: 0 })
    expect(withEvents.bytesAfter).toBeGreaterThan(withEvents.bytesBefore)

    const plain = planSession(sessionsDir, 'plain')
    expect(plain.imported).toBe(3)
    // 没有已有事件 = 没有重编号这回事。
    expect(plain.renumber).toBeUndefined()
  })

  it('counts the seq references that a renumbering would have to rewrite', () => {
    writeEvents('refs', [
      { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } }, surfaceOp: 'append' },
      { seq: 2, time: 2, type: 'tool/result', data: { runId: 'r', callId: 'c', isError: false, resultPreview: 'p', sourceSeq: 1 } },
      { seq: 3, time: 3, type: 'session/compacted', data: { summary: 's', messageId: 'k', compactedMessageCount: 1, status: 'completed' }, surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] },
    ])
    writeTranscript('refs', [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }])
    // 2 处 surfaceOp(start/end)+ 1 处 sourceEventSeqs + 1 处 sourceSeq。
    expect(planSession(sessionsDir, 'refs').renumber).toEqual({ shift: 1, events: 3, references: 4 })
  })

  it('lists unknown files instead of quietly deciding for them', () => {
    healthy('ok')
    fs.writeFileSync(path.join(sessionsDir, 'ok', '.meta.json.123.tmp'), 'x')
    fs.writeFileSync(path.join(sessionsDir, '.DS_Store'), 'x')
    fs.mkdirSync(path.join(sessionsDir, 'ok', 'blobs'), { recursive: true })

    const plan = buildPlan(store)
    expect(plan.unknown).toContain('sessions/.DS_Store')
    expect(plan.unknown).toContain('ok/.meta.json.123.tmp')
    // blobs/ 在白名单里。
    expect(plan.unknown.some((name: string) => name.includes('blobs'))).toBe(false)
  })

  it('writes nothing at all', () => {
    healthy('ok')
    const before = fs.readdirSync(path.join(sessionsDir, 'ok')).map(name => ({
      name, size: fs.statSync(path.join(sessionsDir, 'ok', name)).size,
    }))
    buildPlan(store)
    expect(fs.readdirSync(path.join(sessionsDir, 'ok')).map(name => ({
      name, size: fs.statSync(path.join(sessionsDir, 'ok', name)).size,
    }))).toEqual(before)
  })

  it('detects a live store owner, and calls a stale lock stale', () => {
    fs.mkdirSync(path.join(store, 'run'), { recursive: true })
    fs.writeFileSync(path.join(store, 'run', 'backend.lock'), JSON.stringify({ pid: process.pid, owner: 'desktop', acquiredAt: 1 }))
    expect(detectLiveness(store)).toMatchObject({ alive: true, lock: { owner: 'desktop' } })

    // 一个几乎不可能存在的 pid = 陈旧的锁。
    fs.writeFileSync(path.join(store, 'run', 'backend.lock'), JSON.stringify({ pid: 999_999, owner: 'desktop', acquiredAt: 1 }))
    expect(detectLiveness(store).alive).toBe(false)
  })

  /**
   * R-c(2026-08-20 裁定,§13.6):活的 core = **硬拦**,没有绕过开关。
   *
   * 理由不是洁癖:迁移要重编号整份 `events.jsonl`,而活着的 core 正拿着内存里的
   * seq 计数器往同一个文件追加 —— 撞号之后 replace 遮蔽的是别人的区间,而校验
   * 会照样放行。
   */
  it('R-c: a live core blocks the migration outright', async () => {
    fs.mkdirSync(path.join(store, 'run'), { recursive: true })
    fs.writeFileSync(
      path.join(store, 'run', 'backend.lock'),
      JSON.stringify({ pid: process.pid, owner: 'desktop', acquiredAt: 1 }),
    )
    const reason = await blockingLivenessReason(detectLiveness(store))
    expect(reason).toBeTruthy()

    // 陈旧的发现文件(pid 不在)拦不住 —— 那不是"有人在用"。
    fs.writeFileSync(
      path.join(store, 'run', 'backend.lock'),
      JSON.stringify({ pid: 999_999, owner: 'desktop', acquiredAt: 1 }),
    )
    expect(await blockingLivenessReason(detectLiveness(store))).toBeUndefined()
  })
})
