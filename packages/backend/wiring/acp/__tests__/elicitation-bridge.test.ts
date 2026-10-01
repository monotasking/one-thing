/**
 * ACP 提问桥(A3-c,方案 §3.5 / §11.3):`elicitation/create` → 交互卡。交互内核、外壳端口、「有没有人在场」
 * 都是桩 —— 这里证的是 schema → 题目的映射、答案译回 agent 的值、以及四种收场各答什么。
 */
import { describe, expect, it, vi } from 'vitest'
import type { InteractionAnswer, InteractionAskInput } from '@shared/interaction/types'
import type { AcpElicitationContext, AcpElicitationRequest } from '@onething/runtime/acp'

vi.mock('../../interaction/no-human.js', () => ({
  NO_HUMAN_DECLINE_REASON: 'nobody',
  noHumanInTheRoom: () => false,
}))
vi.mock('../../permission/message-anchor.js', () => ({
  resolvePermissionMessageAnchor: (_sessionId: string, preferred?: string) => preferred,
}))

const {
  CLAUDE_ASK_OPTION_META,
  createAcpElicitationBridge,
  decodeElicitationAnswer,
  planElicitationForm,
} = await import('../elicitation-bridge.js')

const CONTEXT: AcpElicitationContext = {
  agentId: 'claude',
  agentName: 'Claude',
  localSessionId: 's-1',
  messageId: 'm-1',
  cwd: '/work',
}

const SCHEMA = {
  type: 'object',
  properties: {
    color: {
      type: 'string',
      title: 'Color',
      description: 'Which color?',
      oneOf: [
        { const: 'r', title: 'Red' },
        { const: 'b', title: 'Blue', _meta: { [CLAUDE_ASK_OPTION_META]: { description: 'the blue one', preview: '<blue/>' } } },
      ],
    },
    size: { type: 'string', enum: ['s', 'l'], enumNames: ['Small', 'Large'] },
    tags: { type: 'array', items: { anyOf: [{ const: 'x', title: 'X' }, { const: 'y', title: 'Y' }] } },
    agree: { type: 'boolean', title: 'Agree' },
    count: { type: 'integer', title: 'Count' },
    ratio: { type: 'number', title: 'Ratio' },
    note: { type: 'string', title: 'Note' },
    weird: { type: 'object', title: 'Weird' },
  },
  required: ['color', 'agree'],
}

function answered(answers: InteractionAnswer['answers']): InteractionAnswer {
  return { id: 'i-1', outcome: 'answered', answers }
}

describe('planElicitationForm:schema → 题目', () => {
  const plan = planElicitationForm(SCHEMA, 'Please answer')

  it('每个属性一道题,按类型给选项 / 自由输入', () => {
    const byId = Object.fromEntries(plan.questions.map(question => [question.id, question]))
    expect(plan.questions.map(question => question.id)).toEqual(['color', 'size', 'tags', 'agree', 'count', 'ratio', 'note', 'weird'])
    // oneOf → 单选;claude 的扩展格上卡;message 放在第一题前面。
    expect(byId.color).toEqual({
      id: 'color',
      header: 'Color',
      question: 'Please answer\n\nWhich color?',
      multiSelect: false,
      options: [{ label: 'Red' }, { label: 'Blue', description: 'the blue one', preview: '<blue/>' }],
    })
    // enum + enumNames → 单选,label 用名字;不在 required → 题面注「可选」。
    expect(byId.size).toMatchObject({ question: 'size(可选)', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] })
    expect(byId.tags).toMatchObject({ multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] })
    expect(byId.agree).toMatchObject({ question: 'Agree', options: [{ label: '是' }, { label: '否' }] })
    for (const id of ['count', 'ratio', 'note', 'weird']) {
      expect(byId[id]).toMatchObject({ options: [], allowFreeText: true })
    }
  })

  it('答案译回 agent 要的值:label → 值、是否 → 布尔、数字解析', () => {
    expect(decodeElicitationAnswer(plan, answered({
      color: { selected: ['Blue'] },
      size: { selected: ['Large'] },
      tags: { selected: ['X', 'Y'] },
      agree: { selected: ['否'] },
      count: { selected: [], freeText: '3' },
      ratio: { selected: [], freeText: '0.5' },
      note: { selected: [], freeText: 'hello' },
      weird: { selected: [], freeText: 'raw' },
    }))).toEqual({
      action: 'accept',
      content: { color: 'b', size: 'l', tags: ['x', 'y'], agree: false, count: 3, ratio: 0.5, note: 'hello', weird: 'raw' },
    })
  })

  it('可选题没答就不带;解析不出的数字算没答', () => {
    expect(decodeElicitationAnswer(plan, answered({
      color: { selected: ['Red'] },
      agree: { selected: ['是'] },
      count: { selected: [], freeText: '2.5' },
    }))).toEqual({ action: 'accept', content: { color: 'r', agree: true } })
  })

  it('required 的题没答 → cancel(不交缺格的 accept)', () => {
    expect(decodeElicitationAnswer(plan, answered({ color: { selected: ['Red'] } }))).toEqual({ action: 'cancel' })
  })

  it('declined → decline;timeout / aborted → cancel', () => {
    expect(decodeElicitationAnswer(plan, { id: 'i', outcome: 'declined', answers: {} })).toEqual({ action: 'decline' })
    expect(decodeElicitationAnswer(plan, { id: 'i', outcome: 'timeout', answers: {} })).toEqual({ action: 'cancel' })
    expect(decodeElicitationAnswer(plan, { id: 'i', outcome: 'aborted', answers: {} })).toEqual({ action: 'cancel' })
  })

  it('同名 label 在一道题里去重(答案按 label 回来)', () => {
    const dup = planElicitationForm({ properties: { pick: { type: 'string', oneOf: [{ const: 'a', title: 'Same' }, { const: 'b', title: 'Same' }] } } }, '')
    expect(dup.questions[0].options.map(option => option.label)).toEqual(['Same', 'Same (b)'])
  })
})

