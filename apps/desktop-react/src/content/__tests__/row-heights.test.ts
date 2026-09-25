import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ROW_HEIGHT_BOOKS_LIMIT,
  RowHeightBook,
  RowHeightObserver,
  resetRowHeights,
  rowHeightBookCount,
  rowHeightsOf,
} from '../row-heights'

/**
 * **行高账**(G 线 P4-b ①,正本 §22.2;判词整段在 `row-heights.ts` 的文件头)。
 *
 * 钉三件事:账本自己的两条规矩(0 不是读数、列宽变了整本作废)与 32 本的 LRU;
 * 观察者的「只记渲过的行」—— 这一条是整只文件存在的理由,记错一格就是把 240px 的估计
 * 当真高喂回下一次挂载;以及挂载那一刻给出去的估计**恒定**(它进 P4-a 行元素账的输入
 * 清单,一变那一行的元素就重造)。
 *
 * 真机时序(Electron 41:同一帧里 RO 先报、事件后到)写在源文件头上,这里按那个次序喂。
 */

/* ── 假 RO:把回调收起来,由用例决定哪一拍报什么 ─────────────────────────── */
class FakeResizeObserver {
  static live: FakeResizeObserver[] = []
  readonly targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.live.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
}

/** 浏览器排完版报一格 border box。 */
function report(el: Element, height: number, width = 700) {
  for (const observer of FakeResizeObserver.live) {
    if (!observer.targets.has(el)) continue
    observer.callback(
      [
        {
          target: el,
          borderBoxSize: [{ blockSize: height, inlineSize: width }],
          contentRect: { height, width } as DOMRectReadOnly,
        } as unknown as ResizeObserverEntry,
      ],
      observer as unknown as ResizeObserver,
    )
  }
}

/** 浏览器说这一行跳渲 / 渲着了 —— **不冒泡**,与真事件同形(捕获监听照样收得到)。 */
function state(el: Element, skipped: boolean) {
  const event = new Event('contentvisibilityautostatechange', { bubbles: false })
  Object.defineProperty(event, 'skipped', { value: skipped })
  el.dispatchEvent(event)
}

let previous: typeof globalThis.ResizeObserver | undefined

beforeEach(() => {
  previous = globalThis.ResizeObserver
  FakeResizeObserver.live = []
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  resetRowHeights()
})

afterEach(() => {
  if (previous) globalThis.ResizeObserver = previous
  else Reflect.deleteProperty(globalThis as object, 'ResizeObserver')
  resetRowHeights()
  document.body.innerHTML = ''
})

/** 一列三行 + 列尾那两格 div(座位垫块与尾槽空位),与 `ChatStream` 的 DOM 同形。 */
function column() {
  const root = document.createElement('div')
  const col = document.createElement('div')
  root.appendChild(col)
  const rows = ['a', 'b', 'c'].map((id) => {
    const row = document.createElement('article')
    row.dataset.messageId = id
    col.appendChild(row)
    return row
  })
  col.appendChild(document.createElement('div'))
  col.appendChild(document.createElement('div'))
  document.body.appendChild(root)
  return { root, rows }
}

function observerOver(book = new RowHeightBook()) {
  const heard: [string, number, number][] = []
  const observer = new RowHeightObserver(book, (id, h, w) => heard.push([id, h, w]))
  const { root, rows } = column()
  observer.attach(root)
  const cleanups = rows.map((row) => observer.refFor(row.dataset.messageId ?? '')(row as HTMLElement))
  return { book, observer, heard, root, rows, cleanups }
}

