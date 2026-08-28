// @vitest-environment happy-dom
/**
 * **ui-refold 的判据测试**(§17.8 U1-b,裁定走乙)。
 *
 * 一个**剧本**,两条管子:
 *
 *  - **总线侧**(验证器):按今天真实的 `session:event` / `session:stream` 词汇
 *    驱动**真的 chatStore** —— 那就是手写拼装器本人;
 *  - **账本侧**(真相):同一个剧本写成 `SessionLogEventRecord`,过 core 折叠。
 *
 * 两侧过同一把尺(`canonicalChatMessage`)逐格比,**0 失配**。剧本是唯一来源,
 * 两个发射器各说各的词汇 —— 这正是生产上的形状。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { compareUiRefold, foldLedgerMessages } from '@/stores/ui-refold'
import { canonicalChatMessage } from '@onething/core/session/projection/canonical'
import type { ChatMessage } from '@/types'

const SESSION = 'ui-refold-spec'

let seq = 0
function event(type: string, data: unknown, time = 1000 + seq): unknown {
  seq += 1
  return { seq, time, type, data }
}

function resetSeq(): void {
  seq = 0
}

/** 助手占位在账本上那一格(命令面对流式 assistant 一条都不写,§9.3)。 */
function runStart(messageId: string, runId: string, timestamp: number): unknown {
  return event('run/start', {
    runId,
    kind: 'send',
    assistantMessageId: messageId,
    provider: 'deepseek',
    model: 'deepseek-chat',
    timestamp,
    createdAssistantMessage: true,
  })
}

function chunks(runId: string, messageId: string, partIndex: number, kind: string, text: string[]): unknown {
  return event('assistant/chunks', {
    runId,
    requestIndex: 1,
    messageId,
    partIndex,
    kind,
    time0: 1000,
    dt: text.map((_, index) => index),
    text,
  })
}

function partEnd(runId: string, messageId: string, partIndex: number, kind: string): unknown {
  return event('assistant/part-end', { runId, requestIndex: 1, messageId, partIndex, kind })
}

/**
 * 一次请求的开合。**少了它们 part 不物化** —— `materializeContentParts`
 * (`reducer.ts:1757`)只放行"所属请求已经结算"的那些段:一次没收场的请求,
 * 它的正文还可能被改写。生产上每一次执行都有这一对,夹具也必须有
 * (首轮实测就是漏了它,两条剧本一起报 `contentParts (absent)`)。
 */
function requestStart(runId: string, messageId: string): unknown {
  return event('request/start', { runId, requestIndex: 1, messageId })
}

