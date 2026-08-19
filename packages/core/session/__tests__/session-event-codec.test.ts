/**
 * S0 事件词表 + 编解码(docs/design/session-event-sourcing-2026-08.md §9.1/§9.2)。
 *
 * 这一份钉的是**读侧的向后兼容**:盘上已经有 5 份 `events.jsonl`,总计一千多条
 * 七类记录。词表放大之后,它们必须一行不少地读出来,字段一个不改。
 * `fixtures/legacy-events.jsonl` 是真机文件的逐字节子集(真实会话
 * `fd899977…` 的第 2–33 行,含全部七类)。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  decodeSessionLogEventLine,
  encodeSessionLogEventLine,
  isBlobRef,
  isSessionLogEventType,
  isSessionSurfaceNodeType,
  parseSessionLogEventLog,
  SESSION_LEGACY_EVENT_TYPES,
  SESSION_LOG_EVENT_TABLE_IS_EXHAUSTIVE,
  SESSION_LOG_EVENT_TYPES,
  SESSION_SURFACE_EVENTS_CARRY_NO_MESSAGE_BODY,
} from '../events/index.js'
import type { SessionLogEventRecord } from '../events/index.js'

const FIXTURE = readFileSync(join(__dirname, 'fixtures/legacy-events.jsonl'), 'utf-8')

describe('session event vocabulary v2', () => {
  it('keeps the type table exhaustive in both directions', () => {
    // 类型级守卫;这两行只是让它们在运行时也被引用一次(否则 tree-shake 掉了
    // 编译期的红也照样红,但读测试的人看不见它们存在)。
    expect(SESSION_LOG_EVENT_TABLE_IS_EXHAUSTIVE).toBe(true)
    expect(SESSION_SURFACE_EVENTS_CARRY_NO_MESSAGE_BODY).toBe(true)
    expect(new Set(SESSION_LOG_EVENT_TYPES).size).toBe(SESSION_LOG_EVENT_TYPES.length)
  })

  it('still contains the E0 seven types, in the original order', () => {
    expect(SESSION_LEGACY_EVENT_TYPES).toEqual([
      'request/tools',
      'request/header',
      'request/start',
      'assistant/first-token',
      'tool/call',
      'tool/result',
      'tool/audit',
      'request/end',
    ])
    expect(SESSION_LOG_EVENT_TYPES.slice(0, 8)).toEqual([...SESSION_LEGACY_EVENT_TYPES])
  })

  it('classifies surface node types', () => {
    expect(isSessionSurfaceNodeType('user/message')).toBe(true)
    expect(isSessionSurfaceNodeType('run/start')).toBe(true)
    expect(isSessionSurfaceNodeType('tool/result')).toBe(true)
    // 带 replace op 但不是节点:纯遮蔽。
    expect(isSessionSurfaceNodeType('message/deleted')).toBe(false)
    expect(isSessionSurfaceNodeType('session/cleared')).toBe(false)
    expect(isSessionSurfaceNodeType('request/header')).toBe(false)
  })

  it('accepts every type in the table and rejects strays', () => {
    for (const type of SESSION_LOG_EVENT_TYPES) {
      expect(isSessionLogEventType(type)).toBe(true)
    }
    expect(isSessionLogEventType('session/exploded')).toBe(false)
    expect(isSessionLogEventType(42)).toBe(false)
  })
})

describe('codec backward compatibility', () => {
  it('reads a real E0 log line for line, with no field lost', () => {
    const raw = FIXTURE.split('\n').filter(Boolean)
    const parsed = parseSessionLogEventLog(FIXTURE)
    expect(parsed).toHaveLength(raw.length)

    // 逐行逐字节:decode → encode 必须回到原文(键序也不变,因为 decode 就是
    // JSON.parse 的结果本体)。任何一条被"顺手规整"过都会在这里现形。
    for (let index = 0; index < raw.length; index++) {
      expect(encodeSessionLogEventLine(parsed[index])).toBe(`${raw[index]}\n`)
    }

    const counts = parsed.reduce<Record<string, number>>((acc, record) => {
      acc[record.type] = (acc[record.type] ?? 0) + 1
      return acc
    }, {})
    expect(counts).toEqual({
      'request/tools': 1,
      'request/header': 5,
      'request/start': 8,
      'assistant/first-token': 8,
      'tool/call': 1,
      'tool/audit': 1,
      'tool/result': 1,
      'request/end': 7,
    })
  })

  it('keeps seq order stable and does not reorder same-seq lines', () => {
    const parsed = parseSessionLogEventLog(FIXTURE)
    for (let index = 1; index < parsed.length; index++) {
      expect(parsed[index].seq).toBeGreaterThanOrEqual(parsed[index - 1].seq)
    }
  })

  it('skips a torn last line without losing the ones before it', () => {
    const torn = `${FIXTURE}{"seq":999,"time":1,"type":"tool/`
    expect(parseSessionLogEventLog(torn)).toHaveLength(FIXTURE.split('\n').filter(Boolean).length)
  })

  it('skips unknown types instead of failing the read', () => {
    const withFuture = `${FIXTURE}{"seq":9001,"time":1,"type":"session/teleported","data":{}}\n`
    expect(parseSessionLogEventLog(withFuture)).toHaveLength(
      FIXTURE.split('\n').filter(Boolean).length,
    )
  })

  it('skips records with a broken envelope', () => {
    expect(decodeSessionLogEventLine('')).toBeNull()
    expect(decodeSessionLogEventLine('not json')).toBeNull()
    expect(decodeSessionLogEventLine('[1,2,3]')).toBeNull()
    expect(decodeSessionLogEventLine('{"seq":"1","time":1,"type":"request/end","data":{}}')).toBeNull()
    expect(decodeSessionLogEventLine('{"seq":1,"type":"request/end","data":{}}')).toBeNull()
    expect(decodeSessionLogEventLine('{"seq":1,"time":1,"type":"request/end"}')).toBeNull()
    expect(decodeSessionLogEventLine('{"seq":1,"time":1,"type":"request/end","data":[]}')).toBeNull()
  })

  it('drops a malformed surfaceOp without dropping the event', () => {
    const record = decodeSessionLogEventLine(
      '{"seq":1,"time":1,"type":"user/message","data":{"message":{"id":"m1","role":"user"}},"surfaceOp":{"op":"nope"}}',
    )
    expect(record).not.toBeNull()
    expect(record?.surfaceOp).toBeUndefined()

    const withSeqs = decodeSessionLogEventLine(
      '{"seq":2,"time":1,"type":"user/message","data":{"message":{"id":"m1","role":"user"}},"surfaceOp":"append","sourceEventSeqs":["x"]}',
    )
    expect(withSeqs?.surfaceOp).toBe('append')
    expect(withSeqs?.sourceEventSeqs).toBeUndefined()
  })

  it('round-trips every new v2 type', () => {
    const samples: SessionLogEventRecord[] = [
      { seq: 1, time: 10, type: 'session/created', data: { sessionId: 's1', kind: 'chat' } },
      { seq: 2, time: 11, type: 'session/agent-changed', data: { to: 'a2' } },
      { seq: 3, time: 12, type: 'session/model-changed', data: { to: 'm2' } },
      { seq: 4, time: 13, type: 'session/workdir-changed', data: { to: '/tmp' } },
      {
        seq: 5,
        time: 14,
        type: 'user/message',
        data: { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 14 } },
        surfaceOp: 'append',
      },
      { seq: 6, time: 15, type: 'system/message', data: { message: { id: 'sys1', role: 'system', content: 'x' } }, surfaceOp: 'append' },
      { seq: 7, time: 16, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1' }, surfaceOp: 'append' },
      { seq: 8, time: 17, type: 'request/recipe', data: { runId: 'r1', requestIndex: 1, systemPromptHash: 'h', toolsHash: 't', messages: [{ eventSeq: 5, contentHash: 'c' }] } },
      { seq: 9, time: 18, type: 'assistant/chunks', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 18, dt: [0, 3], text: ['he', 'llo'] } },
      { seq: 10, time: 19, type: 'assistant/part-end', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: 5, hash: 'abc' } },
      { seq: 11, time: 20, type: 'request/response', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 4 } } },
      { seq: 12, time: 21, type: 'request/error', data: { runId: 'r1', requestIndex: 1, error: { message: 'boom' }, willRetry: true, attempt: 1 } },
      { seq: 13, time: 22, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
      { seq: 14, time: 23, type: 'permission/asked', data: { requestId: 'p1', toolCallId: 'c1' } },
      { seq: 15, time: 24, type: 'permission/answered', data: { requestId: 'p1', approved: false } },
      { seq: 16, time: 25, type: 'interaction/asked', data: { requestId: 'i1' } },
      { seq: 17, time: 26, type: 'interaction/answered', data: { requestId: 'i1', answer: 'yes' } },
      { seq: 18, time: 27, type: 'context/turn-update', data: { messageId: 'u1', set: { variables: 'x' } } },
      { seq: 19, time: 28, type: 'plugin/status', data: { pluginId: 'p', id: 's', label: 'l' } },
      { seq: 20, time: 29, type: 'message/patched', data: { messageId: 'a1', patch: { thinkingTime: 2 } } },
      { seq: 21, time: 30, type: 'message/deleted', data: { messageId: 'sys1' }, surfaceOp: { op: 'replace', start: 6, end: 6 }, sourceEventSeqs: [6] },
      { seq: 22, time: 31, type: 'user/message-edited', data: { messageId: 'u1', message: { id: 'u1', role: 'user', content: 'hi2' } }, surfaceOp: { op: 'replace', start: 5, end: 7 }, sourceEventSeqs: [5, 7] },
      { seq: 23, time: 32, type: 'session/compacted', data: { summary: 's', messageId: 'c1', compactedMessageCount: 2 }, surfaceOp: { op: 'replace', start: 22, end: 22 }, sourceEventSeqs: [22] },
      { seq: 24, time: 33, type: 'session/cleared', data: { reason: 'clear' }, surfaceOp: { op: 'replace', start: 23, end: 23 }, sourceEventSeqs: [23] },
      { seq: 25, time: 34, type: 'message/imported', data: { message: { id: 'old1', role: 'user', content: 'legacy' } }, surfaceOp: 'append' },
      { seq: 26, time: 35, type: 'skill/activated', data: { runId: 'r1', messageId: 'a1', skill: 'agent-plan' } },
    ]

    for (const record of samples) {
      const line = encodeSessionLogEventLine(record)
      expect(decodeSessionLogEventLine(line)).toEqual(record)
    }
    expect(parseSessionLogEventLog(samples.map(encodeSessionLogEventLine).join(''))).toEqual(samples)

    // 覆盖率自检:v2 新增的类型一个不漏地在上面出现过。
    const covered = new Set(samples.map(record => record.type))
    const missing = SESSION_LOG_EVENT_TYPES.filter(
      type => !covered.has(type) && !(SESSION_LEGACY_EVENT_TYPES as readonly string[]).includes(type),
    )
    expect(missing).toEqual([])
  })
})

describe('BlobRef', () => {
  it('accepts a complete reference', () => {
    expect(isBlobRef({ hash: 'abc', bytes: 10 })).toBe(true)
    expect(isBlobRef({ hash: 'abc', bytes: 0, mime: 'image/png' })).toBe(true)
  })

  it('rejects the half-built shapes S1 is most likely to write', () => {
    expect(isBlobRef({ hash: 'abc' })).toBe(false)
    expect(isBlobRef({ bytes: 10 })).toBe(false)
    expect(isBlobRef({ hash: '', bytes: 10 })).toBe(false)
    expect(isBlobRef({ hash: 'abc', bytes: -1 })).toBe(false)
    expect(isBlobRef({ hash: 'abc', bytes: '10' })).toBe(false)
    expect(isBlobRef({ hash: 'abc', bytes: 10, mime: 7 })).toBe(false)
    expect(isBlobRef(null)).toBe(false)
    expect(isBlobRef('abc')).toBe(false)
    expect(isBlobRef([])).toBe(false)
  })
})