describe('账本自己的规矩', () => {
  it('记一格、按 id 读;0 与非有限数不是读数', () => {
    const book = new RowHeightBook()
    book.record('a', 120, 700)
    book.record('b', 0, 700)
    book.record('c', Number.NaN, 700)
    expect(book.heightOf('a')).toBe(120)
    expect(book.heightOf('b')).toBeUndefined()
    expect(book.heightOf('c')).toBeUndefined()
  })

  it('列宽变了整本作废,记新宽;亚像素的宽不算变', () => {
    const book = new RowHeightBook()
    book.record('a', 120, 700)
    book.record('b', 80, 700.4)
    expect(book.size).toBe(2)
    book.record('c', 90, 520)
    expect(book.width).toBe(520)
    expect(book.heightOf('a')).toBeUndefined()
    expect(book.heightOf('c')).toBe(90)
  })

  it('一条会话一本;超过上限从最久没用过的那一本逐出', () => {
    const first = rowHeightsOf('s0')
    expect(rowHeightsOf('s0')).toBe(first)
    for (let i = 1; i < ROW_HEIGHT_BOOKS_LIMIT; i += 1) rowHeightsOf(`s${i}`)
    // 用一次 s0,它就不再是最久没用过的那一本
    rowHeightsOf('s0')
    rowHeightsOf('overflow')
    expect(rowHeightBookCount()).toBe(ROW_HEIGHT_BOOKS_LIMIT)
    expect(rowHeightsOf('s0')).toBe(first)
    // 逐出的是 s1:再要它就是一本新的
    const s1 = rowHeightsOf('s1')
    expect(s1.size).toBe(0)
  })
})

describe('观察者:只记渲过的行', () => {
  it('RO 先到、状态还没报 → 不记;事件说「渲着」→ 补记 RO 刚报的那一格', () => {
    const { book, heard, rows } = observerOver()
    report(rows[0], 312)
    expect(book.heightOf('a')).toBeUndefined()
    state(rows[0], false)
    expect(book.heightOf('a')).toBe(312)
    expect(heard).toEqual([['a', 312, 700]])
  })

  it('跳渲中的行报的是占位 → 不记(不然估计就被当成了真高)', () => {
    const { book, rows } = observerOver()
    report(rows[1], 240)
    state(rows[1], true)
    report(rows[1], 240, 700)
    expect(book.heightOf('b')).toBeUndefined()
  })

  it('渲着之后每一次 RO 都记;转回跳渲之后又停', () => {
    const { book, rows } = observerOver()
    state(rows[0], false)
    report(rows[0], 100)
    report(rows[0], 140)
    expect(book.heightOf('a')).toBe(140)
    state(rows[0], true)
    report(rows[0], 240)
    expect(book.heightOf('a')).toBe(140)
  })

  it('列尾那一行永远收不到事件,也永远不跳渲 —— RO 一报就记', () => {
    const { book, rows } = observerOver()
    report(rows[2], 77)
    expect(book.heightOf('c')).toBe(77)
    // 不是列尾的那几行照旧要等事件
    report(rows[1], 55)
    expect(book.heightOf('b')).toBeUndefined()
  })

  it('RO 报来的列宽变了 → 整本作废(老宽下的高不再当真)', () => {
    const { book, rows } = observerOver()
    state(rows[0], false)
    state(rows[1], false)
    report(rows[0], 100, 700)
    report(rows[1], 60, 700)
    report(rows[0], 150, 480)
    expect(book.heightOf('a')).toBe(150)
    expect(book.heightOf('b')).toBeUndefined()
  })

  it('摘下的行不再记;dispose 之后事件与 RO 一格都不收', () => {
    const { book, observer, rows, cleanups } = observerOver()
    expect(observer.observed).toBe(3)
    ;(cleanups[0] as () => void)()
    expect(observer.observed).toBe(2)
    state(rows[0], false)
    report(rows[0], 90)
    expect(book.heightOf('a')).toBeUndefined()
    observer.dispose()
    state(rows[1], false)
    report(rows[1], 90)
    expect(book.heightOf('b')).toBeUndefined()
  })
})

describe('挂载那一刻给出去的估计', () => {
  it('第一次问读账,之后原样交回同一个数(账变了也不跟)', () => {
    const book = new RowHeightBook()
    book.record('a', 120, 700)
    const observer = new RowHeightObserver(book)
    expect(observer.heightAtMount('a')).toBe(120)
    expect(observer.heightAtMount('z')).toBeUndefined()
    book.record('a', 999, 700)
    book.record('z', 50, 700)
    expect(observer.heightAtMount('a')).toBe(120)
    expect(observer.heightAtMount('z')).toBeUndefined()
  })

  it('ref 回调按 id 身份恒定(React 才不会每次提交摘了再挂)', () => {
    const observer = new RowHeightObserver(new RowHeightBook())
    expect(observer.refFor('a')).toBe(observer.refFor('a'))
    expect(observer.refFor('a')).not.toBe(observer.refFor('b'))
  })
})
