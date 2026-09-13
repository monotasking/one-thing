import { describe, expect, it } from 'vitest'
import {
  appendTail,
  applyToolProgress,
  tailTextLength,
  feedTail,
  feedTailToolArgs,
  reconcileOverlay,
  handOverToLedger,
  startTailTool,
  type FoldLens,
  userMessageIds,
  type OverlayEntry,
  type PendingSend,
  type ProjectedMessage,
} from './chat-fold'

/**
 * 屏幕树的纯函数半边。这一层不认识 core、不认识网络 —— 它只回答三个问题:
 * 一截 delta 该挂在哪、尾巴怎么接到折叠产物上、哪一格 overlay 已经被账本接管了。
 */

const message = (over: Partial<ProjectedMessage> & { id: string }): ProjectedMessage =>
  ({ role: 'assistant', content: '', timestamp: 0, ...over }) as ProjectedMessage

describe('活尾巴:只追加文本,一个结构决策都不做', () => {
  it('同类连续的 delta 归同一截,换了种就是新的一截', () => {
    let tail = feedTail(undefined, 'a1', 'text', '你')
    tail = feedTail(tail, 'a1', 'text', '好')
    tail = feedTail(tail, 'a1', 'reasoning', '想', 'inline')
    expect(tail?.segments).toEqual([
      { kind: 'text', text: '你好' },
      { kind: 'reasoning', text: '想' },
    ])
  })

  it('换了消息就换一条尾巴 —— 上一条的字不许跟过来', () => {
    const first = feedTail(undefined, 'a1', 'text', '上一条')
    const second = feedTail(first, 'a2', 'text', '下一条')
    expect(second?.messageId).toBe('a2')
    expect(second?.segments).toEqual([{ kind: 'text', text: '下一条' }])
  })

  it('顶部推理落在 reasoning,不进 segments(8d72e236 的两条回归)', () => {
    const tail = feedTail(undefined, 'a1', 'reasoning', '先想想', 'top')
    expect(tail?.reasoningTop).toBe('先想想')
    expect(tail?.segments).toEqual([])
  })

  it('placement 缺席时按「这条消息还没有正文 = top」兜底', () => {
    expect(feedTail(undefined, 'a1', 'reasoning', '甲', undefined, false)?.reasoningTop).toBe('甲')
    expect(feedTail(undefined, 'a1', 'reasoning', '乙', undefined, true)?.segments).toEqual([
      { kind: 'reasoning', text: '乙' },
    ])
  })

  it('空文本 / 空 messageId 一律不进尾巴', () => {
    expect(feedTail(undefined, 'a1', 'text', '')).toBeUndefined()
    expect(feedTail(undefined, '', 'text', '有字')).toBeUndefined()
  })
})

describe('接尾巴:只延长最后那一段,不回头找', () => {
  it('第一截延长账本的末段,其后每一截自己起一格', () => {
    const tail = feedTail(feedTail(undefined, 'a1', 'text', '续'), 'a1', 'reasoning', '想', 'inline')
    const out = appendTail(
      [message({ id: 'a1', content: '已落账', contentParts: [{ type: 'text', content: '已落账' }] })],
      tail,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '已落账续' },
      { type: 'reasoning', content: '想' },
    ])
    expect(out[0].content).toBe('已落账续')
  })

  it('新的行内推理不许被追加进上一个推理块(症状 1:两个思考块)', () => {
    const tail = feedTail(undefined, 'a1', 'reasoning', '第二段思考', 'inline')
    const out = appendTail(
      [
        message({
          id: 'a1',
          contentParts: [
            { type: 'reasoning', content: '第一段思考' },
            { type: 'text', content: '中间的正文' },
          ],
        }),
      ],
      tail,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'reasoning', content: '第一段思考' },
      { type: 'text', content: '中间的正文' },
      { type: 'reasoning', content: '第二段思考' },
    ])
  })

  it('顶部推理接到 message.reasoning 上,不进 contentParts(症状 3:串味)', () => {
    const tail = feedTail(undefined, 'a1', 'reasoning', '再想', 'top')
    const out = appendTail([message({ id: 'a1', reasoning: '先想' })], tail)
    expect(out[0].reasoning).toBe('先想再想')
    expect(out[0].contentParts ?? []).toEqual([])
  })

  it('账本还没有 parts 时先按 content 搭一格,尾巴延长它(打包行回缩病)', () => {
    // 真机的形:流式中 materialize 不产 contentParts(到 request/end 才有),
    // 打包行把尾巴收走后,折叠的正文只活在 content 里。修前这里会产出
    // [{text:'影,不存 d'}] —— parts 非空,anchor 不再按 content 兜底,
    // 被打包的那一大段正文从屏幕上消失。
    const tail = feedTail(undefined, 'a1', 'text', '影,不存 d')
    const out = appendTail([message({ id: 'a1', content: '打包行收走的那一大段正文,一切皆投' })], tail)
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '打包行收走的那一大段正文,一切皆投影,不存 d' },
    ])
    expect(out[0].content).toBe('打包行收走的那一大段正文,一切皆投影,不存 d')
  })

  it('尾巴认不出主人(那条消息还没折出来)就整段不接', () => {
    const tail = feedTail(undefined, 'ghost', 'text', '孤儿')
    const messages = [message({ id: 'a1', content: '原样' })]
    expect(appendTail(messages, tail)).toEqual(messages)
  })
})

