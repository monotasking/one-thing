import { describe, expect, it } from 'vitest'
import { MIN_BUSY_MS, STALL_HARD_MS, STALL_SOFT_MS } from '../../../components/motion'
import type { ProjectedToolCall, ToolCardEntry, ToolStepModel } from '../../model/segments'
import { presentToolCard, presentToolStep } from '../../assemble/present'
import {
  headIcons,
  headText,
  isBusyRevealed,
  isLiveStep,
  pickSlotStep,
  silentMsOf,
  stallLevel,
  stallSeconds,
  stepLiveAt,
  stepStartedAt,
} from '../card'

/**
 * 工具卡的**判断**那一半(§6.5 / §6.6),纯函数逐条钉。
 *
 * 为什么不在组件测里一起测:那是拿画面测判断 —— 「快步骤门」这类判据改坏了,
 * 屏幕上只是「有时候闪一下」,断言未必红。这里传的是数,答案是数。
 */

const T0 = 1_700_000_000_000

function call(
  id: string,
  toolName = 'read',
  patch: Record<string, unknown> = {},
): ProjectedToolCall {
  return {
    id,
    toolId: toolName,
    toolName,
    arguments: toolName === 'bash' ? { command: `cmd ${id}` } : { path: `/repo/${id}.ts` },
    status: 'completed',
    timestamp: T0,
    ...patch,
  } as unknown as ProjectedToolCall
}

const step = (...args: Parameters<typeof call>): ToolStepModel => presentToolStep(call(...args))
const entries = (calls: ProjectedToolCall[]): ToolCardEntry[] => presentToolCard(calls).entries

describe('headText:由各步的名拼,不是一句计数旁白', () => {
  it('单步一格 = 「工具名 + 行名」', () => {
    expect(headText(entries([call('a', 'read'), call('b', 'bash')]))).toBe('read a.ts · cmd')
  })

  it('bash 那一步念「rg」不念「bash rg」—— 行名即动词的工具自述头行名', () => {
    const text = headText(
      entries([
        call('a', 'bash', { arguments: { command: 'rg -n foo src' } }),
        call('b'),
        call('c'),
        call('d'),
        call('e', 'edit', { arguments: { path: '/repo/ChatStream.tsx' } }),
      ]),
    )
    // §6.1 那句例子,逐字。
    expect(text).toBe('rg · read ×3 · edit ChatStream.tsx')
    expect(text).not.toContain('bash rg')
  })

  it('没自述的工具照旧回落到「工具名 + 行名」—— headLabel 缺席是常态', () => {
    const [readEntry] = entries([call('a', 'read')])
    // 回落的前提:read 这一族一格 headLabel 都不报(报了就不叫回落了)。
    expect(readEntry.row.headLabel).toBeUndefined()
    expect(headText(entries([call('a', 'read'), call('b', 'edit')]))).toBe('read a.ts · edit b.ts')
  })

  it('行名与工具名相同就只说一次(没有参数的调用是这一形)', () => {
    const bare = [
      { id: 'x', toolId: 'read', toolName: 'read', arguments: {}, status: 'completed', timestamp: T0 },
      { id: 'y', toolId: 'bash', toolName: 'bash', arguments: {}, status: 'completed', timestamp: T0 },
    ] as unknown as ProjectedToolCall[]
    expect(headText(entries(bare))).toBe('read · bash')
  })

  it('同名连发是「read ×3」—— 计数是事实,不是徽', () => {
    expect(headText(entries([call('a'), call('b'), call('c')]))).toBe('read ×3')
  })

  it('三格封顶,余下的读作「+N」,N 是剩下几**步**不是几格', () => {
    const text = headText(
      entries([
        call('a', 'read'),
        call('b', 'edit'),
        call('c', 'bash'),
        call('d', 'write'),
        call('e', 'write'),
      ]),
    )
    expect(text.startsWith('read a.ts · edit b.ts · cmd')).toBe(true)
    expect(text.endsWith('+2')).toBe(true)
  })

  it('正好三格时不写「+0」', () => {
    expect(headText(entries([call('a', 'read'), call('b', 'edit'), call('c', 'bash')]))).not.toContain('+')
  })

  it('一格都没有就是空串(卡上根本不画头行,这只是不许它抛)', () => {
    expect(headText([])).toBe('')
  })
})

describe('headIcons:按工具种类去重,最多三枚', () => {
  it('七次 read 一枚图标就说完了', () => {
    expect(headIcons(entries([call('a'), call('b'), call('c')]))).toEqual(['FileText'])
  })

  it('按首次出现序,封顶三枚', () => {
    expect(
      headIcons(entries([call('a', 'read'), call('b', 'bash'), call('c', 'edit'), call('d', 'write')])),
    ).toEqual(['FileText', 'Terminal', 'Pencil'])
  })

  it('种类没变就逐字相同 —— React 因此不动那几个节点(§6.5 第 9 条)', () => {
    const before = headIcons(entries([call('a', 'read'), call('b', 'bash')]))
    const after = headIcons(entries([call('a', 'read'), call('b', 'bash'), call('c', 'read')]))
    expect(after).toEqual(before)
  })
})

