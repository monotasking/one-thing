import { describe, expect, it, vi } from 'vitest'
import {
  buildContextCompactCompletedContent,
  buildContextCompactFailedContent,
  buildContextCompactSummaryMessages,
  buildContextUsageSnapshot,
  createContextCompactMessage,
  estimateSessionInputTokens,
  estimateTextTokens,
  formatMessagesForSummary,
  normalizeContextCompactError,
  normalizeContextSummaryOutput,
  CompactTokenBudget,
  COMPACT_PROMPT_OVERHEAD_TOKENS,
  resolveCompactCharsPerToken,
  resolveCompactChunkChars,
  resolveCompactOutputTokens,
  selectCompactPlan,
  shouldAutoCompactBeforeSend,
  summarizeContextInChunks,
} from '@onething/core/engine'
import type { CoreCompactMessage, CoreCompactSession, CoreContextSummaryRequest } from '@onething/core/engine'

function message(index: number, role: 'user' | 'assistant'): CoreCompactMessage {
  return {
    id: `${role}-${index}`,
    role,
    content: `${role} ${index}`,
  }
}

function session(messages: CoreCompactMessage[], summaryUpToMessageId?: string): CoreCompactSession {
  return {
    id: 's1',
    messages,
    summary: summaryUpToMessageId ? 'Previous summary' : undefined,
    summaryUpToMessageId,
  }
}

