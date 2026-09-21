import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThinkingSegment } from '../ThinkingSegment'
import { textLatest, textPreview, textToFrame } from '../assemble/text'
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
 *
 * 第二个参数是 **`thinking`**(P1b 裁定 D):「**这一块**思考还在进行」。它与
 * `textToFrame` 吃的那格 `live`(「这条消息还在流」,块冻结的判据)在这些用例里
 * 恰好同值 —— 它们造的都是「消息在流、而这块思考就是最后一件」那一档。两者不同值
 * 的那一档(模型转去写正文了、那块思考不动了)由
 * `assemble/__tests__/assemble.test.ts` 钉:那是**装配**算出来的事实,不是这一件的行为。
 */
let lane = 0
function props(text: string, thinking: boolean) {
  const { blocks, tail } = textToFrame(`case${(lane += 1)}`, text, thinking)
  return {
    blocks,
    tail,
    thinking,
    preview: textPreview(blocks, tail),
    latest: textLatest(blocks, tail),
  }
}

/** 一条流:连着喂同一个 id,拿到的就是真的增量帧。 */
function flow(id: string) {
  return (text: string, thinking = true) => {
    const { blocks, tail } = textToFrame(id, text, thinking)
    return {
      blocks,
      tail,
      thinking,
      preview: textPreview(blocks, tail),
      latest: textLatest(blocks, tail),
    }
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

  /**
   * ── 这一条 2026-09-20 被 G 线 P1 整条推翻(正本 `docs/stream-geometry-2026-09.md`
   *    §2 拍点 1 与 §5.1)────────────────────────────────────────────────────
   * 它从前断言的是「流式中自动展开,收尾自动折 —— 跟着事实走,不替用户记偏好」。
   * 那条行为量出来是两处病:收尾自动折那一帧**一帧内视口被拉走**最多 15,054px,
   * 以及人正读到思考段中部时那段字**被从 DOM 上摘掉**(锚点为 null、上方下移 2094px)。
   * 用户 09-20:「思考段想完自动收起,正在读的人被打断」。
   *
   * 所以旧断言**迁到了它的反面**:流式与否无论怎么翻,`expanded` 一格都不动。
   * 「正在想什么」改由收起态那一行自己说(下一条钉它)。
   */
  it('流式与否翻来翻去都不改开合 —— 自动折叠没有产地了(G 线 P1)', () => {
    const view = render(<ThinkingSegment {...props('正在想', true)} />)
    expect(thought().getAttribute('aria-expanded')).toBe('false')
    view.rerender(<ThinkingSegment {...props('想完了', false)} />)
    expect(thought().getAttribute('aria-expanded')).toBe('false')
  })

  it('用户在流式期间点开:落定之后它**还开着**(不被自动收回)', () => {
    const view = render(<ThinkingSegment {...props('正在想', true)} />)
    fireEvent.click(thought())
    expect(thought().getAttribute('aria-expanded')).toBe('true')
    view.rerender(<ThinkingSegment {...props('想完了', false)} />)
    expect(thought().getAttribute('aria-expanded')).toBe('true')
  })

  /**
   * ── 这一条 2026-09-20(G 线 P1 审查打回第 1 条)改了断言 ─────────────────────
   *
   * 它从前断言 `textContent === '第一行\n第二行'`(原文照实摆着)。那在
   * `line-clamp: 1` 的年代是对的:换行符留在 DOM 里,**钳一行**这件事由排版做。
   * P1 把收起态换成「一行 flex + `block-size` 钉死 + `overflow: hidden`」之后,
   * 留着的换行符会真的断行 —— 屏幕上露出来的变成这 240 字里的**第一行**,
   * 流式那一档因此根本不在显示「最新一截」。
   *
   * 所以「钳成一行」这件事从排版层**搬到了装配层**(`assemble/text.ts` 的 `oneLine`:
   * 连续空白折成一个空格),收起态那一行的字**本来就没有换行符**。
   * 旧断言因此迁成它的新形:原文里的换行在这一行上读作一个空格。
   * **展开态那一侧一个字没动** —— 「blocks + tail 逐字等于原文」由下面那一族钉着。
   */
  it('收起态那一行折成一行:原文的换行在这里读作一个空格', () => {
    render(<ThinkingSegment {...props('第一行\n第二行', false)} />)
    expect(thought().textContent).toBe('第一行 第二行')
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

/**
 * G 线 P1 起**流式中也是收起的**,所以这一族里凡是要看展开态的,都先点一下。
 * 那一下正是今天唯一的开合产地(用户自己点),与这些用例要证的「展开之后块怎么
 * 复用」正交 —— 它不是为了绕过什么,是把「谁把它打开的」这件事说准。
 */
const openIt = () => fireEvent.click(thought())

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
    openIt()
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
    openIt()
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
    openIt()
    const firstBefore = paragraphs()[0]!

    // 这一帧里出现了新的换行 → 多冻一块。
    const after = frame('一\n二\n尾巴\n新的尾')
    expect(after.blocks.length).toBeGreaterThan(before.blocks.length)
    view.rerender(<ThinkingSegment {...after} />)
    expect(paragraphs()[0]).toBe(firstBefore)
    expect(thought().textContent).toBe('一\n二\n尾巴\n新的尾')
  })
})

