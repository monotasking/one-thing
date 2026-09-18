/**
 * `variable` 的行为金标(R1 起的对拍 suite,R4b 转成金标 —— 见 time.test.ts 的
 * 头注释)。
 *
 * 用一份内存 registry,这样钉的是工具壳而不是变量系统。
 */

import { describe, expect, it } from 'vitest'
import { defaultValidationMessage, zodToJsonSchema } from '../../contract.js'
import {
  createVariableTool,
  VariableInputSchema,
  type RuntimeContextVariable,
  type RuntimeVariableRegistry,
  type RuntimeVariableSetInput,
} from '../../builtin/variable.js'
import { Outcome } from '@onething/core/toolkit'
import { annotationsOf, modelTextOf, partialsOf, runNewTool } from '../support.js'

const SEED: RuntimeContextVariable[] = [
  { name: 'workdir', value: '/repo', scope: 'session', readonly: true, description: 'Work directory' },
  { name: 'topic', value: 'toolkit', scope: 'session', type: 'string', state: true },
  { name: 'shared_note', value: '/notes', scope: 'global' },
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

function newTool() {
  return createVariableTool({ getRegistry: memoryRegistry })
}

const runVariable = (args: Record<string, unknown>) => runNewTool(newTool(), args)

describe('golden: variable', () => {
  it('spec 钉住', () => {
    const tool = newTool()
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.input).toEqual(zodToJsonSchema(VariableInputSchema))
    expect(tool.spec.concurrency).toBe('sequential')
    expect(tool.spec.effects).toEqual(['capability_change'])
    // R2a 决定②:三类里用了两类的那只工具 —— 一格结构装不下,所以内核那一格
    // 现在就是 `CoreToolPromptContribution`。
    expect(tool.spec.prompt).toMatchSnapshot('prompt contribution')
    expect(tool.spec.prompt?.workspaceRules).toHaveLength(1)
    expect(tool.spec.prompt?.sections?.[0]?.id).toBe('context-variables')
  })

  it('normal: list renders and carries no effect', async () => {
    const run = await runVariable({ action: 'list' })
    expect(modelTextOf(run.outcome)).toMatchSnapshot('list output')
    expect(run.intent.effects).toEqual([])
    expect(annotationsOf(run).map(entry => entry.title)).toMatchSnapshot('list annotation titles')
    expect(annotationsOf(run).at(-1)?.details).toMatchSnapshot('list metadata')
    expect(partialsOf(run).at(-1)?.details).toMatchObject({ phase: 'ready', action: 'list' })
  })

  it('boundary: keys projects names only, in the same order', async () => {
    const run = await runVariable({ action: 'keys' })
    expect(modelTextOf(run.outcome)).toMatchSnapshot('keys output')
    expect(modelTextOf(run.outcome)).not.toContain('/repo')
  })

  it('boundary: get on a missing name returns the self-rescue line', async () => {
    const run = await runVariable({ action: 'get', name: 'nothing_here' })
    expect(modelTextOf(run.outcome)).toMatchSnapshot('missing get output')
    expect(modelTextOf(run.outcome)).toContain('Use action="keys" to see what exists.')
  })

  it('normal: set writes and renders', async () => {
    const run = await runVariable({ action: 'set', name: 'topic', value: 'r1' })
    expect(modelTextOf(run.outcome)).toMatchSnapshot('set output')
    expect(modelTextOf(run.outcome)).toContain('topic = r1')
    expect(run.intent.effects).toEqual([])
  })

  /**
   * **能力变量表今天是空的**(P3,2026-09-18):它唯一的两个成员
   * `user_note_dir` / `work_note_dir` 随笔记领域退役了,「笔记在哪」改成设置里的
   * 一张库表。于是写任何一个变量都不再报 `capability_change`。
   *
   * 机制本身留着(`CAPABILITY_VARIABLE_NAMES` + `VariableTool.plan` 那道门)——
   * 下一个「值即能力」的变量加进来时,改的是那张表里的一行。真加了之后,这条
   * 用例要改回「报效果」的那一版(git 历史里有原样)。
   */
  it('permission input: 能力变量表为空,写变量不报效果', async () => {
    const run = await runVariable({ action: 'set', name: 'shared_note', value: '/elsewhere' })
    expect(run.intent.effects).toEqual([])
    const read = await runVariable({ action: 'get', name: 'shared_note' })
    expect(read.intent.effects).toEqual([])
  })

  it('error: set without a value', async () => {
    const run = await runVariable({ action: 'set', name: 'topic' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toMatchSnapshot('set without value')
  })

  it('error: delete without a name', async () => {
    const run = await runVariable({ action: 'delete' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toMatchSnapshot('delete without name')
  })

  it('error: an illegal action is rejected with the default validation wording', async () => {
    const parsed = VariableInputSchema.safeParse({ action: 'explode' })
    const run = await runVariable({ action: 'explode' })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:模型看到的就是工具的文案本身,没有 `Invalid tool input: ` 前缀。
    expect(Outcome.toModelText(run.outcome))
      .toBe(defaultValidationMessage(parsed.success ? undefined : parsed.error))
  })

  it('cancels: an already-aborted signal yields `aborted`', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(newTool(), { action: 'list' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})