describe('createAcpElicitationBridge', () => {
  function harness(answer: InteractionAnswer | (() => Promise<InteractionAnswer>), openExternal?: (url: string) => Promise<{ success: boolean }>) {
    const asks: InteractionAskInput[] = []
    const aborts: Array<{ sessionId: string; toolCallId?: string }> = []
    let settleAbort: ((value: InteractionAnswer) => void) | undefined
    const bridge = createAcpElicitationBridge({
      ask: input => {
        asks.push(input)
        if (typeof answer === 'function') {
          return new Promise(resolve => { settleAbort = resolve; void answer().then(resolve) })
        }
        return Promise.resolve(answer)
      },
      abort: input => {
        aborts.push(input)
        settleAbort?.({ id: 'i', outcome: 'aborted', answers: {} })
        return true
      },
      openExternal: () => openExternal,
    })
    return { bridge, asks, aborts }
  }

  it('form:卡带会话 / 消息锚 / agent 的 toolCallId,答案回成 accept', async () => {
    const { bridge, asks } = harness(answered({ color: { selected: ['Blue'] }, agree: { selected: ['是'] } }))
    const response = await bridge.create(CONTEXT, {
      mode: 'form', sessionId: 'acp-1', toolCallId: 'tool-9', message: '', requestedSchema: SCHEMA,
    } as AcpElicitationRequest)
    expect(response).toEqual({ action: 'accept', content: { color: 'b', agree: true } })
    expect(asks[0]).toMatchObject({ sessionId: 's-1', origin: 'external-agent', toolCallId: 'tool-9', messageId: 'm-1' })
  })

  it('没有 toolCallId 时自己铸一个(回合中止要按它收卡)', async () => {
    const { bridge, asks } = harness(answered({}))
    await bridge.create(CONTEXT, { mode: 'form', sessionId: 'acp-1', message: '', requestedSchema: { properties: { n: { type: 'string' } } } } as AcpElicitationRequest)
    expect(asks[0].toolCallId).toMatch(/^acp-elicit-/)
  })

  it('回合中止 → 收卡、答 cancel', async () => {
    const controller = new AbortController()
    const { bridge, aborts } = harness(() => new Promise(() => {}))
    const pending = bridge.create({ ...CONTEXT, abortSignal: controller.signal }, {
      mode: 'form', sessionId: 'acp-1', message: '', requestedSchema: { properties: { n: { type: 'string' } } },
    } as AcpElicitationRequest)
    controller.abort()
    expect(await pending).toEqual({ action: 'cancel' })
    expect(aborts).toHaveLength(1)
  })

  it('url:有外壳 → 替人打开,题面带链接;「已完成」→ accept', async () => {
    const opened: string[] = []
    const { bridge, asks } = harness(answered({ url: { selected: ['已完成'] } }), async url => { opened.push(url); return { success: true } })
    const response = await bridge.create(CONTEXT, {
      mode: 'url', sessionId: 'acp-1', elicitationId: 'e-1', url: 'https://example.com/login', message: 'Sign in',
    } as AcpElicitationRequest)
    expect(response).toEqual({ action: 'accept' })
    expect(opened).toEqual(['https://example.com/login'])
    expect(asks[0].questions[0]).toMatchObject({ id: 'url', options: [{ label: '已完成' }, { label: '取消' }] })
    expect(asks[0].questions[0].question).toContain('已在浏览器里打开 https://example.com/login')
  })

  it('url:没有外壳 → 不开,链接写进题面让人自己开;「取消」→ decline', async () => {
    const { bridge, asks } = harness(answered({ url: { selected: ['取消'] } }))
    const response = await bridge.create(CONTEXT, {
      mode: 'url', sessionId: 'acp-1', elicitationId: 'e-2', url: 'https://example.com/x', message: '',
    } as AcpElicitationRequest)
    expect(response).toEqual({ action: 'decline' })
    expect(asks[0].questions[0].question).toContain('请在浏览器里打开 https://example.com/x')
  })

  it('url:非 http(s) 一律不开、答 decline;agent 先说完成 → 收卡、答 accept', async () => {
    const { bridge } = harness(answered({}))
    expect(await bridge.create(CONTEXT, { mode: 'url', sessionId: 'a', elicitationId: 'e', url: 'file:///etc/passwd', message: '' } as AcpElicitationRequest))
      .toEqual({ action: 'decline' })

    const waiting = harness(() => new Promise(() => {}))
    const pending = waiting.bridge.create(CONTEXT, { mode: 'url', sessionId: 'a', elicitationId: 'e-3', url: 'https://x.test', message: '' } as AcpElicitationRequest)
    await Promise.resolve()
    waiting.bridge.complete('claude', 'e-3')
    expect(await pending).toEqual({ action: 'accept' })
    expect(waiting.aborts).toHaveLength(1)
  })
})
