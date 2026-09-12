import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { HeightBook, heightBook, useFlipHeight } from '../flip-height'

/**
 * 高度 FLIP 原语的**自己那份规格**(09-12 立件)。
 *
 * 机制本身(挂载不读几何、RO 报 0 不冲账、没有 RO 的宿主直切、none 档整段不做)
 * 由消费面 `content/tools/__tests__/tool-card.test.tsx` 那一组逐条钉着 —— 它是
 * 这段代码的原产地,判词与病历都在那里,搬家不该把那组用例复制一份。
 *
 * 这里只钉**立件时新长出来的三格**:时长 / 缓动写的是哪个 token、账本能不能指名。
 * 它们是这件原语与两个消费者之间的接口,而接口没人钉就会漂。
 */

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

function report(el: Element, height: number) {
  for (const observer of FakeResizeObserver.live) {
    if (!observer.targets.has(el)) continue
    observer.callback(
      [
        {
          target: el,
          borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
          contentRect: { height } as DOMRectReadOnly,
        } as unknown as ResizeObserverEntry,
      ],
      observer as unknown as ResizeObserver,
    )
  }
}

function Box({
  structure,
  book,
  easeVar,
}: {
  structure: string
  book?: HeightBook
  easeVar?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFlipHeight(ref, structure, { durVar: '--dur-drawer', durMs: 220, easeVar, book })
  return <div ref={ref} data-testid="box" />
}

let previous: typeof globalThis.ResizeObserver

beforeEach(() => {
  previous = globalThis.ResizeObserver
  FakeResizeObserver.live = []
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  // jsdom 不排版,`offsetHeight` 恒 0 —— 这一口是「改后」那个读数的替身。
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.h ?? 0)
    },
  })
  heightBook.reset()
})

afterEach(() => {
  globalThis.ResizeObserver = previous
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
  heightBook.reset()
  document.documentElement.removeAttribute('data-motion-tier')
})

describe('时长与缓动写的是 token,不是数', () => {
  it('内联 transition 引的是调用方给的那两个 var —— 动效档换的就是这一族', () => {
    const view = render(<Box structure="a" />)
    const box = view.getByTestId('box')
    report(box, 40)
    box.dataset.h = '300'
    view.rerender(<Box structure="b" />)
    expect(box.style.transition).toBe('height var(--dur-drawer) var(--ease)')
    expect(box.style.height).toBe('300px')
  })

  it('缓动可以指名(抽屉走 --ease-out,工具卡留 --ease 的缺省)', () => {
    const view = render(<Box structure="a" easeVar="--ease-out" />)
    const box = view.getByTestId('box')
    report(box, 40)
    box.dataset.h = '300'
    view.rerender(<Box structure="b" easeVar="--ease-out" />)
    expect(box.style.transition).toBe('height var(--dur-drawer) var(--ease-out)')
  })
})

describe('账本:不指名就用共享那一本,指名就各记各的', () => {
  it('缺省落在 `heightBook` 上', () => {
    const view = render(<Box structure="a" />)
    report(view.getByTestId('box'), 40)
    expect(heightBook.size).toBe(1)
    view.unmount()
    // 卸载即销账 —— 漏销一格就是攥着一个已经不在树上的 DOM 节点。
    expect(heightBook.size).toBe(0)
  })

  it('指名一本就不碰共享那一本(两族的 `size` 各说各的)', () => {
    const own = new HeightBook()
    const view = render(<Box structure="a" book={own} />)
    report(view.getByTestId('box'), 40)
    expect(own.size).toBe(1)
    expect(heightBook.size).toBe(0)
    view.unmount()
    expect(own.size).toBe(0)
  })
})
