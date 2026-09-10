import { describe, expect, it } from 'vitest'
import {
  SESSION_PAGE_INLINE_RESULT_BYTES,
  extractSessionPageResults,
  isSessionPageResultRef,
} from '../page-results.js'

/** 一条带一次调用的助手消息 —— 三格结果全在,与投影交出来的形逐格同名。 */
function messageWith(result: unknown, options: { text?: unknown; partial?: unknown } = {}) {
  const call = { id: 'call-1', toolName: 'bash', result }
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hi',
    toolCalls: [call],
    steps: [{
      id: 'step-1',
      toolCallId: 'call-1',
      toolCall: { ...call },
      ...(options.text !== undefined ? { result: options.text } : { result }),
      ...(options.partial !== undefined ? { partialResult: options.partial } : {}),
    }],
  }
}

function refKey(value: unknown): string {
  expect(isSessionPageResultRef(value)).toBe(true)
  return (value as { '@pageResult': string })['@pageResult']
}

describe('页里的工具结果侧表', () => {
  it('三格同一段正文折成一枚引用,侧表里只有一份', () => {
    const big = 'x'.repeat(5000)
    const { messages, results } = extractSessionPageResults([messageWith(big)])
    const [message] = messages as [Record<string, any>]

    const a = refKey(message.toolCalls[0].result)
    const b = refKey(message.steps[0].toolCall.result)
    const c = refKey(message.steps[0].result)
    expect(a).toBe('call-1')
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(Object.keys(results)).toEqual(['call-1'])
    expect(results['call-1']).toEqual({ kind: 'inline', value: big })
  })

  /**
   * **两件事各省各的**,所以分两条量 —— 混成一条会让反证空过(第一版就踩了:
   * 拿一段 60KB 的正文量「三份变一份」,而 60KB 早已过了内联线走引用,拆掉
   * 去重照样是三枚小引用,字节看不出差别)。
   */
  it('整页字节 · 内联那一段:三份变一份(这就是本单的那 96.3%)', () => {
    // **压在内联线之下** —— 这一条量的正是去重本身,不是「大结果不带正文」。
    const big = 'x'.repeat(SESSION_PAGE_INLINE_RESULT_BYTES - 1000)
    const before = Buffer.byteLength(JSON.stringify([messageWith(big)]), 'utf8')
    const after = Buffer.byteLength(JSON.stringify(extractSessionPageResults([messageWith(big)])), 'utf8')
    // 三份变一份 —— 原消息是它的两倍半以上。
    expect(before).toBeGreaterThan(after * 2.5)
  })

  it('整页字节 · 过了内联线那一段:正文一个字节都不上线', () => {
    const big = 'x'.repeat(60_000)
    const before = Buffer.byteLength(JSON.stringify([messageWith(big)]), 'utf8')
    const after = Buffer.byteLength(JSON.stringify(extractSessionPageResults([messageWith(big)])), 'utf8')
    // 引用只有尺寸 / 指纹 / 开头 —— 与正文不是一个量级。
    expect(after).toBeLessThan(2000)
    expect(before).toBeGreaterThan(after * 50)
  })

  it('结构化结局与正文是两个值 —— 两枚引用,各是各的事实', () => {
    const structured = { content: [{ type: 'text', text: 'out' }], details: { exitCode: 0 } }
    const { messages, results } = extractSessionPageResults([
      messageWith(structured, { text: 'out', partial: structured }),
    ])
    const [message] = messages as [Record<string, any>]
    expect(refKey(message.toolCalls[0].result)).toBe('call-1')
    expect(refKey(message.steps[0].result)).toBe('call-1#text')
    // partial 与 result 序列化逐字相同 → 跨槽去重折回同一枚。
    expect(refKey(message.steps[0].partialResult)).toBe('call-1')
    expect(Object.keys(results).sort()).toEqual(['call-1', 'call-1#text'])
  })

  it('超过内联预算:侧表只带尺寸 / 指纹 / 开头,不带正文', () => {
    const huge = 'y'.repeat(SESSION_PAGE_INLINE_RESULT_BYTES + 1)
    const { results } = extractSessionPageResults([messageWith(huge)])
    const entry = results['call-1'] as Record<string, unknown>
    expect(entry.kind).toBe('reference')
    expect(entry.toolCallId).toBe('call-1')
    expect(entry.slot).toBe('result')
    expect(entry.bytes).toBeGreaterThan(SESSION_PAGE_INLINE_RESULT_BYTES)
    expect(String(entry.hash)).toMatch(/^[0-9a-f]{16}$/)
    expect(String(entry.preview).length).toBe(200)
    expect(JSON.stringify(results)).not.toContain(huge)
  })

  it('不改入参 —— 交进来的那几只对象是投影 memo 的本体', () => {
    const source = messageWith('short')
    const snapshot = JSON.stringify(source)
    extractSessionPageResults([source])
    expect(JSON.stringify(source)).toBe(snapshot)
  })

  it('子步骤里的调用照样抽,没有结果的一格原样留着', () => {
    const message = {
      id: 'm1',
      role: 'assistant',
      steps: [{
        id: 'step-1',
        toolCallId: 'parent',
        toolCall: { id: 'parent' },
        childSteps: [{ id: 'step-2', toolCallId: 'kid', toolCall: { id: 'kid', result: 'inner' }, result: 'inner' }],
      }],
    }
    const { messages, results } = extractSessionPageResults([message])
    const [out] = messages as [Record<string, any>]
    expect(out.steps[0].toolCall).toEqual({ id: 'parent' })
    expect(refKey(out.steps[0].childSteps[0].result)).toBe('kid')
    expect(results.kid).toEqual({ kind: 'inline', value: 'inner' })
  })

  it('序列化不动的那一格原样留着,不把整页读废掉', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const { messages, results } = extractSessionPageResults([messageWith(cyclic)])
    const [out] = messages as [Record<string, any>]
    expect(out.toolCalls[0].result).toBe(cyclic)
    expect(results).toEqual({})
  })
})
