import { describe, expect, it } from 'vitest'
import { IntentWindow } from '../intent-window'
import type { AnchoredElement } from '../scroll-port'

/** 两格时限窗口(G 线 P2-a)。零 DOM、零时钟:`now` 是入参。 */

const EL: AnchoredElement = { alive: () => true, top: () => 0 }

describe('展开窗', () => {
  it('缺省不在窗内(0 = 没有这回事)', () => {
    expect(new IntentWindow().expanding(1000)).toBe(false)
  })

  it('报一句之后窗内为真,过点为假 —— 边界是 `<`,不是 `<=`', () => {
    const w = new IntentWindow()
    w.noteExpand(1000, 220)
    expect(w.expanding(1219)).toBe(true)
    expect(w.expanding(1220)).toBe(false)
  })

  it('换会话清掉 —— 那格说的是「**那边**有人点开了一样东西」', () => {
    const w = new IntentWindow()
    w.noteExpand(1000, 220)
    w.clearExpand()
    expect(w.expanding(1001)).toBe(false)
  })

  it('再报一次按新的起点重新算(不是取两者的大的)', () => {
    const w = new IntentWindow()
    w.noteExpand(1000, 220)
    w.noteExpand(1100, 50)
    expect(w.expandUntil).toBe(1150)
  })
})

describe('折叠窗', () => {
  it('缺省答 undefined', () => {
    expect(new IntentWindow().folding(1000)).toBeUndefined()
  })

  it('窗内交出同一格(锚记在上面,逐帧接着用)', () => {
    const w = new IntentWindow()
    w.noteFold(1000, 220)
    const first = w.folding(1100)
    expect(first).toBeDefined()
    first!.anchor = EL
    first!.top = 42
    expect(w.folding(1150)).toBe(first)
    expect(w.folding(1150)?.top).toBe(42)
  })

  it('过点**当场清掉**并答 undefined —— 判据是 `>`,不是 `>=`', () => {
    const w = new IntentWindow()
    w.noteFold(1000, 220)
    expect(w.folding(1220)).toBeDefined()
    expect(w.folding(1221)).toBeUndefined()
    // 清过之后即使把时间拨回去也不再在场(它是被消掉的,不是被算出来的)。
    expect(w.folding(1100)).toBeUndefined()
  })

  it('两格互不影响:折起那一段不让展开那一格在场', () => {
    const w = new IntentWindow()
    w.noteFold(1000, 220)
    expect(w.expanding(1100)).toBe(false)
  })
})
