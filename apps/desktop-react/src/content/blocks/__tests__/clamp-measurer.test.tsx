import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { BlockShell } from '../shell/BlockShell'
import shellStyles from '../shell/BlockShell.module.css'
import { clampMeasurer } from '../shell/clamp-measurer'
import type { BlockCtx, BlockDef } from '../registry'
import type { BlockModel } from '../../model/blocks'
import { useStageStore } from '../../../stage/store'

/**
 * 限高折叠的**量尺**(09-03,`probe-hotspots` 的第一热点)。
 *
 * 三条断言对着病历写:
 *  ① 父组件重渲 N 次 **不重新 observe** —— 从前那条 `useLayoutEffect` 的依赖表里
 *     带着 `children`(ReactNode,每渲染一次换引用),于是每一次提交都注销重建一只
 *     RO 并同步读一次 `scrollHeight`(强制排版)。这一条在旧代码上必红。
 *  ② 同一批 N 个块**共用一只**观察者。
 *  ③ 溢出 / 不溢出 / 展开三档的行为与从前逐字相同。
 *
 * jsdom 不排版,所以 RO 与 `scrollHeight/clientHeight` 都得自己摆一份 ——
 * 摆的是**环境**,不是被测对象:判据仍然是「壳读到这两个数之后做了什么」。
 */

interface FakeObserver {
  observed: Element[]
  emit: (targets: Element[]) => void
}

const observers: FakeObserver[] = []
/** 每只盒子的两个高度。没登记的就是 0/0 —— 那正是 jsdom 的原样。 */
const heights = new WeakMap<Element, { scroll: number; client: number }>()

class FakeResizeObserver implements ResizeObserver {
  readonly observed: Element[] = []
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this as unknown as FakeObserver)
  }
  observe(target: Element): void {
    this.observed.push(target)
    // 真 RO 注册之后必派一次初始回调 —— 壳的「初量」全靠它,所以假货也要派。
    this.emit([target])
  }
  unobserve(target: Element): void {
    const at = this.observed.indexOf(target)
    if (at >= 0) this.observed.splice(at, 1)
  }
  disconnect(): void {
    this.observed.length = 0
  }
  emit(targets: Element[]): void {
    act(() => {
      this.callback(
        targets.map((target) => ({ target }) as ResizeObserverEntry),
        this as unknown as ResizeObserver,
      )
    })
  }
}

let originalRO: typeof ResizeObserver | undefined
let scrollDescriptor: PropertyDescriptor | undefined
let clientDescriptor: PropertyDescriptor | undefined

beforeAll(() => {
  originalRO = globalThis.ResizeObserver
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  clientDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return heights.get(this)?.scroll ?? 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return heights.get(this)?.client ?? 0
    },
  })
})

afterAll(() => {
  if (originalRO) globalThis.ResizeObserver = originalRO
  else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollDescriptor)
  if (clientDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientDescriptor)
})

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  clampMeasurer.reset()
  observers.length = 0
})

const ctx: BlockCtx = { messageId: 'a1', streaming: false }

const def: BlockDef = {
  kind: 'code',
  presentation: 'object',
  stream: { midway: 'hold', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: () => <div data-testid="body">画出来了</div>,
  chrome: () => ({ id: 'ts' }),
}

const model = (source = 'const answer = 42'): BlockModel => ({
  kind: 'code',
  lang: 'ts',
  source,
  closed: true,
})

/** 壳画出来的那两层:外层被钳(量它),内层跟着内容长(观察它)。 */
function boxes(container: HTMLElement): { outer: HTMLElement; inner: HTMLElement } {
  const outer = container.getElementsByClassName(shellStyles.body)[0] as HTMLElement
  return { outer, inner: outer.firstElementChild as HTMLElement }
}

describe('限高折叠:量尺搬出 commit', () => {
  it('父组件重渲 10 次,一次都不重新 observe(从前每次提交都注销重建)', () => {
    const { container, rerender } = render(<BlockShell def={def} model={model()} ctx={ctx} />)
    expect(observers).toHaveLength(1)
    const { inner } = boxes(container)
    expect(observers[0].observed).toEqual([inner])

    for (let i = 0; i < 10; i += 1) {
      // 每次都换一份 model:BlockShell 因此真的重渲,`children` 也每次换引用
      // —— 那正是旧依赖表里的那一格。
      rerender(<BlockShell def={def} model={model(`const answer = ${i}`)} ctx={ctx} />)
    }

    expect(observers).toHaveLength(1)
    expect(observers[0].observed).toEqual([inner])
    expect(clampMeasurer.size).toBe(1)
  })

  it('同一批 3 个块共用一只观察者', () => {
    render(
      <>
        <BlockShell def={def} model={model('a')} ctx={ctx} />
        <BlockShell def={def} model={model('b')} ctx={ctx} />
        <BlockShell def={def} model={model('c')} ctx={ctx} />
      </>,
    )
    expect(observers).toHaveLength(1)
    expect(observers[0].observed).toHaveLength(3)
    expect(clampMeasurer.size).toBe(3)
  })

  it('没裁到:不挂遮罩、不出展开钮', () => {
    const { container } = render(<BlockShell def={def} model={model()} ctx={ctx} />)
    const { outer } = boxes(container)
    expect(outer.className).not.toContain(shellStyles.bodyClamped)
    expect(screen.queryByText('展开')).toBeNull()
  })

  it('裁断中:遮罩与展开钮同出一格 overflows', () => {
    const { container } = render(<BlockShell def={def} model={model()} ctx={ctx} />)
    const { outer, inner } = boxes(container)
    heights.set(outer, { scroll: 414, client: 320 })
    observers[0].emit([inner])

    expect(outer.className).toContain(shellStyles.bodyClamped)
    expect(screen.getByText('展开')).toBeTruthy()
  })

  it('展开:撤钳子、换字、并且不再观察(展开态没有「裁没裁到」这个问题)', () => {
    const { container } = render(<BlockShell def={def} model={model()} ctx={ctx} />)
    const { outer, inner } = boxes(container)
    heights.set(outer, { scroll: 414, client: 320 })
    observers[0].emit([inner])

    fireEvent.click(screen.getByText('展开'))

    const after = boxes(container)
    expect(after.outer.className).toContain(shellStyles.bodyExpanded)
    expect(after.outer.className).not.toContain(shellStyles.bodyClamped)
    expect(screen.getByText('收起')).toBeTruthy()
    expect(clampMeasurer.size).toBe(0)
  })

  it('内容后来才长高照旧管得住:第二次回调翻面(图渲完 / 高亮到货那一形)', () => {
    const { container } = render(<BlockShell def={def} model={model()} ctx={ctx} />)
    const { outer, inner } = boxes(container)
    expect(screen.queryByText('展开')).toBeNull()

    heights.set(outer, { scroll: 900, client: 320 })
    observers[0].emit([inner])
    expect(screen.getByText('展开')).toBeTruthy()
  })
})
