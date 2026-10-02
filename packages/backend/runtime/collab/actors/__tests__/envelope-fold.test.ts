/**
 * 折叠信封:渲染、合并、上限、以及与 v2 `buildCollabElsewhere` 的口径对齐。
 *
 * 对齐测试**不比字节**:v2 扫的是执行会话的回合切分 + 房间转录,v3 折的是信箱里
 * 的事件,两者的 `<turn>` 一维本来就不同(v3 的回合痕迹在自己的经历流里,不需要
 * 跨房再报一遍)。要对齐的是那条真正会出事的口径 —— **`<got>` 的行数与合并规则**:
 * 同人同房合并带 count、`from` 的三态(同事 / 用户 / 认不出)、块内按时间升序。
 */
import { describe, expect, it } from 'vitest'

import { buildCollabElsewhere, COLLAB_ELSEWHERE_TAG } from '../../turn-log.js'
import { buildCollabFoldedEnvelope, mergeCollabFoldEntries, type CollabFoldEntry } from '../envelope-fold.js'

const SINCE = Date.parse('2026-08-03T10:00:00')
const T = (minutes: number): number => SINCE + minutes * 60_000

function got(roomId: string, at: number, fromAgentId?: string, key = `${roomId}:${at}:${fromAgentId ?? 'user'}`): CollabFoldEntry {
  return { kind: 'got', at, roomId, key: `got:${key}`, count: 1, ...(fromAgentId ? { fromAgentId } : {}) }
}

const LABELS: Record<string, string> = { den: '狼人窝', village: '村口', board: '项目房' }
const SPEAKERS: Record<string, string> = { 'wolf-a': '狼A#wa', 'wolf-b': '狼B#wb' }

function render(entries: CollabFoldEntry[], overrides: Partial<Parameters<typeof buildCollabFoldedEnvelope>[0]> = {}): string {
  return buildCollabFoldedEnvelope({
    entries,
    since: SINCE,
    resolveRoomLabel: id => LABELS[id],
    resolveSpeakerLabel: id => SPEAKERS[id],
    ...overrides,
  })
}

describe('折叠信封:只有信封,没有正文', () => {
  it('got 行带房、时刻、说话人;正文没有任何入口', () => {
    const block = render([got('den', T(1), 'wolf-a')])
    expect(block).toContain(`<${COLLAB_ELSEWHERE_TAG}`)
    expect(block).toContain('<got room="狼人窝"')
    expect(block).toContain('from="狼A#wa"')
    // 结构性保证:条目类型里压根没有 content 字段,这一条钉住那个事实。
    expect(Object.keys(got('den', T(1), 'wolf-a'))).not.toContain('content')
  })

  it('认不出的房与认不出的人各有兜底,不会渲染出裸 id', () => {
    const block = render([got('unknown-room', T(1), 'ghost')])
    expect(block).toContain('room="另一间房"')
    expect(block).toContain('from="同事"')
    expect(block).not.toContain('ghost')
  })

  it('没有 agentId 的说话人是「用户」', () => {
    expect(render([got('den', T(1))])).toContain('from="用户"')
  })

  it('当前这间房被滤掉 —— 它的消息在房间投影里逐字都有', () => {
    const block = render([got('den', T(1), 'wolf-a'), got('village', T(2), 'wolf-b')], {
      currentRoomId: 'village',
    })
    expect(block).toContain('狼人窝')
    expect(block).not.toContain('村口')
  })

  it('只有当前房的事 = 整块不输出(空块是噪声)', () => {
    expect(render([got('village', T(1), 'wolf-b')], { currentRoomId: 'village' })).toBe('')
  })
})

describe('折叠信封:合并与截断', () => {
  it('同人同房合并成一行带 count,时刻取最后一条', () => {
    const merged = mergeCollabFoldEntries([
      got('den', T(1), 'wolf-a', 'a1'),
      got('den', T(3), 'wolf-a', 'a2'),
      got('den', T(2), 'wolf-b', 'b1'),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ kind: 'got', count: 2, at: T(3), fromAgentId: 'wolf-a' })
    expect(merged[1]).toMatchObject({ kind: 'got', count: 1, fromAgentId: 'wolf-b' })
  })

  it('单房上限先截:一间吵闹的房不能把别的房整段挤掉', () => {
    const noisy = Array.from({ length: 5 }, (_, index) =>
      got('den', T(index + 1), `noisy-${index}`, `n${index}`))
    const block = render([...noisy, got('board', T(9), 'wolf-b', 'q')], { maxPerRoom: 2 })
    expect(block.split('\n').filter(line => line.startsWith('<got')).length).toBe(3)
    expect(block).toContain('项目房')
    // 截断要说出来。
    expect(block).toContain('<more count="3"/>')
  })

  it('总量上限之外的、以及缓冲自己丢过的,并进同一行 more', () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      got(`room-${index}`, T(index + 1), `p${index}`, `k${index}`))
    const block = render(entries, { maxEvents: 2, droppedBefore: 7 })
    expect(block).toContain('<more count="11"/>')
  })

  it('maxEvents = 0 时整块不输出(而不是输出一个空壳)', () => {
    expect(render([got('den', T(1), 'wolf-a')], { maxEvents: 0 })).toBe('')
  })
})

