/**
 * 「别处发生的事」事件块（collab-agent-view-v3.md §3，V4'）。
 *
 * 这个文件守两条线，两条都是初版踩出来的：
 *
 *  1. **事件，不是状态**。同一件事只在它发生的那个窗口里出现一次。初版是滚动
 *     快照，实测同一个事件最多被写入 23 次、平均 9.3 份副本 —— 而 drive 会落盘，
 *     写几次上下文里就有几份。
 *  2. **凭据，不是内容**。工具参数走白名单，`<got>` 只有信封。一旦有一个字的
 *     正文漏进来，跨房隔离就形同虚设。
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_ELSEWHERE_MAX_CALLS,
  COLLAB_ELSEWHERE_TAG,
  buildCollabElsewhere,
  type CollabTurnLogMessageLike,
} from '../turn-log.js'

const T0 = new Date(2026, 7, 1, 17, 0, 0).getTime()
const min = (n: number) => T0 + n * 60_000

function drive(at: number, reason = '被 @ 激活'): CollabTurnLogMessageLike {
  return {
    role: 'user',
    source: 'collab',
    timestamp: at,
    content: `<turn agent="Iris" reason="${reason}">\nYour turn.\n</turn>`,
  }
}

function turnRecord(
  at: number,
  calls: Array<{ toolName: string; arguments?: unknown }>,
): CollabTurnLogMessageLike {
  return { role: 'assistant', source: 'collab-turn', timestamp: at, toolCalls: calls }
}

function said(at: number, agentId: string | undefined, content: string): CollabTurnLogMessageLike {
  return {
    role: agentId ? 'assistant' : 'user',
    ...(agentId ? { agentId } : {}),
    content,
    timestamp: at,
    source: agentId ? 'collab-say' : 'text',
  }
}

/** 事故那间私聊房：Iris 17:52 发牌，Bram 17:55 被驱动、读完没说话。 */
const BRAM_DM = {
  roomLabel: 'Bram ⇄ Iris',
  roomMessages: [
    said(min(52), 'iris', '🐺 你的身份：**狼人**\n天黑时你可以睁眼…'),
  ],
  execMessages: [drive(min(55)), turnRecord(min(55) + 1, [])],
}

const build = (over: Partial<Parameters<typeof buildCollabElsewhere>[0]> = {}) =>
  buildCollabElsewhere({
    sources: [BRAM_DM],
    since: min(40),
    until: min(60),
    selfAgentId: 'bram',
    resolveSpeakerLabel: (id) => (id === 'iris' ? 'Iris#eba0c4b7' : undefined),
    ...over,
  })

describe('事件，不是状态', () => {
  it('同一件事只在它发生的那个窗口里出现，之后的窗口不再重复', () => {
    const inWindow = build({ since: min(40), until: min(60) })
    expect(inWindow).toContain('at="2026-08-01 17:52"')

    // 下一个回合的窗口在那之后 → 同一件事一个字都不再出现
    const nextWindow = build({ since: min(60), until: min(70) })
    expect(nextWindow).toBe('')
  })

  it('首轮返回空 —— 没有"上一条 drive"，列出别房全部历史就又变回快照了', () => {
    expect(build({ since: 0 })).toBe('')
    expect(build({ since: undefined })).toBe('')
  })

  it('窗口内别处什么都没发生 → 整块不输出（多数回合都是这种）', () => {
    expect(build({ since: min(56), until: min(59) })).toBe('')
  })
})

