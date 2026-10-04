/**
 * v2 → v3 迁移的**映射规则**(D5)。
 *
 * 这一层不碰磁盘,所以能被逐条问:哪一格搬到了哪一格、哪一格是近似的、哪一格
 * 有意丢了。带 IO 的那半(备份、幂等、marker)在 `app/collab/actors/__tests__/migrate.test.ts`。
 */
import { describe, expect, it } from 'vitest'

import { FLOOR_LEASE_INITIAL_EPOCH } from '@onething/backend/collab/kernel'

import type { CollabMessageLike } from '../../collab-types.js'
import {
  COLLAB_MIGRATION_BACKFILL_MAX,
  COLLAB_V3_MIGRATION_VERSION,
  formatCollabMigrationReport,
  planCollabAgentRoomMigration,
  planCollabRoomAccountMigration,
  readCollabV2RoomState,
  summarizeCollabMigration,
  type CollabRoomMigrationEntry,
  type CollabV3MigrationReport,
} from '../collab-actors-migrate-rules.js'
import type { CollabActorVerb } from '../collab-actors-protocol.js'

const ROOM = 'room-1'
const AGENT = 'iris'

/** 真机的可见性边界(`collabRoomBroadcastRecipients`)的同形复制:自己说的不回声给自己。 */
const recipients = (verb: CollabActorVerb, memberIds: readonly string[]): string[] =>
  verb.type === 'room:posted' && verb.author.kind === 'agent'
    ? memberIds.filter(id => id !== verb.author.id)
    : [...memberIds]

function message(id: string, overrides: Partial<CollabMessageLike> = {}): CollabMessageLike {
  return {
    id,
    role: 'user',
    content: `内容 ${id}`,
    timestamp: 1_000 + Number(id.replace(/\D/g, '')),
    ...overrides,
  }
}

describe('readCollabV2RoomState', () => {
  it('认得出 v2 的四格,并记下有意丢弃的两格', () => {
    const state = readCollabV2RoomState({
      version: 1,
      lastProcessedMessageId: 'm7',
      lastProcessedAt: 9_000,
      chainCount: 3,
      floorEpoch: 5,
      activations: [{ id: 'a1' }],
      plan: { id: 'p1', waves: [] },
    })
    expect(state).toEqual({
      lastProcessedMessageId: 'm7',
      lastProcessedAt: 9_000,
      chainCount: 3,
      floorEpoch: 5,
      droppedFields: ['activations', 'plan'],
    })
  })

  it('缺字段的老 state 读成 0,不是 undefined', () => {
    expect(readCollabV2RoomState({ version: 1 })).toEqual({
      chainCount: 0,
      floorEpoch: 0,
      droppedFields: [],
    })
  })

  it('认不出形状返回 null —— 迁移里「读错」比「读不到」贵得多', () => {
    expect(readCollabV2RoomState(null)).toBeNull()
    expect(readCollabV2RoomState('{}')).toBeNull()
    expect(readCollabV2RoomState([])).toBeNull()
    expect(readCollabV2RoomState({ chainCount: 3 })).toBeNull() // 没有 version:1
    expect(readCollabV2RoomState({ version: 2, chainCount: 3 })).toBeNull()
  })
})

describe('房间账映射', () => {
  it('watermark 直接搬,epoch 从 floorEpoch 来,chainCount 延续且标近似', () => {
    const state = readCollabV2RoomState({
      version: 1,
      lastProcessedMessageId: 'm7',
      lastProcessedAt: 9_000,
      chainCount: 4,
      floorEpoch: 6,
    })!
    const { account, summary } = planCollabRoomAccountMigration({ roomId: ROOM, state })

    expect(account.roomId).toBe(ROOM)
    expect(account.watermark).toEqual({ messageId: 'm7', at: 9_000 })
    expect(account.floor.epoch).toBe(6)
    expect(account.floor.active).toEqual([])
    expect(account.chainCount).toBe(4)
    expect(summary.chainCountApproximate).toBe(true)
    expect(summary.watermarkMessageId).toBe('m7')
    expect(summary.epoch).toBe(6)
  })

  it('v2 的 floorEpoch=0 抬到 v3 的初始代数 —— 比初始代数还旧的牌一出生就是废牌', () => {
    const state = readCollabV2RoomState({ version: 1, chainCount: 0, floorEpoch: 0 })!
    const { account } = planCollabRoomAccountMigration({ roomId: ROOM, state })
    expect(account.floor.epoch).toBe(FLOOR_LEASE_INITIAL_EPOCH)
  })

  it('phase 不编:v2 没有相位这个概念', () => {
    const state = readCollabV2RoomState({ version: 1 })!
    expect(planCollabRoomAccountMigration({ roomId: ROOM, state }).account.phase).toBeUndefined()
  })

  it('没有水位的房迁出来就是没有水位,不是一个空字符串', () => {
    const state = readCollabV2RoomState({ version: 1, chainCount: 2 })!
    const { account } = planCollabRoomAccountMigration({ roomId: ROOM, state })
    expect(account.watermark).toEqual({})
  })
})

