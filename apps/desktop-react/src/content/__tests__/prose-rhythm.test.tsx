import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ChatStream } from '../ChatStream'
import { configureChatPort, type ChatPort } from '../../data/chat-port'
import { useChatSource } from '../../data/chat-source'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'

/**
 * 节奏换轨(08-31 阅读体验四件套 · 交付一)的两条门。
 *
 * ① **结构不变式**:换轨换的是「两件东西之间隔多远」,**不是**「哪件东西排在哪」。
 *    所以这里钉的是一条混排消息(正文 → 工具卡 → 正文 → 工具组 → 正文)在消息框
 *    里的**直接子项序列** —— 标签名 + 身份属性,逐项相同。基线是撤 gap **之前**
 *    跑出来的那一份:任何让工具卡换位置、被套进别的层、或归属到另一条消息的改动,
 *    这条当场红。
 * ② **节奏表契约**:`.row` 上不许再有 gap(它是「一律 16」的产地),而那张
 *    「gap(前,后) = max(前的下缘, 后的上缘)」的邻接表必须逐条在场。这一条读的是
 *    CSS 文本 —— jsdom 不排版,量不出真实间距(那是真机门 gate:chat 的活)。
 */

const T0 = 1_700_000_000_000
const SESSION = 's-rhythm'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const created = (seq: number): Ledger => ({
  seq,
  time: T0,
  type: 'session/created',
  data: { sessionId: SESSION },
})
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
const chunks = (
  seq: number,
  runId: string,
  messageId: string,
  partIndex: number,
  kind: 'text' | 'reasoning',
  text: string[],
): Ledger => ({
  seq,
  time: T0,
  type: 'assistant/chunks',
  data: {
    runId,
    requestIndex: 0,
    messageId,
    partIndex,
    kind,
    time0: T0,
    dt: text.map((_, i) => i),
    text,
  },
})
const toolCall = (seq: number, runId: string, messageId: string, callId: string, name: string): Ledger => ({
  seq,
  time: T0,
  type: 'tool/call',
  data: { runId, messageId, callId, name, argumentsRaw: '{}' },
})
const toolResult = (seq: number, runId: string, callId: string): Ledger => ({
  seq,
  time: T0,
  type: 'tool/result',
  data: { runId, callId, isError: false, resultPreview: '读到了', result: { text: '读到了' } },
})

function port(ledger: Ledger[]): ChatPort {
  return {
    ready: async () => undefined,
    listRaw: async () => ({ events: [...ledger] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
  }
}

/**
 * 一条**混排**消息:正文(含标题 / 列表 / 代码围栏)、思考段、单个工具卡、
 * 同名工具连开三次(会被折叠器归成工具组)、再一段正文。
 * 素材经真的数据源进来 —— 这条门证的是屏幕上那棵树,不是某个纯函数的返回值。
 */
const MIXED: Ledger[] = [
  created(1),
  userMessage(2, 'm1', '混排一条'),
  runStart(3, 'r1', 'a1'),
  chunks(4, 'r1', 'a1', 0, 'reasoning', ['先想一下怎么做']),
  chunks(5, 'r1', 'a1', 1, 'text', ['开头一段。\n\n## 二级标题\n\n- 一项\n- 二项\n']),
  toolCall(6, 'r1', 'a1', 'c1', 'read'),
  toolResult(7, 'r1', 'c1'),
  chunks(8, 'r1', 'a1', 2, 'text', ['中间一段。\n\n```ts\nconst a = 1\n```\n']),
  toolCall(9, 'r1', 'a1', 'c2', 'bash'),
  toolResult(10, 'r1', 'c2'),
  toolCall(11, 'r1', 'a1', 'c3', 'bash'),
  toolResult(12, 'r1', 'c3'),
  toolCall(13, 'r1', 'a1', 'c4', 'bash'),
  toolResult(14, 'r1', 'c4'),
  chunks(15, 'r1', 'a1', 3, 'text', ['收尾一段。']),
]

/**
 * 一个直接子项的**身份**:标签名 + 那几个说明「它是什么」的属性。
 * 刻意不含 class(CSS Modules 的 hash 每次构建都可能变,那不是结构)。
 */
function identify(el: Element): string {
  const marks = ['data-block-kind', 'data-tool-status', 'data-tool-group', 'data-research-id', 'data-testid']
  const bits = marks.flatMap((name) => {
    const value = el.getAttribute(name)
    return value === null ? [] : [value === '' ? name : `${name}=${value}`]
  })
  return `${el.tagName.toLowerCase()}${bits.length ? `[${bits.join(' ')}]` : ''}`
}

/** 单卡形:一段正文 + 一次收场的工具调用。工具卡在这一形里是**独立一张卡**,不成组。 */
const SIMPLE: Ledger[] = [
  created(1),
  userMessage(2, 'm1', '读一下'),
  runStart(3, 'r1', 'a1'),
  chunks(4, 'r1', 'a1', 0, 'text', ['这就去读。']),
  toolCall(5, 'r1', 'a1', 'c1', 'read'),
  toolResult(6, 'r1', 'c1'),
]

async function mountLedger(ledger: Ledger[]) {
  configureChatPort(port(ledger))
  useExposeStore.setState({ currentSessionId: SESSION })
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ChatStream />)
  })
  await waitFor(() => expect(useChatSource.getState().status).not.toBe('loading'))
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useChatSource.getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
})

afterEach(async () => {
  await act(async () => {
    useChatSource.getState().reset()
  })
  configureChatPort(undefined)
})

