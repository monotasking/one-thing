import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatStream } from './ChatStream'
import { EXIT_MS, SCROLL_ANCHOR_SETTLE_MS } from '../components/motion'
import { configureChatPort, type ChatPort } from '../data/chat-port'
import { chatSources } from '../data/chat-source'
import {
  readSessionScrollAnchor,
  resetSessionViewStates,
  saveSessionScrollAnchor,
  type ScrollAnchor,
} from '../data/session-view-state'
import { CHAT_TAIL_WINDOW, CHAT_WINDOW_STEP, resetChatWindows } from './chat-window'
import { PanelVisibilityContext } from './visibility'

import { useExposeStore } from '../expose/store'
import { useStageStore } from '../stage/store'

/**
 * 组件层只钉「屏幕上到底出现了什么」—— 折叠与尾巴的判据在 data/ 那两只测试里。
 * 素材一律经**真的数据源**进来(端口换成假的),所以这一层顺带证明了
 * 「屏幕上画的就是折叠器的输出」这句话在组件这一端也成立。
 */

const T0 = 1_700_000_000_000
const SESSION = 's1'

/* ── 可控的假 ResizeObserver(2026-09-10)──────────────────────────────────
 *
 * jsdom 没有 ResizeObserver,而**跟底从这一批起只有一个产地就是它**
 * (那只「每一次提交都贴底」的无依赖 layout effect 已经退役,病历在
 * `ChatStream.tsx`)。所以要验「流式跟底」就必须把这只观察者摆出来 ——
 * 从前那几条用例靠的是「推一次屏 = 贴一次底」,而那句话现在是假的,
 * 它正是这一批要拆掉的东西。
 *
 * 假货只做一件事:把回调收起来,让用例自己决定「内容长高了」发生在哪一拍。
 */
let roCallbacks: ResizeObserverCallback[] = []

class FakeResizeObserver implements ResizeObserver {
  readonly #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.#cb = cb
    roCallbacks.push(cb)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    roCallbacks = roCallbacks.filter((cb) => cb !== this.#cb)
  }
}

/** 装上假货,返回卸载口(缺席时装回缺席,不留一个假的给别的用例)。 */
function installFakeResizeObserver(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  })
  return () => {
    roCallbacks = []
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original)
    else Reflect.deleteProperty(globalThis as object, 'ResizeObserver')
  }
}

/** 「内容列长高到 height」—— 真机上这一下由浏览器派,这里由用例派。 */
async function fireContentGrew(el: HTMLDivElement, height: number) {
  const column = el.firstElementChild
  if (!column) throw new Error('滚动容器里没有内容列')
  const entry = { target: column, contentRect: { height } } as unknown as ResizeObserverEntry
  await act(async () => {
    for (const cb of [...roCallbacks]) cb([entry], {} as ResizeObserver)
  })
}

/** 数这只容器被写了几次 `scrollTop` —— 「提交次数 ≠ 贴底次数」那条反证的秤。 */
function countScrollWrites(el: HTMLElement): { count: () => number; restore: () => void } {
  let value = el.scrollTop
  let writes = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      writes += 1
      value = next
    },
  })
  return { count: () => writes, restore: () => void Reflect.deleteProperty(el, 'scrollTop') }
}

/**
 * **这条会话那台机器**(W5-b)。从前这里写的是 `useChatSource`(= 注册表
 * `current` 槽指着的那一台)—— 那一格现在由**焦点叶投影**宣布
 * (`content/session-projection.ts`),而这只文件只渲染一片 `ChatStream`、
 * 不接那条订阅。所以用例直接点名它要摆弄的那一条:与产品里
 * `useChatSourceOf(sessionId, …)` 读的是同一台。
 */
const sessionSource = () => chatSources.ensure(SESSION)

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
/**
 * 收场那三条(2026-09-09):配方带定稿后的 maxTokens、响应带用量(**只有它带
 * reasoningTokens**)、`request/end` 带归一后的 stopReason。三条一起才 join 得出
 * 「这一轮为什么提前结束」。
 */
const recipe = (seq: number, runId: string, maxTokens: number): Ledger => ({
  seq,
  time: T0,
  type: 'request/recipe',
  data: { runId, requestIndex: 1, systemPromptHash: 'h', toolsHash: 't', messages: [], params: { maxTokens } },
})
const response = (
  seq: number,
  runId: string,
  messageId: string,
  usage: { outputTokens: number; reasoningTokens?: number },
): Ledger => ({
  seq,
  time: T0,
  type: 'request/response',
  data: { runId, requestIndex: 1, messageId, usage: { inputTokens: 10, ...usage } },
})
const requestEnd = (seq: number, runId: string, stopReason: string): Ledger => ({
  seq,
  time: T0,
  type: 'request/end',
  data: { runId, requestIndex: 1, stopReason },
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
    /*
     * 页那条路在这只假端口上**说不**(工单 5 ③)—— 于是这一台退回整份账本,
     * 也就是这些用例本来就在测的那条路。假端口给一份空页会把树画成空的,
     * 那是造事实;说不才是它此刻的真话。
     */
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...ledger] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => sendResult(),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
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
  if (sessionId) await waitFor(() => expect(sessionSource().getState().status).not.toBe('loading'))
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  sessionSource().getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
  sendResult = async () => ({ success: true })
})