describe('agent 账 + 未读尾巴回填', () => {
  const messages = [message('m1'), message('m2'), message('m3'), message('m4')]

  it('seen 游标 → 两个水位同点起跑(迁移时刻没有在途)', () => {
    const { room, summary } = planCollabAgentRoomMigration({
      agentId: AGENT,
      roomId: ROOM,
      messages,
      seenMessageId: 'm2',
      recipients,
    })
    expect(room.readMessageId).toBe('m2')
    expect(room.deliveredMessageId).toBe('m2')
    expect(room.readAt).toBe(room.deliveredAt)
    expect(summary.seenIndex).toBe(1)
  })

  it('游标之后的都回填,事件形状与真机投出去的那一封一致', () => {
    const { events, summary } = planCollabAgentRoomMigration({
      agentId: AGENT,
      roomId: ROOM,
      messages,
      seenMessageId: 'm2',
      recipients,
    })
    expect(events.map(event => event.payload.message.id)).toEqual(['m3', 'm4'])
    expect(summary.backfilled).toBe(2)
    expect(summary.truncated).toBe(0)

    const first = events[0]
    expect(first.type).toBe('room:posted')
    expect(first.from).toEqual({ kind: 'room', id: ROOM })
    expect(first.to).toEqual({ kind: 'agent', id: AGENT })
    // 时刻是消息落库的时刻,不是迁移的时刻 —— 折叠信封的 since 读它。
    expect(first.at).toBe(messages[2].timestamp)
  })

  it('事件 id 是确定性的 `evt:<roomId>:<messageId>` —— 算两次一模一样', () => {
    const once = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages, seenMessageId: 'm1', recipients,
    })
    const twice = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages, seenMessageId: 'm1', recipients,
    })
    expect(once.events.map(event => event.id)).toEqual([
      `evt:${ROOM}:m2`,
      `evt:${ROOM}:m3`,
      `evt:${ROOM}:m4`,
    ])
    expect(twice.events.map(event => event.id)).toEqual(once.events.map(event => event.id))
  })

  it('缺 id 的老消息退到按位置派生,同样确定性', () => {
    const noId = [message('m1'), { role: 'user', content: '没有 id', timestamp: 1_002 }]
    const { events } = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages: noId, seenMessageId: 'm1', recipients,
    })
    expect(events.map(event => event.id)).toEqual([`evt:${ROOM}:n2`])
  })

  it('自己说的话不进自己的信箱 —— 可见性边界由调用方递进来', () => {
    const mixed = [
      message('m1'),
      message('m2', { role: 'assistant', agentId: AGENT }),
      message('m3', { role: 'assistant', agentId: 'bram' }),
    ]
    const { events } = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages: mixed, seenMessageId: 'm1', recipients,
    })
    expect(events.map(event => event.payload.message.id)).toEqual(['m3'])
  })

  it('没有游标 = 零回填(与 planCollabHistoryWindow 同一条纪律)', () => {
    const { events, summary, room } = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages, recipients,
    })
    expect(events).toEqual([])
    expect(summary.seenIndex).toBe(-1)
    expect(room.readMessageId).toBeUndefined()
    expect(room.turns).toBe(0)
  })

  it('游标指向一条已被删的消息 = 定位不到 = 零回填,水位也不写', () => {
    const { events, summary, room } = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages, seenMessageId: '已经没了', recipients,
    })
    expect(events).toEqual([])
    expect(summary.seenIndex).toBe(-1)
    expect(summary.seenMessageId).toBe('已经没了')
    expect(room.readMessageId).toBeUndefined()
  })

  it('超上限从最旧截断,截断量进报告(不是静默丢)', () => {
    const long = Array.from({ length: 12 }, (_, index) => message(`m${index + 1}`))
    const { events, summary } = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages: long, seenMessageId: 'm1', recipients, backfillMax: 4,
    })
    expect(events).toHaveLength(4)
    // 留下的是离现在最近的那一截 —— 刚发生的 @ 不能被丢掉。
    expect(events.map(event => event.payload.message.id)).toEqual(['m9', 'm10', 'm11', 'm12'])
    expect(summary.truncated).toBe(7)
  })

  it('缺省上限走未读窗口口径,不是另造一个数', () => {
    const long = Array.from({ length: COLLAB_MIGRATION_BACKFILL_MAX + 5 }, (_, index) => message(`m${index + 1}`))
    const { events, summary } = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages: long, seenMessageId: 'm1', recipients,
    })
    expect(events).toHaveLength(COLLAB_MIGRATION_BACKFILL_MAX)
    expect(summary.truncated).toBe(4)
  })

  it('turns 取证据的下界:说过几句 ∪「有可定位的游标 ⇒ 至少跑过一轮」', () => {
    const spoke = [
      message('m1'),
      message('m2', { role: 'assistant', agentId: AGENT }),
      message('m3', { role: 'assistant', agentId: AGENT }),
    ]
    expect(planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages: spoke, seenMessageId: 'm3', recipients,
    }).room.turns).toBe(2)

    // 一句没说过但读过 → 1,而不是 0(0 在 v3 是「首轮铺底」的判据)。
    expect(planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages: [message('m1')], seenMessageId: 'm1', recipients,
    }).room.turns).toBe(1)
  })

  it('乱序的转录按时间稳定排序之后再切游标', () => {
    const shuffled = [message('m3'), message('m1'), message('m4'), message('m2')]
    const { events } = planCollabAgentRoomMigration({
      agentId: AGENT, roomId: ROOM, messages: shuffled, seenMessageId: 'm2', recipients,
    })
    expect(events.map(event => event.payload.message.id)).toEqual(['m3', 'm4'])
  })
})

