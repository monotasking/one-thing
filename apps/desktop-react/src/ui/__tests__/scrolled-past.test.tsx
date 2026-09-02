import { useRef } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isScrolledPast, scrollParentOf, useScrolledPast } from '../scrolled-past'

/**
 * `useScrolledPast` 的门。守的是它那两条**真机判例**(文件头写着产地):
 *   ① 不相交要问方向 —— 「还没滚到」不算「滚过去了」;
 *   ② root 取的是真正在滚的那一层,不是缺省的视口。
 * 两条各配一个反证(拆掉即红)。
 *
 * jsdom 没有 IntersectionObserver 也不排版,所以这里装一个**记账的桩**:
 * 它把每次 `new` 收到的 options 记下来(② 靠它断言),并把回调交出去手动喂
 * (① 靠它喂带几何的 entry)。
 */

type Entry = {
  isIntersecting: boolean
  boundingClientRect: { top: number }
  rootBounds: { top: number } | null
}

function stubObserver() {
  const calls: { callback: (entries: Entry[]) => void; root: Element | Document | null }[] = []
  class Stub {
    constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
      calls.push({ callback, root: (options?.root ?? null) as Element | null })
    }
    observe() {}
    disconnect() {
      disconnects += 1
    }
  }
  let disconnects = 0
  vi.stubGlobal('IntersectionObserver', Stub)
  return {
    get root() {
      return calls[0]?.root ?? null
    },
    get disconnects() {
      return disconnects
    },
    feed: (entry: Entry) => act(() => calls.forEach((c) => c.callback([entry]))),
    scrollPast: () => ({ isIntersecting: false, boundingClientRect: { top: -400 }, rootBounds: { top: 0 } }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 消费面的最小形:哨兵 + 读数。`scroller` 那一层给了真的 `overflow-y: auto`
 * —— jsdom 不排版,但 `getComputedStyle` 认内联样式,而这只件问的正是计算样式。
 */
function Host({ resetKey, scrolls = true }: { resetKey?: unknown; scrolls?: boolean }) {
  const mark = useRef<HTMLDivElement>(null)
  const { past } = useScrolledPast(mark, { resetKey })
  return (
    <div data-testid="scroller" style={scrolls ? { overflowY: 'auto' } : undefined}>
      <div ref={mark} data-testid="mark" />
      <span data-testid="readout">{past ? 'past' : 'not-past'}</span>
    </div>
  )
}

describe('判例①:不相交要问方向', () => {
  it('哨兵跑到 root 上面 = 滚过去了', () => {
    const observer = stubObserver()
    render(<Host />)
    expect(screen.getByTestId('readout').textContent).toBe('not-past')
    observer.feed(observer.scrollPast())
    expect(screen.getByTestId('readout').textContent).toBe('past')
  })

  it('反证:哨兵在 root **下面**(还没滚到)不算 —— 开面那一刻正是这一档', () => {
    const observer = stubObserver()
    render(<Host />)
    observer.feed({ isIntersecting: false, boundingClientRect: { top: 900 }, rootBounds: { top: 0 } })
    expect(screen.getByTestId('readout').textContent).toBe('not-past')
  })

  it('滚回来读数自己撤 —— 相交了就不是「滚过去了」', () => {
    const observer = stubObserver()
    render(<Host />)
    observer.feed(observer.scrollPast())
    observer.feed({ isIntersecting: true, boundingClientRect: { top: 100 }, rootBounds: { top: 0 } })
    expect(screen.getByTestId('readout').textContent).toBe('not-past')
  })

  it('rootBounds 缺席(某些宿主给 null)按 0 算,方向判据照旧成立', () => {
    expect(isScrolledPast({ isIntersecting: false, boundingClientRect: { top: -1 }, rootBounds: null })).toBe(true)
    expect(isScrolledPast({ isIntersecting: false, boundingClientRect: { top: 1 }, rootBounds: null })).toBe(false)
  })
})

describe('判例②:root 是真正在滚的那一层', () => {
  it('root 取自 overflow 祖先,不是缺省的视口(null)', () => {
    const observer = stubObserver()
    render(<Host />)
    expect(observer.root).toBe(screen.getByTestId('scroller'))
  })

  it('反证:一个会滚的祖先都没有时才交回 null(= 在滚的是视口本身)', () => {
    const observer = stubObserver()
    render(<Host scrolls={false} />)
    expect(observer.root).toBeNull()
  })

  it('scrollParentOf 认计算样式不认类名:scroll 与 auto 都算,visible 不算', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    const leaf = document.createElement('div')
    outer.style.overflowY = 'scroll'
    inner.className = 'scroller looks-like-one'
    outer.append(inner)
    inner.append(leaf)
    document.body.append(outer)
    // 类名叫 scroller 的那一层不会滚,所以答案是**再往上**那一层。
    expect(scrollParentOf(leaf)).toBe(outer)
    outer.remove()
  })
})

describe('三类状态', () => {
  it('生命状态:没量到之前恒 false;卸载时 disconnect', () => {
    const observer = stubObserver()
    const { unmount } = render(<Host />)
    expect(screen.getByTestId('readout').textContent).toBe('not-past')
    unmount()
    expect(observer.disconnects).toBe(1)
  })

  it('生命状态:宿主没有 IntersectionObserver 时不抛,读数停在 false', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    expect(() => render(<Host />)).not.toThrow()
    expect(screen.getByTestId('readout').textContent).toBe('not-past')
  })

  it('换宿主(resetKey 变)读数当场归零 —— 上一份滚到哪儿了跟这一份没关系', () => {
    const observer = stubObserver()
    const { rerender } = render(<Host resetKey="a" />)
    observer.feed(observer.scrollPast())
    expect(screen.getByTestId('readout').textContent).toBe('past')

    rerender(<Host resetKey="b" />)
    expect(screen.getByTestId('readout').textContent).toBe('not-past')
  })

  it('反证:resetKey 没变就不归零 —— 归零是换宿主的事,不是每次重渲的事', () => {
    const observer = stubObserver()
    const { rerender } = render(<Host resetKey="a" />)
    observer.feed(observer.scrollPast())
    rerender(<Host resetKey="a" />)
    expect(screen.getByTestId('readout').textContent).toBe('past')
  })
})
