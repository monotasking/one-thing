import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import {
  markFirstScreenLanded,
  markFirstScreenPending,
  resetFirstScreen,
} from '../data/first-screen'

/**
 * 目录 rail 的**取数时机**(工单 6 ①)。
 *
 * `sessions.getUserMarkers` 要把整份账本折一遍才数得出锚点(真店夹具上单独量
 * 798ms,交出去只有 30KB)。core 是单线程的,所以它出门的**次序**就是首屏那一页
 * 的等待时间。工单 5 已经把它排进了空闲,而空闲只管得住「什么时候发」——
 * 页那一发在飞的时候主线程正好是空的,空闲回调准时开火,两发一起挤进 core 的
 * 队列。所以这里判的是**两件事都在**:先让路(等页落地),再排空闲。
 */
const ensureChapters = vi.fn()
const ensureMarkers = vi.fn()

vi.mock('../data/sessions-source', () => ({
  useSessionChapters: () => ({ data: undefined }),
  useSessionMarkers: () => ({ data: undefined }),
  useSessionsSource: (select: (state: unknown) => unknown) =>
    select({ ensureChapters, ensureMarkers }),
}))

const { TocPanel } = await import('./TocPanel')

/** 让路那一拍 + 空闲那一拍 —— 两条都是微任务 / 宏任务级,跑干净再断言。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  ensureChapters.mockClear()
  ensureMarkers.mockClear()
  resetFirstScreen()
})

afterEach(() => {
  resetFirstScreen()
})

describe('TocPanel 取数时机', () => {
  it('页在飞的时候一发不发;页落地之后才去取', async () => {
    markFirstScreenPending('s1')
    render(<TocPanel sessionId="s1" currentIndex={0} onPick={() => undefined} />)
    await settle()
    expect(ensureChapters).not.toHaveBeenCalled()
    expect(ensureMarkers).not.toHaveBeenCalled()

    markFirstScreenLanded('s1')
    await settle()
    expect(ensureChapters).toHaveBeenCalledWith('s1')
    expect(ensureMarkers).toHaveBeenCalledWith('s1')
  })

  it('还没等到就卸载了:一发都不补(切走的那条会话不该再花 core 的钱)', async () => {
    markFirstScreenPending('s1')
    const view = render(<TocPanel sessionId="s1" currentIndex={0} onPick={() => undefined} />)
    await settle()
    view.unmount()
    markFirstScreenLanded('s1')
    await settle()
    expect(ensureChapters).not.toHaveBeenCalled()
    expect(ensureMarkers).not.toHaveBeenCalled()
  })
})
