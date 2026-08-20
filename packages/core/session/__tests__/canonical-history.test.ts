/**
 * F10a(§13.2/§13.4):**判等器的键序盲区。**
 *
 * `canonicalHistoryMessages` 归一化时对对象键排序 —— 对逐字段映射到 provider
 * 形状的那些格,这是对的。但工具结局与工具参数不是那样走的:它们整个被
 * `JSON.stringify` 成**一串字节**塞进请求(`packages/core/agent-loop/
 * wire-format.ts`),而 `JSON.stringify` 保留键的插入序。
 *
 * 于是从前有一类"判等但不等价":两份历史被影子判成相同,发出去却是两段不同
 * 的前缀 —— provider 的 prompt cache 全失效,而门一声不响。这一套用例把那条
 * 缝钉死。
 */
import { describe, expect, it } from 'vitest'
import { canonicalHistoryMessages } from '../projection/canonical.js'

function toolResultHistory(result: unknown): unknown[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'c1', toolName: 'read', args: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read', result }] },
  ]
}

describe('canonicalHistoryMessages — wire bytes, not object shape (F10a)', () => {
  it('separates two tool results that differ only in key insertion order', () => {
    const a = canonicalHistoryMessages(toolResultHistory({ ok: true, lines: 3 }))
    const b = canonicalHistoryMessages(toolResultHistory({ lines: 3, ok: true }))
    // 同样的内容,不同的插入序 —— wire 上是两串字节,判据必须看得出来。
    expect(a).not.toBe(b)
  })

  it('judges two truly identical tool results equal', () => {
    const payload = { ok: true, lines: 3 }
    expect(canonicalHistoryMessages(toolResultHistory({ ...payload })))
      .toBe(canonicalHistoryMessages(toolResultHistory({ ...payload })))
  })

  it('separates two tool-call argument objects that differ only in key order', () => {
    const call = (args: Record<string, unknown>): unknown[] => [
      { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'c1', toolName: 'edit', args }] },
    ]
    expect(canonicalHistoryMessages(call({ path: 'a', oldText: 'x' })))
      .not.toBe(canonicalHistoryMessages(call({ oldText: 'x', path: 'a' })))
    expect(canonicalHistoryMessages(call({ path: 'a', oldText: 'x' })))
      .toBe(canonicalHistoryMessages(call({ path: 'a', oldText: 'x' })))
  })

  it('treats the string form and the object form of one result as the same bytes', () => {
    // wire 上两者产出同一串:`stringifyToolResult` 对字符串原样返回。
    expect(canonicalHistoryMessages(toolResultHistory('{"ok":true}')))
      .toBe(canonicalHistoryMessages(toolResultHistory({ ok: true })))
  })

  it('still ignores key order everywhere else (message envelope, content parts)', () => {
    expect(canonicalHistoryMessages([{ role: 'user', content: 'x', extra: undefined }]))
      .toBe(canonicalHistoryMessages([{ content: 'x', role: 'user' }]))
    expect(canonicalHistoryMessages([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]))
      .toBe(canonicalHistoryMessages([{ content: [{ text: 'x', type: 'text' }], role: 'user' }]))
  })

  it('keeps the tool-call args comparison honest across args / arguments spellings', () => {
    const withArgs = [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a' } }] }]
    const withArguments = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
    ]
    expect(canonicalHistoryMessages(withArgs)).toBe(canonicalHistoryMessages(withArguments))
  })
})
