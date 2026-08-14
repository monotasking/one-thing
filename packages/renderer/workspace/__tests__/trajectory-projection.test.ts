import { describe, expect, it } from 'vitest'
import type { SessionEventRecord } from '@shared/ipc/session-events.js'
import {
  buildTrajectoryGroups,
  deriveTrajectoryTimeline,
  findTrajectoryToolRow,
  formatTrajectoryDuration,
  summarizeToolArguments,
  TRAJECTORY_IDLE_AXIS_MS,
  TRAJECTORY_MIN_SPAN_SIZE,
} from '../trajectory-projection'

function call(seq: number, time: number, callId: string, name = 'read'): SessionEventRecord {
  return {
    seq,
    time,
    type: 'tool/call',
    data: { callId, argumentsRaw: '{}', name, messageId: 'm' },
  }
}

describe('trajectory projection', () => {
  it('没有 sourceSeq 的老记录退回「同 callId + 顺序在后」配对', () => {
    const groups = buildTrajectoryGroups([
      { seq: 1, time: 10, type: 'request/start', data: { requestIndex: 1, messageId: 'm' } },
      call(2, 20, 'c1'),
      { seq: 3, time: 50, type: 'tool/result', data: { callId: 'c1', isError: false, resultPreview: 'ok' } },
    ])

    const row = findTrajectoryToolRow(groups, 'c1')!.row
    expect(row.pending).toBe(false)
    expect(row.resultTime).toBe(50)
  })

  it('同一个 callId 被复用时,两次调用各认各的结果,不共用一条', () => {
    const groups = buildTrajectoryGroups([
      { seq: 1, time: 10, type: 'request/start', data: { requestIndex: 1, messageId: 'm' } },
      call(2, 20, 'dup'),
      { seq: 3, time: 30, type: 'tool/result', data: { callId: 'dup', isError: false, resultPreview: 'a' } },
      call(4, 40, 'dup'),
      { seq: 5, time: 90, type: 'tool/result', data: { callId: 'dup', isError: true, resultPreview: 'b' } },
    ])

    const rows = groups[0].rows.filter(row => row.kind === 'tool')
    expect(rows).toHaveLength(2)
    expect(rows[0].kind === 'tool' && rows[0].resultTime).toBe(30)
    expect(rows[1].kind === 'tool' && rows[1].resultTime).toBe(90)
    expect(rows[1].kind === 'tool' && rows[1].isError).toBe(true)
  })

  it('request/start 之前的行落进一个显式的「未记账」组,而不是被丢掉', () => {
    const groups = buildTrajectoryGroups([call(1, 10, 'orphan')])

    expect(groups).toHaveLength(1)
    expect(groups[0].requestIndex).toBe(0)
    expect(findTrajectoryToolRow(groups, 'orphan')).toBeDefined()
  })

  it('结果落在 request/end 之后时,仍然算进 call 所在的那一组', () => {
    const groups = buildTrajectoryGroups([
      { seq: 1, time: 10, type: 'request/start', data: { requestIndex: 1, messageId: 'm' } },
      call(2, 20, 'c1'),
      { seq: 3, time: 25, type: 'request/end', data: { requestIndex: 1 } },
      { seq: 4, time: 60, type: 'tool/result', data: { callId: 'c1', isError: false, resultPreview: 'ok', sourceSeq: 2 } },
      { seq: 5, time: 70, type: 'request/start', data: { requestIndex: 2, messageId: 'm2' } },
    ])

    expect(groups).toHaveLength(2)
    const located = findTrajectoryToolRow(groups, 'c1')!
    expect(located.group.requestIndex).toBe(1)
    expect(located.row.resultTime).toBe(60)
  })

  /**
   * 目录与信封是两条独立去重的事件流:system 一变就补一条 header,目录不变就
   * 不补 request/tools。组头因此要**分别**往回找,不能拿 header 去要工具数。
   */
  it('工具数取「该组之前最近的一条 request/tools」,与 header 各走各的', () => {
    const groups = buildTrajectoryGroups([
      {
        seq: 1,
        time: 0,
        type: 'request/tools',
        data: { requestIndex: 1, toolsHash: 'h1', tools: [{ name: 'read' }, { name: 'bash' }] },
      },
      {
        seq: 2,
        time: 0,
        type: 'request/header',
        data: {
          requestIndex: 1,
          provider: 'anthropic',
          model: 'm1',
          systemPromptHash: 's1',
          toolsHash: 'h1',
          reason: 'initial',
        },
      },
      { seq: 3, time: 10, type: 'request/start', data: { requestIndex: 1, messageId: 'm' } },
      // 第二轮:system 变了(新 header),目录没变(没有新的 request/tools)。
      {
        seq: 4,
        time: 20,
        type: 'request/header',
        data: {
          requestIndex: 2,
          provider: 'anthropic',
          model: 'm2',
          systemPromptHash: 's2',
          toolsHash: 'h1',
          reason: 'change',
        },
      },
      { seq: 5, time: 30, type: 'request/start', data: { requestIndex: 2, messageId: 'm2' } },
    ])

    expect(groups.map(group => group.toolCount)).toEqual([2, 2])
    expect(groups.map(group => group.model)).toEqual(['m1', 'm2'])
  })

  it('日志里没有 request/tools 时工具数是 undefined,不用 0 冒充', () => {
    const groups = buildTrajectoryGroups([
      { seq: 1, time: 10, type: 'request/start', data: { requestIndex: 1, messageId: 'm' } },
      call(2, 20, 'c1'),
    ])

    expect(groups[0].toolCount).toBeUndefined()
  })

  it('参数摘要:JSON 拍平;模型写坏 JSON 时原样截断,不藏起来', () => {
    expect(summarizeToolArguments('{"file_path":"/a.ts","limit":10}'))
      .toBe('file_path=/a.ts · limit=10')
    expect(summarizeToolArguments('{"file_path": "/a.ts"')).toContain('{"file_path": "/a.ts"')
    expect(summarizeToolArguments('')).toBe('')
  })

  it('时长只在呈现时算出来', () => {
    expect(formatTrajectoryDuration(500)).toBe('500ms')
    expect(formatTrajectoryDuration(1500)).toBe('1.5s')
    expect(formatTrajectoryDuration(65_000)).toBe('1m05s')
  })
})

