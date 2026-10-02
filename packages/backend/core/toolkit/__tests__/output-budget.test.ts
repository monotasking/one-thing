import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_OUTPUT_BUDGET, OutputBudget } from '../output-budget.js'
import { textResult } from '../result.js'
import { ScriptedTool } from './fakes.js'

describe('OutputBudget', () => {
  it('没超阈值就一个字都不动', async () => {
    const budget = new OutputBudget({ maxLines: 10, maxBytes: 1000 })
    const result = textResult('a\nb\nc')
    const finalized = await budget.finalize(result)
    expect(finalized.content[0]?.text).toBe('a\nb\nc')
    expect(budget.truncated).toBe(false)
  })

  it('行数超了:截断 + <truncation> 尾注 + 落盘端口拿到完整原文', async () => {
    const spilled: string[] = []
    const spill = vi.fn(async (request: { text: string }) => {
      spilled.push(request.text)
      return '/tmp/spill-1.txt'
    })
    const budget = new OutputBudget({ maxLines: 2 }, { spill, toolId: 'bash', callId: 'call-9' })

    const original = ['1', '2', '3', '4', '5'].join('\n')
    const finalized = await budget.finalize(textResult(original))
    const text = finalized.content[0]?.text ?? ''

    expect(text.startsWith('1\n2')).toBe(true)
    expect(text).toContain('<truncation reason="lines"')
    expect(text).toContain('total-lines="5"')
    expect(text).toContain('spill="/tmp/spill-1.txt"')
    expect(budget.truncated).toBe(true)
    expect(spilled).toEqual([original])
    expect(spill.mock.calls[0]?.[0]).toMatchObject({ toolId: 'bash', callId: 'call-9', reason: 'lines' })
  })

  it('字节数超了也截断,并且不切碎多字节字符', async () => {
    const budget = new OutputBudget({ maxBytes: 10 })
    const finalized = await budget.finalize(textResult('中文中文中文中文'))
    const text = finalized.content[0]?.text ?? ''
    expect(text).toContain('reason="bytes"')
    // 截出来的头部仍是合法字符串(没有落单的代理项/半个 UTF-8 序列)。
    expect(text.split('\n<truncation')[0]).toBe('中文中')
  })

  it('没有 spill 端口时照样截断,只是说明里不提溢出文件', async () => {
    const budget = new OutputBudget({ maxLines: 1 })
    const finalized = await budget.finalize(textResult('a\nb'))
    const text = finalized.content[0]?.text ?? ''
    expect(text).toContain('<truncation')
    expect(text).not.toContain('spill=')
    expect(text).toContain('discarded')
  })

  it('落盘端口自己炸了不该把一次成功调用变成失败', async () => {
    const budget = new OutputBudget({ maxLines: 1 }, { spill: () => { throw new Error('disk full') } })
    const finalized = await budget.finalize(textResult('a\nb'))
    expect(finalized.content[0]?.text).toContain('<truncation')
    expect(budget.truncated).toBe(true)
  })

  it('只对 text part 生效,image/file part 原样透传', async () => {
    const budget = new OutputBudget({ maxLines: 1 })
    const finalized = await budget.finalize({
      content: [
        { type: 'image', path: '/tmp/a.png', data: 'x'.repeat(10_000) },
        { type: 'file', path: '/tmp/a.txt' },
      ],
      details: { kept: true },
    })
    expect(finalized.content[0]?.data?.length).toBe(10_000)
    expect(finalized.details).toEqual({ kept: true })
    expect(budget.truncated).toBe(false)
  })

  it('for(spec) 取工具声明的阈值,缺省走默认表', () => {
    const withHint = OutputBudget.for(new ScriptedTool({ id: 'read', budget: { maxLines: 50 } }).spec)
    expect(withHint.limits.maxLines).toBe(50)
    expect(withHint.limits.maxBytes).toBe(DEFAULT_OUTPUT_BUDGET.maxBytes)

    const plain = OutputBudget.for(new ScriptedTool().spec)
    expect(plain.limits).toEqual(DEFAULT_OUTPUT_BUDGET)
  })

  it('R2a 决定⑦:默认阈值是兜底,不是同侪 —— 高于任何一只工具自己的上限', () => {
    // 判据(设计文档 §11.1):read / bash 自己截到 2000 行,内核这把尺子必须留出
    // 它们加尾注的余量,否则会剪掉"怎么把剩下的拿回来"那句话。
    expect(DEFAULT_OUTPUT_BUDGET.maxLines).toBe(4000)
    expect(DEFAULT_OUTPUT_BUDGET.maxBytes).toBe(256 * 1024)
  })

  it('R2a 决定⑦:2048 行(read 的天窗)在默认阈值下一个字都不动', async () => {
    const budget = new OutputBudget()
    const text = Array.from({ length: 2048 }, (_, index) => `line ${index}`).join('\n')
    const finalized = await budget.finalize(textResult(text))
    expect(finalized.content[0]?.text).toBe(text)
    expect(budget.truncated).toBe(false)
  })
})
