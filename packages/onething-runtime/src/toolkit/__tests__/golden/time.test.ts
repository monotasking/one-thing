/**
 * `time` 的行为金标(R1 起的对拍suite,R4b 转成金标)。
 *
 * 原本这里逐条比"新实现 vs 旧 `tools/builtin/time.ts`"。旧实现随 R4b 删除,而
 * 对拍在删除前是**绿的** —— 于是每一条原本写作 `expect(新).toBe(旧)` 的断言改成
 * 一张快照:快照里记的就是当时那份旧行为,只是它的出处从"再跑一遍旧代码"变成
 * "一份签下来的文件"。语义一格没少,只是判据从"和旧的一样"变成"就是这一份"。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultValidationMessage } from '../../contract.js'
import { TimeInputSchema, TimeTool } from '../../builtin/time.js'
import { Outcome } from '@onething/core/toolkit'
import { annotationsOf, modelTextOf, partialsOf, runNewTool } from '../support.js'

const FIXTURES: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'now', args: { action: 'now', timezone: 'Asia/Shanghai', format: 'iso' } },
  { name: 'convert', args: { action: 'convert', time: '2026-08-18T00:00:00Z', to_timezone: 'Asia/Tokyo' } },
  { name: 'diff', args: { action: 'diff', start_time: '2026-08-18T00:00:00Z', end_time: '2026-08-19T06:30:00Z', unit: 'hour' } },
  { name: 'add (negative amount)', args: { action: 'add', time: '2026-08-18T00:00:00Z', amount: -90, unit: 'minute' } },
]

describe('golden: time', () => {
  // `now` 是时钟的函数,所以快照必须在同一个瞬间取。只假 Date —— setTimeout 留给
  // AbortScope 自己用(内核的超时子作用域跑在真定时器上)。
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spec is pinned (description + JSON schema + effects + concurrency)', () => {
    const tool = new TimeTool()
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.input).toMatchSnapshot('input schema')
    expect(tool.spec.concurrency).toBe('parallel')
    expect(tool.spec.effects).toEqual([])
  })

  for (const fixture of FIXTURES) {
    it(`model text and render info are pinned: ${fixture.name}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-08-18T09:51:43.115Z'))

      // Pin the output timezone instead of inheriting the runner's local zone.
      const run = await runNewTool(new TimeTool(), { timezone: 'Asia/Shanghai', ...fixture.args })
      expect(run.outcome.kind).toBe('ok')

      // (a) 模型看到的文本
      expect(modelTextOf(run.outcome)).toMatchSnapshot('model text')
      // (b) 权限输入:空效果、无预览
      expect(run.intent.effects).toEqual([])
      expect(run.intent.preview).toBeUndefined()
      // (d) 渲染信息不丢:状态标题 + 结果标题 + metadata 都在
      expect(annotationsOf(run).map(entry => entry.title)).toMatchSnapshot('annotation titles')
      expect(annotationsOf(run).at(-1)?.details).toMatchSnapshot('final metadata')
      // 进度事件仍然存在
      expect(partialsOf(run)[0]?.content[0]?.text).toBe(`Calculating time ${String(fixture.args.action)}...`)
    })
  }

  it('rejects an illegal action with the contract validation wording', async () => {
    const args = { action: 'yesterday' }
    const parsed = TimeInputSchema.safeParse(args)
    expect(parsed.success).toBe(false)

    const run = await runNewTool(new TimeTool(), args)
    expect(run.outcome.kind).toBe('invalid')
    // 旧管线没有 formatValidationError → `Invalid arguments: <zod message>`
    // R2a 决定③:模型看到的就是工具的文案本身,没有 `Invalid tool input: ` 前缀。
    expect(Outcome.toModelText(run.outcome))
      .toBe(defaultValidationMessage(parsed.success ? undefined : parsed.error))
  })

  it('reports a failure for an unknown timezone', async () => {
    const run = await runNewTool(new TimeTool(), { action: 'now', timezone: 'Mars/Olympus' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toMatchSnapshot('unknown timezone')
  })

  it('reports a failure for a missing required field (diff without start_time)', async () => {
    const run = await runNewTool(new TimeTool(), { action: 'diff' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toMatchSnapshot('diff without start_time')
  })

  it('cancels: an already-aborted signal yields `aborted`, never a result', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(new TimeTool(), { action: 'now' }, { signal: controller.signal })
    // 旧实现完全不认识 abortSignal —— 它照跑并返回成功。这是新增能力,不是回归。
    expect(run.outcome.kind).toBe('aborted')
  })
})