/**
 * ── 收起态那一行:两个读法(G 线 P1,正本 `docs/stream-geometry-2026-09.md` §5.1)──
 *
 * 「高度逐像素相同」是排版,jsdom 量不出来(它不排版)——那一半由真机门
 * `gate:stream-geometry` 量(思考段 live 期间高度变化 0、落定帧高度变化 0)。
 * 这一层钉的是**挂的是哪一段字**、**报不报 `data-live`**、以及那句让整件事成立的话:
 * 不论哪一态,DOM 里都只有 ≤240 字。
 */
describe('收起态那一行:这块思考还在进行时看末尾,想完了看开头', () => {
  /** 一段带换行的长思考:冻得出块,而且首尾两截**不一样**(不然这组用例证不了东西)。 */
  const LONG = `${'开头'.repeat(200)}\n${'中段'.repeat(200)}\n${'结尾'.repeat(200)}`
  /** 与装配层那一手同形:连续空白折成一个空格,两端修掉(`assemble/text.ts` 的 `oneLine`)。 */
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

  it('这块思考还在进行:那一行挂的是**末尾**那一截,并报 data-live', () => {
    const p = props(LONG, true)
    render(<ThinkingSegment {...p} />)
    const line = thought().querySelector('p')!
    expect(line.getAttribute('data-live')).toBe('')
    expect(line.textContent).toBe(p.latest)
    // 末尾那一截:折成一行之后,它仍然以原文的结尾收口。
    expect(oneLine(LONG).endsWith(line.textContent!)).toBe(true)
    // 而且**不是开头** —— 这一条才是审查打回那个 bug 的反面。
    expect(oneLine(LONG).startsWith(line.textContent!)).toBe(false)
  })

  it('这块思考想完了:换回**开头**那一截,`data-live` 不在了', () => {
    const p = props(LONG, false)
    render(<ThinkingSegment {...p} />)
    const line = thought().querySelector('p')!
    expect(line.hasAttribute('data-live')).toBe(false)
    expect(line.textContent).toBe(p.preview)
    expect(oneLine(LONG).startsWith(line.textContent!)).toBe(true)
  })

  /**
   * **一行就是一行**:两态挂出去的字里一个换行符都不许有。
   * 这一条是审查打回那个 bug 的**直接**守卫 —— 留着换行符,CSS 那边不论写 `pre`
   * 还是 `nowrap` 都救不回来(`pre` 断行、`nowrap` 把换行读成空格但**装配层的
   * 240 字额度已经被换行吃掉了**),所以判据落在字上,不落在样式上。
   */
  it('两态的字里都没有换行符(钳一行在装配层做,不在排版层做)', () => {
    for (const thinking of [true, false]) {
      const p = props(LONG, thinking)
      expect(p.latest).not.toMatch(/\s\s|\n/)
      expect(p.preview).not.toMatch(/\s\s|\n/)
    }
  })

  it('两态都只挂 ≤240 字 —— 6 万字的思考在 DOM 里仍然是一行', () => {
    const huge = `开头这一行\n${'思'.repeat(60_000)}`
    const view = render(<ThinkingSegment {...props(huge, true)} />)
    expect(thought().textContent!.length).toBeLessThanOrEqual(240)
    view.rerender(<ThinkingSegment {...props(huge, false)} />)
    expect(thought().textContent!.length).toBeLessThanOrEqual(240)
  })

  /**
   * 「短于一行」那一档:两态挂的是**同一段字**(整段都不到 240 字,首尾两截重合)。
   * 屏幕上它俩也该长得一模一样 —— 左起、不裁 —— 那一半归 CSS
   * (`.thoughtLine` 的 `min-inline-size: 100%`),这里钉的是字相同。
   */
  it('整段短于 240 字:两态是同一段字(没有「换了内容」这回事)', () => {
    const short = '想了一下下'
    const live = props(short, true)
    const settled = props(short, false)
    expect(live.latest).toBe(short)
    expect(settled.preview).toBe(short)
  })
})