/**
 * 交接:**账本这一刻多画得出来多少,尾巴就交出多少**。
 *
 * 这一组翻掉了旧的「打包行按自己的字符数带走一截」(旧 `trimTailByChunks` 与它的
 * 四条用例)。09-01 用户录屏报障、真机探针复现:打包行只说明「这一截进账本了」,
 * **不说明「画得出来」** —— 行内推理在流式期间在账本投影里一个字都没有(它要等
 * `contentParts` 物化),按字符数裁就把它裁进了两边都没有的空档,屏幕上整块消失
 * 2166ms。判据因此换成长度差,活路与重折共用同一条。
 */
const NOTHING: FoldLens = { content: 0, reasoningTop: 0, reasoningInline: 0 }

describe('交接:账本画得出来多少,尾巴就交出多少', () => {
  it('账本长了一截:尾巴交出等长前缀,后面攒的 delta 留着', () => {
    const tail = feedTail(feedTail(undefined, 'a1', 'text', '前一截'), 'a1', 'text', '后一截')
    const out = handOverToLedger(tail, NOTHING, { ...NOTHING, content: '前一截'.length })
    expect(out.tail?.segments).toEqual([{ kind: 'text', text: '后一截' }])
  })

  it('账本盖过了尾巴的全部:尾巴退场', () => {
    const tail = feedTail(undefined, 'a1', 'text', '全部内容')
    expect(handOverToLedger(tail, NOTHING, { ...NOTHING, content: 99 }).tail).toBeUndefined()
  })

  it('账本没长(打包行进来了但 parts 还没物化):尾巴一个字不动', () => {
    const tail = feedTail(undefined, 'a1', 'text', '正文')
    const lens = { ...NOTHING, content: 7 }
    expect(handOverToLedger(tail, lens, lens).tail).toEqual(tail)
  })

  it('账本反而更短(message/patched 剥字段这类):什么都不裁', () => {
    const tail = feedTail(undefined, 'a1', 'text', '正文')
    expect(handOverToLedger(tail, { ...NOTHING, content: 9 }, NOTHING).tail).toEqual(tail)
  })

  /*
   * 这一条是 09-01 那条报障的**正靶**:打包行把行内推理送进了账本,但账本此刻
   * 画不出它(`contentParts` 还没物化,`reasoningInline` 还是 0)。尾巴必须留着
   * 它 —— 交出去就是屏幕上两边都没有。
   */
  it('行内推理:parts 没物化就一个字不交(病历:思考块消失 2 秒)', () => {
    let tail = feedTail(undefined, 'a1', 'text', '这段正文')
    tail = feedTail(tail, 'a1', 'reasoning', '一段思考', 'inline')
    // 正文那截进了账本(content 涨了两个字),行内推理没有产地(reasoningInline 不动)。
    const out = handOverToLedger(tail, NOTHING, { ...NOTHING, content: '这段'.length })
    expect(out.tail?.segments).toEqual([
      { kind: 'text', text: '正文' },
      // ← 修前这一格会被按打包行的字符数裁掉,而账本此刻画不出它:屏幕上整块消失。
      { kind: 'reasoning', text: '一段思考' },
    ])
  })

  it('parts 物化那一刻:行内推理一次交清,不重影', () => {
    let tail = feedTail(undefined, 'a1', 'text', '这段正文')
    tail = feedTail(tail, 'a1', 'reasoning', '一段思考', 'inline')
    const out = handOverToLedger(tail, NOTHING, {
      content: '这段正文'.length,
      reasoningTop: 0,
      reasoningInline: '一段思考'.length,
    })
    expect(out.tail).toBeUndefined()
  })

  it('三条车道互不越界:顶部推理的尺裁不动行内推理那一截', () => {
    let tail = feedTail(undefined, 'a1', 'reasoning', '顶部想', 'top')
    tail = feedTail(tail, 'a1', 'text', '正文')
    tail = feedTail(tail, 'a1', 'reasoning', '行内想', 'inline')
    // 顶部推理的尺给得再大,也只吃掉 reasoningTop —— 从前两者共用一格,溢出会串仓。
    const out = handOverToLedger(tail, NOTHING, { ...NOTHING, reasoningTop: 99 })
    expect(out.tail?.reasoningTop).toBe('')
    expect(out.tail?.segments).toEqual([
      { kind: 'text', text: '正文' },
      { kind: 'reasoning', text: '行内想' },
    ])
  })

  it('顶部推理交清了,后面的正文才轮得到(引用素材下不裁会接成懒续行)', () => {
    let tail = feedTail(undefined, 'a1', 'reasoning', '想了又想', 'top')
    tail = feedTail(tail, 'a1', 'text', '> 引用行\n后续正文')
    const out = handOverToLedger(tail, NOTHING, {
      content: '> 引用行\n'.length,
      reasoningTop: '想了又想'.length,
      reasoningInline: 0,
    })
    expect(out.tail?.reasoningTop).toBe('')
    expect(out.tail?.segments).toEqual([{ kind: 'text', text: '后续正文' }])
    expect(out.taken).toEqual({ content: '> 引用行\n'.length, reasoningTop: 4, reasoningInline: 0 })
  })

  /*
   * **顺序闸**:交接从前往后走,一遇到交不干净的就停 —— 它后面的一律不交。
   *
   * 理由不是保守。账本在流式期间只有一格扁平的 `message.content`(全部正文折在
   * 一起),表达不了「正文、思考、正文」的交替:前面那截思考还交不出去,后面的
   * 正文却交了,那截正文就会被账本那一格拉到最前面,思考段整块搬家。修第一版时
   * 真机探针抓到的正是这一形(t=4.8s:`think|text|表|text|think(205)`,两段思考并了)。
   */
  it('前面那截交不干净,后面的一律不交(顺序闸)', () => {
    let tail = feedTail(undefined, 'a1', 'reasoning', '想了又想', 'top')
    tail = feedTail(tail, 'a1', 'text', '后面的正文')
    // 顶部推理只交得出一半,正文那格的额度再多也不许动。
    const out = handOverToLedger(tail, NOTHING, {
      content: 99,
      reasoningTop: '想了'.length,
      reasoningInline: 0,
    })
    expect(out.tail?.reasoningTop).toBe('又想')
    expect(out.tail?.segments).toEqual([{ kind: 'text', text: '后面的正文' }])
    expect(out.taken.content).toBe(0)
  })

  it('行内推理挡在前面时,它后面的正文也留在尾巴里(顺序闸)', () => {
    let tail = feedTail(undefined, 'a1', 'reasoning', '一段思考', 'inline')
    tail = feedTail(tail, 'a1', 'text', '思考之后的正文')
    const out = handOverToLedger(tail, NOTHING, { ...NOTHING, content: 99 })
    expect(out.tail?.segments).toEqual([
      { kind: 'reasoning', text: '一段思考' },
      { kind: 'text', text: '思考之后的正文' },
    ])
    expect(out.taken.content).toBe(0)
  })
})

