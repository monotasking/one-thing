/**
 * beforeTurn 的**瞬态尾块**(草稿纸 P1)。
 *
 * 这一块的全部风险都在"替换而不是追加"上:追加的话跑 20 个 turn 就有 20 份
 * 草稿纸在上下文里,而且每一份都是过期的。所以这里逐条钉死:替换、去重、
 * 压缩之后要重挂、没有适配器时一个字节都不变。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CORE_EPHEMERAL_TAIL_SENTINEL,
  applyAgentLoopEphemeralTail,
} from '../agent-loop-runtime.js'

interface TestMessage {
  role: string
  content: string
}

function tailText(version: number, body = 'note'): string {
  return `${CORE_EPHEMERAL_TAIL_SENTINEL}path="/tmp/s.md" version="${version}">\n${body}\n</scratchpad>`
}

const history: TestMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
]

describe('applyAgentLoopEphemeralTail', () => {
  it('没有适配器时是彻底的 no-op', async () => {
    const result = await applyAgentLoopEphemeralTail({
      messages: history,
      turn: 1,
      adapters: {},
    })

    expect(result).toBeUndefined()
  })

  it('把尾块挂在数组最后一条', async () => {
    const result = await applyAgentLoopEphemeralTail({
      messages: history,
      turn: 1,
      adapters: {
        buildEphemeralTail: async () => ({ text: tailText(7), version: 7 }),
      },
    })

    expect(result).toHaveLength(3)
    expect(result?.[2]).toEqual({ role: 'user', content: tailText(7) })
    // 原数组不动 —— 调用方拿到的是新数组。
    expect(history).toHaveLength(2)
  })

  it('第二轮是**替换**不是追加 —— 永远只有一块在场', async () => {
    const first = await applyAgentLoopEphemeralTail({
      messages: history,
      turn: 1,
      adapters: { buildEphemeralTail: async () => ({ text: tailText(7), version: 7 }) },
    })
    const second = await applyAgentLoopEphemeralTail({
      messages: first!,
      turn: 2,
      adapters: { buildEphemeralTail: async () => ({ text: tailText(9, 'note2'), version: 9 }) },
    })

    const tails = second!.filter(message =>
      typeof message.content === 'string'
      && message.content.startsWith(CORE_EPHEMERAL_TAIL_SENTINEL))
    expect(tails).toHaveLength(1)
    expect(second).toHaveLength(3)
    expect(tails[0].content).toBe(tailText(9, 'note2'))
  })

  it('逐字相同就原样保留,也不发回调(同一版本不该被消费两次)', async () => {
    const onEphemeralTailInjected = vi.fn()
    const first = await applyAgentLoopEphemeralTail({
      messages: history,
      turn: 1,
      adapters: { buildEphemeralTail: async () => ({ text: tailText(7), version: 7 }) },
    })

    const again = await applyAgentLoopEphemeralTail({
      messages: first!,
      turn: 2,
      adapters: {
        buildEphemeralTail: async () => ({ text: tailText(7), version: 7 }),
        onEphemeralTailInjected,
      },
    })

    expect(again).toBeUndefined()
    expect(onEphemeralTailInjected).not.toHaveBeenCalled()
  })

  it('挂上新的一块才回调,带 turn 与 version', async () => {
    const onEphemeralTailInjected = vi.fn()

    await applyAgentLoopEphemeralTail({
      messages: history,
      turn: 4,
      adapters: {
        buildEphemeralTail: async () => ({ text: tailText(11), version: 11 }),
        onEphemeralTailInjected,
      },
    })

    expect(onEphemeralTailInjected).toHaveBeenCalledWith({ turn: 4, version: 11 })
  })

  it('纸被清空(返回 undefined)时,在场的旧块要被摘掉', async () => {
    const withTail = await applyAgentLoopEphemeralTail({
      messages: history,
      turn: 1,
      adapters: { buildEphemeralTail: async () => ({ text: tailText(7), version: 7 }) },
    })

    const cleared = await applyAgentLoopEphemeralTail({
      messages: withTail!,
      turn: 2,
      adapters: { buildEphemeralTail: async () => undefined },
    })

    expect(cleared).toEqual(history)
  })

  it('本来就没有块、也没有新块 → 什么都不发生', async () => {
    const result = await applyAgentLoopEphemeralTail({
      messages: history,
      turn: 1,
      adapters: { buildEphemeralTail: async () => undefined },
    })

    expect(result).toBeUndefined()
  })

  it('压缩重建后的历史里没有尾块 —— 重挂一次就回来了', async () => {
    // 压缩 rebuild 是从会话历史拼的,天然不含瞬态块。
    const rebuilt: TestMessage[] = [{ role: 'user', content: '[summary]' }]

    const result = await applyAgentLoopEphemeralTail({
      messages: rebuilt,
      turn: 5,
      adapters: { buildEphemeralTail: async () => ({ text: tailText(13), version: 13 }) },
    })

    expect(result).toHaveLength(2)
    expect(result?.[1]).toEqual({ role: 'user', content: tailText(13) })
  })

  it('哨兵只认 user 角色 —— assistant 说到 `<scratchpad ` 不会被当成块摘掉', async () => {
    const withAssistantMention: TestMessage[] = [
      ...history,
      { role: 'assistant', content: `${CORE_EPHEMERAL_TAIL_SENTINEL}是我给你挂的那块` },
    ]

    const result = await applyAgentLoopEphemeralTail({
      messages: withAssistantMention,
      turn: 2,
      adapters: { buildEphemeralTail: async () => ({ text: tailText(3), version: 3 }) },
    })

    expect(result).toHaveLength(4)
    expect(result?.[2]).toEqual(withAssistantMention[2])
  })
})
