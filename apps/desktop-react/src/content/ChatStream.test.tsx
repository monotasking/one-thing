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
const runEnd = (seq: number, runId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/end',
  data: { runId, outcome: 'completed' },
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
    view = render(<ChatStream sessionId={sessionId} />)
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
    render(<ChatStream sessionId={SESSION} />)
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

  it('run 还开着 + 已经有字 = 流中态指示在场;收了就没有', async () => {
    await mount([
      created(1),
      userMessage(2, 'm1', '你好'),
      runStart(3, 'r1', 'a1'),
      chunks(4, 'r1', 'a1', ['好的']),
    ])
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()

    await act(async () => {
      useChatSource.setState({ activeMessageId: undefined })
    })
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
  })

  /**
   * §5.3 拍点 ⑫:**回复槽位开出来到第一个字之间**画三个点。
   * 从前那段是一片空白 —— 与用户报的「不知道它是不是卡住了」同源。
   * 判据是「这条消息此刻画得出什么」(段序列空不空),不是拿 content 猜。
   */
  it('槽位开了、第一个字还没到 = 三个点在场,光标不在', async () => {
    await mount([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    expect(screen.getByLabelText('正在生成')).toBeTruthy()
    // 两件都在场就是两个「还在跑」—— 第一个 delta 到达才换成正文与尾部光标。
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
 * 08-31 真机回访 · 报障二:**进会话就落在最新那条**;09-05 C1 起它并入
 * `content/follow.ts` 的状态机,成了「进场 = pinned」那一格,并且第一次真的**跟底**。
 *
 * 从前一条都没有:整个应用里没有任何一处写过 scrollTop,真机读数 scrollTop=0、
 * 离底 2686px —— 打开一条会话永远停在第一句话。
 *
 * jsdom 不排版,所以这里把两个几何读数(scrollHeight / clientHeight)按在原型上,
 * 只留 `scrollTop` 走真实赋值 —— 量的是**这段逻辑写了什么**,真机上是不是真的贴底
 * 由 gate 那边量(它有真的排版)。
 */
describe('进场落底与流式跟底', () => {
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
      render(<ChatStream sessionId={SESSION} scrollRef={ref} />)
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

  /**
   * C1 §5.1 的换轨点。**这条用例的前身断言的正好相反** —— 它叫
   * 「账本长出新东西就结束进场 —— 跟底是另一件事,本批不做」,守的是
   * `useEnterAtBottom` 那个故意留的出口二。本批做的就是那另一件事,
   * 所以那条断言连同它守的那行代码一起退役了。
   */
  it('贴底时账本长出新东西 = 继续跟底(这正是 08-31 留账里那件「另一件事」)', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    el.scrollTop = 0
    // 换一份消息树引用 = 账本推进了。人没滚过,所以此刻仍是 pinned —— 要跟。
    await act(async () => {
      useChatSource.setState({ messages: [...useChatSource.getState().messages] })
    })
    expect(el.scrollTop).toBe(HEIGHT)
  })

  it('空会话不落底(此刻没有底可言,落了会把进场判成已完成)', async () => {
    const ref = await mountWithRef([created(1)])
    expect(ref.current!.scrollTop).toBe(0)
  })

  it('人自己滚回底 = 回到跟随(不必点丸)', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    el.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(el)
    })
    // 滚回底:gap = 0 ≤ EPS。
    el.scrollTop = HEIGHT - VIEWPORT
    await act(async () => {
      fireEvent.scroll(el)
    })
    await act(async () => {
      useChatSource.setState({ messages: [...useChatSource.getState().messages] })
    })
    expect(el.scrollTop).toBe(HEIGHT)
  })
})

/**
 * 跟随丸(§5.3)。**挂载判据是状态,不是几何** —— 所以这一组不必按 scrollHeight,
 * 只要把状态机推到「浏览中 + 有没看见的东西」那一格。
 * 三张脸的文案与无障碍名由 `content/FollowPill` 自己的 props 决定,这里量的是
 * 「它在不在场」与「点了之后回不回底」这两件跨组件的事。
 */
describe('跟随丸', () => {
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

  async function mountWithRef(ledger: Ledger[]) {
    const ref = { current: null as HTMLDivElement | null }
    configureChatPort(port(ledger))
    useExposeStore.setState({ currentSessionId: SESSION })
    await act(async () => {
      render(<ChatStream sessionId={SESSION} scrollRef={ref} />)
    })
    await waitFor(() => expect(useChatSource.getState().status).not.toBe('loading'))
    return ref
  }

  /*
   * 这一组用**收了场**的账本(有 run/end):三张脸里 `streaming` 排在最前,
   * 所以只要还有一轮在跑,丸画的就是三个点 —— 「已发送」那张脸的前提正是
   * 「自己发了一条,回复还没开始」。
   */
  const LEDGER = [
    created(1),
    userMessage(2, 'm1', '你好'),
    runStart(3, 'r1', 'a1'),
    chunks(4, 'r1', 'a1', ['好的']),
    runEnd(5, 'r1'),
  ]

  /** 上翻一次 —— 之后状态机就在 browsing 上了。 */
  async function scrollUp(el: HTMLDivElement) {
    el.scrollTop = 0
    await act(async () => {
      fireEvent.scroll(el)
    })
  }

  it('贴底时不画 —— 你就在底,没有「没看见」这回事', async () => {
    await mountWithRef(LEDGER)
    expect(screen.queryByTestId('chat-follow-pill')).toBeNull()
  })

  it('浏览中但下面什么都没长 —— 也不画', async () => {
    const ref = await mountWithRef(LEDGER)
    await scrollUp(ref.current!)
    expect(screen.queryByTestId('chat-follow-pill')).toBeNull()
  })

  it('浏览中自己发了一条 = 丸说「已发送」,而且不滚', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    await scrollUp(el)
    await act(async () => {
      useChatSource.getState().send('再问一句')
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 已发送')
    expect(el.scrollTop).toBe(0)
  })

  /**
   * 用户 09-05 定的那条序列:**浏览中发送 → 「已发送」→ 回复开始流 → 三个点 →
   * 流完 → 「回到最新」**。这条用例走的是真链路的三跳,不是直接摆状态机:
   * 发送经数据源的 `send()`,回复到达经 `lastDeltaAt` 变化 + 有活消息(那正是
   * `chat-source` 收到一段 delta 时写出去的两格),收场经 `activeMessageId` 归空。
   *
   * 打回前这条会红在最后一步:`grew` 不覆盖 `sent`(它必须不覆盖 —— 自己发的那条
   * 本身就是一次长高),于是流完之后丸仍写着「已发送」,而此刻明明有一条没看过的
   * 回复。修法不是动 `grew`,是给「回复到达」一个自己的事件。
   */
  it('浏览中:发送 → 已发送 → 回复开始流 → 三个点 → 流完 → 回到最新', async () => {
    const ref = await mountWithRef(LEDGER)
    await scrollUp(ref.current!)
    await act(async () => {
      useChatSource.getState().send('再问一句')
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 已发送')

    // 回复开张 + 第一段 delta 到 —— 数据源同一次 set 写出去的就是这两格。
    await act(async () => {
      useChatSource.setState({ activeMessageId: 'a2', lastDeltaAt: T0 + 1 })
    })
    const streaming = screen.getByTestId('chat-follow-pill')
    // 生成中那张脸一个字都不写(三个点),名字改说「正在生成」。
    expect(streaming.getAttribute('aria-label')).toBe('正在生成,回到最新')
    expect(streaming.textContent).toBe('')

    // 流收场:活消息没了,读数也跟着归空(见 chat-source 的 compose)。
    await act(async () => {
      useChatSource.setState({ activeMessageId: undefined, lastDeltaAt: undefined })
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 回到最新')
  })

  /**
   * 反面那一半:**收场那一次 `lastDeltaAt` 归空不算一次「回复到达」**。
   * 判据里那句 `activeMessageId === undefined` 就是为它写的 —— 少了它,一轮结束
   * 也会派一次 `reply`,「已发送」会因为一件根本没发生的事被解闩。
   */
  it('没有活消息时 lastDeltaAt 变化不算回复到达(「已发送」原样留着)', async () => {
    const ref = await mountWithRef(LEDGER)
    await scrollUp(ref.current!)
    await act(async () => {
      useChatSource.getState().send('再问一句')
    })
    await act(async () => {
      useChatSource.setState({ activeMessageId: undefined, lastDeltaAt: T0 + 9 })
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 已发送')
  })

  it('点丸 = 回到底 + 丸当场卸载(不等滚动动画)', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    await scrollUp(el)
    await act(async () => {
      useChatSource.getState().send('再问一句')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-follow-pill'))
    })
    expect(el.scrollTop).toBe(HEIGHT)
    expect(screen.queryByTestId('chat-follow-pill')).toBeNull()
  })

  /**
   * W5-a 起「换会话」在组件这一端就是**换一个 prop**(掉头的是注册表,不是那台
   * 单例),所以这里 rerender 而不是去推数据源 —— 验的仍然是同一件事:
   * 换一条会话 = 一次进场 = pinned,丸跟着卸载。
   */
  it('换会话 = 进场 = pinned,丸跟着卸载', async () => {
    const ref = { current: null as HTMLDivElement | null }
    configureChatPort(port(LEDGER))
    useExposeStore.setState({ currentSessionId: SESSION })
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<ChatStream sessionId={SESSION} scrollRef={ref} />)
    })
    await waitFor(() => expect(useChatSource.getState().status).not.toBe('loading'))
    await scrollUp(ref.current!)
    await act(async () => {
      useChatSource.getState().send('再问一句')
    })
    expect(screen.queryByTestId('chat-follow-pill')).toBeTruthy()
    await act(async () => {
      view.rerender(<ChatStream sessionId="" scrollRef={ref} />)
    })
    expect(screen.queryByTestId('chat-follow-pill')).toBeNull()
  })
})