describe('接尾巴:账本那一格只画到交接线为止', () => {
  it('给了 coverage 就只画那么长 —— 剩下的那截还在尾巴里,画整格就是画两遍', () => {
    // 真机的形:正文 A 交接了,思考挡在中间,正文 B 虽然进了账本的 content
    // 却还留在尾巴里。整格画出来 = B 出现两次,而且排在思考**前面**。
    let tail = feedTail(undefined, 'a1', 'reasoning', '思考', 'inline')
    tail = feedTail(tail, 'a1', 'text', '正文B')
    const out = appendTail([message({ id: 'a1', content: '正文A正文B' })], tail, '正文A'.length)
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '正文A' },
      { type: 'reasoning', content: '思考' },
      { type: 'text', content: '正文B' },
    ])
  })

  it('coverage 缺席 = 不设限(整格画完),与从前逐字相同', () => {
    const tail = feedTail(undefined, 'a1', 'text', '尾')
    const out = appendTail([message({ id: 'a1', content: '账本正文' })], tail)
    expect(out[0].contentParts).toEqual([{ type: 'text', content: '账本正文尾' }])
  })

  it('coverage 为 0:账本那一格一个字都不画,屏幕上只有尾巴', () => {
    const tail = feedTail(undefined, 'a1', 'text', '全在尾巴里')
    const out = appendTail([message({ id: 'a1', content: '全在尾巴里' })], tail, 0)
    expect(out[0].contentParts).toEqual([{ type: 'text', content: '全在尾巴里' }])
  })
})

/**
 * ── 锚点维(09-01 P0)────────────────────────────────────────────────────
 *
 * 真机报障:多轮工具的第二轮正文**先画在工具组上面 191ms,再整段消失 992ms**,
 * 等锚点物化才跳到正确位置(帧证抄在 `FoldLens.contentPlaceable` 的注里)。
 *
 * 病根两半,这一组各钉一半:
 *  · 尺错 —— 账本的 `message.content` 是**全部**正文(不看这一轮收没收齐),而
 *    `contentParts` 只有已结算那几轮。parts 还没物化时把正文交给那条扁平车道,
 *    parts 一物化(那时只画 parts)那一截当场没了;
 *  · 落点错 —— 扁平车道那一格是 turn 盲的,合成出来的工具锚点会跨到它后面。
 */
