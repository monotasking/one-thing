/**
 * 场景面 —— `resolveScene` + 每只工具的 `visibleIn(scene)`,由 `Surface.resolve`
 * 求交(设计文档 §5 SceneResolver)。
 *
 * R3a 时这里是一张**等价测试**:逐组比新路与旧集中式减法表
 * (`tools/scene-surface.ts` 的 `resolveSceneHiddenToolIds`)。R4b 把那张表删了,
 * 于是每一组夹具把它当时算出来的 hidden 集合**写死在 fixture 上** —— 同一组输入、
 * 同一份答案,只是判据从"和旧表一样"变成"就是这一份"。
 *
 * `feature_*` 三只住在装配层(它们依赖 features 注册表与 store 路径),产品层的
 * 测试碰不到。这里用同一个家族基类(`CapabilityTool` + 同一个 skill 名)造三只
 * 同名替身:被测的是**规则**,而三只真工具用的就是这条规则(装配层另有一条测试
 * 钉住它们的 `requiredSkill`)。
 */

import { describe, expect, it } from 'vitest'
import { Catalog, Surface, Tool } from '@onething/core/toolkit'
import type { Intent, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { resolveScene, type SceneSessionLike } from '../scene.js'
import { CapabilityTool, SELF_EVOLUTION_SKILL_NAME } from '../families/capability.js'
import { createAskUserTool } from '../builtin/ask-user.js'
import { createBoardTool } from '../builtin/board.js'
import { createGoalTool } from '../builtin/goal.js'
import { createHistoryTool } from '../builtin/history.js'
import { createNotebookTool } from '../builtin/notebook.js'
import { createPracticeTool } from '../builtin/practice.js'
import { createRadioTool } from '../builtin/radio.js'
import { createSendMessageTool } from '../builtin/send-message.js'
import { createTaskTool } from '../builtin/task.js'
import { createTimeTool } from '../builtin/time.js'
import { createWebOpenTool } from '../builtin/web-open.js'
import { createWebSearchTool } from '../builtin/web-search.js'

/** 一个什么都不做的能力工具 —— 只为了带上 `requiredSkill` 那一位。 */
class FakeCapabilityTool extends CapabilityTool<Record<string, never>> {
  protected readonly requiredSkill = SELF_EVOLUTION_SKILL_NAME
  readonly spec: ToolSpec

  constructor(id: string) {
    super()
    this.spec = {
      id,
      title: id,
      description: '',
      input: { type: 'object', properties: {}, required: [] },
      effects: [],
      presentation: { kind: 'text', shell: 'default' },
      concurrency: 'sequential',
    }
  }

  protected async perform(): Promise<Result> {
    return { content: [] }
  }
}

/** 一个恒可见的工具 —— 代表"场景表管不着的那一批"(bash/read/write/edit/variable)。 */
class AlwaysVisibleTool extends Tool<Record<string, never>, Record<string, never>> {
  readonly spec: ToolSpec

  constructor(id: string) {
    super()
    this.spec = {
      id,
      title: id,
      description: '',
      input: { type: 'object', properties: {}, required: [] },
      effects: [],
      presentation: { kind: 'text', shell: 'default' },
      concurrency: 'sequential',
    }
  }

  async plan(): Promise<Intent<Record<string, never>>> {
    throw new Error('not used')
  }

  async apply(_intent: Intent<Record<string, never>>, _ctx: RunContext): Promise<Result> {
    throw new Error('not used')
  }
}

function fullCatalog(): Catalog {
  const noop = () => { throw new Error('adapter not used in this test') }
  const catalog = new Catalog()
  for (const id of ['bash', 'edit', 'read', 'write', 'variable']) {
    catalog.register(new AlwaysVisibleTool(id))
  }
  catalog.register(createTimeTool())
  catalog.register(createWebSearchTool())
  catalog.register(createWebOpenTool())
  catalog.register(createRadioTool({
    open: noop as never, close: noop as never, status: noop as never, request: noop as never,
  }))
  catalog.register(createPracticeTool({ log: noop as never, query: noop as never, recent: noop as never }))
  catalog.register(createTaskTool({ dispatch: noop as never }))
  catalog.register(createAskUserTool({ ask: noop as never, abort: noop as never }))
  catalog.register(createGoalTool({
    getGoal: noop as never, updateGoalFromModel: noop as never, remainingTokens: noop as never,
  }))
  catalog.register(createBoardTool({
    resolveLinkedRoom: noop as never, resolveMember: noop as never,
    agentName: noop as never, applyAction: noop as never,
  }))
  catalog.register(createHistoryTool({ search: noop as never }))
  catalog.register(createNotebookTool({ append: noop as never }))
  catalog.register(createSendMessageTool({ speak: noop as never, sendDm: noop as never }))
  for (const id of ['feature_mount', 'feature_unmount', 'feature_inspect']) {
    catalog.register(new FakeCapabilityTool(id))
  }
  return catalog
}

interface Fixture {
  readonly name: string
  readonly session: SceneSessionLike | null
  readonly skills: string[]
  /** 这一组场景下**摘掉**的工具 id(旧减法表当年给出的那一份,逐字冻在这里)。 */
  readonly hidden: string[]
}

const CHAT_HIDDEN = [
  'board', 'feature_inspect', 'feature_mount', 'feature_unmount',
  'goal', 'history', 'notebook', 'send_message',
]
const FEATURE_HIDDEN = ['feature_inspect', 'feature_mount', 'feature_unmount']

const FIXTURES: Fixture[] = [
  { name: '普通对话(kind 缺席)', session: null, skills: [], hidden: CHAT_HIDDEN },
  { name: '普通对话(kind=chat)', session: { id: 's1', kind: 'chat' }, skills: [], hidden: CHAT_HIDDEN },
  {
    name: '网关会话(kind 为空字符串)—— 归一化必须算成 chat',
    session: { id: 's2', kind: '' },
    skills: [],
    hidden: CHAT_HIDDEN,
  },
  { name: '认不出的 kind', session: { id: 's3', kind: 'whatever' }, skills: [], hidden: CHAT_HIDDEN },
  {
    name: '房场子',
    session: { id: 's4', kind: 'room' },
    skills: [],
    // notebook 只在 agent / work(collab/tool-surface.ts 的场子表)。
    hidden: [...FEATURE_HIDDEN, 'goal', 'notebook'],
  },
  { name: 'agent 执行会话', session: { id: 's5', kind: 'agent' }, skills: [], hidden: [...FEATURE_HIDDEN, 'goal'] },
  { name: '工作台会话', session: { id: 's6', kind: 'work' }, skills: [], hidden: [...FEATURE_HIDDEN, 'goal'] },
  {
    name: '有 active 目标',
    session: { id: 's7', kind: 'chat', goal: { status: 'active' } },
    skills: [],
    hidden: CHAT_HIDDEN.filter(id => id !== 'goal'),
  },
  {
    name: '目标已完成',
    session: { id: 's8', kind: 'chat', goal: { status: 'complete' } },
    skills: [],
    hidden: CHAT_HIDDEN,
  },
  {
    name: '被派出去的工作会话(禁止套娃)',
    session: { id: 's9', kind: 'chat', task: { callerSessionId: 'c1' } } as SceneSessionLike,
    skills: [],
    hidden: [...CHAT_HIDDEN, 'task'],
  },
  {
    name: '自进化 skill 已启用',
    session: { id: 's10', kind: 'chat' },
    skills: [SELF_EVOLUTION_SKILL_NAME],
    hidden: CHAT_HIDDEN.filter(id => !FEATURE_HIDDEN.includes(id)),
  },
  {
    name: '房 + active 目标 + 自进化(三条规则同时生效)',
    session: { id: 's11', kind: 'room', goal: { status: 'active' } },
    skills: [SELF_EVOLUTION_SKILL_NAME, 'something-else'],
    hidden: ['notebook'],
  },
]

describe('resolveScene + visibleIn 逐组给出这一份工具面', () => {
  const catalog = fullCatalog()
  const allIds = catalog.all().map(tool => tool.spec.id).sort()

  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const hidden = new Set(fixture.hidden)
      const expected = allIds.filter(id => !hidden.has(id))

      const scene = resolveScene({ session: fixture.session, enabledSkillNames: fixture.skills })
      const surface = Surface.resolve({ catalog, scene })

      expect([...surface.names()].sort()).toEqual(expected)
    })
  }

  it('每一组夹具里至少有一只工具被摘掉 —— 否则这组用例什么都没证明', () => {
    expect(FIXTURES.every(fixture => fixture.hidden.length > 0)).toBe(true)
  })

  it('夹具里写死的 hidden id 都真的在目录里 —— 拼错一个名字不许静悄悄地放行', () => {
    const known = new Set(allIds)
    for (const fixture of FIXTURES) {
      for (const id of fixture.hidden) expect(known, `${fixture.name} → ${id}`).toContain(id)
    }
  })
})

describe('resolveScene 本身', () => {
  it('把会话翻成四格归一化结论', () => {
    const scene = resolveScene({
      session: { id: 's', kind: 'work', goal: { status: 'active' }, workingDirectory: '/tmp/x' },
      enabledSkillNames: ['a', 'b'],
    })
    expect(scene).toEqual({
      kind: 'work',
      sessionId: 's',
      skills: ['a', 'b'],
      workspaceRoot: '/tmp/x',
      venue: 'work',
      goalActive: true,
      taskSession: false,
    })
  })

  it('认不出的 kind 一律算 chat(网关会话那个洞的形状)', () => {
    expect(resolveScene({ session: { kind: 'whatever' } }).venue).toBe('chat')
    expect(resolveScene({ session: null }).venue).toBe('chat')
  })
})
