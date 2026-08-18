/**
 * R1 对拍 —— `variable`。旧 `tools/builtin/variable.ts` vs 新
 * `toolkit/builtin/variable.ts`。
 *
 * 用一份内存 registry(两边共用同一份实现,各拿一个新实例),这样比的是工具壳而不
 * 是变量系统。
 */

import { describe, expect, it } from 'vitest'
import { createVariableTool as createLegacyVariableTool } from '../../../tools/builtin/variable.js'
import type {
  RuntimeContextVariable,
  RuntimeVariableRegistry,
  RuntimeVariableSetInput,
} from '../../../tools/builtin/variable.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import { defaultValidationMessage } from '../../contract.js'
import { createVariableTool, VariableInputSchema } from '../../builtin/variable.js'
import { Outcome } from '@onething/core/toolkit'
import { annotationsOf, legacyContext, modelTextOf, normalizeEffects, partialsOf, runNewTool } from '../support.js'

const SEED: RuntimeContextVariable[] = [
  { name: 'workdir', value: '/repo', scope: 'session', readonly: true, description: 'Work directory' },
  { name: 'topic', value: 'toolkit', scope: 'session', type: 'string', state: true },
  { name: 'user_note_dir', value: '/notes', scope: 'global' },
]

function memoryRegistry(): RuntimeVariableRegistry {
  const rows = SEED.map(row => ({ ...row }))
  const upsert = (input: RuntimeVariableSetInput) => {
    const existing = rows.find(row => row.name === input.name)
    const next = { ...(existing ?? { name: input.name }), ...input }
    if (existing) Object.assign(existing, next)
    else rows.push(next)
    return next
  }
  return {
    list: () => rows.map(row => ({ ...row })),
    set: (_ctx, input) => upsert(input),
    append: (_ctx, input) => upsert(input),
    remove: (_ctx, input) => upsert(input),
    delete: (_ctx, name) => {
      const index = rows.findIndex(row => row.name === name)
      if (index >= 0) rows.splice(index, 1)
    },
  }
}

function pair() {
  const adapters = { getRegistry: memoryRegistry }
  return { legacyTool: createLegacyVariableTool(adapters), newTool: createVariableTool(adapters) }
}

async function bothRuns(args: Record<string, unknown>) {
  const { legacyTool, newTool } = pair()
  const { ctx, record } = legacyContext()
  const legacy = await (async () => {
    try {
      const analysis = await Promise.resolve(legacyTool.analyze!(args as never, ctx as never))
      ctx.approvedAnalysis = analysis
      const result = await legacyTool.execute(args as never, ctx as never)
      return { analysis, result, error: undefined }
    } catch (error) {
      return { analysis: undefined, result: undefined, error: error as Error }
    }
  })()
  const run = await runNewTool(newTool, args)
  return { legacy, record, run, legacyTool, newTool }
}

describe('parity: variable', () => {
  it('spec is pinned to the legacy tool', () => {
    const { legacyTool, newTool } = pair()
    expect(newTool.spec.description).toBe(legacyTool.description)
    expect(newTool.spec.input).toEqual(zodToJsonSchema(VariableInputSchema))
    expect(newTool.spec.input).toEqual(zodToJsonSchema(legacyTool.parameters))
    expect(newTool.spec.concurrency).toBe('sequential')
    expect(newTool.spec.effects).toEqual(['capability_change'])
    // R2a 决定②:三类里用了两类的那只工具 —— 一格结构装不下,所以内核那一格
    // 现在就是 `CoreToolPromptContribution`。
    expect(newTool.spec.prompt).toEqual(legacyTool.prompt)
    expect(newTool.spec.prompt?.workspaceRules).toHaveLength(1)
    expect(newTool.spec.prompt?.sections?.[0]?.id).toBe('context-variables')
  })

  it('normal: list renders identically and carries no effect', async () => {
    const { legacy, record, run } = await bothRuns({ action: 'list' })
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(run.intent.effects).toEqual([])
    const titles = annotationsOf(run).map(entry => entry.title)
    expect(titles).toContain(record.metadataCalls[0]?.title)
    expect(titles).toContain(legacy.result!.title)
    expect(annotationsOf(run).at(-1)?.details).toEqual(legacy.result!.metadata)
    expect(partialsOf(run).at(-1)?.details).toMatchObject({ phase: 'ready', action: 'list' })
  })

  it('boundary: keys projects names only, in the same order', async () => {
    const { legacy, run } = await bothRuns({ action: 'keys' })
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).not.toContain('/repo')
  })

  it('boundary: get on a missing name returns the same self-rescue line', async () => {
    const { legacy, run } = await bothRuns({ action: 'get', name: 'nothing_here' })
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toContain('Use action="keys" to see what exists.')
  })

  it('normal: set writes and renders identically', async () => {
    const { legacy, run } = await bothRuns({ action: 'set', name: 'topic', value: 'r1' })
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toContain('topic = r1')
    expect(run.intent.effects).toEqual([])
  })

  it('permission input: repointing a capability variable reports capability_change identically', async () => {
    const { legacy, run } = await bothRuns({ action: 'set', name: 'user_note_dir', value: '/elsewhere' })
    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(legacy.analysis!.effects))
    expect(run.intent.preview).toEqual(legacy.analysis!.preview)
    expect(legacy.analysis!.effects[0]?.kind).toBe('capability_change')
    // 读操作不报效果 —— 一次 get 不该弹出"重指目录"的审批框。
    const read = await bothRuns({ action: 'get', name: 'user_note_dir' })
    expect(read.run.intent.effects).toEqual([])
    expect(read.legacy.analysis!.effects).toEqual([])
  })

  it('error: set without a value reports the same message', async () => {
    const { legacy, run } = await bothRuns({ action: 'set', name: 'topic' })
    expect(legacy.error).toBeInstanceOf(Error)
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacy.error!.message)
  })

  it('error: delete without a name reports the same message', async () => {
    const { legacy, run } = await bothRuns({ action: 'delete' })
    expect(legacy.error).toBeInstanceOf(Error)
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacy.error!.message)
  })

  it('error: an illegal action is rejected with the default validation wording', async () => {
    const { legacyTool, newTool } = pair()
    const parsed = legacyTool.parameters.safeParse({ action: 'explode' })
    const run = await runNewTool(newTool, { action: 'explode' })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:模型看到的就是工具的文案本身,没有 `Invalid tool input: ` 前缀。
    expect(Outcome.toModelText(run.outcome))
      .toBe(defaultValidationMessage(parsed.success ? undefined : parsed.error))
  })

  it('cancels: an already-aborted signal yields `aborted`', async () => {
    const { newTool } = pair()
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(newTool, { action: 'list' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})