describe('锚点维:parts 没物化前,新一轮的正文不许交给扁平车道', () => {
  it('contentPlaceable 为 false:正文额度 0(推理那两条车道照旧)', () => {
    let tail = feedTail(undefined, 'a1', 'text', '第二轮正文', undefined, undefined, 2)
    tail = feedTail(tail, 'a1', 'reasoning', '第二轮想', 'inline', true, 2)
    const out = handOverToLedger(tail, NOTHING, {
      // 账本的 content 已经涨到装得下这一截了 —— 但它此刻摆不对。
      content: 99,
      reasoningTop: 0,
      reasoningInline: 0,
      contentPlaceable: false,
    })
    expect(out.taken.content).toBe(0)
    expect(out.tail?.segments).toEqual([
      { kind: 'text', text: '第二轮正文', turnIndex: 2 },
      { kind: 'reasoning', text: '第二轮想', turnIndex: 2 },
    ])
  })

  it('缺席 = 摆得对(没有工具活儿的消息永远是这样),与从前逐字相同', () => {
    const tail = feedTail(undefined, 'a1', 'text', '正文')
    expect(handOverToLedger(tail, NOTHING, { ...NOTHING, content: 2 }).taken.content).toBe(2)
  })

  it('换了轮次就是新的一段 —— 两轮正文中间隔着那一轮的工具', () => {
    let tail = feedTail(undefined, 'a1', 'text', '第一轮', undefined, undefined, 1)
    tail = feedTail(tail, 'a1', 'text', '第二轮', undefined, undefined, 2)
    expect(tail?.segments).toEqual([
      { kind: 'text', text: '第一轮', turnIndex: 1 },
      { kind: 'text', text: '第二轮', turnIndex: 2 },
    ])
  })
})

describe('接尾巴:账本 parts 画不到的那一截照样画,而且带轮次号', () => {
  it('parts 只装了第一轮,第二轮那截从 content 里补出来(消失 992ms 的那一格)', () => {
    // 真机的形:第一轮的 request 结算了(parts 有它),第二轮还在流 —— 它的正文
    // 只活在 content 里。修前 parts 一非空就不画 content,那一截两边都没有。
    const tail = feedTail(undefined, 'a1', 'text', '还在尾巴里', undefined, undefined, 2)
    const out = appendTail(
      [
        message({
          id: 'a1',
          content: '第一轮正文第二轮已打包',
          contentParts: [{ type: 'text', content: '第一轮正文', turnIndex: 1 }],
        } as never),
      ],
      tail,
      '第一轮正文第二轮已打包'.length,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '第一轮正文', turnIndex: 1 },
      // 补出来的那一截跟着尾巴那一轮 —— 不带轮次号的话它算第 0 轮,
      // 第一轮的工具锚点会插到它**后面**去。它与尾巴那一段同轮同种,合成一格
      // (它们本来就是同一段话的前后半截:前半截已打包,后半截还在路上)。
      { type: 'text', content: '第二轮已打包还在尾巴里', turnIndex: 2 },
    ])
  })

  /*
   * 09-01 用户真机证词:「markdown 的渲染很奇怪,它会显示原始字符串,其实 table
   * 已经画出来了」—— 同一截内容被画了两遍(一份成了表,一份还是原始 markdown)。
   *
   * 构造的正是那一形:一张表流到一半,账本的 parts **一次物化**把整张表都装了进去,
   * 而交接线还停在半路 —— 尾巴手里还攥着最后一行。少了那道显示不变量,那一行会被
   * 账本画一次、尾巴再画一次。
   */
  const TABLE = '| 项 | 值 |\n| --- | --- |\n| 甲 | 一 |\n| 乙 | 二 |'
  const HALF = TABLE.length - '| 乙 | 二 |'.length

  it('账本已经画过的字,尾巴不再画一遍(证词:表画出来了,原始字符串还在)', () => {
    const tail = feedTail(undefined, 'a1', 'text', '| 乙 | 二 |', undefined, undefined, 1)
    const out = appendTail(
      [
        message({
          id: 'a1',
          content: TABLE,
          // parts 一次物化:整张表都在账本里了。
          contentParts: [{ type: 'text', content: TABLE, turnIndex: 1 }],
        } as never),
      ],
      tail,
      // …而交接线还停在最后一行之前。
      HALF,
    )
    expect(out[0].contentParts).toEqual([{ type: 'text', content: TABLE, turnIndex: 1 }])
    expect(out[0].content).toBe(TABLE)
  })

  it('只剪重叠的那几个字,后面新到的一截照画', () => {
    const tail = feedTail(undefined, 'a1', 'text', '| 乙 | 二 |\n| 丙 | 三 |', undefined, undefined, 1)
    const out = appendTail(
      [
        message({
          id: 'a1',
          content: TABLE,
          contentParts: [{ type: 'text', content: TABLE, turnIndex: 1 }],
        } as never),
      ],
      tail,
      HALF,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: `${TABLE}\n| 丙 | 三 |`, turnIndex: 1 },
    ])
  })

  it('重叠只从正文那几段里剪 —— 推理走的是另一条车道,不许被正文的账剪掉', () => {
    let tail = feedTail(undefined, 'a1', 'reasoning', '想了想', 'inline', true, 1)
    tail = feedTail(tail, 'a1', 'text', '重复的一段', undefined, undefined, 1)
    const out = appendTail(
      [
        message({
          id: 'a1',
          content: '账本正文重复的一段',
          contentParts: [{ type: 'text', content: '账本正文重复的一段', turnIndex: 1 }],
        } as never),
      ],
      tail,
      '账本正文'.length,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '账本正文重复的一段', turnIndex: 1 },
      { type: 'reasoning', content: '想了想', turnIndex: 1 },
    ])
  })

  it('跨轮不合并:上一轮那一格不许被这一轮的尾巴延长', () => {
    const tail = feedTail(undefined, 'a1', 'text', '第二轮', undefined, undefined, 2)
    const out = appendTail(
      [
        message({
          id: 'a1',
          content: '第一轮',
          contentParts: [{ type: 'text', content: '第一轮', turnIndex: 1 }],
        } as never),
      ],
      tail,
      '第一轮'.length,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '第一轮', turnIndex: 1 },
      { type: 'text', content: '第二轮', turnIndex: 2 },
    ])
  })

  it('同轮同种照旧延长(轮次号两边都缺席也算同一轮)', () => {
    const tail = feedTail(undefined, 'a1', 'text', '续', undefined, undefined, 1)
    const out = appendTail(
      [
        message({
          id: 'a1',
          content: '已落账',
          contentParts: [{ type: 'text', content: '已落账', turnIndex: 1 }],
        } as never),
      ],
      tail,
      '已落账'.length,
    )
    expect(out[0].contentParts).toEqual([{ type: 'text', content: '已落账续', turnIndex: 1 }])
  })
})

