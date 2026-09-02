import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ContextRing, MeterCard } from './MeterCard'
import { meterQuery, useMeterSource } from '../../data/meter-source'
import type { MeterFacts } from '../../data/meter-source'
import { useModelsSource } from '../../data/models-source'
import { catalogQuery } from '../../providers/catalog-query'
import { openRouterModel } from '../../data/__fixtures__/models'
import { useSessionsSource } from '../../data/sessions-source'
import { useStageStore } from '../../stage/store'
import type { SessionSummary } from '../../expose/types'

/**
 * 读数的**缺席态**(D2 波一)。这一层只验一件事:**编不出来的数一个都不画**。
 *  - 窗口不知道 → 环画成一串点(不是一圈 0%),卡上那行只说用量;
 *  - 缓存分母为 0 → 整行不出现;
 *  - 厂商没报价 → 那一行不出现;
 *  - 没有会话 → 一行「还没有读数」,不是一张写着 0 的卡。
 *
 * 数从 store 里摆(判据本身在 data/meter-source.test.ts):这一层是「画成什么样」。
 */

const NOW = 1_700_000_000_000

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: 's',
    kind: 'chat',
    projectId: null,
    preview: '',
    digest: null,
    messageCount: null,
    updatedAt: NOW,
    model: null,
    provider: null,
    agentId: null,
    ...over,
  }
}

const TOKENS = {
  totalInputTokens: 48_200,
  totalOutputTokens: 12_600,
  totalTokens: 60_800,
  maxTokens: 0,
  lastInputTokens: 110_000,
  contextSize: 124_000,
}

const USAGE = {
  apiCostUSD: 0.87,
  subscriptionCostUSD: 0,
  turnCount: 3,
  usage: {
    inputTokens: 48_200,
    outputTokens: 12_600,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 60_800,
  },
}

/**
 * 读数直接打进那一格 —— 「怎么拉」有它自己一组用例(data/meter-source.test.ts),
 * 这一层只管「画成什么样」。`patch` 是 kernel 交出来的就地补丁口,不绕过任何东西。
 */
function seedFacts(facts: MeterFacts): void {
  meterQuery.get(facts.sessionId).patch(facts)
}

/** 摆一条「正在这条会话上、跑着 grok-4」的现场。`window` 给 null = 目录还没到。 */
function stage(window: number | null): void {
  useSessionsSource.setState({
    sessions: [session({ id: 's1', model: 'grok-4', provider: 'xai' })],
  })
  // 窗口那一格的产地是目录那一族(批 7b 合并后与设置面共用一格)。
  // `window === null` = 那一格**从没拉过** —— 那正是「目录还没到」的真形状。
  if (window !== null) catalogQuery.get('xai').patch([openRouterModel('grok-4', window)])
  useMeterSource.setState({ sessionId: 's1' })
  seedFacts({ sessionId: 's1', tokens: TOKENS, usage: USAGE })
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useModelsSource.getState().reset()
  // 目录那一族有自己的家(providers/catalog-query.ts),models-source 的 reset
  // 不收它 —— 两个 reset 收同一格就是两个主人。所以用例自己收。
  catalogQuery.reset()
  useMeterSource.getState().reset()
  useSessionsSource.setState({ sessions: [] })
})

/*
 * 归零要包在 act 里:vitest 的 afterEach 是后进先出,所以这一钩比 RTL 自己的
 * 卸载先跑 —— 那时组件还挂着,一次 store 归零就是一次 act 之外的重渲染。
 */
afterEach(() => {
  act(() => {
    useModelsSource.getState().reset()
    catalogQuery.reset()
    useMeterSource.getState().reset()
  })
})

