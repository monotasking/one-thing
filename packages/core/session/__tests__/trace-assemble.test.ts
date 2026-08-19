/**
 * 轨迹装配器(S3,§12)的单测。
 *
 * 场景照 S0 合同测试那份口径挑:一次干净的执行、工具循环、重试、abort、压缩、
 * 只有七类的老文件、多 run 的会话。每一条都要求装配器**只说日志里有的东西** ——
 * 断言里因此有相当一部分是"这一格必须缺席"。
 */
import { describe, expect, it } from 'vitest'

import {
  assembleSessionTrace,
  materializeTraceResponseText,
} from '../trace/index.js'
import type { SessionLogEventRecord } from '../events/index.js'

// ============ 事件小工厂 ============

class Log {
  readonly events: SessionLogEventRecord[] = []
  private seq = 0
  private time = 1_000

  push<T extends SessionLogEventRecord['type']>(
    type: T,
    data: Extract<SessionLogEventRecord, { type: T }>['data'],
    step = 10,
  ): SessionLogEventRecord {
    this.time += step
    const event = { seq: ++this.seq, time: this.time, type, data } as SessionLogEventRecord
    this.events.push(event)
    return event
  }
}

function userMessage(log: Log, id: string, content: string): void {
  log.push('user/message', { message: { id, role: 'user', content } })
}

/** 一次完整的执行:run/start → (header/tools/recipe/start/…/end)×N → run/end。 */
function fullRun(log: Log, options: {
  runId: string
  messageId: string
  triggerMessageId?: string
  requests: Array<{
    index: number
    text?: string
    tool?: { callId: string; name: string; args: string; result?: string; isError?: boolean }
    error?: { message: string; willRetry: boolean; attempt: number }
  }>
  outcome?: 'completed' | 'aborted' | 'error'
}): void {
  log.push('run/start', {
    runId: options.runId,
    kind: 'send',
    agentId: 'default',
    assistantMessageId: options.messageId,
    provider: 'openai',
    model: 'gpt-4o',
    ...(options.triggerMessageId ? { triggerMessageId: options.triggerMessageId } : {}),
  })
  log.push('request/tools', {
    requestIndex: options.requests[0]?.index ?? 1,
    toolsHash: 'th1',
    tools: [{ name: 'time' }, { name: 'bash' }],
    runId: options.runId,
  })
  log.push('request/header', {
    requestIndex: options.requests[0]?.index ?? 1,
    provider: 'openai',
    model: 'gpt-4o',
    systemPromptHash: 'sysabcdef01',
    toolsHash: 'th1',
    reason: 'initial',
    runId: options.runId,
  })

  for (const request of options.requests) {
    log.push('request/recipe', {
      runId: options.runId,
      requestIndex: request.index,
      systemPromptHash: 'sysabcdef01',
      toolsHash: 'th1',
      messages: [{ eventSeq: 1, contentHash: 'h1' }, { eventSeq: 2, contentHash: 'h2' }],
    })
    log.push('request/start', {
      requestIndex: request.index,
      messageId: options.messageId,
      runId: options.runId,
    })
    if (request.error) {
      log.push('request/error', {
        runId: options.runId,
        requestIndex: request.index,
        error: { message: request.error.message },
        willRetry: request.error.willRetry,
        attempt: request.error.attempt,
      })
      continue
    }
    log.push('assistant/first-token', {
      requestIndex: request.index,
      messageId: options.messageId,
      runId: options.runId,
    })
    if (request.text) {
      log.push('assistant/chunks', {
        runId: options.runId,
        requestIndex: request.index,
        messageId: options.messageId,
        partIndex: request.index,
        kind: 'text',
        time0: 2_000,
        dt: [0],
        text: [request.text],
      })
      log.push('assistant/part-end', {
        runId: options.runId,
        requestIndex: request.index,
        messageId: options.messageId,
        partIndex: request.index,
        kind: 'text',
        len: request.text.length,
        hash: 'texthash',
      })
    }
    if (request.tool) {
      const call = log.push('tool/call', {
        callId: request.tool.callId,
        argumentsRaw: request.tool.args,
        name: request.tool.name,
        messageId: options.messageId,
        runId: options.runId,
      })
      log.push('tool/audit', {
        callId: request.tool.callId,
        toolId: request.tool.name,
        effects: ['read'],
        effectCount: 1,
        decision: 'allow',
        asked: false,
        outcome: request.tool.isError ? 'failed' : 'ok',
        runId: options.runId,
      })
      if (request.tool.result !== undefined) {
        log.push('tool/result', {
          callId: request.tool.callId,
          isError: request.tool.isError ?? false,
          resultPreview: request.tool.result,
          sourceSeq: call.seq,
          result: { text: request.tool.result },
          runId: options.runId,
        })
      }
    }
    log.push('request/response', {
      runId: options.runId,
      requestIndex: request.index,
      messageId: options.messageId,
      finishReason: request.tool ? 'tool_calls' : 'stop',
      usage: { inputTokens: 10 * request.index, outputTokens: request.index, totalTokens: 11 * request.index },
      parts: request.text
        ? [{ partIndex: request.index, kind: 'text', len: request.text.length, hash: 'texthash' }]
        : [],
    })
    log.push('request/end', {
      requestIndex: request.index,
      stopReason: request.tool ? 'tool_calls' : 'stop',
      usage: { inputTokens: 10 * request.index, outputTokens: request.index },
      runId: options.runId,
    })
  }

  log.push('run/end', { runId: options.runId, outcome: options.outcome ?? 'completed' })
}