/**
 * ── 活调用车道(09-01 P1)──────────────────────────────────────────────
 *
 * 真机读数:`tool:input-start` t=1693ms,`tool/call` 落账 t=1929ms,打包行
 * t=1988ms —— 参数逐片到达的那 295ms 屏幕上**什么都没有**。
 */
describe('活调用:参数还在流的那一次,由尾巴顶着', () => {
  it('开卡 + 参数逐片进来,挂进 toolCalls 且状态是 input-streaming', () => {
    let tail = startTailTool(undefined, 'a1', 'call_a', 'time', 111, 900)
    tail = feedTailToolArgs(tail, 'a1', 'call_a', '{"timezone":', 950)
    tail = feedTailToolArgs(tail, 'a1', 'call_a', '"Asia/Shanghai"}', 1000)
    const out = appendTail([message({ id: 'a1', content: '我查一下' })], tail)
    expect(out[0].toolCalls).toEqual([
      {
        id: 'call_a',
        toolId: 'time',
        toolName: 'time',
        arguments: {},
        status: 'input-streaming',
        timestamp: 111,
        streamingArgs: '{"timezone":"Asia/Shanghai"}',
        // 活性读数(§6.6):**上一次收到数据**的本机时刻,每收一片就往前推 ——
        // 不是建卡那一刻(900),也不是事件里那个 timestamp(111)。
        liveAt: 1000,
      },
    ])
  })

  it('同一个 id 再开一次不重复建卡(重连回放会把同一条事件送两遍)', () => {
    let tail = startTailTool(undefined, 'a1', 'call_a', 'time', 111)
    tail = startTailTool(tail, 'a1', 'call_a', 'time', 222)
    expect(tail?.tools).toHaveLength(1)
  })

  it('没建过卡的 id 一律不认 —— 名字只有 input-start 说得出', () => {
    const tail = feedTailToolArgs(startTailTool(undefined, 'a1', 'call_a', 'time', 1), 'a1', 'ghost', '{}')
    expect(tail?.tools.map((tool) => tool.argsText)).toEqual([''])
  })

  it('账本认领了这个 id,尾巴这一份当场退役(按身份,不按长度)', () => {
    const tail = startTailTool(undefined, 'a1', 'call_a', 'time', 111)
    const out = handOverToLedger(tail, NOTHING, {
      ...NOTHING,
      ledgerToolCallIds: new Set(['call_a']),
    })
    expect(out.tail).toBeUndefined()
  })

  it('账本已经有这次调用时一格都不多画(少一张是说谎,多一张是重影)', () => {
    const tail = startTailTool(undefined, 'a1', 'call_a', 'time', 111)
    const ledgerCall = { id: 'call_a', toolId: 'time', toolName: 'time', arguments: {}, status: 'completed', timestamp: 1 }
    const out = appendTail([message({ id: 'a1', toolCalls: [ledgerCall] } as never)], tail)
    expect(out[0].toolCalls).toEqual([ledgerCall])
  })
})

/**
 * ── 交接线 = 收到多少 − 还剩多少(09-01 自查走查)──────────────────────
 *
 * 从前交接线是**累加** `taken.content` 攒出来的。累加会漂,而漂在表格上的代价不是
 * 「少两个字」:分隔行多一格或少几个字,表头 8 列对不上分隔行,GFM 当场判它不是表
 * —— 屏幕上整张表退回裸文本 350ms+(自查 3 轮 2 复现)。
 */
describe('尾巴手里还剩多少正文', () => {
  it('只数正文那条车道 —— 推理不进 message.content', () => {
    let tail = feedTail(undefined, 'a1', 'text', '正文一', undefined, undefined, 1)
    tail = feedTail(tail, 'a1', 'reasoning', '想了想', 'inline', true, 1)
    tail = feedTail(tail, 'a1', 'text', '正文二', undefined, undefined, 1)
    expect(tailTextLength(tail)).toBe(6)
  })

  it('没有尾巴 = 0', () => {
    expect(tailTextLength(undefined)).toBe(0)
  })
})

