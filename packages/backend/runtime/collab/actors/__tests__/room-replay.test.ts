/**
 * 金重放:RoomActor 管线对快照。
 *
 * fixture 只有一份 —— D0 立的那一份(`src/collab/actors/__tests__/golden/`)。
 * 第二条管线读的是**同一批输入**:复制一份 fixture 等于给同一个剧本留两个会漂的
 * 版本,而"金重放在自己那份 fixture 上绿、在别人那份上炸"是最难查的那种漂。
 * 期望快照按管线名分文件(`<name>.room-actor.expected.txt`),挨着输入放。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  foldCollabRoomChain,
  formatCollabActorReplay,
  parseRoomTranscriptJsonl,
  replayRoomTranscript,
  type CollabActorReplayTranscript,
} from '../index.js'

import {
  collabRoomMembersFromTranscript,
  createCollabRoomActorReplayPipeline,
  type CollabRoomReplayOptions,
} from '../room-replay.wiring.js'

const GOLDEN_DIR = join(__dirname, 'golden')

function loadGolden(name: string, roomId: string): CollabActorReplayTranscript {
  return parseRoomTranscriptJsonl(readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), 'utf-8'), roomId)
}

function expectedSnapshot(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.room-actor.expected.txt`), 'utf-8')
}

interface GoldenCase {
  name: string
  roomId: string
  options?: Partial<CollabRoomReplayOptions>
}

const GOLDEN_CASES: GoldenCase[] = [
  // 默认档:一次一个人说话、链闸不设限 —— 看的是发牌/让位这条骨架跑不跑得通。
  { name: 'werewolf-night', roomId: 'werewolf-night' },
  { name: 'plain-room', roomId: 'plain-room' },
  // 争抢档:两个座位、链闸三格 —— 并发举手 / 顶格冻住 / 人类清零三件事同一个剧本。
  { name: 'floor-contest', roomId: 'floor-contest', options: { maxConcurrent: 2, maxChain: 3 } },
]

function replay(testCase: GoldenCase) {
  const transcript = loadGolden(testCase.name, testCase.roomId)
  const pipeline = createCollabRoomActorReplayPipeline({
    roomId: testCase.roomId,
    // 名册是事后视角:谁在这间房里,整份转录都在手上时是已知的。真机那侧名册
    // 来自房间设置,所以它是显式入参而不是藏在默认值里。
    members: collabRoomMembersFromTranscript(transcript),
    ...testCase.options,
  })
  return { transcript, pipeline, result: replayRoomTranscript({ transcript, pipeline }) }
}

describe('金重放:RoomActor 管线', () => {
  for (const testCase of GOLDEN_CASES) {
    it(`${testCase.name} 的动词序列与快照逐字节相同`, () => {
      const { result } = replay(testCase)
      expect(formatCollabActorReplay(result)).toBe(expectedSnapshot(testCase.name))
    })

    it(`${testCase.name} 两次重放完全一致(确定性)`, () => {
      const first = replay(testCase)
      const second = replay(testCase)
      expect(formatCollabActorReplay(second.result)).toBe(formatCollabActorReplay(first.result))
      // 同一条管线跑两次(reset 之间)也必须一致 —— 账、牌号、消息 id 全部清干净。
      const again = replayRoomTranscript({ transcript: first.transcript, pipeline: first.pipeline })
      expect(formatCollabActorReplay(again)).toBe(formatCollabActorReplay(first.result))
    })

    it(`${testCase.name} 的链账 live = 重放重算`, () => {
      const { pipeline, result } = replay(testCase)
      expect(foldCollabRoomChain(result.verbs)).toBe(pipeline.account().chainCount)
    })
  }
})

describe('金重放:free 策略在争抢剧本里的行为', () => {
  const contest = GOLDEN_CASES[2]

  it('三个人被一次点名,两个座位:第三个进队,让位后立刻补上', () => {
    const { result } = replay(contest)
    const grants = result.verbs.filter(verb => verb.type === 'room:floor-granted')
    // ana / bo 是直通授牌,cy 是让位腾出座位后从队里补的。
    expect(grants.slice(0, 3).map(verb => (verb as { agentId: string }).agentId))
      .toEqual(['ana', 'bo', 'cy'])
  })

  it('链闸顶格:dan / eve 的发言在 v3 发不出去,只贴一次系统行', () => {
    const { pipeline, result } = replay(contest)
    const spoken = result.verbs
      .filter(verb => verb.type === 'agent:speak')
      .map(verb => (verb as { agentId: string }).agentId)
    // fc-5 / fc-6 那两句被闸挡住;人类清零之后 fc-8 / fc-9 才说得出口。
    expect(spoken).toEqual(['ana', 'bo', 'cy', 'dan', 'eve'])

    const holdLines = pipeline.messages().filter(message => message.role === 'system')
    expect(holdLines).toHaveLength(1)
    expect(holdLines[0].content).toContain('连着聊了 3 条')
  })

  it('人类插话清零之后,队里两只手一起放行', () => {
    const { pipeline } = replay(contest)
    // 收尾时账是干净的:没有人还举着手,链数是清零之后重新走出来的那几格。
    expect(pipeline.account().hands).toEqual([])
    expect(pipeline.account().chainCount).toBe(2)
    expect(pipeline.account().chainResetMessageId).toBe('fc-7')
  })
})