describe('折叠信封:非 posted 的四类事件', () => {
  it('换相 / 成员 / 卡片 / 子 actor 各一行,全部只有标识没有正文', () => {
    const block = render([
      { kind: 'phase', at: T(1), roomId: 'den', key: 'phase:den:2:night', phase: 'night' },
      { kind: 'members', at: T(2), roomId: 'village', key: 'members:village:1', joined: 2, left: 1 },
      { kind: 'card', at: T(3), roomId: 'board', key: 'card:board:c-1', cardId: 'c-1', event: 'delivered' },
      { kind: 'worker', at: T(4), key: 'worker:w-1:c-1', cardId: 'c-1', ok: true },
    ])
    expect(block).toContain('<phase room="狼人窝"')
    expect(block).toContain('to="night"')
    expect(block).toContain('joined="2" left="1"')
    expect(block).toContain('<card room="项目房"')
    expect(block).toContain('id="c-1" event="delivered"')
    expect(block).toContain('<worker')
    expect(block).toContain('ok="yes"')
  })

  it('worker 没有房,不会渲染出一个假的 room 属性', () => {
    const block = render([{ kind: 'worker', at: T(1), key: 'worker:w:c', cardId: 'c', ok: false }])
    expect(block).not.toContain('room=')
    expect(block).toContain('ok="no"')
  })
})

describe('折叠信封:与 v2 elsewhere 的口径对齐', () => {
  /**
   * 同一组事实喂两条路:v2 从房间转录里扫 `<got>`,v3 从信箱事件里折。
   * 比的是行数与合并口径,不是字节 —— 两者的 `<turn>` 一维本来就不同(见文件头)。
   */
  const roomMessages = [
    { id: 'm1', role: 'user', content: '在吗', timestamp: T(1) },
    { id: 'm2', role: 'assistant', agentId: 'wolf-a', content: '在', timestamp: T(2) },
    { id: 'm3', role: 'assistant', agentId: 'wolf-a', content: '再补一句', timestamp: T(3) },
    { id: 'm4', role: 'assistant', agentId: 'self', content: '我自己说的', timestamp: T(4) },
  ]

  function v2Lines(): string[] {
    return buildCollabElsewhere({
      sources: [{ roomLabel: '狼人窝', roomMessages }],
      since: SINCE,
      until: T(10),
      selfAgentId: 'self',
      resolveSpeakerLabel: id => SPEAKERS[id],
    }).split('\n').filter(line => line.startsWith('<got'))
  }

  function v3Lines(): string[] {
    // 信箱里的对应事件:自己说的那条不进(v3 在 onPosted 里就短路了)。
    const entries = roomMessages
      .filter(message => message.agentId !== 'self')
      .map(message => got('den', message.timestamp, message.agentId, message.id))
    return render(entries).split('\n').filter(line => line.startsWith('<got'))
  }

  it('行数一致 —— 同人合并、自己说的不算', () => {
    expect(v3Lines()).toHaveLength(v2Lines().length)
    expect(v3Lines()).toHaveLength(2)
  })

  it('合并计数一致', () => {
    expect(v2Lines().some(line => line.includes('count="2"'))).toBe(true)
    expect(v3Lines().some(line => line.includes('count="2"'))).toBe(true)
  })

  it('说话人的三态口径一致(同事句柄 / 用户)', () => {
    expect(v2Lines().join('\n')).toContain('from="用户"')
    expect(v3Lines().join('\n')).toContain('from="用户"')
    expect(v2Lines().join('\n')).toContain('from="狼A#wa"')
    expect(v3Lines().join('\n')).toContain('from="狼A#wa"')
  })

  it('两边都不含任何一条正文', () => {
    for (const line of [...v2Lines(), ...v3Lines()]) {
      expect(line).not.toContain('再补一句')
      expect(line).not.toContain('在吗')
    }
  })
})
