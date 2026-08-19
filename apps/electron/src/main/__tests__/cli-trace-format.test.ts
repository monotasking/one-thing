/**
 * `onething trace` 的排版(S3,§12)。
 *
 * 只测**纯格式化函数**(`formatSessionTrace`),不起 CLI:命令那一层的全部内容
 * 是"读文件 + 打印",而读文件已经由 `app/session/__tests__/trace.test.ts` 钉住。
 *
 * 快照守的是三件事:时刻一律**相对 run 起点**(绝对时刻排障时没用)、没配到
 * 结果的调用如实写 `(no result recorded)`、老日志的合成组标出 `(synthetic)`。
 */
import { describe, expect, it } from 'vitest'
import type { SessionTrace } from '@onething/core/session'
import { formatDuration, formatSessionTrace } from '../cli/trace-command.js'

const T0 = 1_700_000_000_000

const trace: SessionTrace = {
  sessionId: 'sess-1',
  hasRunEvents: true,
  eventCount: 27,
  createdAt: T0 - 5_000,
  sessionKind: 'chat',
  totalRuns: 2,
  compactions: [
    { seq: 40, time: T0 + 9_000, messageId: 'c1', compactedMessageCount: 12, status: 'completed' },
  ],
  runs: [
    {
      key: 'run_abc',
      runId: 'run_abc',
      synthetic: false,
      kind: 'send',
      agentId: 'default',
      provider: 'openai',
      model: 'gpt-4o',
      outcome: 'completed',
      assistantMessageId: 'a1',
      trigger: { messageId: 'u1', preview: 'what time is it?' },
      firstSeq: 3,
      startTime: T0,
      endTime: T0 + 2_400,
      requests: [
        {
          requestIndex: 1,
          startSeq: 7,
          provider: 'openai',
          model: 'gpt-4o',
          systemPromptHash: 'ab12cd34ef',
          toolsHash: 'th1',
          toolCount: 12,
          recipeMessageCount: 4,
          startTime: T0 + 20,
          firstTokenTime: T0 + 420,
          endTime: T0 + 900,
          finishReason: 'tool_calls',
          usage: { inputTokens: 1_120, outputTokens: 48 },
          parts: [{ partIndex: 0, kind: 'text', len: 21 }],
          errors: [],
          toolCalls: [
            {
              callId: 'call_1',
              name: 'time',
              argumentsRaw: '{"action":"now"}',
              callSeq: 12,
              callTime: T0 + 500,
              resultTime: T0 + 840,
              resultPreview: '2026-08-20T01:00:00+08:00',
              isError: false,
              audit: {
                toolId: 'time', effects: ['read'], effectCount: 1,
                outcome: 'ok', decision: 'allow', asked: false, time: T0 + 505,
              },
            },
            {
              callId: 'call_2',
              name: 'bash',
              argumentsRaw: '{"command":"sleep 100"}',
              callSeq: 14,
              callTime: T0 + 600,
              audit: {
                toolId: 'bash', effects: ['write', 'exec'], effectCount: 2,
                outcome: 'denied', decision: 'deny', asked: true, time: T0 + 610,
              },
              permission: { requestId: 'p1', approved: false, reason: '不要动那个目录' },
            },
          ],
        },
        {
          requestIndex: 2,
          startSeq: 20,
          model: 'gpt-4o',
          startTime: T0 + 1_000,
          endTime: T0 + 2_300,
          finishReason: 'stop',
          usage: { inputTokens: 1_400, outputTokens: 96 },
          parts: [{ partIndex: 1, kind: 'text', len: 64 }],
          errors: [
            { seq: 22, time: T0 + 1_200, message: 'overloaded', willRetry: true, attempt: 1 },
          ],
          toolCalls: [],
        },
      ],
    },
    {
      key: 'legacy:a9',
      runId: '',
      synthetic: true,
      firstSeq: 50,
      requests: [
        { requestIndex: 9, startSeq: 50, model: 'claude', startTime: T0 + 10_000, parts: [], errors: [], toolCalls: [] },
      ],
    },
  ],
}

describe('formatSessionTrace', () => {
  it('renders the run tree with times relative to the run start', () => {
    expect(formatSessionTrace(trace).join('\n')).toMatchInlineSnapshot(`
      "session sess-1 · 2 runs · 27 events

      run run_abc · send · completed · openai/gpt-4o · agent=default
        trigger  what time is it?
        elapsed  2.40s
           +20ms  request #1 · gpt-4o · sys=ab12cd34 · tools=12 · history=4
          +420ms    first token
          +500ms    tool time [read]  {"action":"now"}
          +840ms      ↳ ok  340ms  2026-08-20T01:00:00+08:00
          +600ms    tool bash [write,exec] denied  {"command":"sleep 100"}
                      ↳ (no result recorded)
                      ↳ permission: 不要动那个目录
          +900ms    end  tool_calls  in=1120 out=48  text:21
          +1.00s  request #2 · gpt-4o
          +1.20s    error  attempt 1 (will retry)  overloaded
          +2.30s    end  stop  in=1400 out=96  text:64

      run legacy:a9 (synthetic) · open
           ·      request #9 · claude

      compactions
        seq 40  completed  12 messages"
    `)
  })

  it('shows how many of the total runs are being printed when filtered', () => {
    const filtered = { ...trace, runs: [trace.runs[1]] }
    expect(formatSessionTrace(filtered)[1]).toBe('showing 1 of 2')
  })

  it('says so when the log has no runs at all', () => {
    const empty: SessionTrace = {
      sessionId: 's', hasRunEvents: false, eventCount: 0, totalRuns: 0, runs: [], compactions: [],
    }
    expect(formatSessionTrace(empty)).toEqual([
      'session s · 0 runs · 0 events · legacy log (runs are synthetic)',
      '',
      '  (no runs recorded)',
    ])
  })

  it('formats durations without ever inventing one', () => {
    expect(formatDuration(340)).toBe('340ms')
    expect(formatDuration(2_400)).toBe('2.40s')
    expect(formatDuration(125_000)).toBe('2m05s')
    expect(formatDuration(Number.NaN)).toBe('?')
  })
})