describe('isLiveStep / stepStartedAt / stepLiveAt', () => {
  it('busy 那几档算活着,收场的不算', () => {
    expect(isLiveStep(step('a', 'read', { status: 'executing' }))).toBe(true)
    expect(isLiveStep(step('a', 'read', { status: 'input-streaming' }))).toBe(true)
    expect(isLiveStep(step('a', 'read', { status: 'completed' }))).toBe(false)
    expect(isLiveStep(step('a', 'read', { status: 'failed' }))).toBe(false)
  })

  it('起点按「越贴近这一步越优先」:startTime → receivedAt → timestamp', () => {
    expect(stepStartedAt(call('a', 'read', { startTime: 5, receivedAt: 3, timestamp: 1 }))).toBe(5)
    expect(stepStartedAt(call('a', 'read', { receivedAt: 3, timestamp: 1 }))).toBe(3)
    expect(stepStartedAt(call('a', 'read', { timestamp: 1 }))).toBe(1)
    expect(stepStartedAt({ id: 'a' } as unknown as ProjectedToolCall)).toBeUndefined()
  })

  it('活性时刻优先 liveAt;没有它就退到步的起点 —— 那是实话不是误报', () => {
    expect(stepLiveAt(call('a', 'read', { liveAt: 9, startTime: 5 }))).toBe(9)
    // 今天的工具执行中一个字都不报,所以静默从步开始算。
    expect(stepLiveAt(call('a', 'read', { startTime: 5 }))).toBe(5)
  })
})

describe('silentMsOf:静默从「这台开始等它」起算', () => {
  it('真在流的那一步:liveAt 一直被推到此刻,下限从不生效', () => {
    expect(silentMsOf(call('a', 'bash', { liveAt: T0 + 900 }), T0, T0 + 1_400)).toBe(500)
  })

  it('**冷开会话**:账本里那次两年前开了头没有结局的调用,从打开会话算起', () => {
    const stale = call('a', 'bash', { status: 'input-streaming', timestamp: T0 })
    const openedAt = T0 + 86_400_000 * 700
    // 直接减对端两年前的钟会读出「已 6 千万秒」;下限把它按回「刚开始看」。
    expect(silentMsOf(stale, openedAt, openedAt + 3_000)).toBe(3_000)
  })

  it('两个都有就取晚的那个 —— 「上一次收到数据」比「开始看着它」更晚时,它才是答案', () => {
    expect(silentMsOf(call('a', 'bash', { liveAt: T0 + 5_000 }), T0, T0 + 6_000)).toBe(1_000)
    expect(silentMsOf(call('a', 'bash', { liveAt: T0 }), T0 + 5_000, T0 + 6_000)).toBe(1_000)
  })

  it('时钟回拨按 0 算,不显示负的静默', () => {
    expect(silentMsOf(call('a', 'bash', { liveAt: T0 + 9_000 }), T0, T0 + 1_000)).toBe(0)
  })
})

describe('stallLevel:判据是静默时长,不是猜测', () => {
  it.each([
    [0, 'none'],
    [STALL_SOFT_MS - 1, 'none'],
    [STALL_SOFT_MS, 'soft'],
    [STALL_HARD_MS - 1, 'soft'],
    [STALL_HARD_MS, 'hard'],
  ])('静默 %sms → %s', (ms, level) => {
    expect(stallLevel(ms)).toBe(level)
  })

  it('读数只到秒,所以 10Hz 的时钟不会让它抖', () => {
    expect(stallSeconds(5_099)).toBe(5)
    expect(stallSeconds(5_999)).toBe(5)
    expect(stallSeconds(6_000)).toBe(6)
    // 时钟回拨 / 未来时刻按 0 算,不显示负数。
    expect(stallSeconds(-2_000)).toBe(0)
  })
})

describe('isBusyRevealed:快步骤不闪(§6.5 第 7 条)', () => {
  const live = step('a', 'read', { status: 'executing', startTime: T0 })

  it('开始不足 250ms 的活步不露 busy 形', () => {
    expect(isBusyRevealed(live, T0 + MIN_BUSY_MS - 1)).toBe(false)
  })

  it('到点了就露 —— 时间到了它还活着,那是真的在跑', () => {
    expect(isBusyRevealed(live, T0 + MIN_BUSY_MS)).toBe(true)
  })

  it('收场了的步永远算露过(它画的就是收场形)', () => {
    expect(isBusyRevealed(step('a', 'read', { durationMs: 30 }), T0)).toBe(true)
  })

  it('算不出起点时按露出算 —— 宁可多画一行,不可让一行永远不出现', () => {
    const noTime = {
      row: { callId: 'a', icon: 'Wrench', name: 'x', status: 'executing' },
      call: { id: 'a' } as unknown as ProjectedToolCall,
    } as ToolStepModel
    expect(isBusyRevealed(noTime, T0)).toBe(true)
  })
})

describe('pickSlotStep:收起态的活槽位常驻(§6.5 第 6 条)', () => {
  it('有正在跑的就画它', () => {
    const steps = [
      step('a', 'read', { durationMs: 30 }),
      step('b', 'bash', { status: 'executing', startTime: T0 }),
    ]
    expect(pickSlotStep(steps, T0 + 1_000)?.row.callId).toBe('b')
  })

  it('没有正在跑的就画**最近收场**的那一步', () => {
    const steps = [step('a', 'read', { durationMs: 30 }), step('b', 'bash', { durationMs: 40 })]
    expect(pickSlotStep(steps, T0 + 1_000)?.row.callId).toBe('b')
  })

  it('活步还在快步骤门里时,槽位留给上一步的收场形(那 250ms 卡不许空)', () => {
    const steps = [
      step('a', 'read', { durationMs: 30 }),
      step('b', 'bash', { status: 'executing', startTime: T0 }),
    ]
    expect(pickSlotStep(steps, T0 + 100)?.row.callId).toBe('a')
  })

  it('第一步就在门里(还没有任何一步收场过)时只好画它 —— 空着比闪更糟', () => {
    const steps = [step('a', 'bash', { status: 'executing', startTime: T0 })]
    expect(pickSlotStep(steps, T0 + 100)?.row.callId).toBe('a')
  })

  it('一步都没有就是 undefined', () => {
    expect(pickSlotStep([], T0)).toBeUndefined()
  })
})
