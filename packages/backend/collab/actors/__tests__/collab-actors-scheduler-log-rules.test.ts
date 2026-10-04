/**
 * 调度时间轴的纯规则(D8 §3.3)。
 *
 * 三件事在这里被钉死:
 *  - **17 类行渲染/解析往返**:写下去什么样,读回来就什么样。一本读不回来的账
 *    等于没有;
 *  - **正文永不入账**:类型级门 + 一条按行断言的测试(speak 行只有 messageId);
 *  - **一次房间转换派生哪几行**:因果链(triggeredBy)能不能从 posted 一路走到 yield。
 */
import { describe, expect, it } from 'vitest'

import {
  COLLAB_SCHEDULER_LOG_CARRIES_NO_TRANSCRIPT,
  COLLAB_SCHEDULER_LOG_RETENTION_DAYS,
  COLLAB_SCHEDULER_LOG_TABLE_IS_EXHAUSTIVE,
  COLLAB_SCHEDULER_LOG_TYPES,
  collabSchedulerDeadLetter,
  collabSchedulerErrorLine,
  collabSchedulerExternalTool,
  collabSchedulerExternalTurn,
  collabSchedulerGateBlock,
  collabSchedulerGrant,
  collabSchedulerHand,
  collabSchedulerInteraction,
  collabSchedulerJudgeDegraded,
  collabSchedulerJudgeOpen,
  collabSchedulerJudgeVerdict,
  collabSchedulerLogDayKey,
  collabSchedulerLogFileDayKey,
  collabSchedulerLogFileName,
  collabSchedulerPhase,
  collabSchedulerPosted,
  collabSchedulerRevoke,
  collabSchedulerSpeak,
  collabSchedulerWorkerResult,
  collabSchedulerWorkerSpawn,
  collabSchedulerYield,
  formatCollabSchedulerLogLine,
  isCollabSchedulerLogExpired,
  isCollabSchedulerLogType,
  parseCollabSchedulerLogLine,
  type CollabSchedulerLogRow,
} from '../collab-actors.js'

/** 每一类各造一行 —— 表的长度与它相等,少一类就红。 */
const SAMPLES: CollabSchedulerLogRow[] = [
  collabSchedulerPosted({ at: 1, messageId: 'm1', authorKind: 'user', chainReset: true }),
  collabSchedulerHand({ at: 2, agentId: 'ana', reason: 'mention', origin: 'mention', triggeredBy: 'm1' }),
  collabSchedulerJudgeOpen({ at: 3, token: 'r#J1', candidates: ['ana', 'bo'], triggeredBy: 'm1' }),
  collabSchedulerJudgeVerdict({
    at: 4,
    token: 'r#J1',
    order: ['bo', 'ana'],
    why: '阿波手上有那张卡',
    elapsedMs: 812,
    model: 'gpt-5-mini',
    triggeredBy: 'r#J1',
  }),
  collabSchedulerJudgeDegraded({ at: 5, token: 'r#J2', reason: 'timeout', elapsedMs: 8_000, triggeredBy: 'r#J2' }),
  collabSchedulerGrant({ at: 6, agentId: 'bo', leaseId: 'r#L1', reason: 'self-elected', triggeredBy: 'r#J1' }),
  collabSchedulerGateBlock({ at: 7, agentId: 'ana', gate: 'seats', triggeredBy: 'm1' }),
  collabSchedulerSpeak({ at: 8, agentId: 'bo', leaseId: 'r#L1', messageId: 'm2', triggeredBy: 'r#L1' }),
  collabSchedulerYield({ at: 9, agentId: 'bo', leaseId: 'r#L1', reason: 'done', triggeredBy: 'r#L1' }),
  collabSchedulerRevoke({ at: 10, agentId: 'bo', leaseId: 'r#L1', cause: 'yield', triggeredBy: 'r#L1' }),
  collabSchedulerPhase({ at: 11, name: 'night', previousPhase: 'day', epoch: 3 }),
  collabSchedulerWorkerSpawn({ at: 12, agentId: 'ana', workerId: 'w1', cardId: 'card-1', triggeredBy: 'card-1' }),
  collabSchedulerWorkerResult({ at: 13, agentId: 'ana', workerId: 'w1', cardId: 'card-1', outcome: 'complete', triggeredBy: 'w1' }),
  collabSchedulerDeadLetter({ at: 14, actor: 'agent:ana', eventType: 'room:posted', error: 'boom', triggeredBy: 'evt-1' }),
  // ── 外部通路三类(E6,claude-code-integration-v2 §6)──
  collabSchedulerExternalTurn({
    at: 15,
    agentId: 'iris',
    connectorId: 'acp',
    phase: 'end',
    outcome: 'aborted',
    elapsedMs: 131_000,
    triggeredBy: 'r#L2',
  }),
  collabSchedulerExternalTool({
    at: 16,
    agentId: 'iris',
    connectorId: 'acp',
    toolName: 'send_message',
    decision: 'allow',
    hostTool: true,
    toolCallId: 'toolu_1',
    triggeredBy: 'r#L2',
  }),
  collabSchedulerInteraction({
    at: 17,
    phase: 'open',
    interactionId: 'itx-1',
    origin: 'external-agent',
    questionCount: 3,
    agentId: 'iris',
    toolCallId: 'toolu_2',
    triggeredBy: 'r#L2',
  }),
]