describe('对账报告', () => {
  const entries: CollabRoomMigrationEntry[] = [
    {
      roomId: ROOM,
      status: 'migrated',
      summary: {
        roomId: ROOM,
        watermarkMessageId: 'm2',
        epoch: 3,
        chainCount: 4,
        chainCountApproximate: true,
        droppedFields: ['plan'],
      },
      memberCount: 2,
      agents: [
        { agentId: AGENT, roomId: ROOM, seenMessageId: 'm2', seenIndex: 1, transcriptCount: 4, backfilled: 2, truncated: 0, turns: 1 },
        { agentId: 'bram', roomId: ROOM, seenIndex: -1, transcriptCount: 4, backfilled: 0, truncated: 0, turns: 0 },
      ],
      checks: [
        { kind: 'transcript', roomId: ROOM, status: 'ok', count: 4 },
        { kind: 'board', roomId: ROOM, status: 'unreadable', detail: 'Unexpected end of JSON input' },
      ],
    },
    { roomId: 'room-2', status: 'failed', error: 'state.json 认不出形状', memberCount: 0, agents: [], checks: [] },
    { roomId: 'room-3', status: 'skipped', memberCount: 0, agents: [], checks: [] },
  ]

  it('总计逐格算得对', () => {
    expect(summarizeCollabMigration(entries)).toEqual({
      rooms: 3,
      roomsMigrated: 1,
      roomsSkipped: 1,
      roomsFailed: 1,
      agentPairs: 2,
      backfilled: 2,
      truncated: 0,
      checksUnreadable: 1,
    })
  })

  it('一行一条,判据都在行上(游标位/回填量/近似标记)', () => {
    const report: CollabV3MigrationReport = {
      version: COLLAB_V3_MIGRATION_VERSION,
      dryRun: true,
      skipped: false,
      at: 0,
      storePath: '/tmp/store',
      rooms: entries,
      totals: summarizeCollabMigration(entries),
    }
    const text = formatCollabMigrationReport(report).join('\n')
    expect(text).toContain('dry-run')
    expect(text).toContain('[migrated] room-1')
    expect(text).toContain('chain=4(近似)')
    expect(text).toContain('丢弃=plan')
    expect(text).toContain('iris  游标=2/4 回填=2')
    expect(text).toContain('bram  游标=无游标(4 条转录)')
    expect(text).toContain('! board room-1 unreadable')
    expect(text).toContain('[failed]   room-2')
    expect(text).toContain('[skipped]  room-3')
    expect(text).toContain('总计 房 3(迁 1 / 跳 1 / 失败 1)')
  })
})
