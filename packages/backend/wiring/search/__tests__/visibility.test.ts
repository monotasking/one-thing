/**
 * 拍点辛 a 的判据(设计 docs/design/search-index-2026-09.md §0 拍点辛 / §6.4b / §14.2)。
 *
 * 「当前空间里的**非协作**会话 + 自己是**成员**的协作房」——这一份用例把那句话拆成
 * 每一个字各一条,并且**逐条种反例**:别的空间的会话、我不在的房、我被移出的房。
 *
 * 判据本身不是这个文件写的(`resolveCollabVenue` / `collabRoomVisibleUntil` 是协作域
 * 的资产),所以这里用的是**真的那两个函数** —— 换句话说,哪天协作那边改了成员规则,
 * 这份用例会跟着一起动,而不是各自维护一份会漂的副本。
 */

import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/ipc.js'
import type { SearchPrincipal } from '@onething/core/search'
import { VISIBLE_SESSIONS_CAP, visibleSessionIdsFor } from '../visibility.js'

/** 到顶报警的口是注入的 —— 用例接一只数组,不 mock 日志模块。 */
const truncations: Array<{ agentId: string; allowed: number; cap: number }> = []

const A1: SearchPrincipal = { kind: 'agent', id: 'a1', sessionId: 'here' }

function chat(id: string, space: string, updatedAt = 0): SessionMeta {
  return { id, name: id, createdAt: 0, updatedAt, kind: 'chat', workspaceId: space } as SessionMeta
}

function room(id: string, members: string[], former: Array<{ agentId: string; removedAt: number }> = []): SessionMeta {
  return {
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    kind: 'room',
    workspaceId: 'space-x',
    room: { memberAgentIds: members, formerMembers: former },
  } as unknown as SessionMeta
}

/** 说话人此刻在 `here`,而 `here` 属于 space-a。 */
const HERE = chat('here', 'space-a')

describe('当前空间里的非协作会话', () => {
  it('同一个空间的看得见,别的空间的看不见', () => {
    const sessions = [HERE, chat('mine', 'space-a'), chat('elsewhere', 'space-b')]
    expect(visibleSessionIdsFor(A1, sessions)).toEqual(['here', 'mine'])
  })

  it('「当前空间」是从**说话人所在的那条会话**推出来的,不从别处猜', () => {
    const sessions = [chat('there', 'space-b'), chat('mine', 'space-a'), HERE]
    const fromB = visibleSessionIdsFor({ ...A1, sessionId: 'there' }, sessions)
    expect(fromB).toEqual(['there'])
  })

  it('说话人那条会话不在表上(刚建 / 没有会话语境)→ 按空串算,与投影器写 facet 的缺省一致', () => {
    const sessions = [chat('nospace', ''), chat('mine', 'space-a')]
    expect(visibleSessionIdsFor({ ...A1, sessionId: 'ghost' }, sessions)).toEqual(['nospace'])
  })
})

describe('自己是成员的协作房', () => {
  it('我在的房看得见;我不在的房看不见 —— 哪怕它就在同一个空间里', () => {
    const sessions = [HERE, room('r-mine', ['a1', 'a2']), room('r-theirs', ['a2', 'a3'])]
    expect(visibleSessionIdsFor(A1, sessions)).toEqual(['here', 'r-mine'])
  })

  it('房不问空间 —— 拍点辛 a 的第二半没有空间限定词', () => {
    const foreign = { ...room('r-far', ['a1']), workspaceId: 'space-z' } as SessionMeta
    expect(visibleSessionIdsFor(A1, [HERE, foreign])).toEqual(['here', 'r-far'])
  })

  it('**被移出的房不给** —— 比 `history` 严一格,理由写在 visibility.ts 的文件头(范围表达不了时间窗)', () => {
    const removed = room('r-was', ['a2'], [{ agentId: 'a1', removedAt: 500 }])
    expect(visibleSessionIdsFor(A1, [HERE, removed])).toEqual(['here'])
  })

  it('agent / work 两个场子也算协作 —— 判据是 resolveCollabVenue,不是「kind === room」', () => {
    const agentVenue = { ...chat('dm', 'space-a'), kind: 'agent' } as SessionMeta
    const workVenue = { ...chat('job', 'space-a'), kind: 'work' } as SessionMeta
    // 同空间,但它们是协作场子 → 走成员判据,而它们没有 room 名单 → 看不见。
    expect(visibleSessionIdsFor(A1, [HERE, agentVenue, workVenue])).toEqual(['here'])
  })

  it('kind 认不出的一律当普通会话(归一化只有一个方向)', () => {
    const weird = { ...chat('gateway-born', 'space-a'), kind: undefined } as SessionMeta
    expect(visibleSessionIdsFor(A1, [HERE, weird])).toEqual(['here', 'gateway-born'])
  })
})

describe('上限与截断', () => {
  it('没到顶就一条不少', () => {
    const sessions = [HERE, ...Array.from({ length: 50 }, (_, i) => chat(`s${i}`, 'space-a'))]
    expect(visibleSessionIdsFor(A1, sessions)).toHaveLength(51)
  })

  it('到顶按 updatedAt 倒序留下最近的那些,并**记一条 warn**(不静默丢)', () => {
    truncations.length = 0
    const many = Array.from({ length: VISIBLE_SESSIONS_CAP + 10 }, (_, i) => chat(`s${i}`, 'space-a', i))
    const ids = visibleSessionIdsFor({ ...A1, sessionId: 's0' }, many, detail => truncations.push(detail))

    expect(ids).toHaveLength(VISIBLE_SESSIONS_CAP)
    // 最新那条在,最冷那条被截掉。
    expect(ids).toContain(`s${VISIBLE_SESSIONS_CAP + 9}`)
    expect(ids).not.toContain('s0')
    expect(truncations).toEqual([{ agentId: 'a1', allowed: VISIBLE_SESSIONS_CAP + 10, cap: VISIBLE_SESSIONS_CAP }])
  })

  it('上限远低于 SQLite 的绑定参数上限(32766),也远高于真库今天的 469 条会话', () => {
    expect(VISIBLE_SESSIONS_CAP).toBeLessThan(32766)
    expect(VISIBLE_SESSIONS_CAP).toBeGreaterThan(469)
  })
})
