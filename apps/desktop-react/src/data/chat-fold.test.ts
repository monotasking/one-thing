import { describe, expect, it } from 'vitest'
import {
  appendTail,
  feedTail,
  reconcileOverlay,
  reconcileTailAfterRefold,
  trimTailByChunks,
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

  it('账本还没有 parts 时先按 content 搭一格,尾巴延长它(打包行回缩病)', () => {
    // 真机的形:流式中 materialize 不产 contentParts(到 request/end 才有),
    // 打包行把尾巴收走后,折叠的正文只活在 content 里。修前这里会产出
    // [{text:'影,不存 d'}] —— parts 非空,anchor 不再按 content 兜底,
    // 被打包的那一大段正文从屏幕上消失。
    const tail = feedTail(undefined, 'a1', 'text', '影,不存 d')
    const out = appendTail([message({ id: 'a1', content: '打包行收走的那一大段正文,一切皆投' })], tail)
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '打包行收走的那一大段正文,一切皆投影,不存 d' },
    ])
    expect(out[0].content).toBe('打包行收走的那一大段正文,一切皆投影,不存 d')
  })

  it('尾巴认不出主人(那条消息还没折出来)就整段不接', () => {
    const tail = feedTail(undefined, 'ghost', 'text', '孤儿')
    const messages = [message({ id: 'a1', content: '原样' })]
    expect(appendTail(messages, tail)).toEqual(messages)
  })
})

describe('打包行只带走它自己那一截(整段丢就是回缩)', () => {
  it('尾巴比打包行长:裁掉前缀,留下打包窗之后的 delta', () => {
    const tail = feedTail(feedTail(undefined, 'a1', 'text', '前一截'), 'a1', 'text', '后一截')
    const trimmed = trimTailByChunks(tail, 'a1', 'text', '前一截'.length)
    expect(trimmed?.segments).toEqual([{ kind: 'text', text: '后一截' }])
  })

  it('打包行覆盖了尾巴的全部:等价于从前的整段丢掉', () => {
    const tail = feedTail(undefined, 'a1', 'text', '全部内容')
    expect(trimTailByChunks(tail, 'a1', 'text', 99)).toBeUndefined()
  })

  it('别的消息的打包行不碰这条尾巴', () => {
    const tail = feedTail(undefined, 'a1', 'text', '内容')
    expect(trimTailByChunks(tail, 'b2', 'text', 99)).toBe(tail)
  })

  it('reasoning 打包行先裁顶部推理,再裁行内推理截,不碰正文截', () => {
    let tail = feedTail(undefined, 'a1', 'reasoning', '顶部想', 'top')
    tail = feedTail(tail, 'a1', 'text', '正文')
    tail = feedTail(tail, 'a1', 'reasoning', '行内想', 'inline')
    const trimmed = trimTailByChunks(tail, 'a1', 'reasoning', '顶部想行'.length)
    expect(trimmed?.reasoningTop).toBe('')
    expect(trimmed?.segments).toEqual([
      { kind: 'text', text: '正文' },
      { kind: 'reasoning', text: '内想' },
    ])
  })
})

describe('重折调解:新折叠盖过的前缀离开尾巴(真机重影那只病)', () => {
  it('长度差就是要交出去的前缀 —— 引用素材下不裁会把后一份接成懒续行', () => {
    // 真机的形:重折前折叠正文冻结在 0(打包行没折过),尾巴从头攒到现在;
    // 重折把第一条打包行折了进来(新折长 = 打包那截),尾巴须交出等长前缀。
    const tail = feedTail(undefined, 'a1', 'text', '> 引用行\n后续正文')
    const out = reconcileTailAfterRefold(tail, { content: 0, reasoning: 0 }, { content: '> 引用行\n'.length, reasoning: 0 })
    expect(out?.segments).toEqual([{ kind: 'text', text: '后续正文' }])
  })

  it('新折叠没有长(重折没折进新东西):尾巴一个字不动', () => {
    const tail = feedTail(undefined, 'a1', 'text', '正文')
    expect(reconcileTailAfterRefold(tail, { content: 7, reasoning: 0 }, { content: 7, reasoning: 0 })).toBe(tail)
  })

  it('新折叠盖过了尾巴的全部:尾巴退场', () => {
    const tail = feedTail(undefined, 'a1', 'text', '短尾')
    expect(reconcileTailAfterRefold(tail, { content: 0, reasoning: 0 }, { content: 99, reasoning: 0 })).toBeUndefined()
  })

  it('正文与顶部推理各按各的尺裁', () => {
    let tail = feedTail(undefined, 'a1', 'reasoning', '想了又想', 'top')
    tail = feedTail(tail, 'a1', 'text', '正文两截')
    const out = reconcileTailAfterRefold(
      tail,
      { content: 0, reasoning: 0 },
      { content: '正文'.length, reasoning: '想了'.length },
    )
    expect(out?.reasoningTop).toBe('又想')
    expect(out?.segments).toEqual([{ kind: 'text', text: '两截' }])
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
