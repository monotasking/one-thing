/**
 * S3.1(§10.11):真机影子抓到的两个引擎缺陷,各钉一条。
 *
 * 1. **step.type 冻在占位那一刻**。占位 step 建于 `tool_input_start` —— 那时参数
 *    还是 `{}`,`bash` 只能算成 `command`。参数定稿后引擎重算了 `title` 却没重算
 *    `type`,于是 `cat x/SKILL.md` 在账上写着 `command`。
 * 2. **skillUsed 从来没落到消息上**。agent-loop 这条路上引擎根本没认过技能,只有
 *    事件记录器自己认了一遍 —— 账本有 `skill/activated`,消息上没有 `skillUsed`。
 *
 * 裁定是"修引擎不供养怪癖":引擎在参数定稿那一刻重算 type、认一次技能并宣告。
 */
import { describe, expect, it } from 'vitest'
import {
  createCoreToolInputStartArtifacts,
  startAgentLoopToolExecution,
} from '@onething/core/engine'
import type { CoreStreamToolCallLike } from '@onething/core/engine'

/** 就用引擎自己那份形状 —— 占位工厂产出的就是它,免得测试里再手抄一份。 */
type TestToolCall = CoreStreamToolCallLike

interface StepUpdate {
  status?: string
  type?: string
  toolCall?: TestToolCall
}

function harness(rawToolName: string) {
  const stepUpdates: Array<{ stepId: string; update: StepUpdate }> = []
  const skills: string[] = []
  const { placeholderStep, placeholderToolCall } = createCoreToolInputStartArtifacts<TestToolCall>({
    toolCallId: 'call-1',
    resolved: { toolId: rawToolName, displayName: rawToolName },
    stepId: 'step-1',
    rawToolName,
    timestamp: 1,
  })
  return { stepUpdates, skills, placeholderStep, placeholderToolCall }
}

function runStart(
  toolCall: TestToolCall,
  sinks: { stepUpdates: Array<{ stepId: string; update: StepUpdate }>; skills: string[] },
): TestToolCall {
  const toolCalls: TestToolCall[] = [toolCall]
  return startAgentLoopToolExecution<TestToolCall, StepUpdate>({
    sessionId: 's1',
    assistantMessageId: 'a1',
    toolCall,
    toolCalls,
    stepId: 'step-1',
    store: { updateMessageToolCalls: () => {} },
    emitter: {
      sendToolCall: () => {},
      sendToolExecutionStart: () => {},
      sendStepUpdated: (stepId, update) => {
        sinks.stepUpdates.push({ stepId, update })
      },
      sendSkillActivated: (skillName) => {
        sinks.skills.push(skillName)
      },
    },
    now: () => 100,
  })
}

describe('engine step type + skill activation (S3.1)', () => {
  it('placeholder starts at command and the start update recomputes from final args', () => {
    const { stepUpdates, skills, placeholderStep, placeholderToolCall } = harness('bash')
    // 占位那一条:参数是 {},bash 只能是 command —— 这就是被冻住的那一格。
    expect(placeholderStep.type).toBe('command')
    expect(placeholderToolCall.arguments).toEqual({})

    const started = runStart(
      { ...placeholderToolCall, arguments: { command: 'cat skills/lenovo-scripts/SKILL.md' } },
      { stepUpdates, skills },
    )

    expect(started.status).toBe('executing')
    expect(stepUpdates).toHaveLength(1)
    expect(stepUpdates[0].update.type).toBe('skill-read')
    expect(stepUpdates[0].update.status).toBe('running')
    // 同一次宣告:引擎认出技能,宿主那边同时落 message.skillUsed 与 skill/activated。
    expect(skills).toEqual(['lenovo-scripts'])
  })

  it.each([
    ['cat README.md', 'file-read', []],
    ['mkdir tmp', 'file-write', []],
    ['npm test', 'command', []],
    ['cat SKILL.md', 'skill-read', []],
    ['head docs/lenovo-scripts/SKILL.md', 'skill-read', ['lenovo-scripts']],
  ] as const)('bash %s → %s', (command, expected, expectedSkills) => {
    const { stepUpdates, skills, placeholderToolCall } = harness('bash')
    runStart({ ...placeholderToolCall, arguments: { command } }, { stepUpdates, skills })
    expect(stepUpdates[0].update.type).toBe(expected)
    expect(skills).toEqual([...expectedSkills])
  })

  it('non-bash tools stay tool-call and never announce a skill', () => {
    const { stepUpdates, skills, placeholderStep, placeholderToolCall } = harness('read')
    expect(placeholderStep.type).toBe('tool-call')
    runStart(
      { ...placeholderToolCall, arguments: { path: 'skills/lenovo-scripts/SKILL.md' } },
      { stepUpdates, skills },
    )
    expect(stepUpdates[0].update.type).toBe('tool-call')
    expect(skills).toEqual([])
  })

  it('announces the skill even when no step id is known', () => {
    const stepUpdates: Array<{ stepId: string; update: StepUpdate }> = []
    const skills: string[] = []
    const toolCall: TestToolCall = {
      id: 'call-1',
      toolId: 'bash',
      toolName: 'bash',
      arguments: { command: 'less a/lenovo-scripts/SKILL.md' },
      status: 'pending',
      timestamp: 1,
    }
    startAgentLoopToolExecution<TestToolCall, StepUpdate>({
      sessionId: 's1',
      assistantMessageId: 'a1',
      toolCall,
      toolCalls: [toolCall],
      store: { updateMessageToolCalls: () => {} },
      emitter: {
        sendToolCall: () => {},
        sendToolExecutionStart: () => {},
        sendStepUpdated: (stepId, update) => {
          stepUpdates.push({ stepId, update })
        },
        sendSkillActivated: (skillName) => {
          skills.push(skillName)
        },
      },
      now: () => 100,
    })
    expect(stepUpdates).toHaveLength(0)
    expect(skills).toEqual(['lenovo-scripts'])
  })
})