describe('行类型表', () => {
  it('17 类,双向穷尽(C3 纪律)', () => {
    expect(COLLAB_SCHEDULER_LOG_TABLE_IS_EXHAUSTIVE).toBe(true)
    expect(COLLAB_SCHEDULER_LOG_TYPES).toHaveLength(17)
    expect(new Set(COLLAB_SCHEDULER_LOG_TYPES).size).toBe(17)
  })

  it('样本覆盖全表 —— 一类新行没有样本就红', () => {
    expect(new Set(SAMPLES.map(row => row.type))).toEqual(new Set(COLLAB_SCHEDULER_LOG_TYPES))
  })

  it('类型判据认表不认字符串', () => {
    expect(isCollabSchedulerLogType('judge-verdict')).toBe(true)
    expect(isCollabSchedulerLogType('judge_verdict')).toBe(false)
    expect(isCollabSchedulerLogType(42)).toBe(false)
  })
})

describe('渲染与解析', () => {
  it('17 类行逐条往返,一个字段都不丢', () => {
    for (const row of SAMPLES) {
      const parsed = parseCollabSchedulerLogLine(formatCollabSchedulerLogLine(row))
      expect(parsed).toEqual(row)
    }
  })

  it('键序规范化 —— 同一条行无论怎么构造,落盘字节都一样', () => {
    const a = formatCollabSchedulerLogLine(
      collabSchedulerGrant({ at: 6, agentId: 'bo', leaseId: 'r#L1', reason: 'mention', triggeredBy: 'm1' }),
    )
    const b = formatCollabSchedulerLogLine(
      collabSchedulerGrant({ triggeredBy: 'm1', reason: 'mention', leaseId: 'r#L1', agentId: 'bo', at: 6 }),
    )
    expect(a).toBe(b)
    expect(a.startsWith('{"type":"grant","at":6,"triggeredBy":"m1"')).toBe(true)
  })

  it('认不出的行是 null,不抛 —— 一本半坏的账不该把诊断工具变成第二个故障源', () => {
    expect(parseCollabSchedulerLogLine('')).toBeNull()
    expect(parseCollabSchedulerLogLine('  ')).toBeNull()
    expect(parseCollabSchedulerLogLine('{ 半行')).toBeNull()
    expect(parseCollabSchedulerLogLine('{"type":"nope","at":1}')).toBeNull()
    expect(parseCollabSchedulerLogLine('{"type":"speak"}')).toBeNull()
    expect(parseCollabSchedulerLogLine('"just a string"')).toBeNull()
  })

  it('未来新增的枚举值读得回来 —— 宽松只对枚举,不对 type', () => {
    // 明天多一个 yield 理由,昨天的账不该整份读不出来。
    const row = parseCollabSchedulerLogLine('{"type":"yield","at":1,"agentId":"a","leaseId":"L","reason":"brand-new"}')
    expect(row?.type).toBe('yield')
  })
})