describe('节奏换轨:只许间距变,不许次序变', () => {
  it('混排消息的直接子项序列与换轨前逐项相同', async () => {
    const { container } = await mountLedger(MIXED)
    const row = container.querySelector('[data-message-id="a1"]')
    expect(row).toBeTruthy()
    const children = Array.from(row!.children).map(identify)
    /*
     * 基线**逐字取自撤 .row gap 之前**的一次真实渲染(2026-08-31)。它记的是
     * 今天这台的排布事实,不是「应该长这样」的主张 —— 所以两处「读起来意外」的
     * 地方也照记不改:
     *  · 三段文本 part 之间**直接相接**(anchor.ts 的 `+=`),于是
     *    `- 二项\n` 后面紧跟的「中间一段。」被 markdown 当成列表项的懒续行,
     *    并进了 <ul> —— 所以这里只有两个 <p> 而不是三个;
     *  · 这条素材的 tool/call 不带 turnIndex,core 的锚点合成因此把四次调用
     *    一起挂在尾部,归成一个工具组。
     * 两条都是**换轨之前**就有的行为。这条门的职责是「换轨没动它们」,
     * 要改这两件事得另开一批(改了这里就得连着改基线,那正是它该被看见的时刻)。
     */
    expect(children).toEqual([
      'div[data-testid=chat-thought]',
      'p',
      'h2',
      'ul',
      'section[data-block-kind=code]',
      'p',
      'div[data-tool-group=true]',
      'span[data-testid=chat-streaming]',
    ])
  })

  it('单卡形:正文 → 工具卡,次序与换轨前相同', async () => {
    const { container } = await mountLedger(SIMPLE)
    const row = container.querySelector('[data-message-id="a1"]')!
    expect(Array.from(row.children).map(identify)).toEqual([
      'p',
      'div[data-tool-status=completed]',
      'span[data-testid=chat-streaming]',
    ])
  })

  it('工具卡 / 工具组都是消息框的**直接**子项 —— 没有被套进任何包裹层', async () => {
    const mixed = await mountLedger(MIXED)
    const mixedRow = mixed.container.querySelector('[data-message-id="a1"]')!
    const group = mixed.container.querySelector('[data-tool-group]')
    expect(group).toBeTruthy()
    expect(group!.parentElement, '工具组的父节点应当就是消息框').toBe(mixedRow)

    await act(async () => {
      useChatSource.getState().reset()
    })
    const simple = await mountLedger(SIMPLE)
    const simpleRow = simple.container.querySelectorAll('[data-message-id="a1"]')
    const card = simple.container.querySelectorAll('[data-tool-status]')
    const lastRow = simpleRow[simpleRow.length - 1]
    const lastCard = card[card.length - 1]
    expect(lastCard, '单卡形里应当有一张工具卡').toBeTruthy()
    expect(lastCard.parentElement, '工具卡的父节点应当就是消息框').toBe(lastRow)
  })
})

describe('节奏表契约', () => {
  const css = readFileSync(path.resolve(__dirname, '../ChatStream.module.css'), 'utf-8')
  /** 注释里也写着 gap,所以先把注释抹掉再查。 */
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rowBlock = code.slice(code.indexOf('.row {'), code.indexOf('}', code.indexOf('.row {')))

  it('.row 上不许再有 gap —— 「一律 16」的产地已经拆掉', () => {
    expect(rowBlock).not.toMatch(/(^|[;{\s])(gap|row-gap)\s*:/)
  })

  /*
   * 这一条是 08-31 真机量出来的病:`<p>` / `<h2>` / `<ul>` / `<blockquote>` 在 UA
   * 样式表里各带 `margin-block: 1em`,而本仓没有全局清边距。不清零的话节奏表算出来
   * 的间距会被悄悄加上一截 —— 实测段落到代码块本该 11.9px,量出来 25.9px。
   * 清零规则还必须**排在**邻接表之前:两者同特异性(0-1-0),后写的赢。
   */
  it('⓪ 先清掉浏览器自带的块边距,且它排在邻接表之前', () => {
    const resetAt = code.search(/\.row > \*\s*\{[^}]*margin-block:\s*0/)
    expect(resetAt, '缺少 `.row > * { margin-block: 0 }`').toBeGreaterThan(-1)
    const tableAt = code.indexOf('.row > * + *')
    expect(tableAt).toBeGreaterThan(resetAt)
  })

  it('邻接表五条规则齐全:默认 / 前一件说了算 / 后一件说了算', () => {
    // 默认:任意相邻两件 = 段距
    expect(code).toMatch(/\.row > \* \+ \*\s*\{[^}]*margin-block-start:\s*var\(--pr-gap\)/)
    // 前一件说了算(标题下缘 / 物件下缘)
    expect(code).toMatch(/\.row > \[data-prose='h2'\] \+ \*\s*\{[^}]*var\(--pr-h2-btm\)/)
    expect(code).toMatch(/\.row > \[data-prose='h3'\] \+ \*\s*\{[^}]*var\(--pr-h3-btm\)/)
    expect(code).toMatch(/\.row > \[data-prose='object'\] \+ \*\s*\{[^}]*var\(--pr-obj\)/)
    // 后一件说了算(标题上缘 / 物件上缘)—— 必须排在「前一件」那几条**之后**,
    // 同特异性下后来者胜,这正是 max() 语义的落地方式。
    const prevSide = code.indexOf(".row > [data-prose='object'] + *")
    const nextSide = code.indexOf(".row > * + [data-prose='object']")
    expect(prevSide).toBeGreaterThan(-1)
    expect(nextSide).toBeGreaterThan(prevSide)
    expect(code).toMatch(/\.row > \* \+ \[data-prose='h3'\]\s*\{[^}]*var\(--pr-h3-top\)/)
  })

  it('聊天列的宽度由阅读轴说了算(--pr-col),不再是写死的 --chat-col', () => {
    expect(code).toMatch(/\.column\s*\{[^}]*max-width:\s*var\(--pr-col\)/)
  })
})
