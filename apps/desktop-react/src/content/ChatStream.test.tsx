import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatStream } from './ChatStream'
import { configureChatPort, type ChatPort } from '../data/chat-port'
import { useChatSource } from '../data/chat-source'
import { useExposeStore } from '../expose/store'
import { useStageStore } from '../stage/store'

/**
 * 组件层只钉「屏幕上到底出现了什么」—— 折叠与尾巴的判据在 data/ 那两只测试里。
 * 素材一律经**真的数据源**进来(端口换成假的),所以这一层顺带证明了
 * 「屏幕上画的就是折叠器的输出」这句话在组件这一端也成立。
 */

const T0 = 1_700_000_000_000
const SESSION = 's1'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const created = (seq: number): Ledger => ({ seq, time: T0, type: 'session/created', data: { sessionId: SESSION } })
const userMessage = (seq: number, id: string, content: string): Ledger => ({
  seq,
  time: T0,
  type: 'user/message',
  data: { message: { id, role: 'user', content, timestamp: T0 } },
})
const runStart = (seq: number, runId: string, assistantMessageId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/start',
  data: { runId, kind: 'chat', assistantMessageId, timestamp: T0 },
})
const chunks = (seq: number, runId: string, messageId: string, text: string[]): Ledger => ({
  seq,
  time: T0,
  type: 'assistant/chunks',
  data: { runId, requestIndex: 0, messageId, partIndex: 0, kind: 'text', time0: T0, dt: text.map((_, i) => i), text },
})
const toolCall = (seq: number, runId: string, messageId: string): Ledger => ({
  seq,
  time: T0,
  type: 'tool/call',
  data: { runId, messageId, callId: 'c1', name: 'read', argumentsRaw: '{}' },
})
const toolResult = (seq: number, runId: string): Ledger => ({
  seq,
  time: T0,
  type: 'tool/result',
  data: { runId, callId: 'c1', isError: false, resultPreview: '读到了', result: { text: '读到了' } },
})

let sendResult: () => Promise<{ success: boolean; error?: string }> = async () => ({ success: true })

function port(ledger: Ledger[]): ChatPort {
  return {
    ready: async () => undefined,
    listRaw: async () => ({ events: [...ledger] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => sendResult(),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
  }
}

async function mount(ledger: Ledger[], sessionId = SESSION) {
  configureChatPort(port(ledger))
  useExposeStore.setState({ currentSessionId: sessionId })
  // 起底是异步的(effect → open → listRaw → 按帧推屏),整段包进 act 里等它落定。
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ChatStream />)
  })
  if (sessionId) await waitFor(() => expect(useChatSource.getState().status).not.toBe('loading'))
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useChatSource.getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
  sendResult = async () => ({ success: true })
})

afterEach(async () => {
  // RTL 的自动 cleanup 注册得比这条早,而 afterEach 是后进先出 —— 所以这一句
  // 跑的时候组件还挂着。归零会推一次 state,包进 act 里才不吵 React。
  await act(async () => {
    useChatSource.getState().reset()
  })
  configureChatPort(undefined)
})

describe('空态:三种各说各话,一种都不回退到假数据', () => {
  it('还没有当前会话', async () => {
    await mount([], '')
    expect(screen.getByText('还没有选中会话')).toBeTruthy()
  })

  it('这条会话还没有消息', async () => {
    await mount([created(1)])
    expect(screen.getByText('这条会话还没有消息')).toBeTruthy()
  })

  it('读不到时把后端说的那句话原样摆出来,不回退到 mock', async () => {
    configureChatPort({
      ...port([]),
      listRaw: async () => {
        throw new Error('listRaw 炸了')
      },
    })
    useExposeStore.setState({ currentSessionId: SESSION })
    render(<ChatStream />)
    await waitFor(() => expect(screen.getByText('读不到这条会话')).toBeTruthy())
    expect(screen.getByText('listRaw 炸了')).toBeTruthy()
  })
})

