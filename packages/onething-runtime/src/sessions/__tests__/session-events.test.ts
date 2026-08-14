/**
 * 会话事件日志的纯编解码(主线 E0)。
 *
 * 这里守的是四件事实层面的承诺:半行不吃掉整份日志、信封没变就不重复记账、
 * **目录与信封各自独立去重**、历史调用永远解析到它**当时**那份 schema。
 */
import { describe, expect, it } from 'vitest'
import {
  decodeSessionEventLine,
  encodeSessionEventLine,
  findLastSessionEventInLog,
  hashSessionEventSystemPrompt,
  hashSessionEventTools,
  isSameRequestHeaderEnvelope,
  parseSessionEventLog,
  resolveToolCallInspection,
  scanSessionEventLogCounters,
  truncateSessionEventPreview,
  type SessionEventRecord,
  type SessionEventToolSchema,
  type SessionRequestHeaderEventData,
} from '../session-events.js'

function header(
  seq: number,
  time: number,
  overrides: Partial<SessionRequestHeaderEventData> = {},
): SessionEventRecord {
  return {
    seq,
    time,
    type: 'request/header',
    data: {
      requestIndex: 1,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      systemPromptHash: 'aaaaaaaaaaaaaaaa',
      toolsHash: 'cccccccccccccccc',
      reason: 'initial',
      ...overrides,
    },
  }
}

function toolsEvent(
  seq: number,
  time: number,
  tools: SessionEventToolSchema[],
  requestIndex = 1,
): SessionEventRecord {
  return {
    seq,
    time,
    type: 'request/tools',
    data: { requestIndex, toolsHash: hashSessionEventTools(tools), tools },
  }
}

describe('session event codec', () => {
  it('round-trips a record and always ends the line', () => {
    const record = header(1, 1000)
    const line = encodeSessionEventLine(record)
    expect(line.endsWith('\n')).toBe(true)
    expect(decodeSessionEventLine(line)).toEqual(record)
  })

  it('drops a crash-truncated tail line and keeps everything before it', () => {
    const text =
      encodeSessionEventLine(header(1, 1000)) +
      encodeSessionEventLine({
        seq: 2,
        time: 1001,
        type: 'request/start',
        data: { requestIndex: 1, messageId: 'm1' },
      }) +
      '{"seq":3,"time":1002,"type":"tool/ca'

    const records = parseSessionEventLog(text)
    expect(records.map(r => r.seq)).toEqual([1, 2])
  })

  it('ignores a type it does not know instead of failing the whole read', () => {
    const text =
      encodeSessionEventLine(header(1, 1000)) +
      '{"seq":2,"time":1001,"type":"future/thing","data":{}}\n' +
      encodeSessionEventLine({
        seq: 3,
        time: 1002,
        type: 'request/end',
        data: { requestIndex: 1 },
      })

    expect(parseSessionEventLog(text).map(r => r.type)).toEqual(['request/header', 'request/end'])
  })

  it('recovers seq and requestIndex counters without parsing JSON', () => {
    const text =
      encodeSessionEventLine(header(1, 1000, { requestIndex: 1 })) +
      encodeSessionEventLine({
        seq: 7,
        time: 1001,
        type: 'request/start',
        data: { requestIndex: 4, messageId: 'm1' },
      }) +
      '{"seq":8,"time":100'

    expect(scanSessionEventLogCounters(text)).toEqual({ lastSeq: 8, lastRequestIndex: 4 })
    expect(scanSessionEventLogCounters('')).toEqual({ lastSeq: 0, lastRequestIndex: 0 })
  })

  it('finds the last record of a type', () => {
    const text =
      encodeSessionEventLine(header(1, 1000, { systemPromptHash: 'one' })) +
      encodeSessionEventLine({
        seq: 2,
        time: 1001,
        type: 'request/start',
        data: { requestIndex: 1, messageId: 'm1' },
      }) +
      encodeSessionEventLine(header(3, 1002, { systemPromptHash: 'two', reason: 'change' }))

    expect(findLastSessionEventInLog(text, 'request/header')?.data.systemPromptHash).toBe('two')
    expect(findLastSessionEventInLog(text, 'tool/call')).toBeUndefined()
  })

  it('truncates the result preview with an ellipsis', () => {
    expect(truncateSessionEventPreview('abc', 5)).toBe('abc')
    expect(truncateSessionEventPreview('abcdefgh', 5)).toBe('abcde…')
  })

  it('hashes the system prompt to 16 hex chars', () => {
    const hash = hashSessionEventSystemPrompt('hello')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hash).toBe(hashSessionEventSystemPrompt('hello'))
    expect(hash).not.toBe(hashSessionEventSystemPrompt('hello '))
  })

  it('hashes the tool catalog to 16 hex chars, stable across calls', () => {
    const tools: SessionEventToolSchema[] = [
      { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
      { name: 'edit', description: 'Edit a file' },
    ]
    const hash = hashSessionEventTools(tools)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hash).toBe(hashSessionEventTools([...tools]))
    expect(hashSessionEventTools([])).not.toBe(hash)
    // 描述改一个字就是另一份目录 —— 那正是"模型看到的世界变了"。
    expect(hashSessionEventTools([{ name: 'read', description: 'Read a file v2' }])).not.toBe(hash)
    // 顺序也算进指纹:注册顺序变了 = 装配变了,该记一条新目录(见函数注释)。
    expect(hashSessionEventTools([tools[1], tools[0]])).not.toBe(hash)
  })
})