/**
 * ── 尾巴刚交清的那一瞬,账本那一截照样要画(09-01 自查帧证)────────────
 *
 * `t=3659` 一帧里块数 2→0、正文 786→371,下一帧原样回来。病根是 `appendTail`
 * 开头那句 `if (!tail) return list`:尾巴一交清就整个掉头,于是「账本 parts 还
 * 画不到的那一截」——多轮消息里**还没结算的这一轮**的全部正文 —— 也没人画。
 */
describe('没有尾巴时:账本 parts 画不到的那一截照样画', () => {
  it('parts 只装了第一轮,第二轮那截照画(尾巴不在场)', () => {
    const out = appendTail(
      [
        message({
          id: 'a1',
          isStreaming: true,
          content: '第一轮正文第二轮已打包',
          contentParts: [{ type: 'text', content: '第一轮正文', turnIndex: 1 }],
        } as never),
      ],
      undefined,
    )
    expect(out[0].contentParts).toEqual([
      { type: 'text', content: '第一轮正文', turnIndex: 1 },
      { type: 'text', content: '第二轮已打包' },
    ])
  })

  it('没有尾巴、也没有要补的那一截 = 消息对象**引用不变**(物化 memo 的契约)', () => {
    const only = message({
      id: 'a1',
      isStreaming: true,
      content: '都结算过了',
      contentParts: [{ type: 'text', content: '都结算过了', turnIndex: 1 }],
    } as never)
    const out = appendTail([only], undefined)
    expect(out[0]).toBe(only)
  })

  it('没有尾巴、也没有在流的消息 = 整份原样', () => {
    const settled = message({ id: 'a1', content: '收工了' })
    const out = appendTail([settled], undefined)
    expect(out[0]).toBe(settled)
  })
})

