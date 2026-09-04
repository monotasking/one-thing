import { describe, expect, it } from 'vitest'
import type { ProjectedMessage } from '../../../data/chat-fold'
import { anchorMessage } from '../anchor'
import { assembleMessage } from '..'

/**
 * ① **锚点归位**的单测(§2 ①)。
 *
 * 验的是一件事:**工具段出现在它发生的那个正文位置**,而不是消息尾。P0 时锚点是
 * 直通的(工具卡一律挂尾),所以这一批的可感知变化全在这个文件里说清。
 *
 * 算法本身不在这里测 —— 它是 core 的 `synthesizeCoreToolAnchors`,那边有自己的
 * 用例,而本壳是第三个消费者(不许抄第二份)。这里测的是**接得对不对**:
 * parts 递进去了吗、`data-steps{turnIndex}` 翻回真调用了吗、没被锚点认领的调用
 * 有没有消失。
 */

const T0 = 1_700_000_000_000

function call(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    toolId: 'read',
    toolName: 'read',
    arguments: { path: `${id}.txt` },
    status: 'completed',
    timestamp: T0,
    ...patch,
  }
}

function step(callId: string, turnIndex: number) {
  return { id: `s-${callId}`, type: 'tool-call', title: 't', status: 'completed', timestamp: T0, turnIndex, toolCallId: callId, toolCall: call(callId) }
}

function message(patch: Partial<ProjectedMessage> = {}): ProjectedMessage {
  return { id: 'a1', role: 'assistant', content: '', timestamp: T0, ...patch } as ProjectedMessage
}

/** 两轮:说一句 → 做一件事 → 再说一句 → 再做一件事。屏幕上该是交错的四段。 */
function twoTurnMessage(): ProjectedMessage {
  return message({
    content: '先看看这个再看看那个',
    contentParts: [
      { type: 'text', content: '先看看', turnIndex: 0 },
      { type: 'text', content: '这个', turnIndex: 0 },
      { type: 'text', content: '再看看那个', turnIndex: 1 },
    ],
    steps: [step('c1', 0), step('c2', 1)],
    toolCalls: [call('c1'), call('c2')],
  } as Partial<ProjectedMessage>)
}