describe('读数环', () => {
  it('窗口不知道:底圈是点线,不画那一段弧;读屏软件听见的是「未知」', () => {
    stage(null)
    const { container } = render(<ContextRing onEnter={() => {}} onLeave={() => {}} />)
    expect(screen.getByRole('img', { name: '上下文用量未知' })).toBeTruthy()
    const circles = container.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0].getAttribute('stroke-dasharray')).toBeTruthy()
  })

  it('窗口知道:底圈实线 + 一段弧', () => {
    stage(200_000)
    const { container } = render(<ContextRing onEnter={() => {}} onLeave={() => {}} />)
    expect(screen.getByRole('img', { name: '上下文用量' })).toBeTruthy()
    const circles = container.querySelectorAll('circle')
    expect(circles).toHaveLength(2)
    expect(circles[0].getAttribute('stroke-dasharray')).toBeNull()
  })

  it('没有会话:也是缺席态 —— 不画成 0%', () => {
    const { container } = render(<ContextRing onEnter={() => {}} onLeave={() => {}} />)
    expect(screen.getByRole('img', { name: '上下文用量未知' })).toBeTruthy()
    expect(container.querySelectorAll('circle')).toHaveLength(1)
  })
})

describe('明细卡', () => {
  it('窗口知道:上下文那行给出用量 / 窗口 / 百分比', () => {
    stage(200_000)
    render(<MeterCard open />)
    expect(screen.getByText('124k / 200k · 62%')).toBeTruthy()
  })

  it('窗口不知道:只说用量,并如实交代占比算不出来', () => {
    stage(null)
    render(<MeterCard open />)
    expect(screen.getByText('124k · 窗口未知')).toBeTruthy()
  })

  it('缓存分母为 0(这条会话什么都还没送过):整行不画', () => {
    stage(200_000)
    seedFacts({
      sessionId: 's1',
      tokens: TOKENS,
      usage: { ...USAGE, usage: { ...USAGE.usage, inputTokens: 0, cacheReadTokens: 0 } },
    })
    render(<MeterCard open />)
    expect(screen.queryByText('缓存命中')).toBeNull()
  })

  it('送过但一次没命中:画 0% —— 那是**真值**,与「分母为 0」不是一件事', () => {
    stage(200_000)
    render(<MeterCard open />)
    expect(screen.getByText('缓存命中')).toBeTruthy()
    expect(screen.getByText('0%')).toBeTruthy()
  })

  it('缓存有读数:画出来,并且不带「省了多少钱」那半句(整仓无产地)', () => {
    stage(200_000)
    seedFacts({
      sessionId: 's1',
      tokens: TOKENS,
      usage: { ...USAGE, usage: { ...USAGE.usage, inputTokens: 1_000, cacheReadTokens: 9_000 } },
    })
    render(<MeterCard open />)
    expect(screen.getByText('缓存命中')).toBeTruthy()
    expect(screen.getByText('90%')).toBeTruthy()
    expect(screen.queryByText(/省/)).toBeNull()
  })

  it('厂商没报价:只有本地估算那一行', () => {
    stage(200_000)
    render(<MeterCard open />)
    expect(screen.getByText('$0.87')).toBeTruthy()
    expect(screen.queryByText('厂商报价')).toBeNull()
  })

  it('厂商报了价:多一行,**并存**不替换本地估算', () => {
    stage(200_000)
    seedFacts({ sessionId: 's1', tokens: TOKENS, usage: { ...USAGE, providerCostUSD: 1.5 } })
    render(<MeterCard open />)
    expect(screen.getByText('$0.87')).toBeTruthy()
    expect(screen.getByText('厂商报价')).toBeTruthy()
    expect(screen.getByText('$1.50')).toBeTruthy()
  })

  it('没有会话:一行「还没有读数」,不是一张写着 0 的卡', () => {
    render(<MeterCard open />)
    expect(screen.getByText('还没有读数')).toBeTruthy()
    expect(screen.queryByText(/%/)).toBeNull()
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  // 从前这条钉的是一句手写的陈值门;迁到键控 query 之后钉的是**缓存的形状**:
  // 换一条会话读的就是另一格,别人的账根本到不了屏幕上。
  it('手上这份读数不属于当前会话时当没有 —— 不画别人的账', () => {
    stage(200_000)
    useMeterSource.setState({ sessionId: 's2' })
    render(<MeterCard open />)
    expect(screen.getByText('还没有读数')).toBeTruthy()
  })
})
