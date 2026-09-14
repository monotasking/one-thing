import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThinkingSegment } from '../ThinkingSegment'
import { textPreview, textToFrame } from '../assemble/text'
import { useStageStore } from '../../stage/store'

/**
 * 思考段的行为(定稿 S2)+ 分块流式(09-14,正本 `docs/thinking-stream-2026-09.md` §4)。
 *
 * 前七条是 S2 那三条行为,一个断言都没动 —— 它们正是「分块没改行为」的证词;
 * 变的只有**props 怎么造**:段模型 09-14 起是「一串块 + 活动尾」,所以这里用真的
 * 装配产地 `textToFrame` 造,不手搓一份形状(手搓的形状迟早与产地分叉)。
 *
 * 后面几条是分块自己的:拼起来逐字等于原文、收起态的 DOM 封顶、以及那句让整件事
 * 成立的话 —— **两帧之间只有最后一个 `<p>` 换了文本**。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  // 选区是 window 上的东西:上一条用例伪造过就会漏给下一条,而「点了收不收」
  // 恰恰全靠它 —— 不复位的话后面每条用例都在别人的选区里跑。
  vi.restoreAllMocks()
})

/** 拨选区:jsdom 的 getSelection 默认给一个空选区,圈选态要手动伪造。 */
function selectSomething(): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection)
}

const thought = () => screen.getByTestId('chat-thought')
const paragraphs = () => Array.from(thought().querySelectorAll('p'))

/**
 * 按真产地造 props。`id` 每次不同 —— 一条用例一条流,车道不许互相污染
 * (流式那一族要连着两帧喂同一个 id,用 `flow()`)。
 */
let lane = 0
function props(text: string, live: boolean) {
  const { blocks, tail } = textToFrame(`case${(lane += 1)}`, text, live)
  return { blocks, tail, live, preview: textPreview(blocks, tail) }
}

/** 一条流:连着喂同一个 id,拿到的就是真的增量帧。 */
function flow(id: string) {
  return (text: string, live = true) => {
    const { blocks, tail } = textToFrame(id, text, live)
    return { blocks, tail, live, preview: textPreview(blocks, tail) }
  }
}

