/**
 * F4(§13.2):**合同测试验的是生产从不走的 core 缺省配方**。
 *
 * `projection-contract.test.ts` 的模型历史场景全部跑 `projectModelHistory` 的
 * **缺省** `buildMessageContent` —— 而真机上没有任何一次请求走过它:桌面端那条路
 * 是 `historyProjectionRecipe()`(房投影 / goal drive 折叠 / 用户消息上模型面 +
 * 图片附件钩子 + 尾块回放落点)。两者在**老会话的 `contextUpdate`** 上就不同字节:
 * 宿主把那段旧格式原样渲染进正文(铁律:老会话每条消息的字节都不许变,否则升级后
 * 第一轮就整段 cache 失效),core 缺省的那份根本不认识这个字段。
 *
 * 所以这一份跑的是**宿主配方**。它住在 app 层而不是 core 的合同测试里,理由是
 * 分层:core 的测试不许 import 装配层(`architecture-boundaries` 盯着这条)。
 * core 那边的缺省配方仍由原来那份测试守着 —— 两份各测各的那一条路。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalChatMessage,
  canonicalHistoryMessages,
  projectChatMessages,
  projectModelHistory,
  type SessionLogEventRecord,
} from '@onething/core/session'
import type { ChatMessage } from '@shared/ipc.js'
import {
  dehydrateProjectedMessages,
  dehydrateSessionForStorage,
  rehydrateSessionFromStorage,
} from '@onething/runtime/sessions/session-dehydrate'
import {
  buildHistoryMessages,
  historyProjectionRecipe,
} from '../../wiring/engine/stream/message-helpers.js'

/** 事件行 + 与它同源的那份消息数组(A 线 / B 线的唯一共享物是这个场景描述)。 */
function scenario(messages: ChatMessage[]): {
  messages: ChatMessage[]
  events: SessionLogEventRecord[]
} {
  const events: SessionLogEventRecord[] = messages.map((message, index) => ({
    seq: index + 1,
    time: message.timestamp ?? index + 1,
    type: 'message/imported',
    data: { message: message as never },
    surfaceOp: 'append',
  } as SessionLogEventRecord))
  return { messages, events }
}

function projectedWithHostRecipe(events: readonly SessionLogEventRecord[]): string {
  return canonicalHistoryMessages(
    projectModelHistory(events, {}, historyProjectionRecipe()) as readonly unknown[],
  )
}

function builtByHost(messages: ChatMessage[]): string {
  return canonicalHistoryMessages(buildHistoryMessages(messages) as readonly unknown[])
}

describe('F4:模型历史合同跑的是**宿主配方**', () => {
  it('renders a legacy contextUpdate exactly as the host does', () => {
    const { messages, events } = scenario([
      {
        id: 'u1', role: 'user', content: 'hello', timestamp: 1,
        // 2026-08-18 之前的老形状:一段裸字符串,不是分节 delta。
        contextUpdate: 'Current date: 2026-01-01',
      } as ChatMessage,
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 } as ChatMessage,
    ])

    const host = builtByHost(messages)
    expect(host).toContain('Current date: 2026-01-01')
    expect(projectedWithHostRecipe(events)).toBe(host)

    // 反证:core 缺省配方在这一格上与宿主**不同字节** —— 这正是 F4 说的覆盖洞。
    const coreDefault = canonicalHistoryMessages(
      projectModelHistory(events, {}) as readonly unknown[],
    )
    expect(coreDefault).not.toBe(host)
  })

  it('replays the sectioned turnContext delta the way the request does', () => {
    const { messages, events } = scenario([
      {
        id: 'u1', role: 'user', content: 'hello', timestamp: 1,
        turnContext: { set: { workdir: '# Work Directory\n/tmp/x' } },
      } as ChatMessage,
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 } as ChatMessage,
    ])
    const host = builtByHost(messages)
    expect(host).toContain('Work Directory')
    expect(projectedWithHostRecipe(events)).toBe(host)
  })

  it('keeps a tool turn byte-identical through the host recipe', () => {
    const { messages, events } = scenario([
      { id: 'u1', role: 'user', content: 'read it', timestamp: 1 } as ChatMessage,
      {
        id: 'a1', role: 'assistant', content: 'done', timestamp: 2,
        contentParts: [{ type: 'text', content: 'done', turnIndex: 1 }],
        toolCalls: [{
          id: 'c1', toolId: 'read', toolName: 'read',
          arguments: { path: 'a.md' }, status: 'completed',
          result: 'file body', timestamp: 2,
        }],
        steps: [{
          id: 's1', type: 'file-read', title: 'Reading a.md', status: 'completed',
          timestamp: 2, turnIndex: 1, toolCallId: 'c1', result: 'file body',
        }],
      } as unknown as ChatMessage,
    ])
    expect(projectedWithHostRecipe(events)).toBe(builtByHost(messages))
  })
})

