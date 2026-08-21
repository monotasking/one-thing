/**
 * 双 actor 金重放:一间群房 + 一间狼人私聊房,闭环跑通。
 *
 * 这份剧本存在的理由只有一个 —— **§1.3 的保密不变量必须有一条落地测试**。
 * 狼人在私聊房里说的那句话,在群房的回合里只能留下一个信封;正文一个字都不该
 * 出现。任何一次「跨房上下文」的优化都会先撞到这条测试。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  formatCollabActorReplay,
  parseRoomTranscriptJsonl,
  type CollabActorReplayTranscript,
} from '@onething/runtime/collab/actors'

vi.mock('@onething/runtime/storage', () => ({ getOnethingStorePath: () => '/tmp/onething-agent-duet-test' }))

const { replayCollabDuet } = await import('../agent-replay.js')
type CollabDuetReplayResult = import('../agent-replay.js').CollabDuetReplayResult

const GOLDEN_DIR = join(__dirname, '../../../../collab/actors/__tests__/golden')
const SNAPSHOT = join(GOLDEN_DIR, 'werewolf-duet.expected.txt')

function load(name: string, roomId: string): CollabActorReplayTranscript {
  return parseRoomTranscriptJsonl(readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), 'utf-8'), roomId)
}

const VILLAGE = 'werewolf-village'
const DEN = 'werewolf-den'

const VILLAGE_MEMBERS = [
  { id: 'judge', name: '判官' },
  { id: 'wolf-a', name: '狼A' },
  { id: 'wolf-b', name: '狼B' },
  { id: 'seer', name: '预言家' },
]
const DEN_MEMBERS = [
  { id: 'wolf-a', name: '狼A' },
  { id: 'wolf-b', name: '狼B' },
]

/** 狼人在私聊房里说的那句话。它在群房的 drive 里出现一次就是一次泄密。 */
const WOLF_SECRET = '刀四号'

function duet(): Promise<CollabDuetReplayResult> {
  return replayCollabDuet({
    rooms: [
      {
        roomId: VILLAGE,
        transcript: load('werewolf-duet-village', VILLAGE),
        members: VILLAGE_MEMBERS,
        roomLabel: '村口',
      },
      {
        roomId: DEN,
        transcript: load('werewolf-duet-den', DEN),
        members: DEN_MEMBERS,
        roomLabel: '狼人窝',
        // 刻意**不**标 dm:狼人窝是一间两人的小群,不是「用户 ↔ 某位同事」的
        // 托管私聊。标了的话启发式的第二条会让每一位狼在每一条人类消息上都举手,
        // 而这条剧本要看的是保密边界,不是活跃度。
      },
    ],
  })
}

describe('双 actor 金重放:狼人杀的夜晚', () => {
  it('闭环的动词序列与快照逐字节相同', async () => {
    const result = await duet()
    const actual = formatCollabActorReplay({
      events: [],
      verbs: result.verbs,
      lines: result.lines,
      duplicatesDropped: 0,
    })
    if (process.env.COLLAB_DUET_WRITE_GOLDEN === '1') writeFileSync(SNAPSHOT, actual, 'utf-8')
    expect(actual).toBe(readFileSync(SNAPSHOT, 'utf-8'))
  })

  it('两次重放完全一致(确定性)', async () => {
    const first = await duet()
    const second = await duet()
    expect(second.lines).toEqual(first.lines)
  })

  it('环闭得上:posted → 举手/发牌 → 说话 → 广播 → 交牌', async () => {
    const result = await duet()
    expect(result.failures).toEqual([])

    const spoke = result.verbs
      .filter(verb => verb.type === 'agent:speak')
      .map(verb => (verb as { agentId: string }).agentId)
    expect(spoke).toEqual(['judge', 'wolf-a', 'wolf-b'])

    // 每一次说话都对应一次交牌 —— 座位没有被占死。
    expect(result.verbs.filter(verb => verb.type === 'agent:yield')).toHaveLength(3)
    // 说出去的话真的落进了房间转录(广播闭环)。
    expect(result.messages[VILLAGE].some(message => message.agentId === 'judge')).toBe(true)
    expect(result.messages[DEN].some(message => message.agentId === 'wolf-a')).toBe(true)
  })

  it('游标推进:说过话的那间房都留下了已读水位', async () => {
    const result = await duet()
    expect(result.accounts['judge'].rooms[VILLAGE]).toMatchObject({ turns: 1 })
    expect(result.accounts['judge'].rooms[VILLAGE].readMessageId).toBeTruthy()
    expect(result.accounts['wolf-a'].rooms[DEN]).toMatchObject({ turns: 1 })
    // 从没被点到的那位一个回合都没跑过 —— 也就没有已读水位可推。
    expect(result.accounts['seer'].rooms[VILLAGE]?.turns ?? 0).toBe(0)
  })
})

describe('保密不变量:私聊房的正文绝不进群房的 drive', () => {
  it('狼B 的群回合只看到一个信封,看不到狼A 在私聊房说了什么', async () => {
    const result = await duet()
    const villageTurn = result.calls.find(
      call => call.agentId === 'wolf-b' && call.roomSessionId === VILLAGE,
    )
    expect(villageTurn).toBeDefined()

    // ① 正文一个字都没有。
    expect(villageTurn!.driveContent).not.toContain(WOLF_SECRET)
    // ② 但「那边发生过事」是知道的 —— 信封在。
    expect(villageTurn!.driveContent).toContain('<got room="狼人窝"')
    expect(villageTurn!.driveContent).toContain('from="狼A"')
  })

  it('私聊房里的人自己当然读得到全文(隔离是对外的,不是对内的)', async () => {
    const result = await duet()
    const denTurn = result.calls.find(call => call.roomSessionId === DEN)
    expect(denTurn?.agentId).toBe('wolf-a')
    // 狼A 拿到牌的时候那句话还没说出口,所以它读到的是提问那一条。
    expect(denTurn!.driveContent).toContain('今晚刀谁')
    // 而私聊房的 drive 里不该出现一个指向自己这间房的信封。
    expect(denTurn!.driveContent).not.toContain('room="狼人窝"')
  })

  it('任何一条心智调用的 drive 里都没有别房正文', async () => {
    const result = await duet()
    for (const call of result.calls) {
      if (call.roomSessionId === DEN) continue
      expect(call.driveContent).not.toContain(WOLF_SECRET)
    }
  })
})