describe('两个方向都在', () => {
  it('<got>：别人在那间房对我说过话 —— 事故当天这条一个都看不见', () => {
    const block = build()
    expect(block).toContain('<got room="Bram ⇄ Iris"')
    expect(block).toContain('from="Iris#eba0c4b7"')
  })

  it('<got> 只有信封，正文一个字不进', () => {
    const block = build()
    expect(block).not.toContain('你的身份')
    expect(block).not.toContain('狼人')
  })

  it('<turn silent="yes">：我被拉进那间房、看完没说话 —— 初版这一轮整个消失', () => {
    const block = build()
    expect(block).toContain('<turn room="Bram ⇄ Iris" at="2026-08-01 17:55" silent="yes"/>')
  })

  /**
   * 信封时间到分钟为止，所以同一分钟内同一个人的多条消息会渲染成完全相同的行。
   * 真机上 Bram 那 36 条 drive 里出现过 ×3 —— 读起来像 bug，也白花 token。
   */
  it('同一人同一房在一个窗口里连发 → 合成一行带 count', () => {
    const block = buildCollabElsewhere({
      sources: [{
        roomLabel: 'Bram ⇄ Iris',
        roomMessages: [
          said(min(50), 'iris', '第一条'),
          said(min(50) + 1000, 'iris', '第二条'),
          said(min(50) + 2000, 'iris', '第三条'),
        ],
      }],
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
      resolveSpeakerLabel: () => 'Iris#eba0c4b7',
    })
    expect(block.split('<got').length - 1).toBe(1)
    expect(block).toContain('count="3"')
    // count 是**事件计数**不是待办数：块带 since，说的是"这个窗口里来了 3 条"。
    // 一个过去窗口的计数永远不会过期，与被否决的 unread="3"（状态）是两回事。
    expect(block).toContain('since=')
    // 只有一条时不写 count，省掉一个没有信息量的属性
    const single = buildCollabElsewhere({
      sources: [{ roomLabel: 'Bram ⇄ Iris', roomMessages: [said(min(50), 'iris', '就一条')] }],
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
      resolveSpeakerLabel: () => 'Iris#eba0c4b7',
    })
    expect(single).not.toContain('count=')
  })

  it('不同的人分开算，不会被合掉', () => {
    const block = buildCollabElsewhere({
      sources: [{
        roomLabel: '某群',
        roomMessages: [said(min(50), 'iris', 'a'), said(min(51), 'nova', 'b')],
      }],
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
      resolveSpeakerLabel: (id) => (id === 'iris' ? 'Iris#e' : 'Nova#6'),
    })
    expect(block.split('<got').length - 1).toBe(2)
  })

  it('自己说的话不算「有人找我」', () => {
    const block = buildCollabElsewhere({
      sources: [{ roomLabel: 'Bram ⇄ Iris', roomMessages: [said(min(52), 'bram', '收到')] }],
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
    })
    expect(block).toBe('')
  })

  it('运营噪声与 drive 不算「有人找我」', () => {
    const block = buildCollabElsewhere({
      sources: [{
        roomLabel: '某房',
        roomMessages: [
          { role: 'system', source: 'collab', content: '他们连着聊了 6 条，我先按住了', timestamp: min(50) },
          drive(min(51)),
        ],
      }],
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
    })
    expect(block).toBe('')
  })

  it('多间房按时间归并成一条时间线，不按房分组', () => {
    const block = buildCollabElsewhere({
      sources: [
        { roomLabel: 'A 房', roomMessages: [said(min(55), 'iris', '晚的')] },
        { roomLabel: 'B 房', roomMessages: [said(min(45), 'iris', '早的')] },
      ],
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
      resolveSpeakerLabel: () => 'Iris#eba0c4b7',
    })
    expect(block.indexOf('B 房')).toBeLessThan(block.indexOf('A 房'))
  })
})