describe('core context compact helpers', () => {
  it('builds stable context compact status messages in core', () => {
    expect(createContextCompactMessage({
      id: 'compact-1',
      timestamp: 123,
      compactedMessageCount: 4,
    })).toEqual({
      id: 'compact-1',
      role: 'system',
      timestamp: 123,
      content: JSON.stringify({
        type: 'context-compact',
        status: 'compacting',
        summary: '',
        compactedMessageCount: 4,
      }),
    })

    expect(JSON.parse(buildContextCompactCompletedContent('summary text', 3))).toEqual({
      type: 'context-compact',
      status: 'completed',
      summary: 'summary text',
      compactedMessageCount: 3,
    })

    expect(JSON.parse(buildContextCompactFailedContent('provider failed', 2))).toEqual({
      type: 'context-compact',
      status: 'failed',
      summary: '',
      error: 'provider failed',
      compactedMessageCount: 2,
    })

    expect(normalizeContextCompactError(new Error('bad json'))).toBe('bad json')
    expect(normalizeContextCompactError('nope')).toBe('Failed to compact context')
  })

  it('单块压缩:一次 chunk 请求,带 previousSummary,不带 part', async () => {
    const calls: CoreContextSummaryRequest[] = []
    const summary = await summarizeContextInChunks({
      messages: 'aaa',
      maxChunkChars: 3,
      previousSummary: 'old summary',
      summarizeChunk: async (input) => {
        calls.push(input)
        return '  single  '
      },
    })

    expect(calls).toEqual([{ kind: 'chunk', chunk: 'aaa', previousSummary: 'old summary' }])
    expect(summary).toBe('single')
  })

  it('多块压缩 = map-reduce:N 块各自出部分摘要,再合并一次', async () => {
    const calls: CoreContextSummaryRequest[] = []
    const progress: Array<{ chunk: number; totalChunks: number }> = []
    const summary = await summarizeContextInChunks({
      messages: 'aaabbbccc',
      maxChunkChars: 3,
      previousSummary: 'old summary',
      onChunkComplete: (p) => { progress.push(p) },
      summarizeChunk: async (input) => {
        calls.push(input)
        return input.kind === 'merge' ? ` merged(${input.partials.join('|')}) ` : ` sum(${input.chunk}) `
      },
    })

    const chunkCalls = calls.filter(call => call.kind !== 'merge')
    expect(chunkCalls).toEqual([
      { kind: 'chunk', chunk: 'aaa', part: { index: 1, total: 3 } },
      { kind: 'chunk', chunk: 'bbb', part: { index: 2, total: 3 } },
      { kind: 'chunk', chunk: 'ccc', part: { index: 3, total: 3 } },
    ])
    // previousSummary 只喂给 merge —— 部分摘要不该各自去改写同一份旧摘要。
    expect(calls[calls.length - 1]).toEqual({
      kind: 'merge',
      partials: ['sum(aaa)', 'sum(bbb)', 'sum(ccc)'],
      previousSummary: 'old summary',
    })
    expect(summary).toBe('merged(sum(aaa)|sum(bbb)|sum(ccc))')
    // N 块 + 1 次合并 = N+1 步
    expect(progress).toEqual([
      { chunk: 1, totalChunks: 4 },
      { chunk: 2, totalChunks: 4 },
      { chunk: 3, totalChunks: 4 },
      { chunk: 4, totalChunks: 4 },
    ])
  })

  it('多块并发在途,且完成次序不改变 partials 的块顺序', async () => {
    const deferred = new Map<string, (value: string) => void>()
    let inFlight = 0
    let peakInFlight = 0

    const pending = summarizeContextInChunks({
      messages: 'aaabbbccc',
      maxChunkChars: 3,
      summarizeChunk: (input) => {
        if (input.kind === 'merge') return `merged(${input.partials.join('|')})`
        inFlight += 1
        peakInFlight = Math.max(peakInFlight, inFlight)
        return new Promise<string>((resolve) => {
          deferred.set(input.chunk, (value) => { inFlight -= 1; resolve(value) })
        })
      },
    })

    // 三块同时在途 —— 串行滚动做不到这一点。
    await vi.waitFor(() => expect(deferred.size).toBe(3))
    expect(peakInFlight).toBe(3)

    // 中间那块先回,顺序仍按块序。
    deferred.get('bbb')!('sum(bbb)')
    deferred.get('ccc')!('sum(ccc)')
    deferred.get('aaa')!('sum(aaa)')

    await expect(pending).resolves.toBe('merged(sum(aaa)|sum(bbb)|sum(ccc))')
  })

  it('map 阶段的并发有上限(4)', async () => {
    const releases: Array<(value: string) => void> = []
    let inFlight = 0
    let peakInFlight = 0

    const pending = summarizeContextInChunks({
      messages: 'a'.repeat(18),
      maxChunkChars: 3,
      summarizeChunk: (input) => {
        if (input.kind === 'merge') return 'merged'
        inFlight += 1
        peakInFlight = Math.max(peakInFlight, inFlight)
        return new Promise<string>((resolve) => {
          releases.push((value) => { inFlight -= 1; resolve(value) })
        })
      },
    })

    await vi.waitFor(() => expect(releases.length).toBe(4))
    expect(peakInFlight).toBe(4)
    // 六块只有四个在途,剩下两块要等前面的腾出位置。
    releases[0]('one')
    await vi.waitFor(() => expect(releases.length).toBe(5))
    expect(peakInFlight).toBe(4)

    for (let index = 1; index < 6; index++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index))
      releases[index]('x')
    }
    await expect(pending).resolves.toBe('merged')
  })

  it('某一块失败 → 立即抛出,不再派发新块', async () => {
    let dispatched = 0
    await expect(summarizeContextInChunks({
      messages: 'a'.repeat(18),
      maxChunkChars: 3,
      summarizeChunk: async (input) => {
        if (input.kind === 'merge') return 'merged'
        dispatched += 1
        throw new Error('provider exploded')
      },
    })).rejects.toThrow('provider exploded')

    // 并发上限 4:最多只派发了这一批,剩下两块不再派发。
    expect(dispatched).toBeLessThanOrEqual(4)
  })

  it('builds context compact provider messages in core', () => {
    const messages = buildContextCompactSummaryMessages({
      chunk: 'user: hello',
      previousSummary: 'old summary',
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'system',
    })
    // C5 双护栏:摘要请求喂的是一整段转录,里面全是指令和问句。
    expect(messages[0].content).toContain('context summarization assistant')
    expect(messages[0].content).toContain('Do NOT continue the conversation.')
    expect(messages[0].content).toContain('Do NOT respond to any questions in the conversation.')
    expect(messages[1]).toMatchObject({
      role: 'user',
    })
    expect(messages[1].content).toContain('<previous-summary>\nold summary\n</previous-summary>')
    expect(messages[1].content).toContain('<conversation>\nuser: hello\n</conversation>')
    // 单块路径逐字不变:没有 part 标签。
    expect(messages[1].content).not.toContain('<part ')
  })

  it('多块的 chunk 消息带 part 标签', () => {
    const messages = buildContextCompactSummaryMessages({
      kind: 'chunk',
      chunk: 'user: hello',
      part: { index: 2, total: 3 },
    })

    expect(messages[1].content).toContain('<part index="2" total="3">')
    expect(messages[1].content).toContain('This is part 2 of 3 of one longer conversation.')
    expect(messages[1].content).toContain('<conversation>\nuser: hello\n</conversation>')
  })

  it('merge 消息把部分摘要按序装进 <partial-summaries>', () => {
    const messages = buildContextCompactSummaryMessages({
      kind: 'merge',
      partials: ['## Goal\nfirst', '## Goal\nsecond'],
    })

    expect(messages[0].content).toContain('context summarization assistant')
    expect(messages[1].content).toContain('<partial-summaries>')
    expect(messages[1].content).toContain('<part index="1">\n## Goal\nfirst\n</part>')
    expect(messages[1].content).toContain('<part index="2">\n## Goal\nsecond\n</part>')
    // 指令正文里提到了这个标签名,所以只断言"没有真的装进一个块"。
    expect(messages[1].content).not.toContain('<previous-summary>\n')
    expect(messages[1].content).toContain('Merge the partial summaries above')

    const withPrevious = buildContextCompactSummaryMessages({
      kind: 'merge',
      partials: ['## Goal\nfirst'],
      previousSummary: 'old summary',
    })
    expect(withPrevious[1].content).toContain('<previous-summary>\nold summary\n</previous-summary>')
  })

  it('resolveCompactChunkChars:块大小随模型窗口走', () => {
    const transcript = 'the quick brown fox jumps over the lazy dog. '.repeat(200)

    // 窗口未知 → 回退到 80k,行为与从前一致。
    expect(resolveCompactChunkChars({ transcript, reservedOutputTokens: 8_192 })).toBe(80_000)
    expect(resolveCompactChunkChars({ transcript, modelContextLength: 0, reservedOutputTokens: 8_192 })).toBe(80_000)

    // 200k 窗口 + 纯英文 → 远大于 80k(多数会话因此退回单块)。
    const large = resolveCompactChunkChars({
      transcript,
      modelContextLength: 200_000,
      reservedOutputTokens: 8_192,
    })
    expect(large).toBeGreaterThan(500_000)

    // 可用预算为负 → 回退 80k。
    expect(resolveCompactChunkChars({
      transcript,
      modelContextLength: 8_000,
      reservedOutputTokens: 8_192,
    })).toBe(80_000)

    // 下限 20k。
    expect(resolveCompactChunkChars({
      transcript: '中'.repeat(1000),
      modelContextLength: 8_000,
      reservedOutputTokens: 100,
    })).toBe(20_000)

    // 中文的 chars/token 比更低 → 同一个窗口下块更小,不会撑爆。
    const cjk = resolveCompactChunkChars({
      transcript: '压缩上下文的摘要请求'.repeat(500),
      modelContextLength: 200_000,
      reservedOutputTokens: 8_192,
    })
    expect(cjk).toBeLessThan(large)
  })

  it('resolveCompactOutputTokens:按窗口夹住摘要请求的 max_tokens(2026-09-08 事故)', () => {
    // 事故现场:deepseek-v4-pro,窗口 1048576、注册输出上限 384000,而这次压缩
    // 的输入被 provider 报成 701297 —— 原样透传 384000 就是 provider 那条
    // 「requested 1085297 tokens」的 400。
    expect(resolveCompactOutputTokens({
      modelContextLength: 1_048_576,
      registeredMaxOutputTokens: 384_000,
      inputTokens: 701_297,
    })).toBe(343_279)
    // 1048576 − 701297 − 4000 = 343279:开销就是 COMPACT_PROMPT_OVERHEAD_TOKENS。
    expect(1_048_576 - 701_297 - COMPACT_PROMPT_OVERHEAD_TOKENS).toBe(343_279)

    // 输入很小 → 夹不动,注册上限原样(不许把上限往下编)。
    expect(resolveCompactOutputTokens({
      modelContextLength: 1_048_576,
      registeredMaxOutputTokens: 384_000,
      inputTokens: 10_000,
    })).toBe(384_000)

    // 注册表查不到上限 → undefined,不传,让 provider 自报错(2026-08-15 裁定)。
    expect(resolveCompactOutputTokens({
      modelContextLength: 1_048_576,
      inputTokens: 701_297,
    })).toBeUndefined()
    expect(resolveCompactOutputTokens({
      modelContextLength: 1_048_576,
      registeredMaxOutputTokens: 0,
      inputTokens: 10,
    })).toBeUndefined()

    // 窗口未知 → 没什么可夹的,注册上限原样。
    expect(resolveCompactOutputTokens({
      registeredMaxOutputTokens: 384_000,
      inputTokens: 701_297,
    })).toBe(384_000)

    // 输入已经把窗口吃满 → undefined = 「这块太大」,由调用方处置。
    expect(resolveCompactOutputTokens({
      modelContextLength: 100_000,
      registeredMaxOutputTokens: 8_192,
      inputTokens: 100_000,
    })).toBeUndefined()
  })

  it('resolveCompactCharsPerToken:有 provider 真数就用真数,没有才回退估算器', () => {
    const transcript = '压缩上下文的摘要请求'.repeat(500)

    // 校准生效:比值就是 chars / tokens,不再问估算器。
    const calibrated = resolveCompactCharsPerToken({
      transcript,
      calibration: { chars: 10_000, tokens: 5_000 },
    })
    expect(calibrated.source).toBe('provider')
    expect(calibrated.charsPerToken).toBe(2)

    // 回退:两个数任一不正就当没有(0 tokens 会直接除爆)。
    const fallback = resolveCompactCharsPerToken({ transcript })
    expect(fallback.source).toBe('estimator')
    expect(fallback.charsPerToken).toBeCloseTo(1.8, 1)
    expect(resolveCompactCharsPerToken({ transcript, calibration: { chars: 10_000, tokens: 0 } }))
      .toEqual(fallback)

    // 同一份转录,provider 报的 token 比估算器多 → 比值更小 → 块更小。
    const chars = transcript.length
    const optimistic = resolveCompactChunkChars({ transcript, modelContextLength: 200_000, reservedOutputTokens: 8_192 })
    const honest = resolveCompactChunkChars({
      transcript,
      modelContextLength: 200_000,
      reservedOutputTokens: 8_192,
      calibration: { chars, tokens: Math.round(chars / 1.8 * 1.33) },
    })
    expect(honest).toBeLessThan(optimistic)
  })

  it('CompactTokenBudget:四个数收在一处,块与 max_tokens 读的是同一个比值', () => {
    const transcript = 'x'.repeat(1_000_000)
    const budget = new CompactTokenBudget({
      transcript,
      modelContextLength: 1_048_576,
      registeredMaxOutputTokens: 384_000,
      calibration: { chars: transcript.length, tokens: 701_297 },
    })

    expect(budget.calibrationSource).toBe('provider')
    expect(budget.charsPerToken).toBeCloseTo(1_000_000 / 701_297, 6)
    // 折回去就是 provider 报的那个数(向上取整)。
    expect(budget.inputTokensForChars(transcript.length)).toBe(701_297)

    const allowance = budget.outputAllowanceForChars(transcript.length)
    expect(allowance.maxTokens).toBe(343_279)
    expect(allowance.overflow).toBe(false)
    expect(allowance.provenance).toBe('clamped to window 1048576 \u2212 input 701297 \u2212 overhead 4000')

    // 小块 → 夹不动,来历说的是注册上限。
    const small = budget.outputAllowanceForChars(1_000)
    expect(small.maxTokens).toBe(384_000)
    expect(small.provenance).toBe("the model's registered max output")

    // 注册表查不到上限 → 不传,来历说清是 provider 默认。
    const unregistered = new CompactTokenBudget({ transcript, modelContextLength: 1_048_576 })
    const none = unregistered.outputAllowanceForChars(transcript.length)
    expect(none.maxTokens).toBeUndefined()
    expect(none.provenance).toContain('no model max output is registered')

    // 输入吃满窗口 → overflow,照传注册上限(本笔不缩块重试)。
    const tight = new CompactTokenBudget({
      transcript,
      modelContextLength: 100_000,
      registeredMaxOutputTokens: 8_192,
      calibration: { chars: transcript.length, tokens: 200_000 },
    })
    const over = tight.outputAllowanceForChars(transcript.length)
    expect(over.overflow).toBe(true)
    expect(over.maxTokens).toBe(8_192)
  })

  it('selects older messages while keeping the configured recent user turns', () => {
    const planSession = session([
      message(1, 'user'),
      message(2, 'assistant'),
      message(3, 'user'),
      message(4, 'assistant'),
      message(5, 'user'),
      message(6, 'assistant'),
      message(7, 'user'),
      message(8, 'assistant'),
    ])
    const plan = selectCompactPlan(planSession, planSession.messages, 2)

    expect(plan?.cutoffMessage.id).toBe('assistant-4')
    expect(plan?.messagesToSummarize.map(item => item.id)).toEqual([
      'user-1',
      'assistant-2',
      'user-3',
      'assistant-4',
    ])
  })

  it('uses provider usage and local estimates against the user threshold only', async () => {
    const testSession = session([{ ...message(1, 'user'), content: 'x'.repeat(10000) }])

    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      sessionMessages: testSession.messages,
      modelContextLength: 100,
      thresholdPercent: 50,
    })).resolves.toBe(true)

    // 2026-08-23:本地估算(10000 字符 ≈ 2500 token)照样过 85% 线;判定里
    // 不再有任何"预留输出撞窗口"的第二条路。
    testSession.contextSize = 80
    await expect(shouldAutoCompactBeforeSend({
      session: testSession,
      sessionMessages: testSession.messages,
      modelContextLength: 100,
      thresholdPercent: 85,
    })).resolves.toBe(true)
  })

  it('bases shared usage on built history instead of raw session tool results', () => {
    const hugeRawToolResult = 'x'.repeat(500000)
    const testSession = session([{
      ...message(1, 'assistant'),
      toolCalls: [{
        toolId: 'bash',
        toolName: 'bash',
        arguments: { cmd: 'cat huge.log' },
        status: 'completed',
        result: { output: hugeRawToolResult },
      }],
    }])
    testSession.contextSize = 52730
    testSession.lastInputTokens = 52730

    const builtHistory = [
      { role: 'user', content: 'short visible provider payload' },
    ]
    const usage = buildContextUsageSnapshot({
      session: testSession,
      historyMessages: builtHistory,
      modelContextLength: 272000,
      thresholdPercent: 85,
      providerId: 'codex',
      model: 'gpt-5.5',
    })

    expect(usage.visibleInputTokens).toBe(estimateTextTokens(JSON.stringify(builtHistory)))
    expect(usage.visibleInputTokens).toBeLessThan(1000)
    expect(usage.triggerReason).toBe('none')
    expect(estimateSessionInputTokens(testSession, testSession.messages)).toBeGreaterThan(usage.visibleInputTokens * 10)
  })

  it('normalizes fenced markdown summaries and formats sanitized tool results', () => {
    // C5:合格 = 剥掉围栏后有 `## Goal` 标题(不再解析 JSON)。
    expect(normalizeContextSummaryOutput('```markdown\n## Goal\nShip compact\n```'))
      .toBe('## Goal\nShip compact')

    const summaryInput = formatMessagesForSummary([{
      ...message(1, 'assistant'),
      toolCalls: [{
        toolId: 'read',
        toolName: 'read',
        arguments: { path: '/tmp/large.txt' },
        status: 'completed',
        result: {
          output: 'important finding ' + 'x'.repeat(10000),
          originalContent: 'do not include rollback content',
        },
      }],
    }])

    expect(summaryInput).toContain('important finding')
    expect(summaryInput).toContain('[truncated')
    expect(summaryInput).not.toContain('do not include rollback content')
    expect(estimateSessionInputTokens(session([message(1, 'user')]), session([message(1, 'user')]).messages)).toBeGreaterThan(0)
  })
})
