/**
 * `goal` / `task` 的行为金标(R3a 起的对拍 suite,R4b 转成金标 —— 见
 * time.test.ts 的头注释)。
 *
 * 每只四组以上:正常 / 边界 / 错误 / 取消,外加场景门(`visibleIn`)。
 */

import { describe, expect, it, vi } from 'vitest'
import { EFFECT_POLICY, Outcome } from '@onething/core/toolkit'
import { zodToJsonSchema } from '../../contract.js'
import type { SessionGoal } from '../../../goals/types.js'
import { createGoalTool, GoalInputSchema, type GoalToolAdapters } from '../../builtin/goal.js'
import { createTaskTool, TaskInputSchema, type TaskToolPorts } from '../../builtin/task.js'
import { annotationsOf, modelTextOf, normalizeDetails, runNewTool } from '../support.js'

function activeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'g1',
    objective: '把工具系统搬完',
    status: 'active',
    tokensUsed: 100,
    timeUsedSeconds: 42.4,
    continuationCount: 2,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SessionGoal
}

function goalAdapters(goal: SessionGoal | undefined): GoalToolAdapters {
  return {
    getGoal: () => goal,
    updateGoalFromModel: (_sessionId, status, reason) =>
      activeGoal({ status: status as SessionGoal['status'], statusReason: reason }),
    remainingTokens: () => 900,
  }
}