describe('overlay:以折叠为准的认领', () => {
  const pending = (
    id: string,
    text: string,
    seen: string[] = [],
    status: 'sending' | 'failed' = 'sending',
  ): PendingSend => ({ id, kind: 'pending', text, attachments: 0, status, seenUserIds: seen })

  it('账本长出同一句话 = 那一格 pending 被接管,丢掉', () => {
    const out = reconcileOverlay(
      [pending('o1', '发一句')],
      [message({ id: 'm1', role: 'user', content: '发一句' })],
    )
    expect(out).toEqual([])
  })

  /**
   * **病 ① 的账**(09-12 真机:@ 一个文件发出去,屏幕上留下两条用户气泡,
   * 其中一条是裸的 `{{file:/Users/…}}` 且永不消失)。
   *
   * 认领判据是「正文逐字相同」—— 它没有病,病的是从前有**两句话**:乐观 overlay
   * 记的是草稿原文(token 句),账本落的是展开句(`@<绝对路径>`),于是那一格
   * pending 永远等不到自己那条消息。修法在上游(`ComposerInput.readDraft` 交出去
   * 的就已经是展开句),这两条把「修好之后」与「病着的时候」各钉一遍。
   */
  it('展开句对展开句 = 认领得上(修好之后的形)', () => {
    const out = reconcileOverlay(
      [pending('o1', '看看 @/abs/x.ts')],
      [message({ id: 'm1', role: 'user', content: '看看 @/abs/x.ts' })],
    )
    expect(out).toEqual([])
  })

  it('token 句对展开句 = 认不上,那一格永远留在屏上(病着的时候的形)', () => {
    const out = reconcileOverlay(
      [pending('o1', '看看 {{file:/abs/x.ts}}')],
      [message({ id: 'm1', role: 'user', content: '看看 @/abs/x.ts' })],
    )
    // 这正是用户看见的第二条气泡 —— 它不是多发了一条,是一格没人认领的乐观 overlay。
    expect(out.map((entry) => entry.id)).toEqual(['o1'])
  })

  it('快照里已有的那条不算认领 —— 连发同一句话不会一次消掉两格', () => {
    const out = reconcileOverlay(
      [pending('o1', '同一句', []), pending('o2', '同一句', ['m1'])],
      [message({ id: 'm1', role: 'user', content: '同一句' })],
    )
    // m1 被 o1 认领(它不在 o1 的快照里);o2 的快照里已经有 m1,继续等自己那条。
    expect(out.map((entry) => entry.id)).toEqual(['o2'])
  })

  it('失败的那一格不认领 —— 它说的正是「这条没到账本」,留着让人重试', () => {
    const failed = pending('o1', '发一句', [], 'failed')
    const out = reconcileOverlay([failed], [message({ id: 'm1', role: 'user', content: '发一句' })])
    expect(out).toHaveLength(1)
  })

  /**
   * **病 ② 的账**(09-13 真机第二次报障,`a00e1728` 治的是记号句、没治到根)。
   *
   * 真账本形状(`~/.onething/sessions/2bd6d352…/events.jsonl` 第 21 条,
   * 逐字缩样):`content` 是引擎跑完 `expandFileMentions` 之后的**模型版** ——
   * 一整份 34KB 的 `<file>` 块;`contentParts` 才是壳发出去的那 55 个字。
   * 「正文逐字相同」在这条路上**结构上不可能成立**:比的两句话从来就不是同一句。
   */
  const FILE_BODY = '-- ChatBot.lua\n'.repeat(2000)
  const fileModelContent =
    `<file path="/Users/me/ChatBot.lua" lines="1995" shown="1-773">\n${FILE_BODY}\n</file>`

  it('@ 文件:账本上的 content 是模型版 → 认领靠 messageId(改后的形)', () => {
    const entry: PendingSend = {
      ...pending('o1', '@/Users/me/ChatBot.lua'),
      messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }
    const out = reconcileOverlay(
      [entry],
      [
        message({
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          role: 'user',
          content: fileModelContent,
          contentParts: [{ type: 'text', content: '@/Users/me/ChatBot.lua' }],
        } as never),
      ],
    )
    expect(out).toEqual([])
  })

  /**
   * **反证**:同一份夹具,那一格没有 `messageId`(= 改动之前的形)。正文兜底
   * 比的是**显示文本**,而这一条的显示文本恰好就是那 55 个字 —— 所以它也认得上。
   * 病着的时候兜底比的是 `content`(34KB 的 `<file>` 块),下面一条钉它。
   */
  it('@ 文件:没有 messageId 时兜底比显示文本(contentParts),不是 content', () => {
    const out = reconcileOverlay(
      [pending('o1', '@/Users/me/ChatBot.lua')],
      [
        message({
          id: 'm1',
          role: 'user',
          content: fileModelContent,
          contentParts: [{ type: 'text', content: '@/Users/me/ChatBot.lua' }],
        } as never),
      ],
    )
    expect(out).toEqual([])
  })

  it('@ 文件:拿 content 比就是用户看见的那条永不消失的气泡(病着的形)', () => {
    // 改动之前 `reconcileOverlay` 比的正是这一格 —— 34KB 的 `<file>` 块 ≠ 那 55 个字。
    expect(fileModelContent).not.toBe('@/Users/me/ChatBot.lua')
    const out = reconcileOverlay(
      [pending('o1', '@/Users/me/ChatBot.lua')],
      // 老会话没有 `contentParts` 这一格,于是兜底只剩 `content` —— 认不上。
      [message({ id: 'm1', role: 'user', content: fileModelContent })],
    )
    expect(out.map((entry) => entry.id)).toEqual(['o1'])
  })

  /**
   * 技能那一支同病同治:`content` 是整份 SKILL.md,`contentParts` 是
   * `[skill-ref, text]` —— 显示文本只有末尾那句话,与发出去的那句**不相等**
   * (chip 那一格不是文字),所以这一条**只有靠 id 才认得上**。
   */
  it('/skill:x:显示文本也对不上 → 只有 messageId 认得上', () => {
    const skillLedger = message({
      id: 'ffffffff-1111-4222-8333-444444444444',
      role: 'user',
      content: '<skill name="commit">…整份 SKILL.md…</skill> 提交',
      contentParts: [
        { type: 'skill-ref', skillId: 'commit', name: 'commit', content: '…整份 SKILL.md…' },
        { type: 'text', content: ' 提交' },
      ],
    } as never)

    const withId: PendingSend = {
      ...pending('o1', '/skill:commit 提交'),
      messageId: 'ffffffff-1111-4222-8333-444444444444',
    }
    expect(reconcileOverlay([withId], [skillLedger])).toEqual([])

    // 反证:同一份账本,没有 id 那一格认不上(显示文本是 ' 提交',不是原话)。
    expect(reconcileOverlay([pending('o2', '/skill:commit 提交')], [skillLedger])
      .map((entry) => entry.id)).toEqual(['o2'])
  })

  /**
   * **文本兜底对带 id 的也照跑**(判词在 `reconcileOverlay` 的注)。
   * 会话忙的时候 send 降级成 steering,而 steering 那一段自己铸 id ——
   * 「有 id 就只按 id 认」在那条路上就是又一格永不消失的气泡。
   */
  it('带 id 但引擎用了别的 id(忙时降级 steering)→ 文本兜底仍然认得上', () => {
    const entry: PendingSend = {
      ...pending('o1', '补一句'),
      messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }
    const out = reconcileOverlay(
      [entry],
      // steering 落的是引擎自己铸的 id,正文没被改写。
      [message({ id: 'steer-1', role: 'user', content: '补一句' })],
    )
    expect(out).toEqual([])
  })

  it('id 撞不上、正文也不同 = 不认领', () => {
    const entry: PendingSend = {
      ...pending('o1', '这一句'),
      messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }
    const out = reconcileOverlay([entry], [message({ id: 'm1', role: 'user', content: '另一句' })])
    expect(out.map((e) => e.id)).toEqual(['o1'])
  })

  it('id 命中的那条已被别人认领 = 退回文本兜底,不重复认领同一条', () => {
    const first: PendingSend = { ...pending('o1', '同一句'), messageId: 'id-aaaaaaaa' }
    const second: PendingSend = { ...pending('o2', '同一句'), messageId: 'id-aaaaaaaa' }
    const out = reconcileOverlay(
      [first, second],
      [message({ id: 'id-aaaaaaaa', role: 'user', content: '同一句' })],
    )
    expect(out.map((e) => e.id)).toEqual(['o2'])
  })

  it('本地提示按定义不在账本上,永远不被认领', () => {
    const notice: OverlayEntry = { id: 'n1', kind: 'notice', notice: 'ask-rejected' }
    expect(reconcileOverlay([notice], [])).toEqual([notice])
  })

  it('快照只拍用户消息', () => {
    expect(
      userMessageIds([
        message({ id: 'm1', role: 'user' }),
        message({ id: 'a1', role: 'assistant' }),
        message({ id: 'm2', role: 'user' }),
      ]),
    ).toEqual(['m1', 'm2'])
  })
})