describe('凭据不是内容', () => {
  it('白名单之外的参数不渲染：bash 只留工具名', () => {
    const block = buildCollabElsewhere({
      sources: [{
        roomLabel: '某房',
        execMessages: [
          drive(min(50)),
          turnRecord(min(50) + 1, [{ toolName: 'bash', arguments: { command: 'rm -rf ~/secret' } }]),
        ],
      }],
      since: min(40),
      until: min(60),
    })
    expect(block).toContain('<bash/>')
    expect(block).not.toContain('rm -rf')
  })

  it('变量名是标识符（进），变量值是内容（不进）', () => {
    const block = buildCollabElsewhere({
      sources: [{
        roomLabel: '某房',
        execMessages: [
          drive(min(50)),
          turnRecord(min(50) + 1, [{
            toolName: 'variable',
            arguments: { action: 'set', name: 'werewolf_assignments', value: '{"Bram":"wolf"}' },
          }]),
        ],
      }],
      since: min(40),
      until: min(60),
    })
    expect(block).toContain('name="werewolf_assignments"')
    expect(block).not.toContain('{"Bram"')
  })

  it('say 折成一个计数 —— 说了什么在那间房的转录里逐字都有', () => {
    const block = buildCollabElsewhere({
      sources: [{
        roomLabel: '某房',
        execMessages: [
          drive(min(50)),
          turnRecord(min(50) + 1, [
            { toolName: 'say' }, { toolName: 'say' }, { toolName: 'say' },
          ]),
        ],
      }],
      since: min(40),
      until: min(60),
    })
    expect(block).toContain('<say count="3"/>')
  })

  it('单轮调用超上限折成 more，属性注入撑不破', () => {
    const many = Array.from({ length: COLLAB_ELSEWHERE_MAX_CALLS + 3 }, (_, i) => ({
      toolName: 'read',
      arguments: { file_path: `/tmp/f${i}.ts` },
    }))
    const block = buildCollabElsewhere({
      sources: [{ roomLabel: '某房', execMessages: [drive(min(50)), turnRecord(min(50) + 1, many)] }],
      since: min(40),
      until: min(60),
    })
    expect(block).toContain('<more count="3"/>')

    const injected = buildCollabElsewhere({
      sources: [{
        roomLabel: '某房',
        execMessages: [
          drive(min(50)),
          turnRecord(min(50) + 1, [{ toolName: 'variable', arguments: { name: 'a"/><injected x="' } }]),
        ],
      }],
      since: min(40),
      until: min(60),
    })
    expect(injected).not.toContain('<injected')
    expect(injected).toContain('&quot;')
  })
})

describe('块的形状', () => {
  it('带 since 属性宣告这是增量，不是快照', () => {
    expect(build()).toContain(`<${COLLAB_ELSEWHERE_TAG} since="2026-08-01 17:40">`)
  })

  it('事件太多时截断要说出来 —— 静默丢弃读起来和"什么都没发生"一样', () => {
    // 25 间房各来一条 = 25 个**不同**的事件（同一房同一人会被合并，见上面那条）
    const sources = Array.from({ length: 25 }, (_, i) => ({
      roomLabel: `房 ${i}`,
      roomMessages: [said(min(41 + i * 0.5), 'iris', `第${i}条`)],
    }))
    const block = buildCollabElsewhere({
      sources,
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
      maxEvents: 5,
      resolveSpeakerLabel: () => 'Iris#eba0c4b7',
    })
    expect(block).toContain('<more count="20"/>')
    expect(block.split('<got').length - 1).toBe(5)
    // 留下的是**最近**的五条：旧的先被丢
    expect(block).toContain('房 24')
    expect(block).not.toContain('房 0"')
  })
})

describe('上限分层（一间吵闹的房不能挤掉别的房）', () => {
  it('先按房截、再按总量截 —— 每间有动静的房至少能说上话', () => {
    const noisy = {
      roomLabel: '吵闹的房',
      roomMessages: Array.from({ length: 30 }, (_, i) =>
        said(min(41) + i * 1000, `peer${i}`, `第${i}条`)),
    }
    const quiet = { roomLabel: '安静的房', roomMessages: [said(min(41), 'iris', '一条要紧的')] }
    const block = buildCollabElsewhere({
      sources: [noisy, quiet],
      since: min(40),
      until: min(60),
      selfAgentId: 'bram',
      maxPerRoom: 3,
      resolveSpeakerLabel: (id) => id,
    })
    // 只有总上限的话，安静那间会被 30 条整段挤掉
    expect(block).toContain('安静的房')
    expect(block.split('吵闹的房').length - 1).toBe(3)
    // 丢掉的要说出来
    expect(block).toContain('<more count="27"/>')
  })
})
