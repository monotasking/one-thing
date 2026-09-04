import { beforeEach, describe, expect, it } from 'vitest'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import { materializeChatMessagesCached, messageStamp } from '../../../data/chat-materialize'
import { StreamWater } from '../../../data/stream-water'
import { __resetAssembleCacheForTests, assembleMessage } from '../index'

/**
 * 装配缓存的**第二层**:按身份章索引、活过换会话(09-03)。
 *
 * 病历(`probe-hotspots` 的 dev profile):第一层是
 * `WeakMap<ProjectedMessage, SegmentModel[]>` —— 按**对象**活。而换一次会话折叠器
 * 整份换掉(新 state、新节点、新成品对象),那张表于是整片 miss:「切回刚才那条
 * 会话」要把整篇 markdown 重新解析一遍。读数:`MessageRow2` total 47.9ms,
 * 其中 47ms 是 `assembleMessage → markdownToFrame → fromMarkdown`。
 *
 * 这一份用**同一份账本折两次**来还原「换走再换回」:两次折出来的是两组不同的
 * 对象,但同一条消息的 `<id>@<rev>@<epoch>` 逐字相同 —— 所以第二次该原样复用。
 */

const T0 = 1_700_000_000_000

type Ev = { seq: number; time: number; type: string; data: unknown }

const ledger = (): Ev[] => [
  { seq: 1, time: T0, type: 'session/created', data: { sessionId: 's1' } },
  {
    seq: 2,
    time: T0,
    type: 'user/message',
    data: { message: { id: 'u1', role: 'user', content: '第一问', timestamp: T0 } },
  },
  { seq: 3, time: T0, type: 'run/start', data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 } },
  {
    seq: 4,
    time: T0,
    type: 'assistant/chunks',
    data: {
      runId: 'r1',
      requestIndex: 0,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: T0,
      dt: [0],
      text: ['# 标题\n\n一段正文,外加 `code`。'],
    },
  },
  { seq: 5, time: T0, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
]

const OPTS = {} as Parameters<typeof materializeChatMessagesCached>[1]

function foldAll(): ReturnType<typeof materializeChatMessagesCached> {
  let state = createSessionProjectionState()
  for (const event of ledger()) state = reduceSessionProjection(state, event as never)
  return materializeChatMessagesCached(state, OPTS, 0)
}

beforeEach(() => {
  __resetAssembleCacheForTests()
})

describe('装配缓存活过换会话', () => {
  it('同一份账本折两次:对象是两组,装配结果原样复用', () => {
    const first = foldAll().messages
    const second = foldAll().messages

    const a = first.find((m) => m.id === 'a1')!
    const b = second.find((m) => m.id === 'a1')!
    // 前提:这确实是**两个不同的对象**(不然这条用例什么都没验)。
    expect(b).not.toBe(a)
    expect(messageStamp(b)).toBe(messageStamp(a))

    expect(assembleMessage(b)).toBe(assembleMessage(a))
  })

  it('清了那张表就不再复用 —— 复用真的来自它,不是别处的巧合', () => {
    const a = foldAll().messages.find((m) => m.id === 'a1')!
    const kept = assembleMessage(a)
    __resetAssembleCacheForTests()
    const b = foldAll().messages.find((m) => m.id === 'a1')!
    expect(assembleMessage(b)).not.toBe(kept)
  })

  it('活消息拿不到章,永远走全算(内容真的在变,复用会画错)', () => {
    let state = createSessionProjectionState()
    for (const event of ledger()) state = reduceSessionProjection(state, event as never)
    const water = new StreamWater()
    // 活水位比账本长一截 —— `mergeWater` 因此必然造一个新对象。
    water.feed(
      { messageId: 'a1', partIndex: 0, gen: 0, kind: 'text', charOffset: 0 } as never,
      '# 标题\n\n一段正文,外加 `code`。还在打的这一截。',
    )
    const merged = materializeChatMessagesCached(state, OPTS, 0, water).messages.find(
      (m) => m.id === 'a1',
    )!
    const settled = materializeChatMessagesCached(state, OPTS, 0).messages.find(
      (m) => m.id === 'a1',
    )!
    expect(merged).not.toBe(settled)
    expect(messageStamp(merged)).toBeUndefined()
    // 章不在 = 第二层根本不参与:它照旧每次全算,只吃第一层那张按对象的 memo。
    expect(assembleMessage(merged)).not.toBe(assembleMessage(settled))
  })
})
