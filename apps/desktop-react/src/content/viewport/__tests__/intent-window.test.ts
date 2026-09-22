import { describe, expect, it } from 'vitest'
import { IntentWindow } from '../intent-window'
import type { AnchoredElement } from '../scroll-port'

/**
 * **一格**时限窗口(G 线 P2-c 合一;P2-a 抽件时它是两格)。零 DOM、零时钟:
 * `now` 是入参。合一的判词在 `intent-window.ts` 的文件头、正本 §18.1。
 */

const EL: AnchoredElement = { alive: () => true, top: () => 0 }

describe('一格窗:开 / 在场 / 过期', () => {
  it('缺省答 undefined', () => {
    expect(new IntentWindow().current(1000)).toBeUndefined()
  })

  it('窗内交出同一格(锚记在上面,逐帧接着用)', () => {
    const w = new IntentWindow()
    w.open(1000, 220)
    const first = w.current(1100)
    expect(first).toBeDefined()
    first!.anchor = EL
    first!.top = 42
    expect(w.current(1150)).toBe(first)
    expect(w.current(1150)?.top).toBe(42)
  })

  it('过点**当场清掉**并答 undefined —— 判据是 `>`,不是 `>=`', () => {
    const w = new IntentWindow()
    w.open(1000, 220)
    expect(w.current(1220)).toBeDefined()
    expect(w.current(1221)).toBeUndefined()
    // 清过之后即使把时间拨回去也不再在场(它是被消掉的,不是被算出来的)。
    expect(w.current(1100)).toBeUndefined()
  })

  it('再开一次按新的起点重新算(不是取两者大的)—— **后到的说了算**', () => {
    const w = new IntentWindow()
    w.open(1000, 220)
    w.open(1100, 50)
    expect(w.holdUntil).toBe(1150)
    // 旧那一格连同它的锚一起丢掉:收到一半又展开时,钉的是新点的那一块。
    expect(w.current(1140)?.anchor).toBeUndefined()
  })

  it('换会话 / 离场那一句 `clear()` 把整格窗撤掉', () => {
    const w = new IntentWindow()
    w.open(1000, 220, { anchor: EL, top: 7, rejudge: true })
    w.clear()
    expect(w.current(1001)).toBeUndefined()
  })
})

describe('报出来的那一下带锚、带重判;点不出那一块的只带时长', () => {
  it('点得出:锚与落点在报的那一刻就定下来,`rejudge` 为真', () => {
    const w = new IntentWindow()
    w.open(1000, 220, { anchor: EL, top: 44, rejudge: true })
    const hold = w.current(1100)
    expect(hold?.anchor).toBe(EL)
    expect(hold?.top).toBe(44)
    expect(hold?.rejudge).toBe(true)
  })

  it('点不出:锚留空(第一帧在 RO 里现选),`rejudge` 缺省为假', () => {
    const w = new IntentWindow()
    w.open(1000, 220)
    const hold = w.current(1100)
    expect(hold?.anchor).toBeUndefined()
    expect(hold?.rejudge).toBe(false)
  })
})

describe('这一段还在长就把窗口往后推(`extend`)', () => {
  it('只往后推,不往前拉', () => {
    const w = new IntentWindow()
    w.open(1000, 220)
    w.extend(1100, 220)
    expect(w.holdUntil).toBe(1320)
    w.extend(1000, 10)
    expect(w.holdUntil).toBe(1320)
  })

  it('没有窗时什么都不做(不会凭空开一格)', () => {
    const w = new IntentWindow()
    w.extend(1000, 220)
    expect(w.current(1001)).toBeUndefined()
  })
})

describe('刚过期的那一格只交出一次', () => {
  it('`current` 把它推给 `takeExpired`,取走之后不再有', () => {
    const w = new IntentWindow()
    w.open(1000, 220, { anchor: EL, top: 1, rejudge: true })
    expect(w.takeExpired()).toBeUndefined()
    expect(w.current(1221)).toBeUndefined()
    expect(w.takeExpired()?.rejudge).toBe(true)
    expect(w.takeExpired()).toBeUndefined()
  })
})
