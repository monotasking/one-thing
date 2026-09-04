import { describe, expect, it } from 'vitest'
import {
  AT_BOTTOM_EPS,
  FOLLOW_PINNED,
  followPillVisible,
  followShouldStick,
  reduceFollow,
  type FollowState,
} from '../follow'

/**
 * §5.1 那张转移表,一行一条。纯函数,jsdom 都不用起。
 *
 * 真机那一半(贴底时每帧真的在底、上翻之后真的不动)是 `scripts/gate-chat-follow.mjs`
 * 的活 —— 这里量的是**判据写了什么**。
 */
const browsing = (unseen: FollowState['unseen'] = 'none'): FollowState => ({ mode: 'browsing', unseen })

describe('八条转移(§5.1)', () => {
  it('① 进会话 → pinned', () => {
    expect(reduceFollow(browsing('reply'), { type: 'enter' })).toEqual(FOLLOW_PINNED)
  })

  it('② pinned + 滚动离底 → browsing', () => {
    const next = reduceFollow(FOLLOW_PINNED, { type: 'scrolled', gap: AT_BOTTOM_EPS + 1 })
    expect(next).toEqual({ mode: 'browsing', unseen: 'none' })
  })

  it('③ browsing + 滚回底 → pinned,未读清空', () => {
    const next = reduceFollow(browsing('reply'), { type: 'scrolled', gap: AT_BOTTOM_EPS })
    expect(next).toEqual(FOLLOW_PINNED)
  })

  it('④ pinned + 内容长高 → 还是 pinned(要滚的是调用方)', () => {
    const next = reduceFollow(FOLLOW_PINNED, { type: 'grew' })
    // 同一个对象 —— setState 的浅比会短路,流式每帧那一次白送。
    expect(next).toBe(FOLLOW_PINNED)
    expect(followShouldStick(next)).toBe(true)
  })

  it('⑤ browsing + 内容长高 → 不滚,只把未读翻成 reply', () => {
    const next = reduceFollow(browsing(), { type: 'grew' })
    expect(next).toEqual({ mode: 'browsing', unseen: 'reply' })
    expect(followShouldStick(next)).toBe(false)
  })

  it('⑥ pinned + 发送 → 还是 pinned(自己那条靠长高落进视口)', () => {
    expect(reduceFollow(FOLLOW_PINNED, { type: 'sent' })).toBe(FOLLOW_PINNED)
  })

  it('⑦ browsing + 发送 → 不滚,未读 = sent', () => {
    expect(reduceFollow(browsing(), { type: 'sent' })).toEqual({ mode: 'browsing', unseen: 'sent' })
  })

  it('⑧ 点丸 → pinned,滚到底', () => {
    const next = reduceFollow(browsing('sent'), { type: 'jumpToBottom' })
    expect(next).toEqual(FOLLOW_PINNED)
    expect(followShouldStick(next)).toBe(true)
  })
})

describe('容差与闩', () => {
  it('恰好 EPS 算在底(缩放 / 亚微像素行高不该被当成上翻)', () => {
    expect(reduceFollow(browsing('reply'), { type: 'scrolled', gap: AT_BOTTOM_EPS }).mode).toBe('pinned')
    expect(reduceFollow(FOLLOW_PINNED, { type: 'scrolled', gap: AT_BOTTOM_EPS + 0.5 }).mode).toBe('browsing')
  })

  it('已经在浏览,再滚一下不改未读(攒着的东西不该被一次滚动抹掉)', () => {
    const state = browsing('reply')
    expect(reduceFollow(state, { type: 'scrolled', gap: 500 })).toBe(state)
  })

  /*
   * 与设计稿的那处出入(理由写在 follow.ts 的 `grew` 分支里):自己发的那条本身
   * 就是一次长高,`grew` 若照字面把 `sent` 冲成 `reply`,「已发送」那张脸一帧都
   * 活不到。拆掉这一条就是把一个设计好的态变成死态。
   */
  it('发送之后的那次长高不冲掉「已发送」', () => {
    const sent = reduceFollow(browsing(), { type: 'sent' })
    expect(reduceFollow(sent, { type: 'grew' })).toBe(sent)
  })

  it('「已发送」的闩由回到底解除', () => {
    const sent = browsing('sent')
    expect(reduceFollow(sent, { type: 'jumpToBottom' })).toEqual(FOLLOW_PINNED)
    expect(reduceFollow(sent, { type: 'scrolled', gap: 0 })).toEqual(FOLLOW_PINNED)
    expect(reduceFollow(sent, { type: 'enter' })).toEqual(FOLLOW_PINNED)
  })

  /*
   * 那个闩的**另一把钥匙**。上一条说的是「人看见了」,这一条说的是「回复真的到了」
   * —— 少了它,浏览中发一条、回复流完之后,丸会一直挂着「已发送」,而此刻下面
   * 明明有一条没看过的回复:那张脸在撒谎。`grew` 顶不了这个班(理由见 §5.1 那格),
   * 所以「回复到达」有自己的事件。
   */
  it('「已发送」→ 回复到了 → 「回到最新」', () => {
    const sent = reduceFollow(browsing(), { type: 'sent' })
    expect(sent).toEqual({ mode: 'browsing', unseen: 'sent' })
    expect(reduceFollow(sent, { type: 'reply' })).toEqual({ mode: 'browsing', unseen: 'reply' })
  })

  it('浏览中什么都没攒时,回复到了也翻成 reply', () => {
    expect(reduceFollow(browsing(), { type: 'reply' })).toEqual({ mode: 'browsing', unseen: 'reply' })
  })

  it('pinned 下回复到了什么都不改,而且返回同一个对象', () => {
    // 你就在底,没有「没看见」这回事;而流式期间每段 delta 都来一次,
    // 同一个对象让 setState 的浅比短路 —— 那几百次一次 state 都不推。
    expect(reduceFollow(FOLLOW_PINNED, { type: 'reply' })).toBe(FOLLOW_PINNED)
  })

  it('已经是 reply 了,再来一段 delta 也返回同一个对象', () => {
    const state = browsing('reply')
    expect(reduceFollow(state, { type: 'reply' })).toBe(state)
  })
})

describe('丸挂不挂', () => {
  it('pinned 一律不画', () => {
    expect(followPillVisible(FOLLOW_PINNED)).toBe(false)
  })

  it('browsing 但下面还什么都没长 —— 也不画', () => {
    expect(followPillVisible(browsing())).toBe(false)
  })

  it('browsing + 有未读才画', () => {
    expect(followPillVisible(browsing('sent'))).toBe(true)
    expect(followPillVisible(browsing('reply'))).toBe(true)
  })
})
