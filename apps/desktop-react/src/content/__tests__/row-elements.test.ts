import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { RowElementBook, sameRowInputs } from '../row-elements'

/**
 * 行元素账(G 线 P4-a ①)。它省钱靠的是「交回**同一个**元素对象」(React 见
 * `oldProps === newProps` 直接跳过),所以这一组钉的全是**身份**,不是内容。
 */

const row = (key: string, text: string) => [createElement('p', { key }, text)]

describe('sameRowInputs', () => {
  it('逐格同一个值才算相同', () => {
    const message = { id: 'a' }
    expect(sameRowInputs([message, true, 's'], [message, true, 's'])).toBe(true)
    expect(sameRowInputs([message, true], [{ id: 'a' }, true])).toBe(false)
    expect(sameRowInputs([message, true], [message, false])).toBe(false)
    expect(sameRowInputs([message], [message, false])).toBe(false)
  })
})

describe('RowElementBook', () => {
  it('输入逐格相同 → 交回同一组元素对象,build 不再调', () => {
    const book = new RowElementBook()
    const message = { id: 'a' }
    let builds = 0
    const build = () => { builds += 1; return row('a', 'hi') }

    book.begin()
    const first = book.take('a', [message, false], build)
    book.end()
    book.begin()
    const second = book.take('a', [message, false], build)
    book.end()

    expect(second).toBe(first)
    expect(second[0]).toBe(first[0])
    expect(builds).toBe(1)
  })

  it('任一格变了 → 现造一组新的', () => {
    const book = new RowElementBook()
    const message = { id: 'a' }
    book.begin()
    const first = book.take('a', [message, false], () => row('a', 'hi'))
    book.end()
    book.begin()
    /* 流式那一行:消息对象换了一个(`streaming` 照旧是真)。 */
    const next = book.take('a', [{ id: 'a' }, false], () => row('a', 'hi!'))
    book.end()
    expect(next).not.toBe(first)
    book.begin()
    const flipped = book.take('a', [message, true], () => row('a', 'hi'))
    book.end()
    expect(flipped).not.toBe(next)
  })

  it('这一遍没用到的格在 end() 时摘掉 —— 账的大小等于列里的行数', () => {
    const book = new RowElementBook()
    book.begin()
    book.take('a', [1], () => row('a', 'a'))
    book.take('b', [1], () => row('b', 'b'))
    book.end()
    expect(book.size).toBe(2)

    /* 重试截掉了 b:下一遍只剩 a。 */
    book.begin()
    book.take('a', [1], () => row('a', 'a'))
    book.end()
    expect(book.size).toBe(1)

    /* b 回来(同 id 同输入)也是**现造**的 —— 摘掉就是忘了,不留陈的。 */
    let rebuilt = false
    book.begin()
    book.take('a', [1], () => row('a', 'a'))
    book.take('b', [1], () => { rebuilt = true; return row('b', 'b') })
    book.end()
    expect(rebuilt).toBe(true)
  })

  it('一遍被丢弃(只 begin 没 end)不摘任何一格,下一遍照常命中', () => {
    const book = new RowElementBook()
    book.begin()
    const first = book.take('a', [1], () => row('a', 'a'))
    book.take('b', [1], () => row('b', 'b'))
    book.end()

    /* 并发渲染里被丢掉的那一遍:只走到一半。 */
    book.begin()
    book.take('a', [1], () => row('a', 'a'))

    book.begin()
    expect(book.take('a', [1], () => row('a', 'x'))).toBe(first)
    book.take('b', [1], () => row('b', 'b'))
    book.end()
    expect(book.size).toBe(2)
  })
})