/**
 * #4(§13.13,裁定:选项 1 —— 投影也省略,与脱水一致)。
 *
 * 一张 `read` 工具读回来的图片:落盘时 `dehydrate` 把 `toolCall.result` /
 * `step.partialResult` 里那段图片正文换成 `[Image: … omitted]` 占位,补水又不还原;
 * 而投影(A8)把 blob 换回全文 —— 两侧分叉。修法:投影过一遍**同一把**
 * `dehydrateProjectedMessages`,两侧于是逐字节相同。图片本体仍在 blob 里一份。
 */
describe('§13.13 #4:工具结果图片,投影与脱水同口径省略', () => {
  const base64 = 'A'.repeat(4000)
  const imageResult = { type: 'image', mimeType: 'image/png', data: base64 }
  // 一条带图片工具结果的**全量**消息(= A8 投影补齐后的形状)。
  const full = (): ChatMessage => ({
    id: 'a1', role: 'assistant', content: 'done', timestamp: 2,
    toolCalls: [{
      id: 'c1', toolId: 'read', toolName: 'read',
      arguments: { path: 'x.png' }, status: 'completed',
      result: { ...imageResult }, timestamp: 2,
    }],
    steps: [{
      id: 's1', type: 'file-read', title: 'Reading x.png', status: 'completed',
      timestamp: 2, turnIndex: 1, toolCallId: 'c1',
      partialResult: { ...imageResult }, partialResultIsPartial: false,
    }],
  } as unknown as ChatMessage)

  // 磁盘那一份:落盘即脱水,读盘即补水(存储驱动逐字如此)。
  const disk = (): ChatMessage =>
    (rehydrateSessionFromStorage(
      dehydrateSessionForStorage({ messages: [full()] }),
    ) as { messages: ChatMessage[] }).messages[0]

  it('投影过 dehydrateProjectedMessages 后与磁盘逐字节相同(两侧都省略了图片)', () => {
    const projected = dehydrateProjectedMessages([full()])[0]
    expect(canonicalChatMessage(projected as never))
      .toEqual(canonicalChatMessage(disk() as never))
    // 占位符就是 dehydrate 那把:`[Image: image/png data omitted: 4000 chars]`。
    const json = JSON.stringify(projected)
    expect(json).toContain('data omitted: 4000 chars')
    expect(json).not.toContain(base64)
  })

  it('反证:不省略(裸投影,全量 base64)与磁盘分叉 → 红', () => {
    const raw = full()
    expect(canonicalChatMessage(raw as never))
      .not.toEqual(canonicalChatMessage(disk() as never))
    expect(JSON.stringify(raw)).toContain(base64)
  })
})

/**
 * §13.17:老形态(stepOnly)会话的 `toolCall.changes` 往返保真。changes 只在
 * `steps[].toolCall`(顶层 `toolCalls[]` 没有)。投影侧过
 * `dehydrateProjectedMessages`、磁盘侧过 `dehydrate→rehydrate`,同一把归一函数把
 * changes 归并到顶层持有点 → 两侧逐字节相同、changes 俱在。
 */
describe('§13.17:stepOnly changes 两侧同款归一后逐字节相同', () => {
  const changes = { hunks: [{ a: 1, b: 2 }], summary: 'edited' }
  // stepOnly:顶层无 changes,step.toolCall 上有。
  const stepOnly = (): ChatMessage => ({
    id: 'a1', role: 'assistant', content: 'done', timestamp: 2,
    toolCalls: [{
      id: 'c1', toolId: 'edit', toolName: 'edit',
      arguments: { path: 'x.ts' }, status: 'completed', result: 'ok', timestamp: 2,
    }],
    steps: [{
      id: 's1', type: 'file-edit', title: 'Editing x.ts', status: 'completed',
      timestamp: 2, turnIndex: 1, toolCallId: 'c1',
      toolCall: {
        id: 'c1', toolId: 'edit', toolName: 'edit',
        arguments: { path: 'x.ts' }, status: 'completed', result: 'ok', timestamp: 2,
        changes: { ...changes },
      },
    }],
  } as unknown as ChatMessage)

  const disk = (): ChatMessage =>
    (rehydrateSessionFromStorage(
      dehydrateSessionForStorage({ messages: [stepOnly()] }),
    ) as { messages: ChatMessage[] }).messages[0]

  it('投影与磁盘两侧归一后 canonical 逐字节相同,changes 归位顶层', () => {
    const projected = dehydrateProjectedMessages([stepOnly()])[0]
    expect(canonicalChatMessage(projected as never))
      .toEqual(canonicalChatMessage(disk() as never))
    // changes 归并到顶层持有点,step.toolCall 补水后同引用同样拿得到。
    const p = projected as unknown as { toolCalls: Array<{ changes?: unknown }>; steps: Array<{ toolCall?: { changes?: unknown } }> }
    expect(p.toolCalls[0].changes).toEqual(changes)
    expect(p.steps[0].toolCall?.changes).toEqual(changes)
  })

  it('反证:裸 stepOnly(未归一,顶层无 changes)与磁盘归一形态分叉 → 红', () => {
    // 若不把 changes 归并到顶层持有点,canonical 在 toolCalls[].changes 上分叉。
    expect(canonicalChatMessage(stepOnly() as never))
      .not.toEqual(canonicalChatMessage(disk() as never))
  })
})