describe('request header dedupe', () => {
  it('writes nothing when the envelope is identical', () => {
    const a = header(1, 1000).data as SessionRequestHeaderEventData
    const b = { ...a, requestIndex: 9, reason: 'change' as const }
    expect(isSameRequestHeaderEnvelope(a, b)).toBe(true)
  })

  it('has no previous header on the very first request', () => {
    expect(isSameRequestHeaderEnvelope(undefined, header(1, 1000).data as SessionRequestHeaderEventData)).toBe(false)
  })

  it.each([
    ['provider', { provider: 'openai' }],
    ['model', { model: 'deepseek-v4-flash' }],
    ['system prompt', { systemPromptHash: 'bbbbbbbbbbbbbbbb' }],
    ['tool catalog', { toolsHash: 'dddddddddddddddd' }],
  ] as const)('detects a changed %s', (_label, overrides) => {
    const a = header(1, 1000).data as SessionRequestHeaderEventData
    const b = { ...a, ...overrides } as SessionRequestHeaderEventData
    expect(isSameRequestHeaderEnvelope(a, b)).toBe(false)
  })

  it('carries no tool catalog body — only its hash', () => {
    // 这条是 40KB 陪葬那个坑的守门员:header 里再出现 tools 正文就红。
    expect(Object.keys(header(1, 1000).data)).not.toContain('tools')
  })
})

describe('resolveToolCallInspection', () => {
  const events: SessionEventRecord[] = [
    toolsEvent(1, 1000, [
      { name: 'edit', description: 'v1 description', parameters: { type: 'object', properties: { path: {} } } },
    ]),
    { seq: 2, time: 1001, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
    {
      seq: 3,
      time: 1010,
      type: 'tool/call',
      data: { callId: 'call-old', name: 'edit', argumentsRaw: '{"path":"a.ts"}', messageId: 'm1' },
    },
    {
      seq: 4,
      time: 1050,
      type: 'tool/result',
      data: { callId: 'call-old', isError: false, resultPreview: 'ok', sourceSeq: 3 },
    },
    // 工具后来改了 schema:第二条 request/tools 只影响它之后的调用。
    toolsEvent(
      5,
      2000,
      [{ name: 'edit', description: 'v2 description', parameters: { type: 'object', properties: { path: {}, replaceAll: {} } } }],
      2,
    ),
    {
      seq: 6,
      time: 2010,
      type: 'tool/call',
      data: { callId: 'call-new', name: 'edit', argumentsRaw: '{"path":"b.ts","replaceAll":true}', messageId: 'm2' },
    },
    {
      seq: 7,
      time: 2080,
      type: 'tool/result',
      data: { callId: 'call-new', isError: true, resultPreview: 'boom', sourceSeq: 6 },
    },
  ]

  it('pairs arguments, result and moments', () => {
    const inspection = resolveToolCallInspection(events, 'call-old')
    expect(inspection).toMatchObject({
      callId: 'call-old',
      name: 'edit',
      argumentsRaw: '{"path":"a.ts"}',
      callTime: 1010,
      resultTime: 1050,
      resultPreview: 'ok',
      isError: false,
    })
  })

  it('resolves a historical call to the schema that was live at the time', () => {
    expect(resolveToolCallInspection(events, 'call-old')?.schema?.description).toBe('v1 description')
    expect(resolveToolCallInspection(events, 'call-new')?.schema?.description).toBe('v2 description')
  })

  it('reads the schema from request/tools, not from the header', () => {
    // header 只带指纹;哪怕它就在调用前面,也不该有 schema 可取。
    const headerOnly = resolveToolCallInspection(
      [
        header(1, 1000),
        {
          seq: 2,
          time: 1010,
          type: 'tool/call',
          data: { callId: 'c', name: 'edit', argumentsRaw: '{}', messageId: 'm' },
        },
      ],
      'c',
    )
    expect(headerOnly?.schema).toBeUndefined()
  })

  it('reports an in-flight call as a call without a result', () => {
    const pending = resolveToolCallInspection(
      [
        toolsEvent(1, 1000, [{ name: 'read' }]),
        {
          seq: 2,
          time: 1010,
          type: 'tool/call',
          data: { callId: 'call-x', name: 'read', argumentsRaw: '{}', messageId: 'm1' },
        },
      ],
      'call-x',
    )
    expect(pending?.callTime).toBe(1010)
    expect(pending?.resultTime).toBeUndefined()
    expect(pending?.resultPreview).toBeUndefined()
  })

  it('returns undefined for an unknown call id', () => {
    expect(resolveToolCallInspection(events, 'nope')).toBeUndefined()
  })

  it('leaves schema undefined when no tool catalog covers the call', () => {
    const orphan = resolveToolCallInspection(
      [
        {
          seq: 1,
          time: 10,
          type: 'tool/call',
          data: { callId: 'c', name: 'read', argumentsRaw: '{}', messageId: 'm' },
        },
      ],
      'c',
    )
    expect(orphan?.schema).toBeUndefined()
  })
})
