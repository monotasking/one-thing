import { describe, expect, it } from 'vitest'
import {
  appendTail,
  feedTail,
  reconcileOverlay,
  userMessageIds,
  type OverlayEntry,
  type PendingSend,
  type ProjectedMessage,
} from './chat-fold'

/**
 * 屏幕树的纯函数半边。这一层不认识 core、不认识网络 —— 它只回答三个问题:
 * 一截 delta 该挂在哪、尾巴怎么接到折叠产物上、哪一格 overlay 已经被账本接管了。
 */

const message = (over: Partial<ProjectedMessage> & { id: string }): ProjectedMessage =>
  ({ role: 'assistant', content: '', timestamp: 0, ...over }) as ProjectedMessage

describe('活尾巴:只追加文本,一个结构决策都不做', () => {
  it('同类连续的 delta 归同一截,换了种就是新的一截', () => {
    let tail = feedTail(undefined, 'a1', 'text', '你')
    tail = feedTail(tail, 'a1', 'text', '好')
    tail = feedTail(tail, 'a1', 'reasoning', '想', 'inline')
    expect(tail?.segments).toEqual([
      { kind: 'text', text: '你好' },
      { kind: 'reasoning', text: '想' },
    ])
  })

  it('换了消息就换一条尾巴 —— 上一条的字不许跟过来', () => {
    const first = feedTail(undefined, 'a1', 'text', '上一条')
    const second = feedTail(first, 'a2', 'text', '下一条')
    expect(second?.messageId).toBe('a2')
    expect(second?.segments).toEqual([{ kind: 'text', text: '下一条' }])
  })

  it('顶部推理落在 reasoning,不进 segments(8d72e236 的两条回归)', () => {
    const tail = feedTail(undefined, 'a1', 'reasoning', '先想想', 'top')
    expect(tail?.reasoningTop).toBe('先想想')
    expect(tail?.segments).toEqual([])
  })

  it('placement 缺席时按「这条消息还没有正文 = top」兜底', () => {
    expect(feedTail(undefined, 'a1', 'reasoning', '甲', undefined, false)?.reasoningTop).toBe('甲')
    expect(feedTail(undefined, 'a1', 'reasoning', '乙', undefined, true)?.segments).toEqual([
      { kind: 'reasoning', text: '乙' },
    ])
  })

  it('空文本 / 空 messageId 一律不进尾巴', () => {
    expect(feedTail(undefined, 'a1', 'text', '')).toBeUndefined()
    expect(feedTail(undefined, '', 'text', '有字')).toBeUndefined()
  })
})

describe('接尾巴:只延长最后那一段,不回头找', () => {
  it('第一截延长账本的末段,其后每一截自己起一格', () => {
    const tail = feedTail(feedTail(undefined, 'a1', 'text', '续'), 'a1', 'reasoning', '想', 'inline')
    const out = appendTail(
      [message({ id: 'a1', content: '已落账', contentParts: [{ type: 'text', content: '已落账' }] })],
      tail,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '已落账续' },
      { type: 'reasoning', content: '想' },
    ])
    expect(out[0].content).toBe('已落账续')
  })

  it('新的行内推理不许被追加进上一个推理块(症状 1:两个思考块)', () => {
    const tail = feedTail(undefined, 'a1', 'reasoning', '第二段思考', 'inline')
    const out = appendTail(
      [
        message({
          id: 'a1',
          contentParts: [
            { type: 'reasoning', content: '第一段思考' },
            { type: 'text', content: '中间的正文' },
          ],
        }),
      ],
      tail,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'reasoning', content: '第一段思考' },
      { type: 'text', content: '中间的正文' },
      { type: 'reasoning', content: '第二段思考' },
    ])
  })

  it('顶部推理接到 message.reasoning 上,不进 contentParts(症状 3:串味)', () => {
    const tail = feedTail(undefined, 'a1', 'reasoning', '再想', 'top')
    const out = appendTail([message({ id: 'a1', reasoning: '先想' })], tail)
    expect(out[0].reasoning).toBe('先想再想')
    expect(out[0].contentParts ?? []).toEqual([])
  })

  it('尾巴认不出主人(那条消息还没折出来)就整段不接', () => {
    const tail = feedTail(undefined, 'ghost', 'text', '孤儿')
    const messages = [message({ id: 'a1', content: '原样' })]
    expect(appendTail(messages, tail)).toEqual(messages)
  })
})

describe('overlay:以折叠为准的认领', () => {
  const pending = (
    id: string,
    text: string,
    seen: string[] = [],
    status: 'sending' | 'failed' = 'sending',
  ): PendingSend => ({ id, kind: 'pending', text, attachments: 0, status, seenUserIds: seen })

  it('账本长出同一句话 = 那一格 pending 被接管,丢掉', () => {
    const out = reconcileOverlay(
      [pending('o1', '发一句')],
      [message({ id: 'm1', role: 'user', content: '发一句' })],
    )
    expect(out).toEqual([])
  })

  it('快照里已有的那条不算认领 —— 连发同一句话不会一次消掉两格', () => {
    const out = reconcileOverlay(
      [pending('o1', '同一句', []), pending('o2', '同一句', ['m1'])],
      [message({ id: 'm1', role: 'user', content: '同一句' })],
    )
    // m1 被 o1 认领(它不在 o1 的快照里);o2 的快照里已经有 m1,继续等自己那条。
    expect(out.map((entry) => entry.id)).toEqual(['o2'])
  })

  it('失败的那一格不认领 —— 它说的正是「这条没到账本」,留着让人重试', () => {
    const failed = pending('o1', '发一句', [], 'failed')
    const out = reconcileOverlay([failed], [message({ id: 'm1', role: 'user', content: '发一句' })])
    expect(out).toHaveLength(1)
  })

  it('本地提示按定义不在账本上,永远不被认领', () => {
    const notice: OverlayEntry = { id: 'n1', kind: 'notice', notice: 'ask-rejected' }
    expect(reconcileOverlay([notice], [])).toEqual([notice])
  })

  it('快照只拍用户消息', () => {
    expect(
      userMessageIds([
        message({ id: 'm1', role: 'user' }),
        message({ id: 'a1', role: 'assistant' }),
        message({ id: 'm2', role: 'user' }),
      ]),
    ).toEqual(['m1', 'm2'])
  })
})