describe('思考段:同一段字的两个读法', () => {
  it('不流时默认收起,点一下展开', () => {
    render(<ThinkingSegment {...props('想了一些事', false)} />)
    expect(thought().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(thought())
    expect(thought().getAttribute('aria-expanded')).toBe('true')
  })

  it('展开后圈着字点一下 —— 不收(否则复制到一半这段就自己关了)', () => {
    render(<ThinkingSegment {...props('想了一些事', false)} />)
    fireEvent.click(thought())
    selectSomething()
    fireEvent.click(thought())
    expect(thought().getAttribute('aria-expanded')).toBe('true')
  })

  it('展开后在空选区处点一下 —— 收起', () => {
    render(<ThinkingSegment {...props('想了一些事', false)} />)
    fireEvent.click(thought())
    fireEvent.click(thought())
    expect(thought().getAttribute('aria-expanded')).toBe('false')
  })

  it('流式中自动展开,收尾自动折 —— 跟着事实走,不替用户记偏好', () => {
    const view = render(<ThinkingSegment {...props('正在想', true)} />)
    expect(thought().getAttribute('aria-expanded')).toBe('true')
    view.rerender(<ThinkingSegment {...props('想完了', false)} />)
    expect(thought().getAttribute('aria-expanded')).toBe('false')
  })

  it('原文照实摆着(收起态靠排版钳一行,不靠截字符串)', () => {
    render(<ThinkingSegment {...props('第一行\n第二行', false)} />)
    expect(thought().textContent).toBe('第一行\n第二行')
  })

  it('键盘也能开合(整块是它自己的开关,没有另设小三角)', () => {
    render(<ThinkingSegment {...props('想了一些事', false)} />)
    fireEvent.keyDown(thought(), { key: 'Enter' })
    expect(thought().getAttribute('aria-expanded')).toBe('true')
  })

  /*
   * 08-31 真机回访 · 报障一。思考段从前不报节奏身份,于是「思考挨着思考」这句话
   * 表里说不出来,只能吃默认段距。报了身份之后 ChatStream 那张表的 ④ 才有落点。
   * 这里钉的是**身份在场**;间距是不是真的变紧由真机门量(jsdom 不排版)。
   */
  it('报得出自己的节奏身份 —— data-prose="thought"', () => {
    render(<ThinkingSegment {...props('想了一些事', false)} />)
    expect(thought().getAttribute('data-prose')).toBe('thought')
  })
})

describe('分块流式(§4)', () => {
  it('分块渲染与「把所有块和尾拼起来」逐字相等(含换行)', () => {
    const frame = flow('join')
    // 先喂几帧,让它真的切出几块来(一帧一块,切点是最后一个换行)。
    frame('第一行\n')
    frame('第一行\n第二行\n')
    const text = '第一行\n第二行\n第三行\n还在写的那一截'
    const last = frame(text)
    expect(last.blocks.length).toBeGreaterThan(1)

    render(<ThinkingSegment {...last} />)
    // 展开态:块 + 尾。
    expect(thought().textContent).toBe(text)
    expect(paragraphs().map((p) => p.textContent).join('')).toBe(text)
  })

  it('收起态只挂预览 —— DOM 里的思考字符 ≤ 260(正文根本不挂载)', () => {
    // 20 万字的那一段(正本 §0 的真机量级)。
    const text = `开头这一行\n${'思'.repeat(200_000)}`
    render(<ThinkingSegment {...props(text, false)} />)
    expect(thought().getAttribute('aria-expanded')).toBe('false')
    expect(thought().textContent!.length).toBeLessThanOrEqual(260)
    // 收起态是一个元素一行字,不是一堆块。
    expect(paragraphs()).toHaveLength(1)
  })

  it('展开·流式中:两帧之间只有最后一个 <p> 换文本,前面的是同一个 DOM 节点', () => {
    const frame = flow('nodes')
    frame('甲行\n')
    const before = frame('甲行\n乙行\n活动尾巴')
    const view = render(<ThinkingSegment {...before} />)
    expect(thought().getAttribute('aria-expanded')).toBe('true')
    const nodesBefore = paragraphs()
    expect(nodesBefore).toHaveLength(3) // 两块(甲行 / 乙行)+ 一条尾
    // 重渲染之前把字抄下来:下面要断言的正是「这个**节点没换**、只是字换了」,
    // 而节点没换就意味着重渲染之后从它身上读到的已经是新字了。
    const tailTextBefore = nodesBefore[2]!.textContent

    // 追加一段**不含换行**的字:切点不动,只有活动尾变长。
    const after = frame('甲行\n乙行\n活动尾巴还在长')
    expect(after.blocks[0]).toBe(before.blocks[0])
    view.rerender(<ThinkingSegment {...after} />)

    const nodesAfter = paragraphs()
    expect(nodesAfter).toHaveLength(3)
    // 冻住那两块:**同一个 DOM 节点、同一段字**(memo 当场返回,浏览器不重排它们)。
    expect(nodesAfter[0]).toBe(nodesBefore[0])
    expect(nodesAfter[1]).toBe(nodesBefore[1])
    expect(nodesAfter.slice(0, 2).map((p) => p.textContent)).toEqual(['甲行\n', '乙行\n'])
    // 活动尾:同一个 DOM 节点(不重挂),只有字换了 —— 每帧的全部代价就在这一格。
    expect(nodesAfter[2]).toBe(nodesBefore[2])
    expect(tailTextBefore).toBe('活动尾巴')
    expect(nodesAfter[2]!.textContent).toBe('活动尾巴还在长')
  })

  it('新冻住一块时,前面那些块的 DOM 节点仍是同一批', () => {
    const frame = flow('grow')
    frame('一\n')
    const before = frame('一\n二\n尾')
    const view = render(<ThinkingSegment {...before} />)
    const firstBefore = paragraphs()[0]!

    // 这一帧里出现了新的换行 → 多冻一块。
    const after = frame('一\n二\n尾巴\n新的尾')
    expect(after.blocks.length).toBeGreaterThan(before.blocks.length)
    view.rerender(<ThinkingSegment {...after} />)
    expect(paragraphs()[0]).toBe(firstBefore)
    expect(thought().textContent).toBe('一\n二\n尾巴\n新的尾')
  })
})
