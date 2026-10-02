import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CollabMessageLike } from '../../types.js'
import { collabAgentRaiseHand, type CollabActorVerb } from '../protocol.js'
import {
  createCollabActorPassthroughPipeline,
  formatCollabActorReplay,
  formatCollabActorVerb,
  orderTranscriptMessages,
  parseRoomTranscriptJsonl,
  replayRoomTranscript,
  transcriptMessageKey,
  type CollabActorReplayPipeline,
} from '../replay.js'

const GOLDEN_DIR = join(__dirname, 'golden')

function loadGolden(name: string, roomId: string) {
  return parseRoomTranscriptJsonl(readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), 'utf-8'), roomId)
}

function expectedSnapshot(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.expected.txt`), 'utf-8')
}

const GOLDEN_CASES: Array<{ name: string; roomId: string; messages: number }> = [
  { name: 'werewolf-night', roomId: 'werewolf-night', messages: 8 },
  { name: 'plain-room', roomId: 'plain-room', messages: 10 },
]

describe('金重放:fixture 对快照', () => {
  for (const testCase of GOLDEN_CASES) {
    it(`${testCase.name} 的动词序列与快照逐字节相同`, () => {
      const transcript = loadGolden(testCase.name, testCase.roomId)
      expect(transcript.messages).toHaveLength(testCase.messages)

      const result = replayRoomTranscript({
        transcript,
        pipeline: createCollabActorPassthroughPipeline(),
      })
      expect(formatCollabActorReplay(result)).toBe(expectedSnapshot(testCase.name))
      expect(result.duplicatesDropped).toBe(0)
    })

    it(`${testCase.name} 两次重放完全一致(确定性)`, () => {
      const transcript = loadGolden(testCase.name, testCase.roomId)
      const pipeline = createCollabActorPassthroughPipeline()
      const first = replayRoomTranscript({ transcript, pipeline })
      const second = replayRoomTranscript({ transcript, pipeline })

      expect(formatCollabActorReplay(second)).toBe(formatCollabActorReplay(first))
      // 事件 id / 时刻都从转录派生 —— 没有 randomUUID、没有 Date.now()
      expect(second.events.map(e => e.id)).toEqual(first.events.map(e => e.id))
      expect(second.events.map(e => e.at)).toEqual(first.events.map(e => e.at))
    })
  }
})

describe('金重放:幂等与乱序', () => {
  it('乱序注入被时间序拉回原位', () => {
    const transcript = loadGolden('plain-room', 'plain-room')
    const baseline = replayRoomTranscript({
      transcript,
      pipeline: createCollabActorPassthroughPipeline(),
    })

    const shuffled = {
      roomId: transcript.roomId,
      messages: [...transcript.messages].reverse(),
    }
    const replayed = replayRoomTranscript({
      transcript: shuffled,
      pipeline: createCollabActorPassthroughPipeline(),
    })
    expect(formatCollabActorReplay(replayed)).toBe(formatCollabActorReplay(baseline))
  })

  it('重复注入被幂等层挡在管线之外', () => {
    const transcript = loadGolden('werewolf-night', 'werewolf-night')
    const baseline = replayRoomTranscript({
      transcript,
      pipeline: createCollabActorPassthroughPipeline(),
    })

    // 每一条都重投一次,再整体打乱 —— at-least-once 的最坏形态
    const doubled = {
      roomId: transcript.roomId,
      messages: [...transcript.messages, ...transcript.messages].reverse(),
    }
    const pipeline = createCollabActorPassthroughPipeline()
    const replayed = replayRoomTranscript({ transcript: doubled, pipeline })

    expect(replayed.duplicatesDropped).toBe(transcript.messages.length)
    expect(pipeline.received).toHaveLength(transcript.messages.length)
    expect(formatCollabActorReplay(replayed)).toBe(formatCollabActorReplay(baseline))
  })

  it('无 id 的老转录靠内容指纹去重', () => {
    const message: CollabMessageLike = { role: 'user', content: 'hi', timestamp: 1 }
    expect(transcriptMessageKey(message)).toBe(transcriptMessageKey({ ...message }))
    expect(transcriptMessageKey(message)).not.toBe(transcriptMessageKey({ ...message, content: 'ho' }))

    const result = replayRoomTranscript({
      transcript: { roomId: 'r1', messages: [message, { ...message }] },
      pipeline: createCollabActorPassthroughPipeline(),
    })
    expect(result.events).toHaveLength(1)
    expect(result.duplicatesDropped).toBe(1)
  })
})

describe('金重放:管线接缝', () => {
  it('管线吐什么就捕获什么,按序', () => {
    const pipeline: CollabActorReplayPipeline = {
      name: 'raise-hand-on-user',
      onPosted: event =>
        event.payload.author.kind === 'user'
          ? [collabAgentRaiseHand({ roomId: event.payload.roomId, agentId: 'a1', urgency: 'high' })]
          : [],
    }
    const result = replayRoomTranscript({ transcript: loadGolden('plain-room', 'plain-room'), pipeline })
    // pr-1 / pr-4 / pr-9 三条人类消息
    expect(result.lines).toEqual([
      'agent:raise-hand agentId="a1" roomId="plain-room" urgency="high"',
      'agent:raise-hand agentId="a1" roomId="plain-room" urgency="high"',
      'agent:raise-hand agentId="a1" roomId="plain-room" urgency="high"',
    ])
  })

  it('reset 在每次重放开头调用', () => {
    let resets = 0
    const pipeline: CollabActorReplayPipeline = {
      name: 'counting',
      reset: () => {
        resets += 1
      },
      onPosted: () => [],
    }
    const transcript = loadGolden('plain-room', 'plain-room')
    replayRoomTranscript({ transcript, pipeline })
    replayRoomTranscript({ transcript, pipeline })
    expect(resets).toBe(2)
  })

  it('管线拿得到稳定的序号与总数', () => {
    const seen: Array<[number, number]> = []
    const pipeline: CollabActorReplayPipeline = {
      name: 'context-probe',
      onPosted: (_event, context) => {
        seen.push([context.index, context.total])
        return []
      },
    }
    replayRoomTranscript({ transcript: loadGolden('werewolf-night', 'werewolf-night'), pipeline })
    expect(seen.map(([index]) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(seen.every(([, total]) => total === 8)).toBe(true)
  })
})

describe('转录解析与格式化', () => {
  it('同时吃裸消息行与会话 jsonl 的 {t:m} 行', () => {
    const text = [
      JSON.stringify({ t: 'h', v: 2, sessionId: 'room-1' }),
      JSON.stringify({ t: 'm', seq: 1, m: { id: 'm1', role: 'user', content: 'a', timestamp: 1 } }),
      JSON.stringify({ id: 'm2', role: 'assistant', agentId: 'a1', content: 'b', timestamp: 2 }),
      '',
      '{"broken":', // 崩溃截断的尾行
    ].join('\n')
    const transcript = parseRoomTranscriptJsonl(text, 'room-1')
    expect(transcript.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('不是消息的行被跳过', () => {
    const text = [JSON.stringify({ foo: 'bar' }), JSON.stringify({ role: 'user' })].join('\n')
    expect(parseRoomTranscriptJsonl(text, 'r').messages).toEqual([])
  })

  it('排序稳定且不动输入数组', () => {
    const messages: CollabMessageLike[] = [
      { id: 'b', role: 'user', content: 'b', timestamp: 2 },
      { id: 'a', role: 'user', content: 'a', timestamp: 1 },
      { id: 'c', role: 'user', content: 'c' },
    ]
    expect(orderTranscriptMessages(messages).map(m => m.id)).toEqual(['c', 'a', 'b'])
    expect(messages.map(m => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('格式化按字段名排序,缺席字段不占位', () => {
    const verb: CollabActorVerb = collabAgentRaiseHand({ roomId: 'r1', agentId: 'a1' })
    expect(formatCollabActorVerb(verb)).toBe('agent:raise-hand agentId="a1" roomId="r1"')
    expect(formatCollabActorVerb(collabAgentRaiseHand({ roomId: 'r1', agentId: 'a1', why: '有话说' })))
      .toBe('agent:raise-hand agentId="a1" roomId="r1" why="有话说"')
  })

  it('空重放的快照是空串,不是一行空白', () => {
    expect(formatCollabActorReplay({ events: [], verbs: [], lines: [], duplicatesDropped: 0 })).toBe('')
  })
})
