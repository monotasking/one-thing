/**
 * R1 对拍 —— `time`。旧 `tools/builtin/time.ts` vs 新 `toolkit/builtin/time.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimeTool as LegacyTimeTool } from '../../../tools/builtin/time.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import { defaultValidationMessage } from '../../contract.js'
import { TimeTool } from '../../builtin/time.js'
import { Outcome } from '@onething/core/toolkit'
import { annotationsOf, legacyContext, modelTextOf, partialsOf, runNewTool } from '../support.js'

const FIXTURES: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'now', args: { action: 'now', timezone: 'Asia/Shanghai', format: 'iso' } },
  { name: 'convert', args: { action: 'convert', time: '2026-08-18T00:00:00Z', to_timezone: 'Asia/Tokyo' } },
  { name: 'diff', args: { action: 'diff', start_time: '2026-08-18T00:00:00Z', end_time: '2026-08-19T06:30:00Z', unit: 'hour' } },
  { name: 'add (negative amount)', args: { action: 'add', time: '2026-08-18T00:00:00Z', amount: -90, unit: 'minute' } },
]

describe('parity: time', () => {
  // `now` 是时钟的函数,对拍必须在同一个瞬间比。只假 Date —— setTimeout 留给
  // AbortScope 自己用(内核的超时子作用域跑在真定时器上)。
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spec is pinned to the legacy tool (description + JSON schema)', () => {
    const tool = new TimeTool()
    expect(tool.spec.description).toBe(LegacyTimeTool.description)
    expect(tool.spec.input).toEqual(zodToJsonSchema(LegacyTimeTool.parameters))
    expect(tool.spec.concurrency).toBe('parallel')
    expect(tool.spec.effects).toEqual([])
  })

  for (const fixture of FIXTURES) {
    it(`model text and render info match: ${fixture.name}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-08-18T09:51:43.115Z'))
      const { ctx, record } = legacyContext()
      const legacy = await LegacyTimeTool.execute(fixture.args as never, ctx as never)

      const run = await runNewTool(new TimeTool(), fixture.args)
      expect(run.outcome.kind).toBe('ok')

      // (a) 模型看到的文本
      expect(modelTextOf(run.outcome)).toBe(legacy.output)
      // (b) 权限输入:两边都是空效果、无预览
      expect(run.intent.effects).toEqual([])
      expect(run.intent.preview).toBeUndefined()
      // (d) 渲染信息不丢:旧的两个标题(状态标题 + 结果标题)与 metadata 都在
      const titles = annotationsOf(run).map(entry => entry.title)
      expect(titles).toContain(record.metadataCalls[0]?.title)
      expect(titles).toContain(legacy.title)
      expect(annotationsOf(run).at(-1)?.details).toEqual(legacy.metadata)
      // 进度事件仍然存在
      expect(partialsOf(run)[0]?.content[0]?.text).toBe(`Calculating time ${String(fixture.args.action)}...`)
    })
  }

  it('rejects an illegal action with the same validation wording', async () => {
    const args = { action: 'yesterday' }
    const parsed = LegacyTimeTool.parameters.safeParse(args)
    expect(parsed.success).toBe(false)

    const run = await runNewTool(new TimeTool(), args)
    expect(run.outcome.kind).toBe('invalid')
    // 旧管线没有 formatValidationError → `Invalid arguments: <zod message>`
    // R2a 决定③:模型看到的就是工具的文案本身,没有 `Invalid tool input: ` 前缀。
    expect(Outcome.toModelText(run.outcome))
      .toBe(defaultValidationMessage(parsed.success ? undefined : parsed.error))
  })

  it('reports the same failure for an unknown timezone', async () => {
    const args = { action: 'now', timezone: 'Mars/Olympus' }
    const { ctx } = legacyContext()
    const legacyError = await LegacyTimeTool.execute(args as never, ctx as never).then(
      () => undefined,
      (error: unknown) => error as Error,
    )
    expect(legacyError).toBeInstanceOf(Error)

    const run = await runNewTool(new TimeTool(), args)
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacyError?.message)
  })

  it('reports the same failure for a missing required field (diff without start_time)', async () => {
    const args = { action: 'diff' }
    const { ctx } = legacyContext()
    const legacyError = await LegacyTimeTool.execute(args as never, ctx as never).then(
      () => undefined,
      (error: unknown) => error as Error,
    )

    const run = await runNewTool(new TimeTool(), args)
    if (legacyError) {
      expect(run.outcome.kind).toBe('failed')
      expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacyError.message)
    } else {
      expect(run.outcome.kind).toBe('ok')
    }
  })

  it('cancels: an already-aborted signal yields `aborted`, never a result', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(new TimeTool(), { action: 'now' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
    // 旧实现完全不认识 abortSignal —— 它照跑并返回成功。这是新增能力,不是回归。
    const { ctx } = legacyContext({ signal: controller.signal })
    const legacy = await LegacyTimeTool.execute({ action: 'now' } as never, ctx as never)
    expect(legacy.output).toBeTruthy()
  })
})