/* ── C2-b:工具进度活流 ─────────────────────────────────────────────────── */

const executingCall = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  toolId: 'bash',
  toolName: 'bash',
  arguments: { command: 'seq 1 20' },
  status: 'executing',
  timestamp: 1_000,
  startTime: 1_000,
  ...over,
})

describe('applyToolProgress:快照,替换不拼接', () => {
  it('后一条整条盖掉前一条 —— outputTail 不是追加缓冲', () => {
    let tail = applyToolProgress(undefined, 'a1', 'c1', { outputTail: '1\n2' }, 100)
    tail = applyToolProgress(tail, 'a1', 'c1', { outputTail: '19\n20' }, 200)
    expect(tail?.progress.c1).toEqual({ value: { outputTail: '19\n20' }, at: 200 })
  })

  it('**不必先建过卡** —— 进度在执行中到达,那时尾巴里那张卡早就退役了', () => {
    const tail = applyToolProgress(undefined, 'a1', 'c1', { message: 'seq 1 20' }, 100)
    expect(tail?.tools).toEqual([])
    expect(tail?.progress.c1?.value).toEqual({ message: 'seq 1 20' })
  })

  it('参数还在流的那一段里来了进度:那张卡的 lastDeltaAt 一并推到此刻', () => {
    let tail = startTailTool(undefined, 'a1', 'c1', 'bash', 1_000, 100)
    tail = applyToolProgress(tail, 'a1', 'c1', { message: 'x' }, 350)
    expect(tail?.tools[0].lastDeltaAt).toBe(350)
  })

  it('没有 messageId / toolCallId 的一条原样交回,不新开尾巴', () => {
    expect(applyToolProgress(undefined, '', 'c1', { message: 'x' })).toBeUndefined()
    expect(applyToolProgress(undefined, 'a1', '', { message: 'x' })).toBeUndefined()
  })
})

describe('appendTail:进度盖在账本那次调用上', () => {
  it('执行中的那一次拿到 progress,liveAt 推到收到进度的时刻', () => {
    const list = [message({ id: 'a1', toolCalls: [executingCall('c1')] as never })]
    const tail = applyToolProgress(undefined, 'a1', 'c1', { outputTail: '19\n20', ratio: 0.95 }, 5_000)
    const [painted] = appendTail(list, tail)
    const call = painted.toolCalls![0] as { progress?: unknown; liveAt?: number }
    expect(call.progress).toEqual({ outputTail: '19\n20', ratio: 0.95 })
    expect(call.liveAt).toBe(5_000)
  })

  it('**收场了的调用不盖** —— 那一行该说成果,不该挂一句关于过去的现在时', () => {
    const list = [
      message({ id: 'a1', toolCalls: [executingCall('c1', { status: 'completed' })] as never }),
    ]
    const tail = applyToolProgress(undefined, 'a1', 'c1', { outputTail: '19\n20' }, 5_000)
    const [painted] = appendTail(list, tail)
    expect((painted.toolCalls![0] as { progress?: unknown }).progress).toBeUndefined()
  })

  it('一格没盖 = 整条消息**按引用**原样交回(下游 memo 认的就是它)', () => {
    const list = [
      message({ id: 'a1', toolCalls: [executingCall('c1', { status: 'completed' })] as never }),
    ]
    const tail = applyToolProgress(undefined, 'a1', 'c9', { outputTail: 'x' }, 5_000)
    expect(appendTail(list, tail)[0]).toBe(list[0])
  })

  it('账本换了一份进度 = 换了引用:少了这一条,那一行的摘要逐帧在变而屏幕一动不动', () => {
    const list = [message({ id: 'a1', toolCalls: [executingCall('c1')] as never })]
    const first = appendTail(list, applyToolProgress(undefined, 'a1', 'c1', { outputTail: 'a' }, 1))[0]
    const second = appendTail(list, applyToolProgress(undefined, 'a1', 'c1', { outputTail: 'b' }, 2))[0]
    expect(first).not.toBe(second)
    expect((second.toolCalls![0] as { progress?: { outputTail?: string } }).progress?.outputTail).toBe('b')
  })
})

describe('handOverToLedger:进度不随交接退役', () => {
  it('账本认领了这次调用,那张卡没了,而进度那张表还在', () => {
    let tail = startTailTool(undefined, 'a1', 'c1', 'bash', 1_000, 100)
    tail = applyToolProgress(tail, 'a1', 'c1', { outputTail: '1' }, 200)
    const lens: FoldLens = { content: 0, reasoningTop: 0, reasoningInline: 0 }
    const { tail: next } = handOverToLedger(tail, lens, {
      ...lens,
      ledgerToolCallIds: new Set(['c1']),
    })
    expect(next?.tools).toEqual([])
    expect(next?.progress.c1?.value).toEqual({ outputTail: '1' })
  })
})
