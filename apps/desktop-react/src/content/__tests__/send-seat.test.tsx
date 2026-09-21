import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { ChatStream } from '../ChatStream'
import { configureChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'

/**
 * **座位**在组件这一端的那几句话(正本 `docs/send-flow-2026-09.md` §3、§5 表 1)。
 *
 * 算多高由纯函数答(`__tests__/seat.test.ts`),**滑到置顶线之后屏幕上没动过**
 * 由真机门答(`gate:send-flow` ①②)—— jsdom 不排版,量位移在这里只会量出 0 并
 * 说谎。这一层只钉**结构与寿命**:垫块在不在、它是不是一条消息、换会话还在不在、
 * 以及「人往上翻着发送时一像素不动」那条既有裁定没有被座位破掉。
 */

const T0 = 1_700_000_000_000
const SESSION = 'seat'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const LEDGER: Ledger[] = [
  { seq: 1, time: T0, type: 'session/created', data: { sessionId: SESSION } },
  {
    seq: 2,
    time: T0,
    type: 'user/message',
    data: { message: { id: 'm1', role: 'user', content: '你好', timestamp: T0 } },
  },
  {
    seq: 3,
    time: T0,
    type: 'run/start',
    data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 },
  },
  {
    seq: 4,
    time: T0,
    type: 'assistant/chunks',
    data: {
      runId: 'r1',
      requestIndex: 0,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: T0,
      dt: [0],
      text: ['好的'],
    },
  },
]

function port(ledger: Ledger[]) {
  return {
    ready: async () => undefined,
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...ledger] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  }
}

const source = (id = SESSION) => chatSources.ensure(id)

async function mount(sessionId = SESSION) {
  const ref = { current: null as HTMLDivElement | null }
  configureChatPort(port(LEDGER))
  useExposeStore.setState({ currentSessionId: sessionId })
  const view = await act(async () =>
    render(<ChatStream sessionId={sessionId} scrollRef={ref} />),
  )
  await waitFor(() => expect(source(sessionId).getState().status).not.toBe('loading'))
  return { ref, view }
}

const seatOf = (container: HTMLElement) => container.querySelector('[data-seat]')

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  source().getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
})

afterEach(async () => {
  await act(async () => {
    source().getState().reset()
  })
  configureChatPort(undefined)
})

describe('座位的寿命', () => {
  it('进场没有座位 —— 它是「刚发送的这一轮」的产物,不落盘', async () => {
    const { view } = await mount()
    expect(seatOf(view.container)).toBeNull()
  })

  it('发送那一拍建出来,而且它**不是一条消息**', async () => {
    const { view } = await mount()
    await act(async () => {
      source().getState().send('再问一句')
    })
    const seat = seatOf(view.container)
    expect(seat).toBeTruthy()
    // 不带 data-message-id:挂上去 TOC 的钢琴键就会落到一块空白上。
    expect(seat!.hasAttribute('data-message-id')).toBe(false)
    expect(seat!.getAttribute('aria-hidden')).toBe('true')
    /*
     * 它排在所有内容**之后** —— 内容长进的是它上面。
     * **2026-09-20 G 线 P1 起它不再是列的最后一格**:尾槽那一格排在它后面,
     * 判词在正本 `docs/stream-geometry-2026-09.md` §3.1。所以这一条从
     * 「后面没有了」改成「后面恰好只有那一格」—— 说的仍然是同一件事:
     * 座位是内容的**末位**。
     * **P1h 改了那一格的名字**(§12):画出来的那一份搬去了滚动口上那一层,
     * 列里剩下的是一格什么都不画的空位 `data-tail-spacer`。这一条判的是
     * **列的次序**,所以它问的是空位那个名字。
     */
    expect(seat!.nextElementSibling?.hasAttribute('data-tail-spacer')).toBe(true)
    expect(seat!.nextElementSibling?.nextElementSibling).toBeNull()
    // jsdom 不排版(clientHeight 恒 0)→ 座位算出来是 0:那正是「量不到就不留座位」。
    expect((seat as HTMLElement).style.height === '' || (seat as HTMLElement).style.height === '0px').toBe(true)
  })

  it('下一次发送由同一个节点原位接管(上面的旧内容一像素不动)', async () => {
    const { view } = await mount()
    await act(async () => {
      source().getState().send('第一句')
    })
    const first = seatOf(view.container)
    await act(async () => {
      source().getState().send('第二句')
    })
    expect(seatOf(view.container)).toBe(first)
  })

  it('换会话 = 没有座位(基准按会话记,不带上一条会话的账)', async () => {
    const { view } = await mount()
    await act(async () => {
      source().getState().send('再问一句')
    })
    expect(seatOf(view.container)).toBeTruthy()
    await act(async () => {
      view.rerender(<ChatStream sessionId="seat-2" scrollRef={{ current: null }} />)
    })
    await waitFor(() => expect(seatOf(view.container)).toBeNull())
    await act(async () => {
      source('seat-2').getState().reset()
    })
  })
})

describe('人往上翻着发送:一像素不动(规矩 ⑦,既有裁定)', () => {
  it('浏览中发送不建座位、不滑屏', async () => {
    const { ref, view } = await mount()
    const el = ref.current!
    // 「往上翻」= 滚动事件读到的位置不在底(判据只有位置,见 follow.ts 文件头)。
    el.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(el)
    })
    await act(async () => {
      source().getState().send('再问一句')
    })
    expect(el.scrollTop).toBe(0)
    // 座位是「把视口让给这一轮」的意思,而此刻视口不归这一轮。
    const seat = seatOf(view.container) as HTMLElement | null
    expect(seat === null || seat.style.height === '' || seat.style.height === '0px').toBe(true)
  })
})

/**
 * 源文本那一格守卫:**观察器回调只读不写**(09-10 立法,`ui/frame-coalescer.ts`)。
 * 座位的第一个读者是这条列自己的排版,在 RO 的派发循环里改它正是 Chrome 判
 * 「同深度还有没派送的通知」的那一形。把 `readSeat` 里那句 `schedule()` 换成当场
 * `writeSeat()`,这一条当场红。
 */
describe('座位的写点经 FrameCoalescer,不在观察器回调里', () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ChatStream.tsx'),
    'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')

  /*
   * G 线 P2-a:碰垫块 style 的那一句搬进了 `ScrollPort.writePadHeight`
   * (适配层,§13.2.1)——「只有一处」这句判据一个字没松,只是换了扫描对象;
   * 顺带钉住 `ChatStream.tsx` 里**一处都不剩**(不然就成了两个产地)。
   */
  const portSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../viewport/scroll-port.ts'),
    'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')

  it('只有一处碰垫块的 style', () => {
    expect([...portSource.matchAll(/\.style\.height\s*=/g)]).toHaveLength(1)
    expect([...source.matchAll(/\.style\.height\s*=/g)]).toHaveLength(0)
  })

  it('量座位那只函数排的是下一帧,不是当场写', () => {
    expect(source).toMatch(/seatCoalescerRef\.current\?\.schedule\(\)/)
    // `readSeat` 里不许出现 `writeSeat()` —— 那一支是发送那一拍**同步**用的。
    const readSeat = /const readSeat = useCallback\(([\s\S]*?)\n {2}\}, \[/.exec(source)?.[1] ?? ''
    expect(readSeat).not.toBe('')
    expect(readSeat).not.toMatch(/writeSeat\(\)/)
  })
})