describe('golden: goal', () => {
  it('spec 钉住', () => {
    const tool = createGoalTool(goalAdapters(activeGoal()))
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.input).toEqual(zodToJsonSchema(GoalInputSchema))
    expect(tool.spec.concurrency).toBe('sequential')
    // 旧 permissionGuard 'safe' + 无 analyze → 新树静态上界为空
    expect(tool.spec.effects).toEqual([])
  })

  const FIXTURES: Array<{ name: string; goal?: SessionGoal; args: Record<string, unknown> }> = [
    { name: '正常:get 一个 active 目标', goal: activeGoal(), args: { action: 'get' } },
    { name: '正常:continue 带 note', goal: activeGoal(), args: { action: 'continue', note: '下一步跑测试' } },
    { name: '边界:没有目标时 continue', goal: undefined, args: { action: 'continue' } },
    { name: '边界:目标不是 active 时 continue', goal: activeGoal({ status: 'paused', statusReason: '等用户' }), args: { action: 'continue' } },
    { name: '边界:pause 带 reason', goal: activeGoal(), args: { action: 'pause', reason: '需要你拍板 A 还是 B' } },
    { name: '边界:第一次 complete 触发自检', goal: activeGoal(), args: { action: 'complete', reason: '交付了', evidence: '逐条列过' } },
    { name: '边界:没有目标时 get', goal: undefined, args: { action: 'get' } },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息钉住:${fixture.name}`, async () => {
      const run = await runNewTool(createGoalTool(goalAdapters(fixture.goal)), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toMatchSnapshot('model text')
      expect(annotationsOf(run).at(-1)?.title).toMatchSnapshot('title')
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toMatchSnapshot('metadata')
      expect(run.intent.effects).toEqual([])
    })
  }

  it('边界:第二次 complete 真的完成(自检通过之后)', async () => {
    const args = { action: 'complete', reason: '交付了', evidence: '逐条列过' }
    const tool = createGoalTool(goalAdapters(activeGoal()))
    await runNewTool(tool, args)
    const run = await runNewTool(tool, args)
    expect(modelTextOf(run.outcome)).toMatchSnapshot('second complete')
  })

  it('错误:complete 缺 reason', async () => {
    const run = await runNewTool(createGoalTool(goalAdapters(activeGoal())), { action: 'complete' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toMatchSnapshot('complete without reason')
  })

  it('错误:action 不合契约', async () => {
    const run = await runNewTool(createGoalTool(goalAdapters(activeGoal())), { action: 'abandon' })
    expect(run.outcome.kind).toBe('invalid')
    expect(Outcome.toModelText(run.outcome)).toContain('Invalid arguments')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createGoalTool(goalAdapters(activeGoal())), { action: 'get' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })

  it('场景门:只在会话有 active 目标的回合露面', () => {
    const tool = createGoalTool(goalAdapters(activeGoal()))
    expect(tool.visibleIn({ goalActive: true })).toBe(true)
    expect(tool.visibleIn({ goalActive: false })).toBe(false)
    expect(tool.visibleIn({})).toBe(false)
  })
})

describe('golden: task', () => {
  function ports(outcome: Awaited<ReturnType<TaskToolPorts['dispatch']>>): TaskToolPorts {
    return { dispatch: vi.fn(async () => outcome) }
  }

  const OK = { ok: true as const, taskSessionId: 'sess-9', workingDirectory: '/tmp/x', running: 1 }

  it('spec 钉住(描述 / schema / 并发档)', () => {
    const tool = createTaskTool(ports(OK))
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.input).toEqual(zodToJsonSchema(TaskInputSchema))
    expect(tool.spec.concurrency).toBe('sequential')
  })

  /**
   * 派工报一条 `session_spawn`,而它在策略表里是 **`silent`**(R3a 复盘裁定):
   * 派工的本义就是"派出去继续干",风险由并发上限与子会话自己的权限卡兜住。
   * 所以这条效果**不改变用户看到的东西** —— 它存在是为了让审计能回答"这一回合
   * 派出去过一条会话",而旧路里那件事只留在日志里。
   */
  it('派工报一条 session_spawn,但它是 silent —— 不弹卡,只进审计', async () => {
    const run = await runNewTool(createTaskTool(ports(OK)), { prompt: '去把 X 做了' })
    expect(run.intent.effects.map(effect => effect.kind)).toEqual(['session_spawn'])
    expect(run.intent.preview?.title).toContain('Dispatch a background task')
    // 关键的一句:这一组效果不需要惊动任何人(与旧 permissionGuard 'safe' 同效)。
    expect(EFFECT_POLICY.session_spawn.policy).toBe('silent')
    expect(run.intent.requiresAuthorization).toBe(false)
    // 屏障保留:两次并发登记会把并发闸算错。
    expect(run.intent.effects[0]?.barrier).toBe(true)
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown>; outcome: Awaited<ReturnType<TaskToolPorts['dispatch']>> }> = [
    { name: '正常:派出去了', args: { prompt: '去把 X 做了' }, outcome: OK },
    { name: '正常:带 description / workingDirectory / model', args: { prompt: 'p', description: '调研', workingDirectory: ' /tmp/y ', model: ' gpt ' }, outcome: OK },
    { name: '边界:空任务书', args: { prompt: '   ' }, outcome: OK },
    { name: '错误:并发满了', args: { prompt: 'p' }, outcome: { ok: false as const, reason: 'concurrency' as const } },
    { name: '错误:工作会话禁止套娃', args: { prompt: 'p' }, outcome: { ok: false as const, reason: 'nested' as const } },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息钉住:${fixture.name}`, async () => {
      const run = await runNewTool(createTaskTool(ports(fixture.outcome)), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toMatchSnapshot('model text')
      expect(annotationsOf(run).at(-1)?.title).toMatchSnapshot('title')
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toMatchSnapshot('metadata')
    })
  }

  it('边界:空任务书不报 session_spawn —— 它根本开不出会话', async () => {
    const run = await runNewTool(createTaskTool(ports(OK)), { prompt: '  ' })
    expect(run.intent.effects).toEqual([])
  })

  it('错误:prompt 缺席不合契约', async () => {
    const run = await runNewTool(createTaskTool(ports(OK)), {})
    expect(run.outcome.kind).toBe('invalid')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createTaskTool(ports(OK)), { prompt: 'p' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })

  it('场景门:工作会话看不见 task(禁止套娃)', () => {
    const tool = createTaskTool(ports(OK))
    expect(tool.visibleIn({})).toBe(true)
    expect(tool.visibleIn({ taskSession: false })).toBe(true)
    expect(tool.visibleIn({ taskSession: true })).toBe(false)
  })
})
