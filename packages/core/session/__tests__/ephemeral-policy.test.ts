/**
 * **定律三的常驻门**(F4-c c5,`docs/design/session-event-sourcing-2026-08.md`
 * §16.19 / §17)。
 *
 * > 一种事实允许不持久化,当且仅当后续某条**持久事件**使它冗余。
 *
 * 这个文件干两件事,缺一不可:
 *
 * 1. **让策略表封闭**——逐条把 `events/ephemeral-policy.ts` 的证明指针解析回
 *    磁盘(文件在不在、`it(...)` 的名字对不对),再对着 `canonical.ts` 真正
 *    消费的那三个口逐格核对。想加一条"不落账"的格,就得在表里留下取代事件与
 *    一条跑得起来的证明,否则这道门当场红。
 * 2. **逐条跑收敛性质**——两种形状(见策略表文件头):
 *    - `strip-homomorphism`:折到取代事件**之后**抹掉这一格,`canonical` 一字
 *      不变;折到取代事件**之前**抹掉,`canonical` 会变(**反证**,证明这条
 *      登记不是空转);
 *    - `substitute-derivable`:取代事件在场时替身逐格算得出来,缺席时替身
 *      **不出现**(不补 0 假装有)。
 *
 * 已经有等价证明的条目不在这里重写 —— 表里的 `proofs` 指过去,这里只补缺的那些。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EPHEMERAL_MESSAGE_KEYS,
  EPHEMERAL_PLACEHOLDER_PART_TYPES,
  EPHEMERAL_STEP_KEYS,
  isEphemeralContentPart,
  SESSION_EPHEMERAL_FACT_POLICY,
  findSessionEphemeralFactPolicy,
} from '../events/ephemeral-policy.js'
import type { SessionLogEventRecord } from '../events/index.js'
import { canonicalChatMessage, projectChatMessages } from '../projection/index.js'
import { toolResultToStructured } from '../../tools/tool-result.js'

/** `packages/core/session/__tests__/` → 仓库根。 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

// ---------------------------------------------------------------------------
// 事件流小工具(与 projection-contract 的 EventLine 同款,只留这里用得上的那点)
// ---------------------------------------------------------------------------

class Line {
  readonly events: SessionLogEventRecord[] = []
  private seq = 0

  push(record: Omit<SessionLogEventRecord, 'seq'>): this {
    this.events.push({ ...record, seq: ++this.seq } as SessionLogEventRecord)
    return this
  }

  /** 折到第 n 条(含)为止 —— "取代事件之前 / 之后"两个采样点就靠它切。 */
  upTo(count: number): SessionLogEventRecord[] {
    return this.events.slice(0, count)
  }
}

function firstMessage(events: readonly SessionLogEventRecord[]): Record<string, unknown> {
  const messages = projectChatMessages(events).messages
  expect(messages.length).toBeGreaterThan(0)
  return messages[0] as unknown as Record<string, unknown>
}

/** 抹掉一格(顶层),返回新对象 —— `strip-homomorphism` 的"抹"。 */
function without(message: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = message
  return rest
}

// ---------------------------------------------------------------------------
// ① 表本身:封闭 + 指针不烂 + 与判据的消费口逐格对齐
// ---------------------------------------------------------------------------

