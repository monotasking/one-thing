import { describe, expect, it } from 'vitest'
import { ANCHOR_RESETTLE_ROUNDS, EntryRestore } from '../entry-restore'
import type { ScrollAnchor } from '../../../data/session-view-state'

/** `EntryRestore` 的三条落稳判据与有界(G 线 P2-a)。零 DOM:对不对得上由调用方量。 */

const ANCHOR: ScrollAnchor = { messageId: 'm1', offset: -12 }

describe('立起来与作废', () => {
  it('没立起来时问谁都答 undefined,`consume` 一律当「落稳了」', () => {
    const r = new EntryRestore()
    expect(r.anchor).toBeUndefined()
    expect(r.consume(true, 999, 2)).toBe(true)
  })

  it('`arm` 之后交得出那个锚,缺省轮数是 6', () => {
    const r = new EntryRestore()
    r.arm(ANCHOR)
    expect(r.anchor).toEqual(ANCHOR)
    expect(r.left).toBe(ANCHOR_RESETTLE_ROUNDS)
  })

  it('`clear()` 作废 —— 换会话那一句(它闭包着上一条会话的锚点)', () => {
    const r = new EntryRestore()
    r.arm(ANCHOR)
    r.clear()
    expect(r.anchor).toBeUndefined()
  })
})

describe('三条落稳判据', () => {
  it('① 那条消息不在树上了 = 当场收手', () => {
    const r = new EntryRestore()
    r.arm(ANCHOR)
    expect(r.consume(false, 0, 2)).toBe(true)
    expect(r.anchor).toBeUndefined()
  })

  it('② 位置不再动(≤ eps)= 这张排版已经稳了', () => {
    const r = new EntryRestore()
    r.arm(ANCHOR)
    expect(r.consume(true, 1.5, 2)).toBe(true)
    expect(r.anchor).toBeUndefined()
  })

  it('② 反向也算(判的是位移的绝对值,不是符号)', () => {
    const r = new EntryRestore()
    r.arm(ANCHOR)
    expect(r.consume(true, -1.5, 2)).toBe(true)
  })

  it('③ 有界:一直在漂也最多再对这么多轮', () => {
    const r = new EntryRestore()
    r.arm(ANCHOR)
    const rounds: boolean[] = []
    for (let i = 0; i < ANCHOR_RESETTLE_ROUNDS + 2; i += 1) rounds.push(r.consume(true, 188, 2))
    // 前 5 轮都还没落稳,第 6 轮轮数用完,之后一律答「落稳了」。
    expect(rounds.slice(0, ANCHOR_RESETTLE_ROUNDS - 1).every((x) => x === false)).toBe(true)
    expect(rounds[ANCHOR_RESETTLE_ROUNDS - 1]).toBe(true)
    expect(r.anchor).toBeUndefined()
  })

  it('还在漂而且轮数没用完:继续对', () => {
    const r = new EntryRestore()
    r.arm(ANCHOR)
    expect(r.consume(true, 188, 2)).toBe(false)
    expect(r.left).toBe(ANCHOR_RESETTLE_ROUNDS - 1)
    expect(r.anchor).toEqual(ANCHOR)
  })
})
