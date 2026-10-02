import { describe, expect, it } from 'vitest'

import { CursorDecodeError, createCursorCodec, hashQueryShape } from '../cursor.js'
import { OFFSET_CURSOR_KIND, paginate, readOffsetCursor } from '../pipeline/page.js'
import type { Candidate } from '../candidate.js'

const codec = createCursorCodec()

function candidate(id: string): Candidate {
  return { capability: 'alpha', id, title: id, score: 1, target: { kind: 'row', payload: {} } }
}

describe('CursorCodec', () => {
  it('往返恒等,含中文与嵌套 payload', () => {
    const payload = { capability: 'alpha', kind: 'offset', payload: { queryHash: 'x1', offset: 40, 说明: '中文也要过' } }
    expect(codec.decode(codec.encode(payload))).toEqual(payload)
  })

  it('是不透明串:base64url 字母表内,没有 = + /', () => {
    const encoded = codec.encode({ capability: 'alpha', kind: 'offset', payload: { offset: 1 } })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('坏串抛类型化错误', () => {
    expect(() => codec.decode('')).toThrow(CursorDecodeError)
    expect(() => codec.decode('!!!not base64!!!')).toThrow(CursorDecodeError)
    expect(() => codec.decode(codec.encode({ capability: 'a', kind: 'k', payload: 1 }).slice(0, 3)))
      .toThrow(CursorDecodeError)
  })

  it('tryDecode 不抛 —— 过期游标不是错误', () => {
    expect(codec.tryDecode('garbage!!')).toBeUndefined()
  })

  it('随机往返 200 次逐字同', () => {
    for (let i = 0; i < 200; i += 1) {
      const payload = { capability: `c${i}`, kind: 'offset', payload: { offset: i, tag: `词${i}` } }
      expect(codec.decode(codec.encode(payload))).toEqual(payload)
    }
  })
})

describe('queryHash 与游标稳定性', () => {
  it('键序无关', () => {
    expect(hashQueryShape({ a: 1, b: { x: 1, y: 2 } })).toBe(hashQueryShape({ b: { y: 2, x: 1 }, a: 1 }))
  })

  it('索引代次变了 hash 就变,旧游标自然失效', () => {
    const before = hashQueryShape({ raw: '身份牌', generation: 1 })
    const after = hashQueryShape({ raw: '身份牌', generation: 2 })
    expect(before).not.toBe(after)

    const cursor = codec.encode({ capability: 'alpha', kind: OFFSET_CURSOR_KIND, payload: { queryHash: before, offset: 20 } })
    expect(readOffsetCursor(codec, cursor, { capability: 'alpha', queryHash: before })).toBe(20)
    expect(readOffsetCursor(codec, cursor, { capability: 'alpha', queryHash: after })).toBe(0)
  })

  it('别人家的游标不认', () => {
    const cursor = codec.encode({ capability: 'beta', kind: OFFSET_CURSOR_KIND, payload: { queryHash: 'h', offset: 20 } })
    expect(readOffsetCursor(codec, cursor, { capability: 'alpha', queryHash: 'h' })).toBe(0)
  })
})

describe('paginate', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map(candidate)

  it('取尽时不发游标(缺席 = 取尽)', () => {
    const page = paginate(items, { limit: 10 }, { capability: 'alpha', codec, queryHash: 'h' })
    expect(page.cursor).toBeUndefined()
    expect(page.total).toBe(5)
  })

  it('还有下一页才发游标,offset 接得上', () => {
    const first = paginate(items, { limit: 2 }, { capability: 'alpha', codec, queryHash: 'h' })
    expect(first.items.map(item => item.id)).toEqual(['a', 'b'])
    expect(first.cursor).toBeDefined()
    expect(readOffsetCursor(codec, first.cursor, { capability: 'alpha', queryHash: 'h' })).toBe(2)
  })

  it('最后一页恰好装满也不发游标 —— 这正是「回来的比要的少」猜错的那一形', () => {
    const page = paginate(items.slice(3), { limit: 2 }, {
      capability: 'alpha', codec, queryHash: 'h', total: 5, offset: 3,
    })
    expect(page.items).toHaveLength(2)
    expect(page.cursor).toBeUndefined()
  })
})