describe('定律三:策略表是封闭的,指针解析得回磁盘', () => {
  it('每条都交齐了三样:取代事件 / 收敛性质形状 / 证明指针', () => {
    expect(SESSION_EPHEMERAL_FACT_POLICY.length).toBeGreaterThan(0)
    const ids = SESSION_EPHEMERAL_FACT_POLICY.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const entry of SESSION_EPHEMERAL_FACT_POLICY) {
      expect(entry.cells.length, `${entry.id}: cells`).toBeGreaterThan(0)
      expect(entry.what.length, `${entry.id}: what`).toBeGreaterThan(0)
      expect(entry.supersededBy.length, `${entry.id}: supersededBy`).toBeGreaterThan(0)
      expect(entry.substitute.length, `${entry.id}: substitute`).toBeGreaterThan(0)
      expect(['strip-homomorphism', 'substitute-derivable']).toContain(entry.proofKind)
      expect(entry.proofs.length, `${entry.id}: proofs`).toBeGreaterThan(0)
    }
  })

  /**
   * 指针**必须解析得回去**。这一条是整张表的价值所在:没有它,`proofs` 就是
   * 一串会烂掉的注释 —— 用例改个名字、文件搬个家,表还在那儿一本正经地撒谎。
   */
  it('每条证明指针都指向一个真实存在的 it(...)', () => {
    const cache = new Map<string, string>()
    for (const entry of SESSION_EPHEMERAL_FACT_POLICY) {
      for (const proof of entry.proofs) {
        let source = cache.get(proof.file)
        if (source === undefined) {
          source = readFileSync(new URL(proof.file, `file://${REPO_ROOT}`), 'utf8')
          cache.set(proof.file, source)
        }
        expect(source, `${entry.id} → ${proof.file}`).toContain(proof.test)
      }
    }
  })

  /**
   * 表与判据之间不许有第二份名单。`canonical.ts` 只从这三个口读,这里反过来
   * 核对它们与表里那几条 `cells` 说的是同一件事。
   */
  it('判据消费的三个口与表里的 cells 逐格对齐', () => {
    const thinking = findSessionEphemeralFactPolicy('message.thinking-activity')
    expect([...EPHEMERAL_MESSAGE_KEYS].sort())
      .toEqual(thinking?.cells.map(cell => cell.replace('ChatMessage.', '')).sort())

    const partial = findSessionEphemeralFactPolicy('step.partialResult')
    expect([...EPHEMERAL_STEP_KEYS].sort())
      .toEqual(partial?.cells.map(cell => cell.replace('Step.', '')).sort())

    expect([...EPHEMERAL_PLACEHOLDER_PART_TYPES].sort()).toEqual(['image-loading', 'waiting'])
    expect(isEphemeralContentPart({ type: 'waiting' })).toBe(true)
    expect(isEphemeralContentPart({ type: 'image-loading' })).toBe(true)
    expect(isEphemeralContentPart({ type: 'plugin-status', label: 'x' })).toBe(true)
    // **反证**:结算之后那一格不再是短命事实(它说的是"跑了多久",不是"正在跑")。
    expect(isEphemeralContentPart({ type: 'plugin-status', label: 'x', durationMs: 12 })).toBe(false)
    // **反证**:渲染锚点不归这张表管(G4,理由在 canonical.ts 的杂项表)。
    expect(isEphemeralContentPart({ type: 'data-steps' })).toBe(false)
    expect(isEphemeralContentPart({ type: 'text', content: 'hi' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ② 逐条收敛性质
// ---------------------------------------------------------------------------

describe('定律三:逐条收敛性质', () => {
  /**
   * `message.isStreaming` —— `strip-homomorphism`,取代事件 `run/end`。
   */
  it('isStreaming: run/end 之后抹掉它 canonical 不变,run/end 之前会变', () => {
    const line = new Line()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1', timestamp: 1 }, surfaceOp: 'append' })
    line.push({ time: 2, type: 'assistant/chunks', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: ['hi'] } })
    line.push({ time: 3, type: 'assistant/part-end', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: 2 } })
    line.push({ time: 4, type: 'request/end', data: { runId: 'r', requestIndex: 1 } })
    line.push({ time: 5, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    // 取代之后:折叠自己就不产出这一格了,抹掉是个空操作。
    const after = firstMessage(line.events)
    expect(after.isStreaming).toBeUndefined()
    expect(canonicalChatMessage(after)).toEqual(canonicalChatMessage(without(after, 'isStreaming')))

    // **反证**:取代之前它是**真在**的,抹掉当场改变判据 —— 这条登记不是空转。
    const before = firstMessage(line.upTo(4))
    expect(before.isStreaming).toBe(true)
    expect(canonicalChatMessage(before)).not.toEqual(canonicalChatMessage(without(before, 'isStreaming')))
  })

  /**
   * `message.thinking-activity` —— `substitute-derivable`,替身是 `thinkingTime`。
   *
   * 两件事一起证:替身**算得出来**(推理段首末差),以及它**算不出来时不出现**
   * (不补 0 —— 0 与"没量到"不是一回事)。顺带钉住:活跃态那两格无论谁写在
   * 消息上,判据都不看。
   */
  it('thinking-activity: 替身 thinkingTime 由推理段算出,算不出时不出现', () => {
    const withReasoning = new Line()
    withReasoning.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1', timestamp: 1 }, surfaceOp: 'append' })
    withReasoning.push({ time: 2, type: 'request/start', data: { runId: 'r', requestIndex: 1, messageId: 'a1' } })
    withReasoning.push({ time: 3, type: 'assistant/chunks', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'reasoning', time0: 1000, dt: [0, 40, 700], text: ['a', 'b', 'c'] } })
    expect(firstMessage(withReasoning.events).thinkingTime).toBe(700)

    // 一条推理 delta 都没有,也没有 first-token:替身**缺席**,不是 0。
    const withoutReasoning = new Line()
    withoutReasoning.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1', timestamp: 1 }, surfaceOp: 'append' })
    withoutReasoning.push({ time: 2, type: 'assistant/chunks', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: ['hi'] } })
    expect(firstMessage(withoutReasoning.events).thinkingTime).toBeUndefined()

    // 活跃态那两格:折叠从不产出,而判据无论谁写上都不看(它们只在一次流的现场
    // 有意义)。替身 `thinkingTime` 的**值**由上面那两条断言在投影层钉住 ——
    // 判据自己也丢它(杂项表那条"派生量"),所以那一格的证明只能在投影层做。
    const projected = firstMessage(withReasoning.events)
    const withActivity = { ...projected, isThinking: true, thinkingStartTime: 1000 }
    expect(projected.isThinking).toBeUndefined()
    expect(projected.thinkingStartTime).toBeUndefined()
    expect(canonicalChatMessage(withActivity)).toEqual(canonicalChatMessage(projected))
    // **反证**:同一把尺看得见真正的正文 —— 上面那条同态不是"判据什么都不看"。
    expect(canonicalChatMessage({ ...projected, content: 'tampered' }))
      .not.toEqual(canonicalChatMessage(projected))
  })

  /**
   * `step.partialResult` —— `substitute-derivable`,取代事件 `tool/result`。
   *
   * 替身是同一条派生规则:`toolResultToStructured(tool/result.result)`。这里
   * **不手抄期望值**,直接拿那个函数算 —— 手抄就成了两份规则。
   */
  it('partialResult: tool/result 之前折不出它,之后由结局唯一算出', () => {
    const result = { title: 'Run: ls', output: 'a\nb', metadata: { lines: 2 } }
    const line = new Line()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1', timestamp: 1 }, surfaceOp: 'append' })
    line.push({ time: 2, type: 'tool/call', data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"ls"}', messageId: 'a1' } })
    line.push({
      time: 3,
      type: 'tool/result',
      // `result` 是给模型看的正文,`resultData` 是**结构化**结局的正身 ——
      // `partialResult` 派生自后者(§13.1 A8)。
      data: {
        runId: 'r', callId: 'c1', isError: false, resultPreview: 'a\nb',
        result: { text: 'a\nb' }, resultData: { text: JSON.stringify(result) },
      },
      surfaceOp: 'append',
    })
    line.push({ time: 4, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    const before = (firstMessage(line.upTo(2)).steps as Record<string, unknown>[])[0]
    expect(before.partialResult).toBeUndefined()
    expect(before.partialResultIsPartial).toBeUndefined()

    const after = (firstMessage(line.events).steps as Record<string, unknown>[])[0]
    expect(after.partialResult).toEqual(toolResultToStructured(result as never))
    expect(after.partialResultIsPartial).toBe(false)

    // 它是**派生缓存**(落盘时被摘掉、冷加载重算),所以判据两边都不看它 ——
    // 抹掉与不抹掉是同一条消息。
    const message = firstMessage(line.events)
    const stripped = {
      ...message,
      steps: (message.steps as Record<string, unknown>[]).map(step =>
        without(without(step, 'partialResult'), 'partialResultIsPartial')),
    }
    expect(canonicalChatMessage(stripped)).toEqual(canonicalChatMessage(message))
    // **反证**:同一条链路上,**结局本身**(`toolCall.result`)判据是看的。
    const tampered = {
      ...message,
      steps: (message.steps as Record<string, unknown>[]).map(step => ({ ...step, result: 'tampered' })),
    }
    expect(canonicalChatMessage(tampered)).not.toEqual(canonicalChatMessage(message))
  })

  /**
   * `toolCall.streamingArgs` —— `strip-homomorphism`,取代事件 `tool/call`。
   */
  it('streamingArgs: tool/call 之后抹掉它 canonical 不变,tool/call 之前会变', () => {
    const line = new Line()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1', timestamp: 1 }, surfaceOp: 'append' })
    line.push({ time: 2, type: 'assistant/chunks', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'tool-input', toolCallId: 'c1', toolName: 'bash', time0: 2, dt: [0, 1], text: ['{"command":', '"ls"}'] } })
    line.push({ time: 3, type: 'assistant/part-end', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'tool-input', toolCallId: 'c1', toolName: 'bash', len: 16 } })
    line.push({ time: 4, type: 'tool/call', data: { runId: 'r', callId: 'c1', name: 'bash', argumentsRaw: '{"command":"ls"}', messageId: 'a1' } })

    const stripCall = (message: Record<string, unknown>): Record<string, unknown> => ({
      ...message,
      toolCalls: (message.toolCalls as Record<string, unknown>[]).map(call => without(call, 'streamingArgs')),
    })

    // 取代之后:参数真相只有 `argumentsRaw` 一份,活文本自己撤下了。
    const after = firstMessage(line.events)
    expect((after.toolCalls as Record<string, unknown>[])[0].streamingArgs).toBeUndefined()
    expect((after.toolCalls as Record<string, unknown>[])[0].arguments).toEqual({ command: 'ls' })
    expect(canonicalChatMessage(stripCall(after))).toEqual(canonicalChatMessage(after))

    // **反证**:取代之前那一格是**在**的(占位卡上的空串 —— 参数流的原文住在
    // 渲染侧,引擎写进消息的那一格从建卡起就是 `''`,原文留在事件里),
    // 抹掉它当场改变判据。
    const before = firstMessage(line.upTo(3))
    expect((before.toolCalls as Record<string, unknown>[])[0].streamingArgs).toBe('')
    expect(canonicalChatMessage(stripCall(before))).not.toEqual(canonicalChatMessage(before))
  })

  /**
   * `contentPart.placeholder` —— `substitute-derivable`,取代它的是同一个位置上
   * 真正的那一格正文 / 图片 part。
   *
   * 两头都要证:折叠**从不**产出占位(账本里没有它、也不该有它),而判据在
   * store 那一侧碰到占位时当场丢掉 —— 于是"占位在不在"永远不构成一次不等。
   */
  it('placeholder part: 折叠从不产出占位,真正文一到就是它该在的那一格', () => {
    const line = new Line()
    line.push({ time: 1, type: 'run/start', data: { runId: 'r', kind: 'send', assistantMessageId: 'a1', timestamp: 1 }, surfaceOp: 'append' })

    // 取代事件之前:一格正文都还没有 —— 折叠**不**替渲染层补一个 `waiting`。
    const empty = firstMessage(line.events)
    expect(empty.contentParts).toBeUndefined()

    line.push({ time: 2, type: 'assistant/chunks', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 2, dt: [0], text: ['hi'] } })
    line.push({ time: 3, type: 'assistant/part-end', data: { runId: 'r', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', len: 2 } })
    line.push({ time: 4, type: 'request/end', data: { runId: 'r', requestIndex: 1 } })
    line.push({ time: 5, type: 'run/end', data: { runId: 'r', outcome: 'completed' } })

    const message = firstMessage(line.events)
    expect(message.contentParts).toEqual([{ type: 'text', content: 'hi', turnIndex: 1 }])

    // store 那一侧带着占位(渲染层追加即撤的那两种)—— 判据当场丢掉它们。
    const withPlaceholders = {
      ...message,
      contentParts: [
        { type: 'waiting' },
        ...(message.contentParts as unknown[]),
        { type: 'image-loading' },
        { type: 'plugin-status', pluginId: 'p', id: 's', label: '正在整理' },
      ],
    }
    expect(canonicalChatMessage(withPlaceholders)).toEqual(canonicalChatMessage(message))

    // **反证一**:**已结算**的插件状态不是短命事实,判据看得见它。
    expect(canonicalChatMessage({
      ...message,
      contentParts: [...(message.contentParts as unknown[]), { type: 'plugin-status', pluginId: 'p', id: 's', label: '整理完', durationMs: 12 }],
    })).not.toEqual(canonicalChatMessage(message))

    // **反证二**:真正的正文一格都不许被当成占位丢掉。
    expect(canonicalChatMessage({
      ...message,
      contentParts: [...(message.contentParts as unknown[]), { type: 'text', content: '!', turnIndex: 1 }],
    })).not.toEqual(canonicalChatMessage(message))
  })
})