/**
 * §13.17 反向 5(影子级单测,§13.9 先例的降级路):影子在 `run/end` 用
 * `canonicalChatMessage` 直比真实消息 vs 事件投影。这一格证明:tool/result 事件
 * 带 changes 时,投影物化出的消息与"引擎写在 toolCall.changes 上的真实消息"
 * canonical 相等;**投影不带 changes 那一侧**(旧事件缺采集点)与真实分叉 → 红。
 *
 * (电池的真机 edit 场景本可端到端验这条,但现行 agent-loop 结算把 step.toolCall
 * 的 changes 覆盖掉、且从不落到 message.toolCalls[] —— 真实消息侧当下就没有
 * changes,是本节之外的独立引擎缺口。故按 §13.17 降级为此单测,判官逐字同款。)
 */
describe('§13.17 反向5:影子判官在 changes 上认得投影带/不带的差别', () => {
  const changes = { diff: '@@ -1 +1 @@', filePath: 'a.ts', additions: 1, deletions: 1 }

  function events(withChanges: boolean): SessionLogEventRecord[] {
    return [
      { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: 'edit', timestamp: 1 } }, surfaceOp: 'append' },
      { seq: 2, time: 2, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2 }, surfaceOp: 'append' },
      { seq: 3, time: 2, type: 'tool/call', data: { runId: 'r1', callId: 'c1', name: 'edit', argumentsRaw: JSON.stringify({ path: 'a.ts' }), messageId: 'a1', turnIndex: 1 } },
      {
        seq: 4, time: 2, type: 'tool/result',
        data: {
          runId: 'r1', callId: 'c1', isError: false, resultPreview: 'ok',
          result: { text: 'ok' }, resultData: { text: JSON.stringify('ok') },
          ...(withChanges ? { changes: { text: JSON.stringify(changes) } } : {}),
          sourceSeq: 3,
        },
      },
      { seq: 5, time: 3, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
    ] as SessionLogEventRecord[]
  }

  function projectedAssistant(withChanges: boolean): ChatMessage {
    const messages = projectChatMessages(events(withChanges)).messages as unknown as ChatMessage[]
    return messages.find(m => m.id === 'a1')!
  }

  it('tool/result 带 changes:投影物化出 toolCall.changes / step.toolCall.changes', () => {
    const a = projectedAssistant(true) as unknown as {
      toolCalls: Array<{ changes?: unknown }>
      steps: Array<{ toolCall?: { changes?: unknown } }>
    }
    expect(a.toolCalls[0].changes).toEqual(changes)
    expect(a.steps[0].toolCall?.changes).toEqual(changes)
  })

  it('影子判官(canonicalChatMessage)认得带/不带 changes 的差别 —— 不带那侧本该红', () => {
    // 与 checkSessionRunShadow 同一把判官:tool/result 缺 changes 采集点(旧事件、
    // 或 HEAD 上没有本节改动)时,投影这一侧 canonical 缺 changes,与带 changes 的
    // 那一侧分叉。切读之后真实消息若带 changes,这就是当场 mismatch 的来路。
    expect(canonicalChatMessage(projectedAssistant(true) as never))
      .not.toEqual(canonicalChatMessage(projectedAssistant(false) as never))
    // 不带那侧的物化消息确实没有 changes(旧行为逐字保留)。
    const without = projectedAssistant(false) as unknown as { toolCalls: Array<{ changes?: unknown }> }
    expect(without.toolCalls[0].changes).toBeUndefined()
  })
})
