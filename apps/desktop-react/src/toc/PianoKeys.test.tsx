import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PianoKeys } from './PianoKeys'
import { TocPanel } from './TocPanel'
import { useTocStore } from './store'
import { initialTocState, tocKeys } from './transitions'
import { CHAT_CHAPTERS, CHAT_TURNS } from '../data/chat-mock'

/**
 * 几何不变式的**结构闸**。
 *
 * CSS 里那套「右对齐 + 定高行 + 绝对定位背景板」保证了坐标不变,但 CSS 在 jsdom 里
 * 量不出来。能在这里机械验证的是它的前提:**两个状态渲染的是同一套行结构** ——
 * 行数、行序、每行的 DOM 形状逐条相同,展开态多出来的东西全是「原地改样式」而不是
 * 「多渲染一批节点」。这一条一旦破了(比如有人把文本列写成条件渲染),坐标必然会动。
 */
const keys = tocKeys(CHAT_CHAPTERS, CHAT_TURNS.length)

function rowSignature(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="toc-key-"]')).map(
    (el) => el.getAttribute('data-testid') ?? '',
  )
}

function renderKeys(open: boolean, onPick = vi.fn()) {
  return render(
    <PianoKeys
      keys={keys}
      chapters={CHAT_CHAPTERS}
      labels={CHAT_TURNS.map((t) => t.user)}
      open={open}
      currentIndex={0}
      hoverIndex={null}
      onHover={vi.fn()}
      onPick={onPick}
    />,
  )
}

describe('键列:两态同一套行结构', () => {
  it('展开与常态的行数、行序逐条相同', () => {
    const closed = renderKeys(false)
    const closedRows = rowSignature()
    closed.unmount()

    renderKeys(true)
    expect(rowSignature()).toEqual(closedRows)
    expect(closedRows.length).toBe(CHAT_TURNS.length)
  })

  it('消息文本与章节标签在常态下也在 DOM 里(只是被样式收起来),不是条件渲染', () => {
    renderKeys(false)
    // 文本在 —— 所以展开时不需要「多插一批节点」,行的几何不会被重排
    expect(screen.getByText(CHAT_TURNS[0].user)).toBeTruthy()
    for (const chapter of CHAT_CHAPTERS) {
      expect(screen.getByText(chapter.title)).toBeTruthy()
    }
  })

  it('每章恰有一个章节标签位(每章前面都摆一个隙,含第一章)', () => {
    renderKeys(true)
    for (const chapter of CHAT_CHAPTERS) {
      expect(screen.getAllByText(chapter.title).length).toBe(1)
    }
  })

  it('当前键带 data-current,且全列只有一枚', () => {
    renderKeys(true)
    const marked = document.querySelectorAll('[data-current="true"]')
    expect(marked.length).toBe(1)
    expect(marked[0].getAttribute('data-testid')).toBe('toc-key-0')
  })

  it('点某一行 = 用那一行的 index 调 onPick(常态下点键也一样)', () => {
    const onPick = vi.fn()
    const closed = renderKeys(false, onPick)
    fireEvent.click(screen.getByTestId('toc-key-5'))
    expect(onPick).toHaveBeenCalledWith(5)
    closed.unmount()

    const onPickOpen = vi.fn()
    renderKeys(true, onPickOpen)
    fireEvent.click(screen.getByTestId('toc-key-8'))
    expect(onPickOpen).toHaveBeenCalledWith(8)
  })
})

/** 定时器要在 act 里推,否则 setTimeout 里的 setState 落不到这一帧的 DOM 上。 */
function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('目录面板:展开、收起、落点', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useTocStore.setState({ ...initialTocState })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('悬停要停够 150ms 才长出来 —— 路过不算意图', () => {
    render(<TocPanel currentIndex={0} onPick={vi.fn()} />)
    const rail = screen.getByTestId('toc-rail')

    fireEvent.mouseEnter(rail)
    tick(100)
    expect(useTocStore.getState().open).toBe(false)

    tick(60)
    expect(useTocStore.getState().open).toBe(true)
    expect(rail.getAttribute('data-open')).toBe('true')
  })

  it('停不够就移出去 = 不展开(定时器被掐掉,不是展开后再收)', () => {
    render(<TocPanel currentIndex={0} onPick={vi.fn()} />)
    const rail = screen.getByTestId('toc-rail')

    fireEvent.mouseEnter(rail)
    tick(100)
    fireEvent.mouseLeave(rail)
    tick(500)
    expect(useTocStore.getState().open).toBe(false)
  })

  it('移出 panel 即收', () => {
    render(<TocPanel currentIndex={0} onPick={vi.fn()} />)
    const rail = screen.getByTestId('toc-rail')
    fireEvent.mouseEnter(rail)
    tick(200)
    expect(useTocStore.getState().open).toBe(true)

    fireEvent.mouseLeave(rail)
    expect(useTocStore.getState().open).toBe(false)
  })

  it('⌘⇧O 开合(目录收着的时候也叫得起来)', () => {
    render(<TocPanel currentIndex={0} onPick={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    expect(useTocStore.getState().open).toBe(true)
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    expect(useTocStore.getState().open).toBe(false)
  })

  it('没按 Shift 的 ⌘O 不归它管(别抢别人的键)', () => {
    render(<TocPanel currentIndex={0} onPick={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    expect(useTocStore.getState().open).toBe(false)
  })

  it('点一行 = 抛出那条消息的 index 并把 panel 收起来', () => {
    const onPick = vi.fn()
    render(<TocPanel currentIndex={0} onPick={onPick} />)
    const rail = screen.getByTestId('toc-rail')
    fireEvent.mouseEnter(rail)
    tick(200)
    expect(useTocStore.getState().open).toBe(true)

    fireEvent.click(screen.getByTestId('toc-key-4'))
    expect(onPick).toHaveBeenCalledWith(4)
    expect(useTocStore.getState().open).toBe(false)
  })

  it('悬停某一行会记进状态(明暗斑与键变深都读它)', () => {
    render(<TocPanel currentIndex={0} onPick={vi.fn()} />)
    fireEvent.mouseEnter(screen.getByTestId('toc-key-2'))
    expect(useTocStore.getState().hoverIndex).toBe(2)
  })
})