afterEach(async () => {
  // RTL 的自动 cleanup 注册得比这条早,而 afterEach 是后进先出 —— 所以这一句
  // 跑的时候组件还挂着。归零会推一次 state,包进 act 里才不吵 React。
  await act(async () => {
    sessionSource().getState().reset()
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
      /*
       * 页那条路在这只假端口上**说不**(工单 5 ③)—— 于是这一台退回整份账本,
       * 也就是这些用例本来就在测的那条路。假端口给一份空页会把树画成空的,
       * 那是造事实;说不才是它此刻的真话。
       */
      readPage: () => Promise.reject(new Error('no page in this fake port')),
      readToolResult: () => Promise.resolve(undefined),
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

  /**
   * **2026-09-20 G 线 P1 改判、09-21 P1b 再改一次**:那枚光标从前是**条件渲染**在
   * 消息行里的一个 span,收尾那一帧卸掉它就带走一个行盒(§0 的病 ③,真机整屏下移
   * 23.8px)。P1 把它搬进列尾那一格尾槽、与等待那道线同格同高;P1b(裁定 B)把等待
   * 那张脸整件删了,于是「亮没亮」这个判据又退回最朴素的一句:**在跑时它在,
   * 收场播完就不在**。收场那一段(`--dur-exit`)里它还在屏上淡出,所以这里等它播完。
   */
  it('run 还开着 = 那枚光标在;收了、淡出播完就没有', async () => {
    await mount([
      created(1),
      userMessage(2, 'm1', '你好'),
      runStart(3, 'r1', 'a1'),
      chunks(4, 'r1', 'a1', ['好的']),
    ])
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('run')

    await act(async () => {
      sessionSource().setState({ activeMessageId: undefined })
    })
    // 收场那一刻:还在屏上,已经在淡出(裁定 C)。
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('leaving')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXIT_MS + 30))
    })
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('idle')
  })

  /**
   * §5.3 拍点 ⑫:**回复槽位开出来到第一个字之间**从前是一片空白 —— 与用户报的
   * 「不知道它是不是卡住了」同源;09-15 之前它是三颗点(`ui/Dots`),正本
   * `docs/send-flow-2026-09.md` §2 ③ 换成一道在扫的折痕,G 线 P1 把那道折痕搬进
   * 列尾的尾槽。
   *
   * **2026-09-21 P1b 裁定 B 把「等待」这个形态整件取消了**:用户原话「保留的尾部的
   * generate 不需要是一个横线,和之前的样式一致即可,且在流式过程中,生成中的这块
   * 样式布局应保持不变」。所以这一条从「等待那张脸亮着」改成钉它的反面:
   * **第一个字前后,尾槽那一格逐字相同**。
   */
  it('槽位开了、第一个字还没到 = 尾槽已经在跑(与出字后逐字相同)', async () => {
    await mount([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    const slot = screen.getByTestId('chat-tail-slot')
    expect(slot.getAttribute('data-face')).toBe('run')
    // 无障碍名照旧有人担(退役的三颗点、以及后来那道折痕,label 一路搬到光标上)。
    expect(screen.getAllByLabelText('正在生成')).toContain(screen.getByTestId('chat-streaming'))
    // 那道在扫的线连同 `WaitingSeam` 一起退役了 —— 屏上没有第二处在等的动画。
    expect(screen.queryByTestId('waiting-seam')).toBeNull()
    expect(document.querySelectorAll('[data-state="running"]')).toHaveLength(0)
  })

  /**
   * **首字到达在这一格里什么都不发生**(裁定 B):它只知道「在跑」。
   * 所以这一下**几何上什么都不发生**(正本 `docs/stream-geometry-2026-09.md` §1 的 G4),
   * 而且比 P1 那版更硬 —— P1 是「两张脸换 opacity」,今天是**压根没有第二张脸**。
   * 中间那一帧几何动没动由真机门 `gate:stream-geometry` 量(首字帧尾槽位移 ≤1px)。
   */
  it('第一个字到了:尾槽那一格逐字不变', async () => {
    const before = await mount([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    const waiting = screen.getByTestId('chat-tail-slot').outerHTML
    before.unmount()
    await mount([
      created(1),
      userMessage(2, 'm1', '你好'),
      runStart(3, 'r1', 'a1'),
      chunks(4, 'r1', 'a1', ['好的']),
    ])
    // 首字前后**同一段 HTML** —— 读数那一行此刻都还没有(这两帧里 `startedAt`
    // 相同、耗时都是 0.0s),所以这一比是逐字的,不是「结构差不多」。
    expect(screen.getByTestId('chat-tail-slot').outerHTML).toBe(waiting)
  })
})

describe('overlay 车道', () => {
  it.each(['inline', 'blob'] as const)('历史图片实际渲染,包括 %s 数据来源', async (source) => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII='
    configureChatPort({
      ...port([]),
      readBlob: async (_session, hash) => {
        expect(_session).toBe(SESSION)
        expect(hash).toBe('image-blob')
        return { base64 }
      },
      readPage: async () => ({
        messages: [{
          id: 'image-message', role: 'user', content: '', timestamp: T0,
          attachments: [{
            id: 'image-1', fileName: '历史图片.png', mimeType: 'image/png',
            base64Data: source === 'inline' ? base64 : { hash: 'image-blob', bytes: 68, mime: 'image/png' },
          }],
        }],
        watermark: 2, hasMoreBefore: false,
      }),
    })
    render(<ChatStream sessionId={SESSION} />)
    const image = await screen.findByRole('img', { name: '历史图片.png' })
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${base64}`)
    // 比稿 A(09-16):图站在气泡外,图下不再挂文件名 chip;只有图 = 不画气泡。
    const message = image.closest('article[data-role="user"]')
    expect(message?.querySelector('[data-ref-kind="attachmentRef"]')).toBeNull()
    expect(message?.textContent).not.toContain('历史图片.png')
  })

  it('只发附件时文件名立即可见,落账后仍在同一条用户消息中', async () => {
    const { container } = await mount([created(1)])
    const files = [new File(['body'], '报告.txt'), new File(['pixels'], '截图.png')]
    await act(async () => {
      sessionSource().getState().send('', files.length, [], files)
    })
    const pending = container.querySelector('article[data-role="user"]')
    expect(pending?.textContent).toContain('报告.txt')
    expect(pending?.textContent).toContain('截图.png')
    const entry = sessionSource().getState().overlay[0]
    const messageId = entry.kind === 'pending' ? entry.messageId : undefined

    await act(async () => {
      sessionSource().setState({
        messages: [{
          id: messageId!, role: 'user', content: '', timestamp: T0,
          attachments: files.map((file, index) => ({
            id: `${index}`, fileName: file.name, filePath: `/stored/${file.name}`,
          })),
        }],
        overlay: [],
      })
    })
    const landed = container.querySelector('article[data-role="user"]')
    expect(landed).toBe(pending)
    expect(landed?.textContent).toContain('报告.txt')
    expect(landed?.getAttribute('data-pending')).toBeNull()
    // 文件是气泡里的 chip,图是气泡外的一张图(落盘路径有了,图就画得出来)。
    expect(landed?.querySelectorAll('[data-ref-kind="attachmentRef"]')).toHaveLength(1)
    expect(landed?.querySelector('img[alt="截图.png"]')).toBeTruthy()
  })

  it('附件发送失败后文件名与重试入口都保留', async () => {
    sendResult = async () => ({ success: false, error: '暂时无法发送' })
    await mount([created(1)])
    await act(async () => {
      sessionSource().getState().send('', 1, [], [new File(['body'], '重试.txt')])
    })
    const failed = await screen.findByTestId('chat-pending-failed')
    expect(failed.textContent).toContain('重试.txt')
    expect(failed.textContent).toContain('暂时无法发送')
    expect(screen.getByText('重试')).toBeTruthy()
  })

  it('重新打开的尾页即使只保留附件字节引用,空正文消息仍显示文件名', async () => {
    configureChatPort({
      ...port([]),
      readPage: async () => ({
        messages: [{
          id: 'attachment-only', role: 'user', content: '', timestamp: T0,
          attachments: [{
            id: 'file-1', fileName: '历史.pdf', mimeType: 'application/pdf',
            base64Data: { hash: 'saved-blob', bytes: 100, mime: 'text/plain' },
          }],
        }],
        watermark: 2,
        hasMoreBefore: false,
      }),
    })
    const { container } = render(<ChatStream sessionId={SESSION} />)
    await waitFor(() => expect(screen.getByText('历史.pdf')).toBeTruthy())
    const message = container.querySelector('[data-message-id="attachment-only"]')
    expect(message?.getAttribute('data-role')).toBe('user')
    expect(message?.querySelector('[data-ref-kind="attachmentRef"]')).toBeTruthy()
  })

  it('账本中的附件和用户正文一起显示,不把文件正文展开进气泡', async () => {
    const { container } = await mount([
      created(1),
      { seq: 2, time: T0, type: 'user/message', data: { message: {
        id: 'with-file', role: 'user', content: '帮我看看', timestamp: T0,
        contentParts: [{ type: 'text', content: '帮我看看' }],
        attachments: [{ id: 'file-1', fileName: 'notes.md', base64Data: 'secret-file-bytes' }],
      } } },
    ])
    const message = container.querySelector('[data-message-id="with-file"]')
    expect(message?.textContent).toContain('帮我看看')
    expect(message?.textContent).toContain('notes.md')
    expect(message?.textContent).not.toContain('secret-file-bytes')
  })

  it('发出去的那条立刻上屏(还没落账,所以是 pending)', async () => {
    await mount([created(1)])
    await act(async () => {
      sessionSource().getState().send('刚发的一条')
    })
    expect(screen.getByTestId('chat-pending-sending').textContent).toContain('刚发的一条')
  })

  it('发不出去 = 摆出后端说的理由,给一个重试和一个不发了', async () => {
    sendResult = async () => ({ success: false, error: '引擎没接住' })
    await mount([created(1)])
    await act(async () => {
      sessionSource().getState().send('会失败的一条')
    })
    await waitFor(() => expect(screen.getByTestId('chat-pending-failed')).toBeTruthy())
    expect(screen.getByText('引擎没接住')).toBeTruthy()

    fireEvent.click(screen.getByText('不发了'))
    await waitFor(() => expect(screen.queryByTestId('chat-pending-failed')).toBeNull())
  })

  /*
   * ── 所见即所发(09-14,正本 §6.2)────────────────────────────────────────
   * 两条,各钉一半:在飞那一格**画的是段**,以及落账那一拍**不换节点**。
   */
  it('在飞那一格画的是**段**,不是 `entry.text` 那一串', async () => {
    const { container } = await mount([created(1)])
    await act(async () => {
      sessionSource().getState().send('看看 @/repo/src/a.ts', 0, [
        { kindId: null, value: { kind: 'text', text: '看看 ' } },
        { kindId: 'file', value: { kind: 'fileRef', path: '/repo/src/a.ts' } },
      ])
    })
    const bubble = container.querySelector('article[data-role="user"]')
    // 屏上是一枚 chip(basename),不是那一整串绝对路径 —— 而**发出去的**仍是它。
    expect(bubble?.textContent).toBe('看看 a.ts')
    expect(bubble?.querySelector('[data-ref-kind="fileRef"]')).toBeTruthy()
    /*
     * **反证**:把 `UserBubble` 里那句 `<UserMessageBody …/>` 换回画
     * `{entry.text}` 纯文本(= 09-14 之前 `OverlayRow` 的原样)→ 这一条当场读到
     * `看看 @/repo/src/a.ts`,也就是用户看见的「chip → 整串路径 → 另一种 chip」
     * 里中间那一形。(**只摘 `segments` 一格不够**:那一支会回落到
     * `segmentReferenceText(entry.text)`,而 `@<绝对路径>` 正好认得回来 ——
     * 回落本身是设计,见 `UserMessageBody` 的三来源判据链。)
     */
    expect(bubble?.textContent).not.toContain('/repo/src/a.ts')
  })

  it('落账不换节点:同一个 DOM 节点从 pending 翻成 landed', async () => {
    const { container } = await mount([created(1)])
    await act(async () => void sessionSource().getState().send('所见即所发'))
    const pending = container.querySelector('article[data-role="user"]')
    expect(pending?.getAttribute('data-pending')).toBe('pending')
    const entry = sessionSource().getState().overlay[0]
    const messageId = entry.kind === 'pending' ? (entry.messageId ?? '') : ''
    expect(messageId).not.toBe('')

    /*
     * 落账那一拍:账本上多了那条消息,overlay 那一格被认领掉。这里直接推那一格
     * 状态(认领的判据归 `chat-fold.reconcileOverlay` 自己那份用例)—— 这一条
     * 钉的是**这一层**:同一张有序表里,同一把 key、同一种元素 = 同一个 DOM 节点。
     */
    await act(async () => {
      sessionSource().setState({
        messages: [
          { id: messageId, role: 'user', content: '所见即所发', timestamp: T0 },
        ] as never,
        overlay: [],
      })
    })
    const landed = container.querySelector('article[data-role="user"]')
    // **同一个引用** —— 不是「长得一样」,是 React 保住了那个节点。
    expect(landed).toBe(pending)
    expect(landed?.getAttribute('data-pending')).toBeNull()
    expect(landed?.getAttribute('data-message-id')).toBe(messageId)
    /*
     * **反证**:把乐观行的 key 从 `entry.messageId` 改回 `entry.id`
     * → `landed` 与 `pending` 不再是同一个引用(React 认不出「还是它」),
     * 真机门 `gate:composer-send` 的 ⑦b 同时红。
     */
  })

  it('拒绝一组问题:进流,但说得轻一点', async () => {
    await mount([created(1)])
    await act(async () => {
      sessionSource().getState().notice('ask-rejected')
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
    restore.push(installFakeResizeObserver())
    for (const [name, value] of [
      ['scrollHeight', HEIGHT],
      ['clientHeight', VIEWPORT],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value })
      restore.push(() => {
        // `scrollHeight` / `clientHeight` 本来长在 **Element**.prototype 上,
        // 所以这里取到的 original 是 undefined —— 那时**必须删掉自己按上去的
        // 那一格**,否则这两个假读数会漏给整只文件后面每一条用例(2026-09-10
        // 逮到:后面新写的用例读到 scrollHeight=1000,量的是别人的世界)。
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
        else Reflect.deleteProperty(HTMLElement.prototype, name)
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
    await waitFor(() => expect(sessionSource().getState().status).not.toBe('loading'))
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
    // 冷载入:进场那一拍树还是空的(没有底可落),消息到齐把内容列撑高才落 ——
    // 2026-09-10 起这一发由观察者派,不再由「又提交了一次」派。
    await fireContentGrew(ref.current!, HEIGHT)
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
      sessionSource().setState({ activeMessageId: undefined })
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
    // 换一份消息树引用 = 账本推进了,而**长出来的那一截让内容列变高** ——
    // 2026-09-10 起「要不要跟」问的就是后者(前者只是一次 React 提交,
    // 而提交不再是贴底的判据)。人没滚过,所以此刻仍是 pinned —— 要跟。
    await act(async () => {
      sessionSource().setState({ messages: [...sessionSource().getState().messages] })
    })
    await fireContentGrew(el, HEIGHT)
    expect(el.scrollTop).toBe(HEIGHT)
  })

  /**
   * **提交次数 ≠ 贴底次数**(2026-09-10 换轨的反证)。
   *
   * 从前这两个数逐帧相等:一只**没有依赖数组**的 layout effect 每次提交都
   * `stick()` 一次,而 `stick()` 要读 `scrollHeight` —— 刚改完 DOM 的那一读就是
   * 一次整棵树的强制排版(真机上 388 条消息一次 834ms)。流式期间每一段 delta
   * 一次提交,于是每一段 delta 都赔一次全树排版。
   *
   * 换轨之后贴底只有两个产地(进场 / 几何真的变了),所以这里**推屏而不长高**:
   * `scrollTop` 一次都不该被写。把那只 effect 加回去,这一条当场红。
   */
  it('流式期间光是推屏不贴底 —— 判据是几何变了,不是「又提交了一次」', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    const spy = countScrollWrites(el)
    try {
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          sessionSource().setState({
            messages: [...sessionSource().getState().messages],
            lastActivityAt: T0 + i,
          })
        })
      }
      expect(spy.count()).toBe(0)
      // 而内容真的长高时,照旧跟一次(跟底没丢,只是换了产地)。
      await fireContentGrew(el, HEIGHT)
      expect(spy.count()).toBe(1)
    } finally {
      spy.restore()
    }
  })

  /**
   * **容器变矮也要重新贴底**(2026-09-10 新补的那一半)。
   *
   * 「在底」= `scrollHeight − clientHeight − scrollTop ≤ EPS`,右边两个量都会变:
   * 输入框多打一行、拼舞台、开查看器都会把这块滚动区挤矮,而 `scrollTop` 一动不动
   * —— 当场离底,并且**不发滚动事件**,谁都不知道。从前是那只「每次提交都贴底」
   * 顺手盖住的,它一走就必须由观察者自己接住。
   */
  it('滚动容器自己变矮 = 重新贴底(它不发滚动事件,没人替它说话)', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    const spy = countScrollWrites(el)
    try {
      // 容器那一格:target 是滚动容器自己,不是内容列。
      await act(async () => {
        const entry = { target: el, contentRect: { height: VIEWPORT } } as unknown as ResizeObserverEntry
        for (const cb of [...roCallbacks]) cb([entry], {} as ResizeObserver)
      })
      expect(spy.count()).toBe(1)
    } finally {
      spy.restore()
    }
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
      sessionSource().setState({ messages: [...sessionSource().getState().messages] })
    })
    await fireContentGrew(el, HEIGHT)
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
        // `scrollHeight` / `clientHeight` 本来长在 **Element**.prototype 上,
        // 所以这里取到的 original 是 undefined —— 那时**必须删掉自己按上去的
        // 那一格**,否则这两个假读数会漏给整只文件后面每一条用例(2026-09-10
        // 逮到:后面新写的用例读到 scrollHeight=1000,量的是别人的世界)。
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
        else Reflect.deleteProperty(HTMLElement.prototype, name)
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
    await waitFor(() => expect(sessionSource().getState().status).not.toBe('loading'))
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
      sessionSource().getState().send('再问一句')
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
      sessionSource().getState().send('再问一句')
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 已发送')

    // 回复开张 + 第一段 delta 到 —— 数据源同一次 set 写出去的就是这两格。
    await act(async () => {
      sessionSource().setState({ activeMessageId: 'a2', lastDeltaAt: T0 + 1 })
    })
    const streaming = screen.getByTestId('chat-follow-pill')
    // 生成中那张脸一个字都不写(三个点),名字改说「正在生成」。
    expect(streaming.getAttribute('aria-label')).toBe('正在生成,回到最新')
    expect(streaming.textContent).toBe('')

    // 流收场:活消息没了,读数也跟着归空(见 chat-source 的 compose)。
    await act(async () => {
      sessionSource().setState({ activeMessageId: undefined, lastDeltaAt: undefined })
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
      sessionSource().getState().send('再问一句')
    })
    await act(async () => {
      sessionSource().setState({ activeMessageId: undefined, lastDeltaAt: T0 + 9 })
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 已发送')
  })

  /**
   * **`lastActivityAt` 单独变化不是一次「回复到达」**(2026-09-09 两格分家的守卫)。
   *
   * 工具跑着那几秒里活性一直在推,而模型一个字都没说 —— 跟随状态机那一拍问的是
   * 「回复到了没有」,不是「这一轮还活着吗」。少了这条,一轮里的每一次工具进度都会
   * 把「已发送」解闩成「回到最新」,而屏幕上根本还没有一句新回复可看。
   *
   * 走的是与上面那条正序用例同一条链,只把喂进去的那一格换成 `lastActivityAt`。
   */
  it('只有 lastActivityAt 在动(工具跑着)不算回复到达 —— 「已发送」原样留着', async () => {
    const ref = await mountWithRef(LEDGER)
    await scrollUp(ref.current!)
    await act(async () => {
      sessionSource().getState().send('再问一句')
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 已发送')

    // 回复开张,但到达的只有工具那几类事实:`lastDeltaAt` 一格没动。
    await act(async () => {
      sessionSource().setState({ activeMessageId: 'a2', lastActivityAt: T0 + 7_000 })
    })
    await act(async () => {
      sessionSource().setState({ activeMessageId: undefined, lastActivityAt: undefined })
    })
    expect(screen.getByTestId('chat-follow-pill').textContent).toBe('↓ 已发送')
  })

  it('点丸 = 回到底 + 丸当场卸载(不等滚动动画)', async () => {
    const ref = await mountWithRef(LEDGER)
    const el = ref.current!
    await scrollUp(el)
    await act(async () => {
      sessionSource().getState().send('再问一句')
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
    await waitFor(() => expect(sessionSource().getState().status).not.toBe('loading'))
    await scrollUp(ref.current!)
    await act(async () => {
      sessionSource().getState().send('再问一句')
    })
    expect(screen.queryByTestId('chat-follow-pill')).toBeTruthy()
    await act(async () => {
      view.rerender(<ChatStream sessionId="" scrollRef={ref} />)
    })
    expect(screen.queryByTestId('chat-follow-pill')).toBeNull()
  })
})

/**
 * 收场通知(2026-09-09 `length` 事故:三次重试都把 2048 的额度花在推理上,
 * 屏幕上一个字不说)。这一层只钉**屏幕上到底出现了什么**——「哪些收场值得说」
 * 与「结局成没成立」两道闸的反证在 core 那只合同测试里。
 *
 * 素材一律经真的折叠器进来,所以这三条同时也证明了 `message.stop` 这一格是
 * 真的从账本折出来的,不是这里手塞的。
 */
describe('收场通知:这一轮为什么提前结束', () => {
  it('有正文、撞上 maxTokens = 「回复被截断」,数字按全壳唯一进位写', async () => {
    await mount([
      created(1),
      userMessage(2, 'm1', '写点什么'),
      runStart(3, 'r1', 'a1'),
      recipe(4, 'r1', 2048),
      chunks(5, 'r1', 'a1', ['开了个头']),
      response(6, 'r1', 'a1', { outputTokens: 2048, reasoningTokens: 1900 }),
      requestEnd(7, 'r1', 'length'),
      runEnd(8, 'r1'),
    ])
    const notice = screen.getByTestId('chat-stop-notice')
    expect(notice.getAttribute('data-kind')).toBe('output-limit')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toBe('输出达到上限 2k token,回复被截断')
  })

  it('一个字都没回、产出全是推理 = 换一句话说(想完就没额度了)', async () => {
    await mount([
      created(1),
      userMessage(2, 'm1', '写点什么'),
      runStart(3, 'r1', 'a1'),
      recipe(4, 'r1', 2048),
      response(5, 'r1', 'a1', { outputTokens: 2048, reasoningTokens: 2048 }),
      requestEnd(6, 'r1', 'length'),
      runEnd(7, 'r1'),
    ])
    expect(screen.getByTestId('chat-stop-notice').textContent)
      .toBe('输出达到上限 2k token,思考还没结束就被截断,没有生成回复')
  })

  it('正常收场(tool_calls / stop)一个字都不说', async () => {
    await mount([
      created(1),
      userMessage(2, 'm1', '写点什么'),
      runStart(3, 'r1', 'a1'),
      recipe(4, 'r1', 2048),
      chunks(5, 'r1', 'a1', ['写完了']),
      response(6, 'r1', 'a1', { outputTokens: 12 }),
      requestEnd(7, 'r1', 'stop'),
      runEnd(8, 'r1'),
    ])
    expect(screen.queryByTestId('chat-stop-notice')).toBeNull()
  })

  /**
   * 防御:活消息按定义拿不到这一格(投影的两道闸在 run/end 之后才放行),
   * 所以这条用例得**手动**把活消息那一格拨回去。它钉的是壳侧那句 `!streaming`
   * ——尾巴合成那条路哪天把一条带 stop 的消息重新算成活的,屏幕上不许当场
   * 冒出一句「这一轮结束了」。
   */
  it('这条消息又变回活的 = 通知当场撤下', async () => {
    await mount([
      created(1),
      userMessage(2, 'm1', '写点什么'),
      runStart(3, 'r1', 'a1'),
      recipe(4, 'r1', 2048),
      chunks(5, 'r1', 'a1', ['开了个头']),
      response(6, 'r1', 'a1', { outputTokens: 2048, reasoningTokens: 1900 }),
      requestEnd(7, 'r1', 'length'),
      runEnd(8, 'r1'),
    ])
    expect(screen.getByTestId('chat-stop-notice')).toBeTruthy()

    await act(async () => {
      sessionSource().setState({ activeMessageId: 'a1' })
    })
    expect(screen.queryByTestId('chat-stop-notice')).toBeNull()
  })
})

/**
 * **流式读数行的静默判据是「最近一次有东西到达」**(2026-09-09 用户裁定:工具进度
 * 计入活性)。事故:真店 fe5261d9 那一轮模型不到 1 秒就发了工具调用,bash 跑了 7 秒、
 * 卡片一直在刷输出,读数行却说「已 7.0s 没有新内容」。
 *
 * 这一层只钉**屏幕上到底写着哪一句** —— 「什么算一次活动」的判据在
 * `data/chat-source.test.ts` 那一组里,`readoutTone` 的阈值表在
 * `message/__tests__/message-chrome.test.tsx` 里。
 */
describe('流式读数行:静默按「最近一次有东西到达」算', () => {
  /** 一轮**还在跑**的对话(有 run/start、没有 run/end),开张时刻由调用方给。 */
  const streamingLedger = (startedAt: number): Ledger[] => [
    created(1),
    userMessage(2, 'm1', '跑一下'),
    {
      seq: 3,
      time: T0,
      type: 'run/start',
      data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: startedAt },
    },
    chunks(4, 'r1', 'a1', ['好的,我来跑']),
  ]

  it('工具跑着(活性 6s 比吐字新):读数行说耗时,不说静默', async () => {
    const now = Date.now()
    await mount(streamingLedger(now - 8_000))
    await act(async () => {
      // 模型 7 秒前吐完最后一个字就去调工具了,而工具 1 秒前还在刷输出。
      sessionSource().setState({ lastDeltaAt: now - 7_000, lastActivityAt: now - 1_000 })
    })
    const readout = screen.getByTestId('chat-readout')
    expect(readout.getAttribute('data-tone')).toBe('live')
    expect(readout.textContent).toMatch(/^正在生成 · /)
    expect(readout.textContent).not.toContain('没有新内容')
  })

  it('两格都停在 6s 前(真的什么都没来):读数行改说静默', async () => {
    const now = Date.now()
    await mount(streamingLedger(now - 8_000))
    await act(async () => {
      sessionSource().setState({ lastDeltaAt: now - 6_000, lastActivityAt: now - 6_000 })
    })
    const readout = screen.getByTestId('chat-readout')
    expect(readout.getAttribute('data-tone')).toBe('stalled')
    expect(readout.textContent).toContain('没有新内容')
  })

  /**
   * 这一轮什么都还没到:退到 `startedAt` 起算,而不是当成「刚刚收到过」。
   * (`lastActivityAt` 缺席那一支 —— 与从前 `lastDeltaAt` 缺席时同一条规矩。)
   */
  it('一格活性都还没有:静默从开张那一刻起算', async () => {
    await mount(streamingLedger(Date.now() - 6_000))
    const readout = screen.getByTestId('chat-readout')
    expect(readout.getAttribute('data-tone')).toBe('stalled')
    expect(readout.textContent).toContain('没有新内容')
  })
})


/**
 * **切走再切回,停在离开时那一行**(C1 · §5.2)。
 *
 * ── jsdom 证得了什么、证不了什么 ──────────────────────────────────────────
 * jsdom 不排版,所以这里把整套几何按在原型上(与上面「进场落底」那一组同一手,
 * 只是多按一格 `getBoundingClientRect` —— 锚点的判据是矩形,不是高度)。
 * 于是这两件钉得住:
 *  ① 离场那一拍真的把此刻的锚点交给了 `data/session-view-state`;
 *  ② 进场那一拍真的把它读回来、并且**交给了滚动逻辑**(容器的 `scrollTop` 落在
 *    锚点算出来的那个数上,而不是落底那个数)。
 * 「眼睛看到的还是那一行」归真机门 `scripts/gate-continuity.mjs`(本批只写不跑)。
 * 算术本身(哪一条算「还露着」、offset 怎么算)在 `data/session-view-state.test.ts`。
 */
describe('进场落点:切回来停在离开时那一行', () => {
  const CONTENT_H = 2000
  const VIEWPORT = 400
  const TOP = 100
  /** 这三条消息在**内容里**的位置(矩形由 scrollTop 现算,所以桩是物理自洽的)。 */
  const ROWS: Record<string, { contentTop: number; height: number }> = {
    m1: { contentTop: 0, height: 120 },
    a1: { contentTop: 120, height: 200 },
    m2: { contentTop: 320, height: 120 },
  }

  const LEDGER = [
    created(1),
    userMessage(2, 'm1', '第一句'),
    runStart(3, 'r1', 'a1'),
    chunks(4, 'r1', 'a1', ['第一答']),
    runEnd(5, 'r1'),
    userMessage(6, 'm2', '第二句'),
  ]

  let restore: (() => void)[] = []
  /** 容器**自己**的矩形被读了几次 = `measureScrollAnchor` 量了几次(见去抖那条用例)。 */
  let containerRects = 0

  beforeEach(() => {
    containerRects = 0
    restore.push(installFakeResizeObserver())
    /*
     * 进场也清一次:RTL 自己那口 cleanup(卸载上一条用例的树)与本文件的
     * `afterEach` 谁先跑不由我们说了算 —— 它后跑时,那一次卸载的兜底会把
     * 锚点又写回刚清空的表里,下一条用例开局就带着上一条的读数。
     */
    resetSessionViewStates()
    for (const [name, value] of [
      ['scrollHeight', CONTENT_H],
      ['clientHeight', VIEWPORT],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value })
      restore.push(() => {
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
        else Reflect.deleteProperty(HTMLElement.prototype, name)
      })
    }
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const scroller = document.querySelector('[data-testid="chat-stream"]')
      const scrollTop = scroller instanceof HTMLElement ? scroller.scrollTop : 0
      const row = ROWS[this.getAttribute('data-message-id') ?? '']
      if (row) {
        return {
          top: TOP + row.contentTop - scrollTop,
          bottom: TOP + row.contentTop + row.height - scrollTop,
          height: row.height,
        } as DOMRect
      }
      if (this.getAttribute('data-testid') === 'chat-stream') containerRects += 1
      // `height` 也给上:内容列的高度是跟随那只观察者的初值,缺了它整条判据读到 NaN。
      return { top: TOP, bottom: TOP + VIEWPORT, height: VIEWPORT } as DOMRect
    }
    restore.push(() => {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    })
  })

  afterEach(() => {
    for (const undo of restore) undo()
    restore = []
    resetSessionViewStates()
  })

  /**
   * **先把机器烘热再挂** —— 这正是「切回来」那条路的形状:停靠池里那台机器
   * 早就折好了,所以进场**第一次提交树上就已经有消息**,锚点当场用得上。
   * 冷载入(`prewarm: false`)时第一帧树是空的,锚点落不下去 —— 那一格由最后
   * 一条用例钉,理由写在 `data/session-view-state.ts` 末尾的留账 ②。
   */
  async function mountWithRef({ prewarm = true } = {}) {
    configureChatPort(port(LEDGER))
    if (prewarm) {
      chatSources.acquire(SESSION)
      await waitFor(() => expect(sessionSource().getState().messages.length).toBe(3))
    }
    const ref = createRef<HTMLDivElement>()
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<ChatStream sessionId={SESSION} scrollRef={ref} />)
    })
    await waitFor(() => expect(sessionSource().getState().status).not.toBe('loading'))
    if (!ref.current) throw new Error('滚动容器没到手')
    return { ref, view }
  }

  /** 滚一下 —— 人的滚动是**事件**,`scrollTop = x` 只是把数字改了。 */
  async function scrollTo(el: HTMLElement, top: number) {
    await act(async () => {
      el.scrollTop = top
      fireEvent.scroll(el)
    })
  }

  /** 等它「停稳」。写点在停下来那一拍,不在滚动的每一帧。 */
  async function settle() {
    await act(async () => {
      await new Promise((done) => setTimeout(done, SCROLL_ANCHOR_SETTLE_MS + 20))
    })
  }

  /**
   * **这一批治的病**(09-10):锚点从前只在离场那一拍量,而换会话走的是整棵
   * 子树的删除 —— React 先摘宿主根再逐个跑 destroy,cleanup 里容器
   * `isConnected === false`、几何全 0,`measureScrollAnchor` 如实答 undefined,
   * 表里**永远是空的**,`applyScrollAnchor` 全程一次没被调用过。
   *
   * 所以这一条把那一拍如实复现:量在滚动停稳时(节点还活着),离场那一拍容器
   * 已经被摘下来 —— 表里那一笔照旧在,重挂回得去。
   */
  it('滚动停稳就记一笔;离场那一拍容器已经被摘掉也回得去', async () => {
    const { ref, view } = await mountWithRef()
    // 人往上翻到 160:a1 的上缘落在容器上缘之上 40px,它就是「我在看的那一条」。
    await scrollTo(ref.current!, 160)
    await settle()
    expect(readSessionScrollAnchor(SESSION)).toEqual({ messageId: 'a1', offset: -40 })

    // 离场那一拍的形:宿主根先离场,cleanup 再跑 —— 那时什么都量不到。
    const detached = ref.current!
    view.container.remove()
    expect(detached.isConnected).toBe(false)
    view.unmount()
    expect(readSessionScrollAnchor(SESSION)).toEqual({ messageId: 'a1', offset: -40 })

    // 切回来:落点是锚点算出来的 160,不是落底那个数。
    const { ref: back } = await mountWithRef()
    expect(back.current!.scrollTop).toBe(160)
  })

  it('贴底时表里是 bottom,不是「停在最后一条上」', async () => {
    const { ref } = await mountWithRef()
    await scrollTo(ref.current!, CONTENT_H - VIEWPORT)
    await settle()
    expect(readSessionScrollAnchor(SESSION)).toBe('bottom')
  })

  /**
   * **去抖**:惯性滚动一秒能发几十发,每一发都量一次就是几十次全量排版
   * (病 ① 教的那一课:几何要在布局干净的时候读)。判据数的是**量了几次**,
   * 不是表里最后是什么 —— 后者连滚一次和连滚十次都一样,分不出去抖有没有拆掉。
   *
   * 一次 `measureScrollAnchor` 在「不在底」这条路上恰好读一次**容器自己的**矩形
   * (行的矩形读在行上),所以容器矩形的读数 = 量了几次。
   */
  it('连滚十下只在停下来那一次量', async () => {
    const { ref } = await mountWithRef()
    containerRects = 0
    for (let i = 1; i <= 10; i += 1) await scrollTo(ref.current!, 100 + i * 4)
    expect(containerRects).toBe(0)

    await settle()
    expect(containerRects).toBe(1)
    // 停在 140:a1 上缘在容器上缘之上 20px。量的是**最后**停下的那一处。
    expect(readSessionScrollAnchor(SESSION)).toEqual({ messageId: 'a1', offset: -20 })
  })

  /**
   * 兜底那一格没退役:**依赖变化**(不是子树删除)那条路上容器确实还连着,
   * cleanup 量得到就是白拿一笔。这里 `scrollTop` 直接改、不发事件,所以去抖
   * 那条路一次都没走 —— 表里那一笔只可能来自 cleanup。
   */
  it('兜底:容器还连着时,离场那一拍照旧量得到', async () => {
    const { ref, view } = await mountWithRef()
    await act(async () => {
      ref.current!.scrollTop = 160
    })
    expect(readSessionScrollAnchor(SESSION)).toBeUndefined()
    view.unmount()
    expect(readSessionScrollAnchor(SESSION)).toEqual({ messageId: 'a1', offset: -40 })
  })

  /**
   * **反证 ②(拆掉进场那一段回写即红)**:落点是锚点算出来的 160,
   * 而不是缺省贴底那个 `scrollHeight`。两个数差得够远,不会互相冒充。
   */
  it('进场时读回锚点,并且真的交给了滚动逻辑', async () => {
    saveSessionScrollAnchor(SESSION, { messageId: 'a1', offset: -40 })
    const { ref } = await mountWithRef()
    expect(ref.current!.scrollTop).toBe(160)
  })

  it('锚点指着一条不在树上的消息:老实落底,不滚到一个差不多的位置', async () => {
    saveSessionScrollAnchor(SESSION, { messageId: '被压缩折进去的那一条', offset: -40 })
    const { ref } = await mountWithRef()
    expect(ref.current!.scrollTop).toBe(CONTENT_H)
  })

  it('记着 bottom 时照旧贴底(缺省那条路一格没动)', async () => {
    saveSessionScrollAnchor(SESSION, 'bottom')
    const { ref } = await mountWithRef()
    expect(ref.current!.scrollTop).toBe(CONTENT_H)
  })

  /**
   * **冷载入不落锚点**(留账 ②,故意的):第一帧树是空的,锚点指的那条还不在,
   * 于是老实落底。要治它得等消息到齐再落一次 —— 那是一次肉眼可见的跳,与
   * 「首帧就在底,不许先画顶部再跳」相悖,所以本批不做,而是**把它钉成用例**,
   * 免得哪天有人以为它坏了。
   */
  it('冷载入(机器不在池里)照旧落底,锚点留着下次用', async () => {
    saveSessionScrollAnchor(SESSION, { messageId: 'a1', offset: -40 })
    const { ref } = await mountWithRef({ prewarm: false })
    // 消息到齐把内容列撑高 —— 冷载入那条路的落底从此走观察者(见上一组同名判词)。
    await fireContentGrew(ref.current!, CONTENT_H)
    expect(ref.current!.scrollTop).toBe(CONTENT_H)
    expect(readSessionScrollAnchor(SESSION)).toBeDefined()
  })
})

/**
 * **消息按屏进**(2026-09-10「响应先行」,规范第 5 轴「交互预算」)。
 *
 * 病:点一行会话 = 一次紧急更新同步造出全部 388 条消息 / 37,470 个节点,列表高亮、
 * 标签标题、内容在 1–2s 后同一帧一起换。治法是把「摆什么」从整份改成一个后缀:
 * 进场只摆尾窗,其余空闲往前补 —— 判据与常数在 `content/chat-window.ts`。
 *
 * 这一节量**组件那一端**:摆了几条、什么时候摆更多、扩窗会不会让视口跳、
 * 锚点在窗外时先扩再落、流式追加落不落在窗里。纯函数那一半在
 * `__tests__/chat-window.test.ts`。
 */
describe('消息按屏进:尾窗 + 空闲扩窗', () => {
  /** 60 轮 = 120 条消息 —— 尾窗 24、每批 48,正好三批扩到全量。 */
  const TURNS = 60
  const TOTAL = TURNS * 2
  const ROW_H = 100
  const VIEWPORT = 300
  const TOP = 50

  function bigLedger(turns: number): Ledger[] {
    const out: Ledger[] = [created(1)]
    let seq = 1
    for (let turn = 0; turn < turns; turn += 1) {
      out.push(userMessage((seq += 1), `bm${turn}`, `第 ${turn} 问`))
      out.push(runStart((seq += 1), `br${turn}`, `ba${turn}`))
      out.push(chunks((seq += 1), `br${turn}`, `ba${turn}`, [`第 ${turn} 答`]))
      out.push(runEnd((seq += 1), `br${turn}`))
    }
    return out
  }

  /* ── 可控的假 requestIdleCallback ──────────────────────────────────────
   *
   * 空闲扩窗排在 `requestIdleCallback`(jsdom 没有,产品里退 `setTimeout 0`)。
   * 要量「进场只摆 24 条」就必须让那一批**还没跑**,所以这里把它换成一格队列,
   * 由用例自己决定「空闲」发生在哪一拍 —— 与上面那只假 ResizeObserver 同一手。
   */
  interface IdleSlot {
    cb: () => void
    cancelled: boolean
  }
  let idleSlots: IdleSlot[] = []

  function installFakeIdle(): () => void {
    const target = window as unknown as Record<string, unknown>
    const hadRequest = 'requestIdleCallback' in target
    const hadCancel = 'cancelIdleCallback' in target
    const originalRequest = target.requestIdleCallback
    const originalCancel = target.cancelIdleCallback
    target.requestIdleCallback = (cb: () => void) => {
      idleSlots.push({ cb, cancelled: false })
      return idleSlots.length
    }
    target.cancelIdleCallback = (handle: number) => {
      const slot = idleSlots[handle - 1]
      if (slot) slot.cancelled = true
    }
    return () => {
      idleSlots = []
      if (hadRequest) target.requestIdleCallback = originalRequest
      else Reflect.deleteProperty(target, 'requestIdleCallback')
      if (hadCancel) target.cancelIdleCallback = originalCancel
      else Reflect.deleteProperty(target, 'cancelIdleCallback')
    }
  }

  /** 「机器闲下来了」—— 把此刻排着的那一批跑掉(取消掉的不跑)。 */
  async function runIdle() {
    const batch = idleSlots
    idleSlots = []
    await act(async () => {
      for (const slot of batch) if (!slot.cancelled) slot.cb()
    })
  }

  const renderedIds = () =>
    [...document.querySelectorAll('[data-message-id]')].map((row) => row.getAttribute('data-message-id'))

  let restore: (() => void)[] = []

  beforeEach(() => {
    resetChatWindows()
    resetSessionViewStates()
    restore.push(installFakeIdle())
    restore.push(installFakeResizeObserver())
    /*
     * 几何桩是**由 DOM 自己算的**,所以它对「窗口变了」是自洽的:
     * 内容总高 = 摆出来的行数 × 行高,每一行的位置 = 它在**摆出来那一列**里的
     * 下标 × 行高。往前扩窗 = 上面凭空多出几行 = 总高变大、下面每一行的坐标
     * 整体下移 —— 正是真机上要补偿的那一下。
     */
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => document.querySelectorAll('[data-message-id]').length * ROW_H,
    })
    restore.push(() => {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    })
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => VIEWPORT,
    })
    restore.push(() => {
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    })
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const scroller = document.querySelector('[data-testid="chat-stream"]')
      const scrollTop = scroller instanceof HTMLElement ? scroller.scrollTop : 0
      const rows = [...document.querySelectorAll('[data-message-id]')]
      const seat = rows.indexOf(this)
      if (seat >= 0) {
        return {
          top: TOP + seat * ROW_H - scrollTop,
          bottom: TOP + (seat + 1) * ROW_H - scrollTop,
          height: ROW_H,
        } as DOMRect
      }
      return { top: TOP, bottom: TOP + VIEWPORT, height: VIEWPORT } as DOMRect
    }
    restore.push(() => {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    })
  })

  afterEach(() => {
    for (const undo of restore) undo()
    restore = []
    resetChatWindows()
    resetSessionViewStates()
  })

  /**
   * **先把机器烘热再挂** —— 停靠池命中那条路的形状:进场第一次提交树上就已经有
   * 全部消息。这一节量的正是那一次提交摆了几条。
   */
  async function mountBig(anchor?: ScrollAnchor) {
    configureChatPort(port(bigLedger(TURNS)))
    chatSources.acquire(SESSION)
    await waitFor(() => expect(sessionSource().getState().messages.length).toBe(TOTAL))
    if (anchor) saveSessionScrollAnchor(SESSION, anchor)
    const ref = createRef<HTMLDivElement>()
    await act(async () => {
      render(<ChatStream sessionId={SESSION} scrollRef={ref} />)
    })
    if (!ref.current) throw new Error('滚动容器没到手')
    return ref
  }

  it('进场只摆尾窗那几条 —— 不是一次性造出整份', async () => {
    await mountBig()
    const ids = renderedIds()
    expect(ids.length).toBe(CHAT_TAIL_WINDOW)
    // 摆的是**最后**那几条(窗口是后缀),最后一行仍然是账本上最后一条。
    expect(ids.at(-1)).toBe(`ba${TURNS - 1}`)
    // 反证的秤:拆掉尾窗(窗口 = 全量)这一条当场红。
    expect(ids.length).toBeLessThan(TOTAL)
  })

  it('空闲里一批一批往前补,直到全量 —— 补齐之后与从前逐字相同', async () => {
    await mountBig()
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW)

    await runIdle()
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW + CHAT_WINDOW_STEP)

    for (let round = 0; round < 6 && renderedIds().length < TOTAL; round += 1) await runIdle()
    expect(renderedIds()).toEqual(sessionSource().getState().messages.map((message) => message.id))

    // 到齐了就不再排下一批(排了就是每一帧白跑一次 setState)。
    await runIdle()
    expect(renderedIds().length).toBe(TOTAL)
  })

  it('人翻到窗口顶部附近:当场补一批,不等空闲', async () => {
    const ref = await mountBig()
    const el = ref.current!
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW)
    // 离顶不足两屏 —— 这一下就是「快撞到窗口顶了」。
    await act(async () => {
      el.scrollTop = VIEWPORT
      fireEvent.scroll(el)
    })
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW + CHAT_WINDOW_STEP)
    // 空闲那一批一个字没跑过 —— 这一格证明它走的是滚动那条路。
    expect(idleSlots.length).toBeGreaterThan(0)
  })

  it('还在窗口中段往下滚:不提前扩(不为不用的东西付造 DOM 的钱)', async () => {
    const ref = await mountBig()
    const el = ref.current!
    await act(async () => {
      el.scrollTop = VIEWPORT * 5
      fireEvent.scroll(el)
    })
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW)
  })

  it('往前扩窗不让视口跳:锚点行的矩形一像素不动', async () => {
    const ref = await mountBig()
    const el = ref.current!
    // 人停在窗口中间某一行上(不在底,所以不会被跟底那一手带走)。
    await act(async () => {
      el.scrollTop = ROW_H * 8
      fireEvent.scroll(el)
    })
    const watched = document.querySelector(`[data-message-id="${renderedIds()[10]}"]`) as HTMLElement
    const before = watched.getBoundingClientRect().top
    const heightBefore = el.scrollHeight
    const topBefore = el.scrollTop

    await runIdle()

    expect(el.scrollHeight).toBe(heightBefore + CHAT_WINDOW_STEP * ROW_H)
    // 补偿是绝对赋值「原位 + 长高了多少」,所以那一行落回原处。
    expect(el.scrollTop).toBe(topBefore + CHAT_WINDOW_STEP * ROW_H)
    expect(watched.getBoundingClientRect().top).toBe(before)
  })

  it('锚点在尾窗外:进场那一帧就把窗口扩到它,当场落位(不先画别处再跳)', async () => {
    // `bm4` = 第 5 轮那句问话,远在尾窗(第 96 条起)之外。
    const ref = await mountBig({ messageId: 'bm4', offset: -30 })
    const ids = renderedIds()
    // 窗口一次性扩到了它(还带上了上面那一段回旋余地 —— 这里锚点靠开头,夹到 0)。
    expect(ids).toContain('bm4')
    expect(ids.length).toBeGreaterThan(CHAT_TAIL_WINDOW)
    // 而且真的落在了它身上:那一行的上缘离容器上缘 −30px,就是离开时记的那个偏移。
    const row = document.querySelector('[data-message-id="bm4"]') as HTMLElement
    const base = ref.current!.getBoundingClientRect().top
    expect(Math.round(row.getBoundingClientRect().top - base)).toBe(-30)
  })

  it('锚点在尾窗里:窗口一格不多摆(与从前逐字相同)', async () => {
    await mountBig({ messageId: `ba${TURNS - 2}`, offset: -20 })
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW)
  })

  it('流式追加落在窗里,而且窗口顶上那一条不动(窗口记的是起点不是条数)', async () => {
    await mountBig()
    const firstBefore = renderedIds()[0]
    await act(async () => {
      const store = sessionSource()
      const grown = [
        ...store.getState().messages,
        { id: 'new-1', role: 'assistant', content: '刚长出来的一条', timestamp: T0 },
      ]
      store.setState({ messages: grown as never })
    })
    const ids = renderedIds()
    expect(ids.at(-1)).toBe('new-1')
    // 记条数的话后缀会往前滑一格,顶上那条被摘掉 —— 人正在看的内容当场往上跳。
    expect(ids[0]).toBe(firstBefore)
    expect(ids.length).toBe(CHAT_TAIL_WINDOW + 1)
  })
})

/**
 * **组件级停靠**(2026-09-10,交互预算第三单)。
 *
 * 切走的那片会话**不卸载**,只是它那一层挂上 `content-visibility: hidden` ——
 * 于是这棵树还在,而它脚下的排版没了。这一组钉的是那三样量几何的活计当场停手
 * (停手的判据是**容器此刻有没有排版**,不是宿主说了什么),外加取回那一拍
 * 位置怎么回来。
 *
 * 屏幕那一半(同一个 DOM 节点、inert + aria-hidden、上限、真删)在
 * `content/__tests__/session-park.test.tsx`。
 */
describe('组件级停靠:藏起来的那棵树停手,取回来位置不丢', () => {
  const TURNS = 40
  const ROW_H = 100
  const VIEWPORT = 300

  /** 「这一层此刻藏起来了吗」—— 几何桩照它作答(真机上由浏览器作答)。 */
  let parked = false
  let restore: (() => void)[] = []
  let idleSlots: { cb: () => void; cancelled: boolean }[] = []

  function bigLedger(turns: number): Ledger[] {
    const out: Ledger[] = [created(1)]
    let seq = 1
    for (let turn = 0; turn < turns; turn += 1) {
      out.push(userMessage((seq += 1), `pm${turn}`, `第 ${turn} 问`))
      out.push(runStart((seq += 1), `pr${turn}`, `pa${turn}`))
      out.push(chunks((seq += 1), `pr${turn}`, `pa${turn}`, [`第 ${turn} 答`]))
      out.push(runEnd((seq += 1), `pr${turn}`))
    }
    return out
  }

  const renderedIds = () =>
    [...document.querySelectorAll('[data-message-id]')].map((row) => row.getAttribute('data-message-id'))

  /** 一格可控的「空闲」——与上面那一组同一手(判词写在那儿)。 */
  function installFakeIdle(): () => void {
    const target = window as unknown as Record<string, unknown>
    const hadRequest = 'requestIdleCallback' in target
    const originalRequest = target.requestIdleCallback
    const originalCancel = target.cancelIdleCallback
    target.requestIdleCallback = (cb: () => void) => {
      idleSlots.push({ cb, cancelled: false })
      return idleSlots.length
    }
    target.cancelIdleCallback = (handle: number) => {
      const slot = idleSlots[handle - 1]
      if (slot) slot.cancelled = true
    }
    return () => {
      idleSlots = []
      if (hadRequest) {
        target.requestIdleCallback = originalRequest
        target.cancelIdleCallback = originalCancel
      } else {
        Reflect.deleteProperty(target, 'requestIdleCallback')
        Reflect.deleteProperty(target, 'cancelIdleCallback')
      }
    }
  }

  async function runIdle() {
    const batch = idleSlots
    idleSlots = []
    await act(async () => {
      for (const slot of batch) if (!slot.cancelled) slot.cb()
    })
  }

  /**
   * 一片装在**宿主可见性**里的聊天区(产品里那一格由 `PaneLeaf` 报,
   * 见 `content/visibility.ts`)。答一口「翻面」。
   */
  async function mountParked(): Promise<{
    el: HTMLDivElement
    writes: { count: () => number; restore: () => void }
    setVisible: (next: boolean) => Promise<void>
  }> {
    configureChatPort(port(bigLedger(TURNS)))
    useExposeStore.setState({ currentSessionId: SESSION })
    /*
     * **先把树装好再渲** —— 与 `mountBig` 同一手:停靠要治的正是「池命中」那条路
     * (机器没被扔掉,进场第一次提交树上就已经有消息了),而冷载入那条路上第一帧
     * 树是空的、窗口从 0 起,两者的窗口行为本来就不同(判词在 `chat-window.ts`)。
     */
    chatSources.acquire(SESSION)
    await waitFor(() => expect(sessionSource().getState().messages.length).toBe(TURNS * 2))
    const ref = createRef<HTMLDivElement>()
    const view = { current: null as null | ReturnType<typeof render> }
    const tree = (visible: boolean) => (
      <PanelVisibilityContext.Provider value={{ visible, interactive: visible }}>
        <ChatStream sessionId={SESSION} scrollRef={ref} />
      </PanelVisibilityContext.Provider>
    )
    await act(async () => {
      view.current = render(tree(true))
    })
    await waitFor(() => expect(sessionSource().getState().status).toBe('ready'))
    const el = ref.current as HTMLDivElement
    const writes = countScrollWrites(el)
    return {
      el,
      writes,
      setVisible: async (next: boolean) => {
        // 真机上这两件事在同一次提交里发生:类名换成 `.layerHidden`,排版当场消失。
        parked = !next
        await act(async () => {
          view.current?.rerender(tree(next))
        })
      },
    }
  }

  beforeEach(() => {
    parked = false
    resetChatWindows()
    resetSessionViewStates()
    restore.push(installFakeIdle())
    restore.push(installFakeResizeObserver())
    const rows = () => document.querySelectorAll('[data-message-id]').length
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      // 停靠中整棵子树没有盒子 —— 浏览器报 0,这里照办。
      get: () => (parked ? 0 : rows() * ROW_H),
    })
    restore.push(() => {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    })
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => (parked ? 0 : VIEWPORT),
    })
    restore.push(() => {
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    })
  })

  afterEach(() => {
    for (const undo of restore) undo()
    restore = []
    parked = false
    resetChatWindows()
    resetSessionViewStates()
  })

  it('停靠中 ResizeObserver 派一发,一次 `scrollTop` 都不写(不是读数,是没有排版)', async () => {
    const { el, writes, setVisible } = await mountParked()
    await setVisible(false)
    const before = writes.count()
    // 藏起来那一下浏览器真的会派一发「高度 0」—— 照常往下走的话 `stick()` 会
    // 把这条会话的位置抹平,而人只是切去看了别的会话。
    await fireContentGrew(el, 0)
    expect(writes.count()).toBe(before)
    writes.restore()
  })

  it('停靠中**空闲扩窗照跑** —— 后台把窗补全,切回来就是全量', async () => {
    const { writes, setVisible } = await mountParked()
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW)
    await setVisible(false)
    await runIdle()
    expect(renderedIds().length).toBe(CHAT_TAIL_WINDOW + CHAT_WINDOW_STEP)
    writes.restore()
  })

  it('停靠中那一发去抖的锚点不当一次读数(容器没有排版,量出来的「在底」是假的)', async () => {
    const { el, writes, setVisible } = await mountParked()
    // 人停在某一行上,记了一笔真锚点。
    el.scrollTop = 900
    await act(async () => {
      fireEvent.scroll(el)
    })
    await setVisible(false)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SCROLL_ANCHOR_SETTLE_MS + 20))
    })
    // 拆掉那一格守卫的话这里是 `'bottom'`(0 − 0 − 0 ≤ EPS),真读数被冲掉。
    expect(readSessionScrollAnchor(SESSION)).not.toBe('bottom')
    writes.restore()
  })

  it('取回那一拍**不在点击那条同步路上读几何**(对位挪进了 RO,读数见判词)', async () => {
    const { el, writes, setVisible } = await mountParked()
    el.scrollTop = 900
    await act(async () => {
      fireEvent.scroll(el)
    })
    const before = writes.count()
    await setVisible(false)
    // 浏览器没把位置留住的那一档(真机上它**留住了** —— 判词与读数在
    // `useParkedScroll` 上;这里假设最坏,好让兜底那一格有得可测)。
    el.scrollTop = 0
    await setVisible(true)
    // 取回那一帧本身零写:那一读会逼一次 400 行的强排版,正是被搬走的 44ms。
    expect(writes.count()).toBe(before + 1) // 只有用例自己那句 `el.scrollTop = 0`
    // 对位落在紧接着的那一批尺寸变化里(真机上由浏览器自己派)。
    await fireContentGrew(el, 40 * 2 * ROW_H)
    expect(el.scrollTop).toBe(900)
    writes.restore()
  })

  it('取回那一拍:跟底档不看记的那个数,当场贴底(位置是算出来的)', async () => {
    const { el, writes, setVisible } = await mountParked()
    await setVisible(false)
    el.scrollTop = 0
    await setVisible(true)
    await fireContentGrew(el, 40 * 2 * ROW_H)
    expect(el.scrollTop).toBe(el.scrollHeight)
    writes.restore()
  })
})
