import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { useChatToc } from './useChatToc'
import { useLocateMessage } from '../content/locate-message'
import { chatSources, useChatSourceOf } from '../data/chat-source'
import { useExposeStore } from '../expose/store'
import { useNotifyStore } from '../services/notify-store'
import { useStageStore } from '../stage/store'
import { initialStageState } from '../stage/transitions'
import { translate } from '../i18n'

/**
 * 「落到某条消息」这条接缝(09-02 正文检索)。
 *
 * 它跨了两个模块:待办住在 `content/locate-message.ts`(检索面点一行时留下),
 * 办事的在 `toc/useChatToc`(锚点真的出现时滚过去 + 点亮)。所以用例也照这条缝
 * 分两头验:**留了没有**在面板的用例里,**办没办成**在这里。
 *
 * 这里刻意不渲染整个 AppShell:要验的是「什么时候算办得成」这条判据,
 * 而它只吃三样东西 —— 当前会话、折叠落地没有、锚点在不在树上。
 */

const SESSION = 'os-provider'

/**
 * 一个最小的宿主:一只滚动容器 + 一串挂着 `data-message-id` 的消息。
 *
 * 消息**从 chat-source 现读**,不走 prop —— 真机上「折叠落地」与「消息渲染出来」
 * 是同一次提交里的两件事,而这条判据要验的正是那一刻的时序。用 prop 递的话
 * 状态与 DOM 会落在两次提交里,测出来的是一个真机上不存在的中间态。
 */
function Harness({ sessionId = SESSION }: { sessionId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const { flashMessageId } = useChatToc(sessionId, ref)
  const messages = useChatSourceOf(sessionId, (st) => st.messages)
  return (
    <div ref={ref} data-testid="scroller">
      <span data-testid="flash">{flashMessageId ?? ''}</span>
      {messages.map((message) => (
        <article key={message.id} data-message-id={message.id}>
          {message.id}
        </article>
      ))}
    </div>
  )
}

/** 折出来的那几条消息 —— 这一组只用得上 `id` 那一格。 */
const folded = (...ids: string[]) => ids.map((id) => ({ id })) as never

const flashOf = (el: HTMLElement) => el.querySelector('[data-testid="flash"]')?.textContent ?? ''

/**
 * 直接摆这条会话那台机器的状态。W5-a 之前它是 `useChatSource.setState`(全应用
 * 一台);现在一条会话一台,所以说清楚是**哪一条**的 —— `ensure` 只造不起底,
 * 摆好的状态不会被一次 `listRaw` 冲掉。
 */
const seedFold = (sessionId: string, patch: Record<string, unknown>) =>
  chatSources.ensure(sessionId).setState(patch as never)

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useLocateMessage.getState().reset()
  useNotifyStore.setState({ items: [] })
  useExposeStore.setState({ currentSessionId: SESSION })
  chatSources.resetAll()
  seedFold(SESSION, { sessionId: SESSION, status: 'ready', messages: folded() })
})

describe('落到某条消息', () => {
  it('锚点在树上:滚过去并点亮,待办随之消掉', async () => {
    seedFold(SESSION, { messages: folded('m1', 'm2') })
    const { container } = render(<Harness />)
    act(() => useLocateMessage.getState().locateMessage(SESSION, 'm2'))
    await waitFor(() => expect(flashOf(container)).toBe('m2'))
    expect(useLocateMessage.getState().request).toBeNull()
    // 办成了就不吭声 —— 屏幕上已经把结果画出来了。
    expect(useNotifyStore.getState().items.length).toBe(0)
  })

  /*
   * 这一条钉的是「不猜延迟」:点下去那一刻聊天区还在重开折叠,树上一条消息都
   * 没有。待办要**等着**,而不是当场判成「找不到」——从前那种写法在真机上
   * 表现为「点了没反应,再点一次才跳」。
   */
  it('折叠还没落地:待办等着,不误判成找不到', async () => {
    seedFold(SESSION, { sessionId: SESSION, status: 'loading', messages: folded() })
    const { container } = render(<Harness />)
    act(() => useLocateMessage.getState().locateMessage(SESSION, 'm2'))
    expect(useLocateMessage.getState().request).not.toBeNull()
    expect(useNotifyStore.getState().items.length).toBe(0)

    // 折叠落地 = 状态与消息**同一次提交**落下来,这一刻它才该动。
    act(() => seedFold(SESSION, { status: 'ready', messages: folded('m1', 'm2') }))
    await waitFor(() => expect(flashOf(container)).toBe('m2'))
    expect(useLocateMessage.getState().request).toBeNull()
  })

  it('当前会话还没换过去:一格都不动(enterSession 还在路上)', () => {
    useExposeStore.setState({ currentSessionId: 'another' })
    seedFold('another', { sessionId: 'another', status: 'ready', messages: folded('m1') })
    render(<Harness sessionId="another" />)
    act(() => useLocateMessage.getState().locateMessage(SESSION, 'm1'))
    expect(useLocateMessage.getState().request).not.toBeNull()
    expect(useNotifyStore.getState().items.length).toBe(0)
  })

  /*
   * 诚实处理那一格:会话进来了、折叠也落地了,那条消息却不在树上
   * (被删 / 被压缩掉)。**说出来**,不滚到一个「最近的位置」去假装办成了。
   */
  it('折叠落地了锚点还是没有:如实报一句,不伪造一次跳转', async () => {
    seedFold(SESSION, { messages: folded('m1') })
    const { container } = render(<Harness />)
    act(() => useLocateMessage.getState().locateMessage(SESSION, 'gone'))
    await waitFor(() => expect(useNotifyStore.getState().items.length).toBe(1))
    expect(useNotifyStore.getState().items[0].title).toBe(translate('zh', 'search.messageGone'))
    expect(useNotifyStore.getState().items[0].source).toBe('search.open')
    // 没有假的高亮,也没有留下一件永远办不成的待办。
    expect(flashOf(container)).toBe('')
    expect(useLocateMessage.getState().request).toBeNull()
  })

  it('连点同一条:token 换了,于是高亮会重放一次', async () => {
    seedFold(SESSION, { messages: folded('m1') })
    const { container } = render(<Harness />)
    act(() => useLocateMessage.getState().locateMessage(SESSION, 'm1'))
    await waitFor(() => expect(flashOf(container)).toBe('m1'))
    const first = useLocateMessage.getState().request
    expect(first).toBeNull()

    act(() => useLocateMessage.getState().locateMessage(SESSION, 'm1'))
    // 先清再点:清的那一帧高亮是空的,下一帧才重新点上。
    await waitFor(() => expect(flashOf(container)).toBe('m1'))
    expect(useLocateMessage.getState().request).toBeNull()
  })

  it('办的过程里又点了另一行:后来那件不会被前一件的收尾抹掉', () => {
    seedFold(SESSION, { status: 'loading', messages: folded() })
    render(<Harness />)
    act(() => useLocateMessage.getState().locateMessage(SESSION, 'm1'))
    const first = useLocateMessage.getState().request!.token
    act(() => useLocateMessage.getState().locateMessage(SESSION, 'm2'))
    act(() => useLocateMessage.getState().settleLocate(first))
    expect(useLocateMessage.getState().request?.messageId).toBe('m2')
  })
})