describe('正文永不入账(保密纪律 §7)', () => {
  it('类型级门:没有任何一类行带得动正文字段', () => {
    expect(COLLAB_SCHEDULER_LOG_CARRIES_NO_TRANSCRIPT).toBe(true)
  })

  it('speak 行**只有 messageId**,一个字的正文都没有', () => {
    const row = collabSchedulerSpeak({ at: 8, agentId: 'bo', leaseId: 'r#L1', messageId: 'm2', triggeredBy: 'r#L1' })
    expect(Object.keys(row).sort()).toEqual(['agentId', 'at', 'leaseId', 'messageId', 'triggeredBy', 'type'])
    expect(formatCollabSchedulerLogLine(row)).not.toMatch(/content|text|body/)
  })

  it('worker-result 只带终局枚举,不带交回父的那句话', () => {
    const row = collabSchedulerWorkerResult({
      at: 13, agentId: 'ana', workerId: 'w1', cardId: 'card-1', outcome: 'complete',
    })
    expect(Object.keys(row)).not.toContain('summary')
  })

  it('整本样本账里没有任何正文字段名', () => {
    const text = SAMPLES.map(formatCollabSchedulerLogLine).join('\n')
    for (const forbidden of ['"content"', '"text"', '"body"', '"summary"', '"excerpt"']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('提问行只记题数,一个题干都不带(E6)', () => {
    const row = collabSchedulerInteraction({
      at: 17, phase: 'open', interactionId: 'itx-1', origin: 'external-agent', questionCount: 3,
    })
    expect(Object.keys(row).sort()).toEqual(
      ['at', 'interactionId', 'origin', 'phase', 'questionCount', 'type'],
    )
    expect(formatCollabSchedulerLogLine(row)).not.toMatch(/question"|prompt|content/)
  })

  it('外部工具行只记名字与决定,不带 input(E6)', () => {
    const row = collabSchedulerExternalTool({
      at: 16,
      agentId: 'iris',
      connectorId: 'acp',
      toolName: 'Write',
      decision: 'deny',
      hostTool: false,
    })
    expect(Object.keys(row)).not.toContain('input')
    expect(formatCollabSchedulerLogLine(row)).not.toMatch(/content|text|body/)
  })

  it('裁决的 why 是**系统自己写的**那一句,所以它在账上(而且带耗时与模型)', () => {
    const row = SAMPLES.find(entry => entry.type === 'judge-verdict')
    expect(row).toMatchObject({ why: '阿波手上有那张卡', elapsedMs: 812, model: 'gpt-5-mini' })
  })

  it('错误只取首行、超长截断 —— 堆栈归 crash-log', () => {
    expect(collabSchedulerErrorLine(new Error('第一行\n第二行\n第三行'))).toBe('第一行')
    expect(collabSchedulerErrorLine('   有空格   ')).toBe('有空格')
    expect(collabSchedulerErrorLine(new Error('x'.repeat(400)))).toHaveLength(201)
  })
})

describe('按日切与保留窗', () => {
  const day = (text: string): number => new Date(`${text}T12:00:00`).getTime()

  it('日期键是本地时区的 YYYY-MM-DD', () => {
    expect(collabSchedulerLogDayKey(day('2026-08-03'))).toBe('2026-08-03')
    expect(collabSchedulerLogFileName(day('2026-08-03'))).toBe('scheduler-log-2026-08-03.jsonl')
  })

  it('文件名认得出来,别的文件不冒充', () => {
    expect(collabSchedulerLogFileDayKey('scheduler-log-2026-08-03.jsonl')).toBe('2026-08-03')
    expect(collabSchedulerLogFileDayKey('room.json')).toBeNull()
    expect(collabSchedulerLogFileDayKey('inbox.jsonl')).toBeNull()
    expect(collabSchedulerLogFileDayKey('scheduler-log-2026-8-3.jsonl')).toBeNull()
  })

  it('保留 14 天:第 14 天还在,第 15 天该清', () => {
    const now = day('2026-08-03')
    expect(COLLAB_SCHEDULER_LOG_RETENTION_DAYS).toBe(14)
    expect(isCollabSchedulerLogExpired('scheduler-log-2026-08-03.jsonl', now)).toBe(false)
    // 含今天在内的 14 天 = 07-21 ~ 08-03。
    expect(isCollabSchedulerLogExpired('scheduler-log-2026-07-21.jsonl', now)).toBe(false)
    expect(isCollabSchedulerLogExpired('scheduler-log-2026-07-20.jsonl', now)).toBe(true)
    // 不是时间轴的文件永远不清 —— 房账与信箱就躺在同一个目录里。
    expect(isCollabSchedulerLogExpired('room.json', now)).toBe(false)
  })
})