function requestEnd(runId: string, messageId: string): unknown[] {
  return [
    event('request/response', {
      runId,
      requestIndex: 1,
      messageId,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    event('request/end', { runId, requestIndex: 1, messageId }),
  ]
}

/**
 * 一条 chunk 走**总线侧**。生产上引擎发出来的那一条带 `turnIndex`(以及 reasoning
 * 的 `placement`)—— 夹具少一格就会在门上报一条**假红**(首轮实测:
 * `contentParts.0.turnIndex a=1 b=(absent)`)。
 */
function chunk(
  store: ReturnType<typeof useChatStore>,
  payload: {
    messageId: string
    type: string
    content?: string
    /** reasoning 那一路的正文在**这一格**上(不是 `content`,`chat.ts:1506`)。 */
    reasoning?: string
    placement?: string
    turnIndex?: number
    toolCall?: unknown
  },
): void {
  store.handleStreamChunk({
    sessionId: SESSION,
    turnIndex: 1,
    ...payload,
  } as never)
}

/**
 * 回合边界的用量。
 *
 * 总线侧有**两个**落点,夹具都要走:`stream:usage`(composer 的实时读数)与
 * **`message:updated` 的回填**(`chat.ts:3016` 的"回填约定" —— 消息级 `usage`
 * 是主进程落盘后播回来的,renderer 一个字都不乐观写)。账本侧那一格的产地是
 * `request/response.usage`。少走回填,门会报一条假红(`.1.usage a=… b=(absent)`)。
 */
const TURN_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }

function settleUsage(store: ReturnType<typeof useChatStore>, messageId: string): void {
  store.handleStreamUsage({ sessionId: SESSION, usage: TURN_USAGE } as never)
  const messages = store.sessionMessages.get(SESSION) ?? []
  const target = messages.find(message => message.id === messageId)
  if (target) (target as unknown as Record<string, unknown>).usage = { ...TURN_USAGE }
}

interface Scenario {
  name: string
  /** 它覆盖勘察底账「十项手写派生」里的哪几项。 */
  covers: string[]
  ledger(): unknown[]
  drive(store: ReturnType<typeof useChatStore>): void
}

/** 用户那条消息 —— 两侧都是"整条落定",没有流式。 */
function userMessage(id: string, content: string, timestamp = 1000): ChatMessage {
  return { id, role: 'user', content, timestamp } as ChatMessage
}

const SCENARIOS: Scenario[] = [
  {
    name: 'streaming-text',
    covers: ['① part 边界/合并', '⑧ 等待→responding 的相位来源'],
    ledger: () => [
      event('user/message', { message: userMessage('u1', '在吗') }),
      runStart('a1', 'r1', 1002),
      requestStart('r1', 'a1'),
      chunks('r1', 'a1', 0, 'text', ['在', '的']),
      partEnd('r1', 'a1', 0, 'text'),
      ...requestEnd('r1', 'a1'),
      event('run/end', { runId: 'r1', outcome: 'completed' }),
    ],
    drive: store => {
      store.sessionMessages.set(SESSION, [
        userMessage('u1', '在吗'),
        {
          id: 'a1', role: 'assistant', content: '', timestamp: 1002, isStreaming: true,
          provider: 'deepseek', model: 'deepseek-chat', toolCalls: [], contentParts: [],
        } as ChatMessage,
      ])
      chunk(store, { messageId: 'a1', type: 'text', content: '在' })
      chunk(store, { messageId: 'a1', type: 'text', content: '的' })
      settleUsage(store, 'a1')
      store.handleStreamComplete({ sessionId: SESSION })
    },
  },
  {
    name: 'reasoning-then-text',
    covers: ['② reasoning placement(引擎规则的第二份拷贝)', '① part 边界'],
    ledger: () => [
      event('user/message', { message: userMessage('u1', '想一下') }),
      runStart('a1', 'r1', 1002),
      requestStart('r1', 'a1'),
      chunks('r1', 'a1', 0, 'reasoning', ['嗯', '…']),
      partEnd('r1', 'a1', 0, 'reasoning'),
      chunks('r1', 'a1', 1, 'text', ['好的']),
      partEnd('r1', 'a1', 1, 'text'),
      ...requestEnd('r1', 'a1'),
      event('run/end', { runId: 'r1', outcome: 'completed' }),
    ],
    drive: store => {
      store.sessionMessages.set(SESSION, [
        userMessage('u1', '想一下'),
        {
          id: 'a1', role: 'assistant', content: '', timestamp: 1002, isStreaming: true,
          provider: 'deepseek', model: 'deepseek-chat', toolCalls: [], contentParts: [],
        } as ChatMessage,
      ])
      chunk(store, { messageId: 'a1', type: 'reasoning', reasoning: '嗯', placement: 'top' })
      chunk(store, { messageId: 'a1', type: 'reasoning', reasoning: '…', placement: 'top' })
      chunk(store, { messageId: 'a1', type: 'text', content: '好的' })
      settleUsage(store, 'a1')
      store.handleStreamComplete({ sessionId: SESSION })
    },
  },
  {
    name: 'tool-call-and-result',
    covers: ['③ tool↔step 连线(linkStepsToToolCalls)', '④ tool 渲染状态'],
    ledger: () => [
      event('user/message', { message: userMessage('u1', '看看文件') }),
      runStart('a1', 'r1', 1002),
      requestStart('r1', 'a1'),
      chunks('r1', 'a1', 0, 'text', ['我看一下']),
      partEnd('r1', 'a1', 0, 'text'),
      // 词表上的键名是 `callId` / `name` / `argumentsRaw`(不是 toolCallId/toolName/args)
      // —— 账本记的是"provider 报上来的那一串",参数在这一层是**原文**。
      event('tool/call', {
        runId: 'r1',
        messageId: 'a1',
        callId: 't1',
        name: 'read',
        argumentsRaw: JSON.stringify({ path: 'a.txt' }),
        turnIndex: 1,
      }),
      event('tool/result', {
        runId: 'r1',
        messageId: 'a1',
        callId: 't1',
        isError: false,
        resultPreview: 'ok',
        // 结局是**结构化**的(`{text}` / `{blob}`),不是裸字符串。
        result: { text: 'ok' },
      }),
      ...requestEnd('r1', 'a1'),
      event('run/end', { runId: 'r1', outcome: 'completed' }),
    ],
    drive: store => {
      store.sessionMessages.set(SESSION, [
        userMessage('u1', '看看文件'),
        {
          id: 'a1', role: 'assistant', content: '', timestamp: 1002, isStreaming: true,
          provider: 'deepseek', model: 'deepseek-chat', toolCalls: [], contentParts: [],
        } as ChatMessage,
      ])
      chunk(store, { messageId: 'a1', type: 'text', content: '我看一下' })
      chunk(store, {
        messageId: 'a1',
        type: 'tool_call',
        toolCall: {
          id: 't1', toolId: 'read', toolName: 'read',
          arguments: { path: 'a.txt' }, status: 'executing',
        },
      })
      // 步骤行的产地是**总线的 step 事件**(账本侧由折叠从 `tool/call` 合成)。
      store.handleStepAdded({
        sessionId: SESSION,
        messageId: 'a1',
        step: {
          // 引擎按工具名算 step 类型(`coreStepTypeForToolName`)—— `read` 是
          // `tool-call`,不是 `command`;回合号与 step 级用量也都是它盖的。
          id: 'step-t1', type: 'tool-call', title: '调用工具: read',
          status: 'running', toolCallId: 't1', timestamp: 1002, turnIndex: 1,
        },
      } as never)
      chunk(store, {
        messageId: 'a1',
        type: 'tool_result',
        toolCall: {
          id: 't1', toolId: 'read', toolName: 'read', arguments: { path: 'a.txt' },
          status: 'completed', result: 'ok',
        },
      })
      store.handleStepUpdated({
        sessionId: SESSION,
        messageId: 'a1',
        stepId: 'step-t1',
        updates: { status: 'completed', result: 'ok', usage: { ...TURN_USAGE } },
      } as never)
      settleUsage(store, 'a1')
      store.handleStreamComplete({ sessionId: SESSION })
    },
  },
  {
    name: 'transient-waiting-swept',
    covers: ['⑤ 瞬态 part 的插与扫', '⑧ 等待相位'],
    ledger: () => [
      event('user/message', { message: userMessage('u1', '等一下') }),
      runStart('a1', 'r1', 1002),
      requestStart('r1', 'a1'),
      chunks('r1', 'a1', 0, 'text', ['来了']),
      partEnd('r1', 'a1', 0, 'text'),
      ...requestEnd('r1', 'a1'),
      event('run/end', { runId: 'r1', outcome: 'completed' }),
    ],
    drive: store => {
      store.sessionMessages.set(SESSION, [
        userMessage('u1', '等一下'),
        {
          id: 'a1', role: 'assistant', content: '', timestamp: 1002, isStreaming: true,
          provider: 'deepseek', model: 'deepseek-chat', toolCalls: [], contentParts: [],
        } as ChatMessage,
      ])
      // 等待指示器:总线上是一条 `content_part`,**账本里没有对应事件**
      // (`ephemeral-policy` 的短命格),收尾时由 `removeTransientIndicators` 扫掉。
      // 这条剧本证的就是"扫干净了" —— 扫漏一格,门当场红。
      chunk(store, {
        messageId: 'a1',
        type: 'content_part',
        contentPart: { type: 'waiting', turnIndex: 1 },
      } as never)
      chunk(store, { messageId: 'a1', type: 'text', content: '来了' })
      settleUsage(store, 'a1')
      store.handleStreamComplete({ sessionId: SESSION })
    },
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
  resetSeq()
  vi.restoreAllMocks()
})

describe('ui-refold:手写拼装 ≡ 账本折(同一把尺)', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} —— 0 失配(覆盖:${scenario.covers.join(' / ')})`, () => {
      resetSeq()
      const ledger = scenario.ledger()
      const store = useChatStore()
      scenario.drive(store)

      const hand = store.sessionMessages.get(SESSION) ?? []
      const result = compareUiRefold(hand, ledger)
      if (!result.match) {
        // 失配时把两侧摊开 —— 报告要能一眼看出是谁错了。
        console.error(scenario.name, JSON.stringify(result.diff, null, 2))
      }
      expect(result.match).toBe(true)
    })
  }
})

describe('ui-refold:折叠侧本身是活的(负对照)', () => {
  it('账本折得出消息树 —— 不是空数组比空数组', () => {
    resetSeq()
    const messages = foldLedgerMessages(SCENARIOS[0].ledger())
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1].content).toBe('在的')
  })
})

/**
 * **四条具名豁免各配一只反证** —— 证明每条豁免都是**吃劲的**:
 * 把它拿掉,门当场红。豁免不是"顺手放过",是"这一格两侧结构上不可能相等"。
 */
describe('ui-refold:具名豁免的反证(拿掉就红)', () => {
  const LEDGER = [
    event('user/message', { message: userMessage('u1', '你好') }),
    runStart('a1', 'r1', 1002),
    requestStart('r1', 'a1'),
    chunks('r1', 'a1', 0, 'text', ['你好']),
    partEnd('r1', 'a1', 0, 'text'),
    ...requestEnd('r1', 'a1'),
    event('run/end', { runId: 'r1', outcome: 'completed' }),
  ]

  /** 手写侧:与账本同形的两条消息,再由各用例往上加那一格豁免物。 */
  function handSide(): ChatMessage[] {
    const ledger = foldLedgerMessages(LEDGER)
    return ledger.map(message => ({ ...message })) as ChatMessage[]
  }

  function sameUnderRuler(a: ChatMessage, b: ChatMessage): boolean {
    return JSON.stringify(canonicalChatMessage(a as never))
      === JSON.stringify(canonicalChatMessage(b as never))
  }

  it('① data-steps:尺子自己丢它(不需要第二层归一)', () => {
    resetSeq()
    const ledger = foldLedgerMessages(LEDGER)
    const hand = handSide()
    const withAnchor = {
      ...hand[1],
      contentParts: [...(hand[1].contentParts ?? []), { type: 'data-steps', turnIndex: 1 }],
    } as ChatMessage
    // 裸比:锚点是一格实实在在的差
    expect(JSON.stringify(withAnchor.contentParts))
      .not.toBe(JSON.stringify(ledger[1].contentParts))
    // 过尺:同一把 canonical 把它归一掉 —— 这就是"不在 strip 里"的理由
    expect(sameUnderRuler(withAnchor, ledger[1] as ChatMessage)).toBe(true)
  })

  it('② 已结算 plugin-status:豁免已撤 —— 它现在有产地,比不上就该红', () => {
    resetSeq()
    const ledger = foldLedgerMessages(LEDGER)
    const hand = handSide()
    const settled = { type: 'plugin-status', pluginId: 'p', id: 's', label: '好了', durationMs: 12 }
    hand[1] = {
      ...hand[1],
      contentParts: [...(hand[1].contentParts ?? []), settled],
    } as ChatMessage
    // 账本侧没有这条事件 = 没有这一格 → **真失配**(从前这里是"具名排除后相等")。
    expect(sameUnderRuler(hand[1], ledger[1] as ChatMessage)).toBe(false)
    expect(compareUiRefold(hand, LEDGER).match).toBe(false)

    // 账本侧也有那条事件时,两侧逐格相等 —— 这是"产地补上了"的正证。
    const withStatus = [
      ...LEDGER,
      event('plugin/status', {
        pluginId: 'p', id: 's', label: '好了', durationMs: 12, runId: 'r1',
      }),
    ]
    expect(compareUiRefold(hand, withStatus).match).toBe(true)
  })

  it('③ attachments:账本存 BlobRef,renderer 没有 blob 读取口', () => {
    resetSeq()
    const ledger = foldLedgerMessages(LEDGER)
    const hand = handSide()
    hand[0] = {
      ...hand[0],
      attachments: [{ type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }],
    } as unknown as ChatMessage
    expect(sameUnderRuler(hand[0], ledger[0] as ChatMessage)).toBe(false)
    expect(compareUiRefold(hand, LEDGER).match).toBe(true)
  })

  it('④ tool-call 锚点:live 一种形状、重放另一种(设计,不是失配)', () => {
    resetSeq()
    const ledger = foldLedgerMessages(LEDGER)
    const hand = handSide()
    hand[1] = {
      ...hand[1],
      contentParts: [
        ...(hand[1].contentParts ?? []),
        { type: 'tool-call', toolCalls: [] },
      ],
    } as ChatMessage
    expect(sameUnderRuler(hand[1], ledger[1] as ChatMessage)).toBe(false)
    expect(compareUiRefold(hand, LEDGER).match).toBe(true)
  })
})