// ============ 场景 ============

describe('assembleSessionTrace', () => {
  it('1) 一次两请求的工具循环:run → 2 requests → 1 toolCall', () => {
    const log = new Log()
    log.push('session/created', { sessionId: 's1', kind: 'chat', agentId: 'default' })
    userMessage(log, 'u1', 'what time is it?')
    fullRun(log, {
      runId: 'run_1',
      messageId: 'a1',
      triggerMessageId: 'u1',
      requests: [
        { index: 1, text: 'let me check', tool: { callId: 'c1', name: 'time', args: '{"action":"now"}', result: '2026-08-20' } },
        { index: 2, text: 'done' },
      ],
    })

    const trace = assembleSessionTrace(log.events, { sessionId: 's1' })
    expect(trace.hasRunEvents).toBe(true)
    expect(trace.totalRuns).toBe(1)
    expect(trace.sessionKind).toBe('chat')

    const [run] = trace.runs
    expect(run.runId).toBe('run_1')
    expect(run.synthetic).toBe(false)
    expect(run.kind).toBe('send')
    expect(run.outcome).toBe('completed')
    expect(run.model).toBe('gpt-4o')
    expect(run.trigger?.preview).toBe('what time is it?')
    expect(run.requests.map(request => request.requestIndex)).toEqual([1, 2])

    const [first, second] = run.requests
    expect(first.provider).toBe('openai')
    expect(first.systemPromptHash).toBe('sysabcdef01')
    expect(first.toolCount).toBe(2)
    expect(first.recipeMessageCount).toBe(2)
    expect(first.finishReason).toBe('tool_calls')
    expect(first.usage).toMatchObject({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })
    expect(first.parts).toEqual([{ partIndex: 1, kind: 'text', len: 12, hash: 'texthash' }])
    expect(first.toolCalls).toHaveLength(1)
    expect(second.toolCalls).toEqual([])

    const [call] = first.toolCalls
    expect(call).toMatchObject({ callId: 'c1', name: 'time', argumentsRaw: '{"action":"now"}' })
    expect(call.resultPreview).toBe('2026-08-20')
    expect(call.audit).toMatchObject({ effects: ['read'], decision: 'allow', outcome: 'ok' })
    // 只有时刻,没有时长 —— 树上一个 duration 字段都不许有。
    expect(Object.keys(call).some(key => /duration/i.test(key))).toBe(false)
    expect(call.resultTime).toBeGreaterThan(call.callTime)
  })

  it('2) 重试:失败那次留一条 error(willRetry),后一次自己一格', () => {
    const log = new Log()
    fullRun(log, {
      runId: 'run_r',
      messageId: 'a1',
      requests: [
        { index: 1, error: { message: 'overloaded', willRetry: true, attempt: 1 } },
        { index: 2, text: 'ok now' },
      ],
    })

    const [run] = assembleSessionTrace(log.events).runs
    expect(run.requests).toHaveLength(2)
    expect(run.requests[0].errors).toMatchObject([{ message: 'overloaded', willRetry: true, attempt: 1 }])
    // 失败的那次没有收尾:endTime / finishReason 一律缺席,不用 0 或空串冒充。
    expect(run.requests[0].endTime).toBeUndefined()
    expect(run.requests[0].finishReason).toBeUndefined()
    expect(run.requests[1].errors).toEqual([])
    expect(run.requests[1].finishReason).toBe('stop')
  })

  it('3) abort:run 的结局如实是 aborted,没配到结果的调用不猜', () => {
    const log = new Log()
    fullRun(log, {
      runId: 'run_a',
      messageId: 'a1',
      requests: [{ index: 1, text: 'working', tool: { callId: 'c9', name: 'bash', args: '{"command":"sleep 100"}' } }],
      outcome: 'aborted',
    })
    log.push('run/end', { runId: 'run_a', outcome: 'aborted', error: { message: 'user aborted' } })

    const [run] = assembleSessionTrace(log.events).runs
    expect(run.outcome).toBe('aborted')
    expect(run.error).toMatchObject({ message: 'user aborted' })
    const [call] = run.requests[0].toolCalls
    expect(call.resultTime).toBeUndefined()
    expect(call.resultPreview).toBeUndefined()
    expect(call.isError).toBeUndefined()
  })

  it('4) 老文件(只有七类):按助手消息 id 合成分组,runId 留空', () => {
    const log = new Log()
    log.push('request/tools', { requestIndex: 1, toolsHash: 'th', tools: [{ name: 'time' }] })
    log.push('request/header', {
      requestIndex: 1,
      provider: 'anthropic',
      model: 'claude',
      systemPromptHash: 'sys',
      toolsHash: 'th',
      reason: 'initial',
    })
    log.push('request/start', { requestIndex: 1, messageId: 'legacy-a1' })
    log.push('assistant/first-token', { requestIndex: 1, messageId: 'legacy-a1' })
    const call = log.push('tool/call', {
      callId: 'lc1', argumentsRaw: '{}', name: 'time', messageId: 'legacy-a1',
    })
    log.push('tool/result', { callId: 'lc1', isError: false, resultPreview: 'now', sourceSeq: call.seq })
    log.push('request/end', { requestIndex: 1, stopReason: 'stop' })
    // 第二条助手消息 = 第二组。
    log.push('request/start', { requestIndex: 2, messageId: 'legacy-a2' })
    log.push('request/end', { requestIndex: 2, stopReason: 'stop' })

    const trace = assembleSessionTrace(log.events)
    expect(trace.hasRunEvents).toBe(false)
    expect(trace.totalRuns).toBe(2)
    expect(trace.runs.map(run => run.key)).toEqual(['legacy:legacy-a1', 'legacy:legacy-a2'])
    expect(trace.runs.every(run => run.synthetic && run.runId === '')).toBe(true)
    expect(trace.runs[0].assistantMessageId).toBe('legacy-a1')
    expect(trace.runs[0].kind).toBeUndefined()
    expect(trace.runs[0].outcome).toBeUndefined()
    expect(trace.runs[0].requests[0].model).toBe('claude')
    expect(trace.runs[0].requests[0].toolCalls[0].resultPreview).toBe('now')
  })

  it('5) 压缩是会话级的一行,不挂在任何一棵 run 上', () => {
    const log = new Log()
    fullRun(log, { runId: 'run_1', messageId: 'a1', requests: [{ index: 1, text: 'hi' }] })
    log.push('session/compacted', {
      summary: 'so far…',
      messageId: 'compact-1',
      compactedMessageCount: 12,
      status: 'completed',
      model: 'gpt-4o',
    })
    fullRun(log, { runId: 'run_2', messageId: 'a2', requests: [{ index: 2, text: 'after' }] })

    const trace = assembleSessionTrace(log.events)
    expect(trace.compactions).toMatchObject([{ messageId: 'compact-1', compactedMessageCount: 12, status: 'completed' }])
    expect(trace.runs.map(run => run.runId)).toEqual(['run_1', 'run_2'])
    expect(trace.runs.every(run => !('compactions' in run))).toBe(true)
  })

  it('6) 过滤:--run 取一棵,--last 取最后 N 棵,totalRuns 说真话', () => {
    const log = new Log()
    fullRun(log, { runId: 'run_1', messageId: 'a1', requests: [{ index: 1, text: 'one' }] })
    fullRun(log, { runId: 'run_2', messageId: 'a2', requests: [{ index: 2, text: 'two' }] })
    fullRun(log, { runId: 'run_3', messageId: 'a3', requests: [{ index: 3, text: 'three' }] })

    expect(assembleSessionTrace(log.events).runs).toHaveLength(3)
    const last = assembleSessionTrace(log.events, { last: 1 })
    expect(last.totalRuns).toBe(3)
    expect(last.runs.map(run => run.runId)).toEqual(['run_3'])
    const one = assembleSessionTrace(log.events, { run: 'run_2' })
    expect(one.runs.map(run => run.runId)).toEqual(['run_2'])
    expect(assembleSessionTrace(log.events, { run: 'nope' }).runs).toEqual([])
  })

  it('7) 权限被拒:理由落在调用上,哪怕审批事件早于 tool/call', () => {
    const log = new Log()
    log.push('run/start', { runId: 'run_p', kind: 'send', assistantMessageId: 'a1' })
    log.push('request/start', { requestIndex: 1, messageId: 'a1', runId: 'run_p' })
    log.push('permission/asked', { requestId: 'req1', runId: 'run_p', toolCallId: 'c1', toolName: 'bash' })
    log.push('permission/answered', {
      requestId: 'req1', runId: 'run_p', toolCallId: 'c1', approved: false, reason: '不要动那个文件',
    })
    log.push('tool/call', { callId: 'c1', argumentsRaw: '{}', name: 'bash', messageId: 'a1', runId: 'run_p' })
    log.push('tool/audit', {
      callId: 'c1', toolId: 'bash', effects: ['write'], effectCount: 1,
      decision: 'deny', asked: true, outcome: 'denied', runId: 'run_p',
    })
    log.push('run/end', { runId: 'run_p', outcome: 'completed' })

    const [call] = assembleSessionTrace(log.events).runs[0].requests[0].toolCalls
    expect(call.permission).toMatchObject({ approved: false, reason: '不要动那个文件' })
    expect(call.audit).toMatchObject({ decision: 'deny', asked: true, outcome: 'denied' })
  })

  it('8) 树上没有正文;正文按需从 chunks 折出来', () => {
    const log = new Log()
    fullRun(log, {
      runId: 'run_t',
      messageId: 'a1',
      requests: [{ index: 1, text: 'first half' }, { index: 2, text: 'second half' }],
    })

    const serialized = JSON.stringify(assembleSessionTrace(log.events))
    expect(serialized).not.toContain('first half')
    expect(serialized).toContain('texthash')

    expect(materializeTraceResponseText(log.events, 'run_t', 1).text).toBe('first half')
    expect(materializeTraceResponseText(log.events, 'run_t', 2).text).toBe('second half')
    expect(materializeTraceResponseText(log.events, 'run_t').text).toBe('first halfsecond half')
    expect(materializeTraceResponseText(log.events, 'nope').partCount).toBe(0)
  })

  it('9) 采集点缺 runId(真机上的 tool/audit)不该开出一个空的第二组', () => {
    // 真机回归:S3 首跑时 `tool/audit` 只带 messageId、不带 runId,装配器为它
    // 凭空开了一棵 `legacy:<mid>` 的空 run —— `totalRuns` 当场从 1 变 2。
    const log = new Log()
    log.push('run/start', { runId: 'run_1', kind: 'send', assistantMessageId: 'a1' })
    log.push('request/start', { requestIndex: 1, messageId: 'a1', runId: 'run_1' })
    const call = log.push('tool/call', {
      callId: 'c1', argumentsRaw: '{}', name: 'time', messageId: 'a1', runId: 'run_1',
    })
    log.push('tool/audit', {
      // ← 没有 runId,只有 messageId。
      callId: 'c1', toolId: 'time', effects: ['read'], effectCount: 1,
      outcome: 'ok', messageId: 'a1',
    })
    log.push('tool/result', { callId: 'c1', isError: false, resultPreview: 'now', sourceSeq: call.seq, runId: 'run_1' })
    log.push('run/end', { runId: 'run_1', outcome: 'completed' })

    const trace = assembleSessionTrace(log.events)
    expect(trace.totalRuns).toBe(1)
    expect(trace.runs[0].runId).toBe('run_1')
    expect(trace.runs[0].requests[0].toolCalls[0].audit).toMatchObject({ effects: ['read'], outcome: 'ok' })
  })

  it('10) 混合文件:表里没有的 messageId 仍然自成一个 legacy 组', () => {
    const log = new Log()
    log.push('request/start', { requestIndex: 1, messageId: 'old-a1' })
    log.push('request/end', { requestIndex: 1, stopReason: 'stop' })
    log.push('run/start', { runId: 'run_new', kind: 'send', assistantMessageId: 'new-a1' })
    log.push('request/start', { requestIndex: 2, messageId: 'new-a1', runId: 'run_new' })
    log.push('run/end', { runId: 'run_new', outcome: 'completed' })

    const trace = assembleSessionTrace(log.events)
    expect(trace.runs.map(run => run.key)).toEqual(['legacy:old-a1', 'run_new'])
    expect(trace.runs.map(run => run.synthetic)).toEqual([true, false])
  })

  it('11) 空日志 = 空树,不是错误', () => {
    const trace = assembleSessionTrace([], { sessionId: 'empty' })
    expect(trace).toMatchObject({ sessionId: 'empty', hasRunEvents: false, totalRuns: 0, runs: [], compactions: [] })
  })
})
