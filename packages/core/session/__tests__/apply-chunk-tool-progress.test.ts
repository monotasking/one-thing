/**
 * C2-b:`Session.applyChunk` 见到 `tool-progress` 时**什么都不做**。
 *
 * 那条空 `case` 不是漏了,是判断:进度是一次调用执行中的**过程读数**(输出尾行 /
 * 比例 / 一句话),不是会话的事实。累进 `accumulatedContent` 会让它冒充正文,
 * 而正文有唯一产地(`text-delta` → 打包行 → 账本)。
 *
 * 拆掉那条 `case`(让它落进 switch 外面)不会让这条测试红 —— 落进外面的行为
 * 与空 `case` 一样什么都不做。红的是**换成累加**那一形,而那正是要防的。
 * 另一半守卫(不进 events.jsonl)在
 * `packages/backend/wiring/engine/stream/__tests__/tool-progress-not-in-ledger.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { Session } from '../session.js'
import type { StreamChunkBase } from '../../events/types.js'

function sessionWithChunks(chunks: StreamChunkBase[]): Session {
  const session = new Session('progress-session')
  for (const chunk of chunks) session.applyChunk(chunk)
  return session
}

const progress = (outputTail: string): StreamChunkBase =>
  ({ type: 'tool-progress', toolCallId: 'c1', message: 'seq 1 20', outputTail } as StreamChunkBase)

describe('applyChunk · tool-progress', () => {
  it('正文一个字都不长 —— 进度不是正文', () => {
    const session = sessionWithChunks([
      { type: 'text-delta', text: '我先跑一条命令。' } as unknown as StreamChunkBase,
      progress('1\n2'),
      progress('18\n19'),
      progress('19\n20'),
    ])
    expect(session.state.accumulatedContent).toBe('我先跑一条命令。')
    expect(session.state.accumulatedReasoning).toBe('')
  })

  it('`outputTail` 不拼接:三条进度过去,状态里一个字节都没有它们', () => {
    const session = sessionWithChunks([progress('a'), progress('b'), progress('c')])
    expect(session.state.accumulatedContent).toBe('')
    expect(JSON.stringify(session.state)).not.toContain('outputTail')
  })

  it('chunkCount 照常 +1 —— 它数的是「收到过几片」,那是实话', () => {
    const session = sessionWithChunks([progress('a'), progress('b')])
    expect(session.state.chunkCount).toBe(2)
  })
})
