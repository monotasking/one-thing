/**
 * W21 闲聊风暴抑制 — docs/design/multi-agent-collab-im.md §4 W21.
 *
 * Two mechanism-level brakes on the self-election loop that produced five agent
 * messages (same agent three times) from one human "hi":
 *  1. speech cooldown — a self-election candidate whose own line is still in the
 *     last K_cd visible messages is dropped before the judgement round.
 *  2. tiered chain cap — self-elected activations gate at min(4, maxChain);
 *     mentions keep the room cap; task events stay exempt.
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_SELF_ELECT_COOLDOWN,
  filterCollabSelfElectCandidates,
  isCollabProjectedRoomMessage,
  selectRecentCollabProjectedMessages,
} from '../cooldown.js'
import {
  decideCollabActivations,
  resolveCollabChainCap,
} from '../activation.js'
import { COLLAB_SAY_SOURCE, COLLAB_TURN_SOURCE } from '../say.js'
import { COLLAB_SYSTEM_SOURCE_TASK } from '../system-lines.js'
import {
  COLLAB_DEFAULT_MAX_CHAIN,
  COLLAB_HARVEST_SOURCE,
  COLLAB_MESSAGE_SOURCE,
  type CollabAgentLike,
  type CollabMessageLike,
} from '../types.js'

const MEMBERS: CollabAgentLike[] = [
  { id: 'pm', name: '阿明', title: '产品经理' },
  { id: 'fe', name: '小李', title: '前端工程师' },
  { id: 'research', name: '小研', title: '研究员' },
]

const say = (agentId: string, content: string): CollabMessageLike =>
  ({ role: 'assistant', content, agentId, source: COLLAB_SAY_SOURCE })
const user = (content: string): CollabMessageLike => ({ role: 'user', content })
const drive = (content: string): CollabMessageLike =>
  ({ role: 'user', content, source: COLLAB_MESSAGE_SOURCE })
const thinking = (agentId: string): CollabMessageLike =>
  ({ role: 'assistant', content: '让我想想', agentId, source: COLLAB_TURN_SOURCE })

const ids = (agents: readonly CollabAgentLike[]): string[] => agents.map(agent => agent.id)

describe('speech cooldown (W21 rule 1)', () => {
  it('drops a candidate that just spoke', () => {
    const transcript = [user('hi'), say('fe', '嗨')]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).toEqual(['pm', 'research'])
  })

  it('keeps a candidate that never spoke', () => {
    const transcript = [user('hi'), say('fe', '嗨')]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).toContain('research')
  })

  it('recovers once K_cd more visible messages have gone by', () => {
    // fe's line is the 3rd-from-last visible message → outside the K_cd=2 window.
    const transcript = [say('fe', '嗨'), say('pm', '大家好'), user('继续')]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).toEqual(['fe', 'research'])
  })

  it('still cools down when only one message has gone by (K_cd=2 window)', () => {
    const transcript = [say('fe', '嗨'), user('继续')]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).toEqual(['pm', 'research'])
  })

  it('counts only VISIBLE messages — drives and thinking records are not elapsed time', () => {
    const noise = [say('fe', '嗨'), drive('(小研 · 主动接话)'), thinking('research')]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, noise))).toEqual(['pm', 'research'])
    // The same tail with two REAL messages instead of the noise releases fe.
    const real = [say('fe', '嗨'), say('research', '我看看'), user('好')]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, real))).toContain('fe')
  })

  it('does NOT count a system line as elapsed time — the machine is not talking (P2-12)', () => {
    // The cooldown口径 is the CONVERSATION, not the projection. A task-fact
    // line is a room fact the model must read (W9.1) and still not the room
    // moving on: counting it let the coordinator's own bookkeeping push a
    // member's line out of the window and re-open its right to self-elect —
    // two task events and an agent could answer its own last sentence.
    const transcript = [
      say('fe', '嗨'),
      { role: 'system', content: '「加 notes.txt」→ 小李 开始执行', source: COLLAB_SYSTEM_SOURCE_TASK },
      { role: 'system', content: '「加 notes.txt」交付,进入评审', source: COLLAB_SYSTEM_SOURCE_TASK },
    ]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).not.toContain('fe')
  })

  it('still lets real conversation cool an agent down', () => {
    const transcript = [
      say('fe', '嗨'),
      { role: 'system', content: '「加 notes.txt」→ 小李 开始执行', source: COLLAB_SYSTEM_SOURCE_TASK },
      user('好'),
      user('那继续'),
    ]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).toContain('fe')
  })

  it('treats a legacy harvest post as that agent having spoken', () => {
    const transcript = [
      user('进度?'),
      { role: 'assistant', content: '已交付', agentId: 'fe', source: COLLAB_HARVEST_SOURCE },
    ]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).toEqual(['pm', 'research'])
  })

  it('is a no-op for an empty transcript or a zero cooldown', () => {
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, []))).toEqual(ids(MEMBERS))
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, [say('fe', '嗨')], 0))).toEqual(ids(MEMBERS))
  })

  it('never mutates the input list', () => {
    const transcript = [say('fe', '嗨')]
    const filtered = filterCollabSelfElectCandidates(MEMBERS, transcript)
    expect(filtered).not.toBe(MEMBERS)
    expect(MEMBERS).toHaveLength(3)
  })

  it('mutation lock: cooldown NEVER touches the @ path — a mention still activates a just-spoken agent', () => {
    // Same transcript that cools fe down; the @ short-circuit must be unaffected.
    const transcript = [user('hi'), say('fe', '嗨')]
    expect(ids(filterCollabSelfElectCandidates(MEMBERS, transcript))).not.toContain('fe')

    const decision = decideCollabActivations({
      authorKind: 'user',
      text: '@小李 你怎么看',
      members: MEMBERS,
      chainCount: 0,
      maxChain: COLLAB_DEFAULT_MAX_CHAIN,
    })
    expect(decision.activations).toEqual([{ agentId: 'fe', reason: 'mention' }])
    expect(COLLAB_SELF_ELECT_COOLDOWN).toBe(2)
  })
})

describe('isCollabProjectedRoomMessage / selectRecentCollabProjectedMessages', () => {
  it('admits real speech and projected system lines, rejects the noise', () => {
    expect(isCollabProjectedRoomMessage(user('hi'))).toBe(true)
    expect(isCollabProjectedRoomMessage(say('fe', '嗨'))).toBe(true)
    expect(isCollabProjectedRoomMessage(
      { role: 'system', content: '开始执行', source: COLLAB_SYSTEM_SOURCE_TASK },
    )).toBe(true)

    expect(isCollabProjectedRoomMessage(drive('(小李 · 主动接话)'))).toBe(false)
    expect(isCollabProjectedRoomMessage(thinking('fe'))).toBe(false)
    expect(isCollabProjectedRoomMessage({ role: 'assistant', content: '[pass]', agentId: 'fe' })).toBe(false)
    expect(isCollabProjectedRoomMessage({ role: 'system', content: '房间已全部暂停' })).toBe(false)
    expect(isCollabProjectedRoomMessage({ role: 'assistant', content: '   ', agentId: 'fe' })).toBe(false)
  })

  it('windows the visible tail, oldest first', () => {
    const tail = selectRecentCollabProjectedMessages(
      [user('a'), drive('d'), say('fe', 'b'), thinking('pm'), say('pm', 'c')],
      2,
    )
    expect(tail.map(message => message.content)).toEqual(['b', 'c'])
    expect(selectRecentCollabProjectedMessages([user('a')], 0)).toEqual([])
  })
})

describe('chain cap —— 一格管到底', () => {
  it('主动接话与被 @ 共用房间那一格;只有任务事件豁免', () => {
    // W21 rule 2 曾给 self-elected 单开一道固定 4 条的暗闸,已撤:一个可配置
    // 的闸,配置了就要算数,否则用户把上限调到 32 却发现他们聊四条就停。
    for (const reason of ['self-elected', 'mention', 'schedule'] as const) {
      expect(resolveCollabChainCap(reason, COLLAB_DEFAULT_MAX_CHAIN)).toBe(COLLAB_DEFAULT_MAX_CHAIN)
      expect(resolveCollabChainCap(reason, 3)).toBe(3)
    }
    expect(resolveCollabChainCap('task-event', COLLAB_DEFAULT_MAX_CHAIN)).toBe(Number.POSITIVE_INFINITY)
  })

  it('房间关掉闸(0 → Infinity)时,聊天类激活也跟着不受限', () => {
    for (const reason of ['self-elected', 'mention', 'schedule'] as const) {
      expect(resolveCollabChainCap(reason, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    }
  })

  it('到达上限: everything chat-shaped is shut, task events still run', () => {
    const chainCount = COLLAB_DEFAULT_MAX_CHAIN
    expect(chainCount >= resolveCollabChainCap('self-elected', COLLAB_DEFAULT_MAX_CHAIN)).toBe(true)
    expect(chainCount >= resolveCollabChainCap('mention', COLLAB_DEFAULT_MAX_CHAIN)).toBe(true)
    expect(chainCount >= resolveCollabChainCap('task-event', COLLAB_DEFAULT_MAX_CHAIN)).toBe(false)

    const decision = decideCollabActivations({
      authorKind: 'agent',
      authorAgentId: 'pm',
      text: '@小李 你接着说',
      members: MEMBERS,
      chainCount,
      maxChain: COLLAB_DEFAULT_MAX_CHAIN,
    })
    expect(decision.activations).toEqual([])
    expect(decision.blockedByChain).toBe(true)
  })

  it('mutation lock: 任务事件是唯一的豁免档,其余一律等于房间那一格', () => {
    const chatShaped = (['self-elected', 'mention', 'schedule'] as const)
      .map(reason => resolveCollabChainCap(reason, COLLAB_DEFAULT_MAX_CHAIN))
    expect(new Set(chatShaped)).toEqual(new Set([COLLAB_DEFAULT_MAX_CHAIN]))
    expect(resolveCollabChainCap('task-event', COLLAB_DEFAULT_MAX_CHAIN))
      .toBe(Number.POSITIVE_INFINITY)
  })
})