/**
 * `textLatest` 自己那张表(纯函数,零 DOM)。它的合同有两句:**取末尾 240 字**,
 * 而且**每帧代价与历史长度无关** —— 后者的写法判据是「只碰活动尾与最后一块」,
 * 由下面第三条钉:给它一百万字的历史块,答案里一个历史块的字都不许出现。
 */
describe('textLatest:末尾那一截', () => {
  const block = (id: string, text: string) => ({ id, text })

  it('活动尾自己就够长:整截都从尾里切', () => {
    const tail = '尾'.repeat(500)
    expect(textLatest([block('b0', '历史')], tail)).toBe('尾'.repeat(240))
  })

  it('尾不够长:从**最后一块**往回借,拼起来正好 240', () => {
    const out = textLatest([block('b0', '甲'.repeat(100)), block('b1', '乙'.repeat(500))], '丙'.repeat(40))
    expect(out).toHaveLength(240)
    expect(out.endsWith('丙'.repeat(40))).toBe(true)
    // 借的是 b1(最后一块),b0 一个字都不许进来。
    expect(out).not.toContain('甲')
  })

  it('整段比 240 还短:原样交出去(短于一行时照常从左起的那一档)', () => {
    expect(textLatest([block('b0', '一二三')], '四五')).toBe('一二三四五')
  })

  /**
   * ── 审查打回第 1 条的守卫(2026-09-20)──────────────────────────────────
   * 真实思考正文满是 `\n`。不折的话这 240 字在一行高的盒子里排成好几行,
   * 屏幕上露出来的是**第一行** —— 流式那一档因此根本不在显示「最新一截」。
   * 判据落在**字**上(装配层),不落在样式上:CSS 那边救不回来,因为 240 字的
   * 额度已经被换行吃掉了。
   */
  it('换行折成一个空格,两端修掉 —— 交出去的就是一行', () => {
    const out = textLatest([block('b0', '甲\n\n乙')], '\n丙  丁\n')
    expect(out).toBe('甲 乙 丙 丁')
    expect(out).not.toMatch(/[\n\r\t]/)
  })

  it('末尾那一截折完仍然以原文的结尾收口(不是开头)', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第 ${i} 行的字`).join('\n')
    const out = textLatest([block('b0', text)], '')
    const flat = text.replace(/\s+/g, ' ').trim()
    expect(flat.endsWith(out)).toBe(true)
    expect(flat.startsWith(out)).toBe(false)
  })

  it('**不吃历史**:一百万字的历史块在场,答案里一个字都没有它', () => {
    const history = Array.from({ length: 50 }, (_, i) => block(`b${i}`, '史'.repeat(20_000)))
    const out = textLatest([...history, block('last', '近'.repeat(300))], '新')
    expect(out).toHaveLength(240)
    expect(out).not.toContain('史')
  })
})