describe('锚点归位:工具段插在它发生的那处正文之间', () => {
  it('按 turnIndex 织进序列 —— 不再一律挂尾', () => {
    const nodes = anchorMessage(twoTurnMessage())
    expect(nodes.map((node) => node.node)).toEqual(['text', 'tool', 'text', 'tool'])
    expect(nodes[1]).toMatchObject({ node: 'tool', call: { id: 'c1' } })
    expect(nodes[3]).toMatchObject({ node: 'tool', call: { id: 'c2' } })
  })

  it('对照旧序:同一条消息在「一律挂尾」的读法下是 text · tool · tool', () => {
    // 这条不是重复上一条 —— 它把**旧行为**写下来,好让下一个人一眼看出这一批
    // 改的是什么:从前 c1 排在全部正文之后,现在它排在第一轮那两段正文之后。
    const nodes = anchorMessage(twoTurnMessage())
    const tailOrder = [
      ...nodes.filter((node) => node.node !== 'tool'),
      ...nodes.filter((node) => node.node === 'tool'),
    ]
    expect(tailOrder.map((node) => node.node)).toEqual(['text', 'text', 'tool', 'tool'])
    expect(nodes.map((node) => node.node)).not.toEqual(tailOrder.map((node) => node.node))
  })

  it('相邻文本 part 合并成一段 —— 一个 <p> 不许被 part 边界劈成两个', () => {
    const nodes = anchorMessage(twoTurnMessage())
    // 前两个 part 中间没有锚点,所以它们是同一段正文,而且逐字相接(没有分隔符)。
    expect(nodes[0]).toEqual({ node: 'text', text: '先看看这个' })
  })

  it('没有 contentParts 的老消息:按正文现搭一格,再走同一条合成', () => {
    const nodes = anchorMessage(
      message({ content: '读一下', toolCalls: [call('c1')] } as Partial<ProjectedMessage>),
    )
    expect(nodes.map((node) => node.node)).toEqual(['text', 'tool'])
  })

  it('只有 toolCalls 没有 steps 的更老消息:走 core 的 tool-call 兜底锚点', () => {
    const nodes = anchorMessage(
      message({
        content: '读一下',
        contentParts: [{ type: 'text', content: '读一下' }],
        toolCalls: [call('c1'), call('c2')],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes.map((node) => node.node)).toEqual(['text', 'tool', 'tool'])
  })

  it('锚点盖不全时剩下的调用挂尾 —— 屏幕上少一张卡就是说谎', () => {
    // c2 有调用但没有 step:锚点只认得出 c1,c2 必须仍然在场。
    const nodes = anchorMessage(
      message({
        contentParts: [{ type: 'text', content: '嗯', turnIndex: 0 }],
        steps: [step('c1', 0)],
        toolCalls: [call('c1'), call('c2')],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes.filter((node) => node.node === 'tool')).toHaveLength(2)
  })

  it('同一次调用只出现一次(锚点 + 挂尾兜底不许重复计数)', () => {
    const nodes = anchorMessage(twoTurnMessage())
    const ids = nodes.flatMap((node) => (node.node === 'tool' ? [node.call.id] : []))
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('顶部推理仍在最前;行内推理按它在 parts 里的位置就位', () => {
    const nodes = anchorMessage(
      message({
        reasoning: '先想想',
        content: '好的',
        contentParts: [
          { type: 'reasoning', content: '再想想', turnIndex: 0 },
          { type: 'text', content: '好的', turnIndex: 0 },
        ],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes).toEqual([
      { node: 'reasoning', text: '先想想', placement: 'top' },
      { node: 'reasoning', text: '再想想', placement: 'inline' },
      { node: 'text', text: '好的' },
    ])
  })

  it('装配之后:两轮消息算成 正文 · 工具 · 正文 · 工具 四段', () => {
    // 工具那两段的段种是 `tool-group`(09-01 P2:一次调用也是一组,画出来仍是
    // 从前那张单发卡)—— 这一条要钉的是**次序**:工具没有一律挂尾。
    expect(assembleMessage(twoTurnMessage()).map((segment) => segment.kind)).toEqual([
      'rich-text',
      'tool-group',
      'rich-text',
      'tool-group',
    ])
  })
})

/**
 * 08-31 真机回访 · 报障三:**脱水形的 step**。
 *
 * 老会话(messages.jsonl 时代)迁进事件账本走的是 `message/imported`,写进去的是
 * `dehydrateProjectedMessages` 脱过水的消息形 —— `step.toolCall` 那一格按定义被摘掉
 * (它是 `toolCalls[]` 里那个对象的重复引用),只留 `toolCallId`;投影对这类消息是
 * 原样搬运。从前这里只读 `step.toolCall`,于是锚点一格都认领不到,整条消息的工具卡
 * 全被末尾兜底堆成一摞。生产 store 只读扫描 250 条会话:带工具活儿的 assistant 消息
 * 1166 条,其中 739 条(63%)的段序列因此是错的。
 */
describe('脱水形的 step:只有 toolCallId,没有 toolCall', () => {
  /** 与 `step()` 同形,少 `toolCall` 那一格 —— 迁移进来的老消息就长这样。 */
  function dehydratedStep(callId: string, turnIndex: number) {
    const { toolCall: _dropped, ...rest } = step(callId, turnIndex)
    return rest
  }

  function importedMessage(): ProjectedMessage {
    return message({
      content: '先看看这个再看看那个',
      contentParts: [
        { type: 'text', content: '先看看', turnIndex: 0 },
        { type: 'text', content: '这个', turnIndex: 0 },
        { type: 'text', content: '再看看那个', turnIndex: 1 },
      ],
      steps: [dehydratedStep('c1', 0), dehydratedStep('c2', 1)],
      toolCalls: [call('c1'), call('c2')],
    } as Partial<ProjectedMessage>)
  }

  it('按 toolCallId 认领 —— 位置与带 toolCall 的那一份逐项相同', () => {
    const nodes = anchorMessage(importedMessage())
    expect(nodes.map((node) => node.node)).toEqual(['text', 'tool', 'text', 'tool'])
    expect(nodes[1]).toMatchObject({ node: 'tool', call: { id: 'c1' } })
    expect(nodes[3]).toMatchObject({ node: 'tool', call: { id: 'c2' } })
    // 与现役消息(step 自带 toolCall)那一份对照:同一条消息,同一个答案。
    expect(nodes.map((node) => node.node)).toEqual(
      anchorMessage(twoTurnMessage()).map((node) => node.node),
    )
  })

  it('反证:认不出来的那个照旧挂尾 —— 不是「认不到就不画」', () => {
    // c2 的 step 在,但 toolCalls 表里没有它 → 锚点那一步查不到,末尾兜底也查不到,
    // 于是屏幕上只有 c1。这一条钉的是**认领失败不吞卡**:凡是 toolCalls 里有的,
    // 一张都不少。
    const nodes = anchorMessage(
      message({
        contentParts: [{ type: 'text', content: '嗯', turnIndex: 0 }],
        steps: [dehydratedStep('c1', 0), dehydratedStep('c2', 0)],
        toolCalls: [call('c1')],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes.flatMap((node) => (node.node === 'tool' ? [node.call.id] : []))).toEqual(['c1'])
  })
})

/**
 * ── 多轮工具:第二轮的正文落在工具**之后**(09-01 P0)────────────────────
 *
 * 真机报障的现场:第二轮流式期间,第一轮的 `contentParts` 还没物化(投影那道
 * `requestSettled` 闸),整条消息只有一格扁平的 `message.content`。活尾巴把第二轮
 * 的正文接上去之后,`synthesizeCoreToolAnchors` 找不到轮次分界,把第一轮的工具
 * 锚点插到了**全部正文之后** —— 屏幕上第二轮的正文画在工具组上面(191ms),
 * 而 parts 一物化它当场消失(992ms)。
 *
 * 修法是让尾巴那一格带上**流自己说的轮次号**(`text-delta.turnIndex`),锚点于是
 * 有了分界。这一组从 `appendTail` 的产物走到段序列,钉的正是那条落点。
 */
describe('多轮工具:活尾巴那一段落在它那一轮的工具之后', () => {
  /** 账本此刻:第一轮的正文进了 content(打包行到了),parts 一格都还没物化。 */
  function midFlight(tailTurn?: number): ProjectedMessage {
    return message({
      content: '第一轮正文',
      contentParts: [
        { type: 'text', content: '第一轮正文' },
        // 活尾巴接上来的第二轮正文。轮次号缺席 = 修前那一版。
        { type: 'text', content: '第二轮正文', ...(tailTurn !== undefined ? { turnIndex: tailTurn } : {}) },
      ],
      steps: [step('c1', 1)],
      toolCalls: [call('c1')],
    } as Partial<ProjectedMessage>)
  }

  it('带轮次号:正文 · 工具 · 正文', () => {
    expect(anchorMessage(midFlight(2)).map((node) => node.node)).toEqual(['text', 'tool', 'text'])
    expect(assembleMessage(midFlight(2)).map((segment) => segment.kind)).toEqual([
      'rich-text',
      'tool-group',
      'rich-text',
    ])
  })

  it('反证 —— 尾巴那一格不带轮次号时,工具被挤到全部正文之后(修前那一形)', () => {
    // 两段文本 part 中间没有分界,`insertDataStepsByTurn` 只能把锚点挂尾:
    // 第二轮的正文于是画在工具组**上面**,正是真机 t=6647..6839 那 191ms。
    expect(anchorMessage(midFlight()).map((node) => node.node)).toEqual(['text', 'tool'])
  })
})


/**
 * **一次调用只有一张表**(C2-b 改的那一格)。
 *
 * `step.toolCall` 与 `message.toolCalls[i]` 是投影分两次物化出来的**两个对象**
 * (`materializeStep` 自己又调了一次 `materializeToolCall`)。内容逐格相同,所以
 * 从前读哪一份都一样 —— 直到有人往其中一份上写东西:C2-b 的活流进度按 id 盖在
 * **表**那一份上,而这条链从前读的是 step 上那一份,于是屏幕上一条进度都看不到
 * (真机读数:20 条 `tool-progress` 全部到达渲染层,而执行中那一行一帧没变)。
 */
describe('一次调用只有一张表(C2-b)', () => {
  it('表里那一份**压过** step 上那一份 —— 活流盖上去的字段读得到', () => {
    const withProgress = call('c1', { status: 'executing', progress: { outputTail: 'line 20' } })
    const nodes = anchorMessage(
      message({
        contentParts: [{ type: 'text', content: '嗯', turnIndex: 0 }],
        // step 上那一份是**没有 progress 的旧影子**(投影分两次物化的另一个对象)。
        steps: [step('c1', 0)],
        toolCalls: [withProgress],
      } as Partial<ProjectedMessage>),
    )
    const tool = nodes.find((node) => node.node === 'tool')
    expect(tool).toMatchObject({ node: 'tool', call: { id: 'c1' } })
    expect((tool as { call: { progress?: unknown } }).call.progress).toEqual({ outputTail: 'line 20' })
  })

  it('表里没有它才退回 step 上那一份 —— 一张卡都不许少', () => {
    const nodes = anchorMessage(
      message({
        contentParts: [{ type: 'text', content: '嗯', turnIndex: 0 }],
        steps: [step('c1', 0)],
        toolCalls: [],
      } as Partial<ProjectedMessage>),
    )
    expect(nodes.flatMap((node) => (node.node === 'tool' ? [node.call.id] : []))).toEqual(['c1'])
  })
})
