import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useScrollMemory } from '../scroll-memory'

/**
 * `useScrollMemory` 的四条判例各配一个用例,外加**判例②的反证**。
 *
 * ── jsdom 的 scrollTop 要换一副存取器 ────────────────────────────────────
 * jsdom 不排版,原生 `scrollTop` 对「不可滚」的元素是空转,而这一组要验的恰恰
 * 是**写进去 / 读出来的那个数**。所以在原型上换一副按元素记账的存取器 ——
 * 它比查看器那一份多守一件事:**节点从 DOM 上摘掉之后读回 0**。真浏览器就是
 * 这样的(游离节点没有布局),而判例②的反证全靠这一条:`useEffect` 的拆卸排在
 * 摘节点之后,那时它读到的就是 0。
 */
const scrollTops = new WeakMap<Element, number>()
let originalScrollTop: PropertyDescriptor | undefined

interface Harness {
  memoKey: string
  store: Map<string, number>
}

function ScrollHarness({ memoKey, store }: Harness) {
  const ref = useRef<HTMLDivElement>(null)
  const { onScroll } = useScrollMemory(ref, memoKey, {
    read: (k) => store.get(k),
    // 端口每渲染都是新闭包 —— 这本身就是「依赖表里不许有它们」那条的现场。
    write: (k, top) => store.set(k, top),
  })
  return <div data-testid="body" ref={ref} onScroll={onScroll} />
}

describe('useScrollMemory —— 还原 / 写回 / 换键 / 节流', () => {
  beforeEach(() => {
    originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return this.isConnected ? (scrollTops.get(this) ?? 0) : 0
      },
      set(this: Element, v: number) {
        scrollTops.set(this, v)
      },
    })
  })
  afterEach(() => {
    if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop)
  })

  it('① 挂载还原:第一帧就把记忆位贴回去(读不到就是 0)', () => {
    const store = new Map([['a', 120]])
    render(<ScrollHarness memoKey="a" store={store} />)
    expect(screen.getByTestId('body').scrollTop).toBe(120)
  })

  it('① 没记忆的键还原到 0,不抛也不留上一份的高度', () => {
    const store = new Map<string, number>()
    render(<ScrollHarness memoKey="fresh" store={store} />)
    expect(screen.getByTestId('body').scrollTop).toBe(0)
  })

  it('③ 换键:先写回旧键,再还原新键(新键没记忆 = 归零)', () => {
    const store = new Map([['a', 40]])
    const { rerender } = render(<ScrollHarness memoKey="a" store={store} />)
    const body = screen.getByTestId('body')
    body.scrollTop = 260

    rerender(<ScrollHarness memoKey="b" store={store} />)
    expect(store.get('a')).toBe(260) // 旧键的账在换走前结清
    expect(body.scrollTop).toBe(0) // 新键没记忆 → 归零,不留上一份的高度
    expect(store.get('b')).toBeUndefined() // 还原不算一次写回
  })

  it('③ 换到一把有记忆的键:贴的是那把键的数', () => {
    const store = new Map([
      ['a', 12],
      ['b', 88],
    ])
    const { rerender } = render(<ScrollHarness memoKey="a" store={store} />)
    rerender(<ScrollHarness memoKey="b" store={store} />)
    expect(screen.getByTestId('body').scrollTop).toBe(88)
  })

  it('② layout cleanup 才读得到真数:卸载时写回的是非 0 的那个位置', () => {
    const store = new Map<string, number>()
    const { unmount } = render(<ScrollHarness memoKey="a" store={store} />)
    screen.getByTestId('body').scrollTop = 340

    unmount()
    // 反证:把 useLayoutEffect 换成 useEffect,这里会读到 0(节点已摘)。
    expect(store.get('a')).toBe(340)
  })

  it('② 卸载 → 重挂(真换宿主)贴得回去', () => {
    const store = new Map<string, number>()
    const { unmount } = render(<ScrollHarness memoKey="a" store={store} />)
    screen.getByTestId('body').scrollTop = 340
    unmount()

    render(<ScrollHarness memoKey="a" store={store} />)
    expect(screen.getByTestId('body').scrollTop).toBe(340)
  })

  it('④ 节流:一帧里连发五次只写两次(领沿一发 + 帧末一发),而且记的是最终位置', async () => {
    const store = new Map<string, number>()
    const writes: number[] = []
    function CountingHarness() {
      const ref = useRef<HTMLDivElement>(null)
      const { onScroll } = useScrollMemory(ref, 'a', {
        read: (k) => store.get(k),
        write: (k, top) => {
          writes.push(top)
          store.set(k, top)
        },
      })
      return <div data-testid="body" ref={ref} onScroll={onScroll} />
    }
    render(<CountingHarness />)
    const body = screen.getByTestId('body')

    for (const top of [10, 20, 30, 40, 50]) {
      body.scrollTop = top
      fireEvent.scroll(body)
    }
    // 领沿那一发是同步的 —— 「滚一下马上换走」不会丢掉这一段。
    expect(writes).toEqual([10])

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(writes).toEqual([10, 50]) // 帧末补最终位置,中间三发并掉
  })

  it('④ 端口每渲染换身份也不会重跑还原(白重渲不许把用户滚到一半的位置弹回去)', () => {
    const store = new Map([['a', 100]])
    const { rerender } = render(<ScrollHarness memoKey="a" store={store} />)
    const body = screen.getByTestId('body')
    expect(body.scrollTop).toBe(100)

    body.scrollTop = 500
    rerender(<ScrollHarness memoKey="a" store={store} />)
    expect(body.scrollTop).toBe(500)
  })
})
