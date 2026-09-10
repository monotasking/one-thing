import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHAT_ANCHOR_BACKFILL,
  CHAT_TAIL_WINDOW,
  chatWindowKeys,
  growChatWindow,
  peekChatWindowStart,
  reachChatWindow,
  releaseChatWindow,
  resetChatWindows,
  seedChatWindow,
  seedWindowStart,
  tailWindowStart,
} from '../chat-window'

/**
 * 窗口那一格的**纯函数与表**(2026-09-10「响应先行」)。
 * 组件那一端(尾窗上屏 / 空闲扩窗 / 上翻提前扩 / 扩窗不跳)在
 * `content/ChatStream.test.tsx` 里量 —— 那些要 DOM 与几何,这里一格都不要。
 */

const list = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))

beforeEach(() => resetChatWindows())
afterEach(() => resetChatWindows())

describe('尾窗:进场只摆最后一屏多一点', () => {
  it('总数够一窗:起点 = 总数 − 尾窗', () => {
    expect(tailWindowStart(388)).toBe(388 - CHAT_TAIL_WINDOW)
  })

  it('总数不够一窗:整份都摆(起点 0,与从前逐字相同)', () => {
    expect(tailWindowStart(CHAT_TAIL_WINDOW)).toBe(0)
    expect(tailWindowStart(3)).toBe(0)
    expect(tailWindowStart(0)).toBe(0)
  })
})

describe('进场那一格:锚点在窗外就一次性扩到它', () => {
  it('没有锚点 = 尾窗', () => {
    expect(seedWindowStart(list(200), undefined)).toBe(tailWindowStart(200))
  })

  it('锚点是「在底」= 尾窗(那本来就是尾窗的意思)', () => {
    expect(seedWindowStart(list(200), 'bottom')).toBe(tailWindowStart(200))
  })

  it('锚点那条消息不在这棵树上 = 尾窗(applyScrollAnchor 那一头会如实答 false)', () => {
    expect(seedWindowStart(list(200), { messageId: '不存在', offset: 0 })).toBe(tailWindowStart(200))
  })

  it('锚点在窗外:一次性扩到它,并在它上面留一段回旋余地', () => {
    // 第 20 条,远在尾窗(176 起)之外。
    expect(seedWindowStart(list(200), { messageId: 'm20', offset: -30 })).toBe(20 - CHAT_ANCHOR_BACKFILL)
  })

  it('锚点已经在尾窗里:窗口不因为它变大(起点只减不增)', () => {
    const tail = tailWindowStart(200)
    expect(seedWindowStart(list(200), { messageId: `m${tail + 3}`, offset: 0 })).toBe(tail)
  })

  it('锚点靠近开头:起点夹在 0(不许为负)', () => {
    expect(seedWindowStart(list(200), { messageId: 'm2', offset: 0 })).toBe(0)
  })
})

describe('窗口只增不减', () => {
  it('往前扩:起点变小,答「真的扩了」', () => {
    seedChatWindow('s', 100)
    expect(growChatWindow('s', 52)).toBe(true)
    expect(peekChatWindowStart('s')).toBe(52)
  })

  it('往回缩:一个字不动,答「没扩」—— 已经渲出来的行永远不收回去', () => {
    seedChatWindow('s', 52)
    expect(growChatWindow('s', 100)).toBe(false)
    expect(peekChatWindowStart('s')).toBe(52)
  })

  it('种一格是幂等的:第二次种不改已有的那格', () => {
    seedChatWindow('s', 100)
    seedChatWindow('s', 10)
    expect(peekChatWindowStart('s')).toBe(100)
  })

  it('起点夹在 0(扩过头不会变成负数)', () => {
    seedChatWindow('s', 20)
    growChatWindow('s', -30)
    expect(peekChatWindowStart('s')).toBe(0)
  })
})

describe('够到某一条:三种答案', () => {
  it('已经在窗口里 = ready,窗口一格不动', () => {
    seedChatWindow('s', tailWindowStart(200))
    expect(reachChatWindow('s', list(200), 'm190')).toBe('ready')
    expect(peekChatWindowStart('s')).toBe(tailWindowStart(200))
  })

  it('在数据里但没渲出来 = grew,当场把窗口够过去', () => {
    seedChatWindow('s', tailWindowStart(200))
    expect(reachChatWindow('s', list(200), 'm30')).toBe('grew')
    expect(peekChatWindowStart('s')).toBe(30 - CHAT_ANCHOR_BACKFILL)
  })

  it('这棵树上根本没有这条 = absent(那句话得说给人听)', () => {
    seedChatWindow('s', tailWindowStart(200))
    expect(reachChatWindow('s', list(200), '被删了')).toBe('absent')
  })

  it('还没种过也答得出:按尾窗算', () => {
    expect(reachChatWindow('s', list(200), 'm199')).toBe('ready')
    expect(chatWindowKeys()).toEqual([])
  })
})

describe('寿命:一次挂载一格', () => {
  it('卸载就忘 —— 切回来才会重新只渲一屏(这一单治的病)', () => {
    seedChatWindow('s', 100)
    growChatWindow('s', 0)
    expect(chatWindowKeys()).toEqual(['s'])
    releaseChatWindow('s')
    expect(peekChatWindowStart('s')).toBeUndefined()
    expect(chatWindowKeys()).toEqual([])
  })
})