/**
 * 时间条带(E2)。钉的是**布局本身**——比例算在投影层,所以不用起 DOM 也不用量
 * 像素:等宽是不是真等宽、按时长是不是真成比例、空闲有没有被压、开区间有没有
 * 被当成收尾了,全部是纯函数的输出。
 */
describe('trajectory timeline', () => {
  const ONE_REQUEST: SessionEventRecord[] = [
    { seq: 1, time: 0, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
    { seq: 2, time: 1000, type: 'assistant/first-token', data: { requestIndex: 1, messageId: 'm1' } },
    call(3, 1000, 'c1'),
    { seq: 4, time: 3000, type: 'tool/result', data: { callId: 'c1', isError: false, resultPreview: 'ok', sourceSeq: 3 } },
    call(5, 3000, 'c2', 'bash'),
    { seq: 6, time: 3500, type: 'tool/result', data: { callId: 'c2', isError: true, resultPreview: 'boom', sourceSeq: 5 } },
    { seq: 7, time: 4000, type: 'request/end', data: { requestIndex: 1 } },
  ]

  it('sequence 档:一个操作一格,等宽;assistant 段在前,工具行按发生顺序', () => {
    const timeline = deriveTrajectoryTimeline(buildTrajectoryGroups(ONE_REQUEST), 'sequence')

    expect(timeline.spans.map(span => span.kind)).toEqual(['wait', 'generate', 'tool', 'tool'])
    expect(timeline.spans.map(span => span.lane))
      .toEqual(['assistant', 'assistant', 'tools', 'tools'])
    // 等宽 = 每格 1/4,起点按序号排;横轴与真实时长无关。
    for (const span of timeline.spans) expect(span.size).toBeCloseTo(0.25, 6)
    expect(timeline.spans.map(span => span.offset))
      .toEqual([0, 0.25, 0.5, 0.75])
    expect(timeline.axisTotal).toBe(4)
    expect(timeline.gaps).toEqual([])
    expect(timeline.ticks).toHaveLength(1)
    expect(timeline.ticks[0].label).toBe('#1')
  })

  it('duration 档:宽度按真实时长成比例,assistant 按首 token 切两段', () => {
    const timeline = deriveTrajectoryTimeline(buildTrajectoryGroups(ONE_REQUEST), 'duration')
    const byKind = (kind: string) => timeline.spans.filter(span => span.kind === kind)

    // 轴 = 0..4000。等待 1000ms = 1/4,生成 3000ms = 3/4 且从 1/4 处起。
    const wait = byKind('wait')[0]
    expect(wait.offset).toBeCloseTo(0, 6)
    expect(wait.size).toBeCloseTo(0.25, 6)
    const generate = byKind('generate')[0]
    expect(generate.offset).toBeCloseTo(0.25, 6)
    expect(generate.size).toBeCloseTo(0.75, 6)

    // 工具:1000→3000 与 3000→3500,各自按真实时长占位。
    const tools = byKind('tool')
    expect(tools[0].offset).toBeCloseTo(0.25, 6)
    expect(tools[0].size).toBeCloseTo(0.5, 6)
    expect(tools[1].offset).toBeCloseTo(0.75, 6)
    expect(tools[1].size).toBeCloseTo(0.125, 6)
    expect(timeline.axisTotal).toBe(4000)
  })

  it('失败的工具 span 带错误标记,成功的不带', () => {
    const timeline = deriveTrajectoryTimeline(buildTrajectoryGroups(ONE_REQUEST), 'duration')
    const tools = timeline.spans.filter(span => span.kind === 'tool')

    expect(tools.map(span => span.callId)).toEqual(['c1', 'c2'])
    expect(tools[0].isError).toBe(false)
    expect(tools[1].isError).toBe(true)
  })

  it('duration 档:请求组之间的长空闲压成固定宽度,短的照实占位', () => {
    const timeline = deriveTrajectoryTimeline(buildTrajectoryGroups([
      { seq: 1, time: 0, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
      { seq: 2, time: 1000, type: 'request/end', data: { requestIndex: 1 } },
      // 60s 空闲 —— 不压的话下面两组会被挤成零宽的线。
      { seq: 3, time: 61_000, type: 'request/start', data: { requestIndex: 2, messageId: 'm2' } },
      { seq: 4, time: 62_000, type: 'request/end', data: { requestIndex: 2 } },
      // 500ms 空闲 —— 阈值以内,按真实比例留着。
      { seq: 5, time: 62_500, type: 'request/start', data: { requestIndex: 3, messageId: 'm3' } },
      { seq: 6, time: 63_000, type: 'request/end', data: { requestIndex: 3 } },
    ]), 'duration')

    // 轴 = 1000(组1) + 400(压缩) + 1000(组2) + 500(短空闲) + 500(组3)。
    expect(timeline.axisTotal).toBe(3400)
    expect(timeline.gaps).toHaveLength(1)
    expect(timeline.gaps[0].skippedMs).toBe(60_000)
    expect(timeline.gaps[0].offset).toBeCloseTo(1000 / 3400, 6)
    expect(timeline.gaps[0].size).toBeCloseTo(TRAJECTORY_IDLE_AXIS_MS / 3400, 6)
    // 第三组的边界刻度落在 2900/3400 —— 短空闲没有被压掉。
    expect(timeline.ticks.map(tick => tick.label)).toEqual(['#1', '#2', '#3'])
    expect(timeline.ticks[2].offset).toBeCloseTo(2900 / 3400, 6)
  })

  it('未收尾的 call 是开区间:没有终点,但仍留一道看得见的宽度', () => {
    const timeline = deriveTrajectoryTimeline(buildTrajectoryGroups([
      { seq: 1, time: 0, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
      { seq: 2, time: 100, type: 'assistant/first-token', data: { requestIndex: 1, messageId: 'm1' } },
      call(3, 200, 'pending'),
      { seq: 4, time: 1000, type: 'request/end', data: { requestIndex: 1 } },
    ]), 'duration')

    const tool = timeline.spans.find(span => span.callId === 'pending')!
    expect(tool.open).toBe(true)
    expect(tool.endTime).toBeUndefined()
    expect(tool.size).toBeCloseTo(TRAJECTORY_MIN_SPAN_SIZE, 6)
  })

  it('缺首 token 退化成单段;缺 request/end 的 assistant 段是开区间', () => {
    const timeline = deriveTrajectoryTimeline(buildTrajectoryGroups([
      { seq: 1, time: 0, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
      call(2, 500, 'c1'),
      { seq: 3, time: 900, type: 'tool/result', data: { callId: 'c1', isError: false, resultPreview: 'ok', sourceSeq: 2 } },
    ]), 'duration')

    const assistant = timeline.spans.filter(span => span.lane === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].kind).toBe('generate')
    expect(assistant[0].open).toBe(true)
    expect(assistant[0].endTime).toBeUndefined()
  })

  it('全部事件同一毫秒时退回等宽 —— 按比例分等于除以零', () => {
    const timeline = deriveTrajectoryTimeline(buildTrajectoryGroups([
      { seq: 1, time: 7, type: 'request/start', data: { requestIndex: 1, messageId: 'm1' } },
      { seq: 2, time: 7, type: 'request/end', data: { requestIndex: 1 } },
    ]), 'duration')

    expect(timeline.mode).toBe('sequence')
    expect(timeline.spans).toHaveLength(1)
    expect(timeline.spans[0].size).toBe(1)
  })

  it('没有任何 span 时是空条带,不是崩溃', () => {
    expect(deriveTrajectoryTimeline([], 'duration')).toEqual({
      mode: 'duration',
      spans: [],
      ticks: [],
      gaps: [],
      axisTotal: 0,
    })
  })
})