describe('消息树:画的就是折叠器的输出', () => {
  it('角色分侧,每条都挂 data-message-id(TOC 的落点)', async () => {
    const { container } = await mount([
      created(1),
      userMessage(2, 'm1', '你好'),
      runStart(3, 'r1', 'a1'),
      chunks(4, 'r1', 'a1', ['好的']),
    ])
    const rows = Array.from(container.querySelectorAll('[data-message-id]'))
    expect(rows.map((row) => row.getAttribute('data-message-id'))).toEqual(['m1', 'a1'])
    expect(rows.map((row) => row.getAttribute('data-role'))).toEqual(['user', 'assistant'])
    expect(screen.getByText('你好')).toBeTruthy()
    expect(screen.getByText('好的')).toBeTruthy()
  })

  it('正文按纯文本画,换行照实保留(富渲染是后批)', async () => {
    await mount([created(1), userMessage(2, 'm1', '第一行\n第二行')])
    const bubble = screen.getByText(/第一行/)
    expect(bubble.textContent).toBe('第一行\n第二行')
  })

  it('工具调用折成一行摘要:工具名 + 参数流(右端不写字)', async () => {
    const { container } = await mount([
      created(1),
      userMessage(2, 'm1', '读一下'),
      runStart(3, 'r1', 'a1'),
      toolCall(4, 'r1', 'a1'),
    ])
    const card = container.querySelector('[data-tool-status]')
    expect(card?.getAttribute('data-tool-status')).toBe('input-streaming')
    /*
     * C2-a(§6.2 第一段):**「参数生成中」那句话退役**。右端不写字 —— 摘要位
     * 那截逐字长出来的参数与尾巴上那枚打字光标已经把「还在长」说完了,再补一个
     * 不变的词只会在参数收齐那一帧凭空消失一次(平添一次跳)。
     * 这条素材的参数是空的,所以摘要位也没得说,行上只剩工具名。
     */
    expect(card?.textContent).toBe('read')
  })

  it('结果回来了 = 已完成 —— 状态照折叠说的走,渲染层不自己判', async () => {
    const { container } = await mount([
      created(1),
      userMessage(2, 'm1', '读一下'),
      runStart(3, 'r1', 'a1'),
      toolCall(4, 'r1', 'a1'),
      toolResult(5, 'r1'),
    ])
    const card = container.querySelector('[data-tool-status]')
    expect(card?.getAttribute('data-tool-status')).toBe('completed')
    // V2 定稿(P2):**成功没有打卡词**。「已完成」那一格从此长在图标上(常灰,
    // 见 data-tool-tone),右端只放成果词或耗时。这条素材里参数是空的、结果里没有
    // lineCount,所以成果词无从说起 —— 右端剩下的就是账本上那个耗时(调用与结果
    // 同一毫秒,所以耗时是 0)。空着也不许拿一句「已完成」去填。
    //
    // C2-a:耗时改走 §5.7 的唯一产地 —— 只到 0.1s、永不写毫秒,所以从前那个
    // 「0ms」现在读作「0.0s」(一张卡上不再有 ms 与 s 两种单位换来换去)。
    expect(card?.getAttribute('data-tool-tone')).toBe('ok')
    expect(card?.textContent).toBe('read0.0s')
  })

  it('run 还开着 = 流中态指示在场;收了就没有', async () => {
    await mount([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()

    await act(async () => {
      useChatSource.setState({ activeMessageId: undefined })
    })
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
  })
})

describe('overlay 车道', () => {
  it('发出去的那条立刻上屏(还没落账,所以是 pending)', async () => {
    await mount([created(1)])
    await act(async () => {
      useChatSource.getState().send('刚发的一条')
    })
    expect(screen.getByTestId('chat-pending-sending').textContent).toContain('刚发的一条')
  })

  it('发不出去 = 摆出后端说的理由,给一个重试和一个不发了', async () => {
    sendResult = async () => ({ success: false, error: '引擎没接住' })
    await mount([created(1)])
    await act(async () => {
      useChatSource.getState().send('会失败的一条')
    })
    await waitFor(() => expect(screen.getByTestId('chat-pending-failed')).toBeTruthy())
    expect(screen.getByText('引擎没接住')).toBeTruthy()

    fireEvent.click(screen.getByText('不发了'))
    await waitFor(() => expect(screen.queryByTestId('chat-pending-failed')).toBeNull())
  })

  it('拒绝一组问题:进流,但说得轻一点', async () => {
    await mount([created(1)])
    await act(async () => {
      useChatSource.getState().notice('ask-rejected')
    })
    expect(screen.getByText('(拒绝了这组问题)')).toBeTruthy()
  })
})

/**
 * 08-31 真机回访 · 报障二:**进会话就落在最新那条**。
 *
 * 从前一条都没有:整个应用里没有任何一处写过 scrollTop,真机读数 scrollTop=0、
 * 离底 2686px —— 打开一条会话永远停在第一句话。
 *
 * jsdom 不排版,所以这里把两个几何读数(scrollHeight / clientHeight)按在原型上,
 * 只留 `scrollTop` 走真实赋值 —— 量的是**这段逻辑写了什么**,真机上是不是真的贴底
 * 由 gate 那边量(它有真的排版)。
 */
describe('进场落底', () => {
  const HEIGHT = 1000
  const VIEWPORT = 300
  let restore: (() => void)[] = []

  beforeEach(() => {
    for (const [name, value] of [
      ['scrollHeight', HEIGHT],
      ['clientHeight', VIEWPORT],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value })
      restore.push(() => {
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
      })
    }
  })

  afterEach(() => {
    for (const undo of restore) undo()
    restore = []
  })

  /** 带一个真 ref 挂 ChatStream —— 落底要靠它拿到滚动容器。 */
  async function mountWithRef(ledger: Ledger[]) {
    const ref = { current: null as HTMLDivElement | null }
    configureChatPort(port(ledger))
    useExposeStore.setState({ currentSessionId: SESSION })
    await act(async () => {
      render(<ChatStream scrollRef={ref} />)
    })
    await waitFor(() => expect(useChatSource.getState().status).not.toBe('loading'))
    return ref
  }

  const LEDGER = [
    created(1),
    userMessage(2, 'm1', '你好'),
    runStart(3, 'r1', 'a1'),
    chunks(4, 'r1', 'a1', ['好的']),
  ]

  it('起底之后落在底部 —— 不是停在第一条', async () => {
    const ref = await mountWithRef(LEDGER)
    expect(ref.current!.scrollTop).toBe(HEIGHT)
  })

  it('人往上翻了就交还给他 —— 之后的重渲染不再把他拽回底部', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    // 「往上翻」= 滚动事件读到的位置不在底(判据就是这一条,不靠标志位)。
    el.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(el)
    })
    // 再推一次屏(任何重渲染都行)—— 位置必须原样留着。
    await act(async () => {
      useChatSource.setState({ activeMessageId: undefined })
    })
    expect(el.scrollTop).toBe(0)
  })

  it('账本长出新东西就结束进场 —— 跟底是另一件事,本批不做', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    el.scrollTop = 0
    // 换一份消息树引用 = 账本推进了。此后哪怕人没滚过,也不再自动落底。
    await act(async () => {
      useChatSource.setState({ messages: [...useChatSource.getState().messages] })
    })
    await act(async () => {
      useChatSource.setState({ activeMessageId: undefined })
    })
    expect(el.scrollTop).toBe(0)
  })

  it('空会话不落底(此刻没有底可言,落了会把进场判成已完成)', async () => {
    const ref = await mountWithRef([created(1)])
    expect(ref.current!.scrollTop).toBe(0)
  })
})
