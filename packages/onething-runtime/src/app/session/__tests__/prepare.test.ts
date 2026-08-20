/**
 * S2a:冷加载收尾合成(§11.1 的 `prepare`)。
 *
 * 用例按**可观察的后果**写:进程被杀在半路的那条会话,再打开时投影里不该
 * 还有"永远在生成中"的消息和"永远在跑"的工具;而第二次打开不该再写一个字节。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_INTERRUPTED_TOOL_ERROR, materializeChatMessages } from '@onething/core/session'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('../../stores/paths.js', () => ({
  getSessionsDir: () => state.sessionsDir,
  getLogDir: () => path.join(state.storeDir, 'log'),
}))

const { appendSessionLogEvent, flushSessionEventLog, getSessionEventsLogPath, resetSessionEventLogCache } =
  await import('../event-log.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { getLiveSessionProjection, resetSessionProjectionCache } = await import('../projection-cache.js')
const { prepareSessionEvents, prepareSessionEventsOnce, resetSessionPrepareCache, scanUnclosedRuns } =
  await import('../prepare.js')

const SESSION = 'crashed'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-prepare-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionSurfaceCache()
  resetSessionProjectionCache()
  resetSessionPrepareCache()
  delete process.env.ONETHING_SESSION_PREPARE
})

afterEach(async () => {
  await flushSessionEventLog()
  delete process.env.ONETHING_SESSION_PREPARE
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 一条被杀在工具执行中途的会话。 */
async function crashedMidTool(): Promise<void> {
  appendSessionLogEvent(SESSION, 'user/message', {
    message: { id: 'u1', role: 'user', content: 'go', timestamp: 1 },
  } as never, { surfaceOp: 'append' })
  appendSessionLogEvent(SESSION, 'run/start', {
    runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2,
  } as never, { surfaceOp: 'append' })
  appendSessionLogEvent(SESSION, 'tool/call', {
    runId: 'r1', callId: 'c1', name: 'bash', argumentsRaw: '{}', messageId: 'a1',
  } as never)
  appendSessionLogEvent(SESSION, 'tool/call', {
    runId: 'r1', callId: 'c2', name: 'read', argumentsRaw: '{}', messageId: 'a1',
  } as never)
  appendSessionLogEvent(SESSION, 'tool/result', {
    runId: 'r1', callId: 'c1', isError: false, resultPreview: 'ok', result: { text: 'ok' },
  } as never)
  await flushSessionEventLog(SESSION)
  // 进程死了 = 进程内的缓存全没了。
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionProjectionCache()
  resetSessionPrepareCache()
}

function scanUnclosedRunsOf(): { open: Array<{ runId: string }>; stoppedAt: string } {
  const buffer = fs.readFileSync(getSessionEventsLogPath(SESSION))
  return scanUnclosedRuns({
    size: buffer.length,
    read: (position: number, length: number) =>
      new Uint8Array(buffer.subarray(position, Math.min(buffer.length, position + length))),
  }, buffer.length)
}

function lines(): string[] {
  return fs.readFileSync(getSessionEventsLogPath(SESSION), 'utf8').split('\n').filter(Boolean)
}

describe('prepare: 未闭合的 run', () => {
  it('synthesizes an aborted result for the unfinished call and closes the run', async () => {
    await crashedMidTool()

    const result = prepareSessionEvents(SESSION)
    expect(result).toMatchObject({ status: 'repaired', runs: 1, toolResults: 1, truncatedScan: false })
    await flushSessionEventLog(SESSION)

    const types = lines().map(line => JSON.parse(line).type)
    expect(types.slice(-2)).toEqual(['tool/result', 'run/end'])
    const [synthesized, end] = lines().slice(-2).map(line => JSON.parse(line))
    expect(synthesized.data).toMatchObject({ callId: 'c2', isError: true, runId: 'r1' })
    expect(end.data).toEqual({ runId: 'r1', outcome: 'interrupted' })
  })

  it('leaves the projection with a settled message instead of an eternal stream', async () => {
    await crashedMidTool()
    prepareSessionEvents(SESSION)
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache()

    const messages = materializeChatMessages(getLiveSessionProjection(SESSION)).messages
    const assistant = messages.find(message => message.id === 'a1')
    expect(assistant?.isStreaming).toBeUndefined()
    // R-a(§13.6):合成的中断结局 = **cancelled**(它没有失败,是没跑完),
    // 与消息侧 `sanitizeSessionOnStartup` 那次修复逐字同口径。
    expect(assistant?.toolCalls?.map(call => call.status)).toEqual(['completed', 'cancelled'])
    const interrupted = assistant?.toolCalls?.[1]
    expect(interrupted?.error).toBe(CORE_INTERRUPTED_TOOL_ERROR)
    // 合成的那条结局**不进** `result` —— 消息侧那次修复只写 status + error。
    expect(interrupted?.result).toBeUndefined()
    expect(assistant?.steps?.[1]).toMatchObject({ status: 'cancelled', error: CORE_INTERRUPTED_TOOL_ERROR })
    expect(assistant?.steps?.[1].result).toBeUndefined()
  })

  /**
   * §13.8 第一类的交汇:**收场记下的那条 `tool/result` 满足 prepare 的悬空扫描**。
   *
   * 中止之后账本上那次调用已经有结局了(`cancelled: true` 的那一条),
   * prepare 因此既不会再合成一条中断结局,也不会因为它而多写什么 ——
   * 两处判据是同一件事:"这次调用有没有 `tool/result`"。
   */
  it('§13.8-1: a cancellation result satisfies the dangling-call scan', async () => {
    appendSessionLogEvent(SESSION, 'run/start', {
      runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2,
    } as never, { surfaceOp: 'append' })
    appendSessionLogEvent(SESSION, 'tool/call', {
      runId: 'r1', callId: 'c1', name: 'bash', argumentsRaw: '{}', messageId: 'a1',
    } as never)
    // 收场采集点写下的那一条(引擎中止时的结局 + 自报标题)。
    appendSessionLogEvent(SESSION, 'tool/result', {
      runId: 'r1', callId: 'c1', isError: false, cancelled: true,
      resultPreview: '{"content":[]}', result: { text: '{"content":[]}' }, reportedTitle: 'sleep 20',
    } as never, { surfaceOp: 'append' })
    // …而进程在写 `run/end` 之前就没了。
    await flushSessionEventLog(SESSION)
    resetSessionEventLogCache()
    resetSessionSurfaceCache()
    resetSessionProjectionCache()
    resetSessionPrepareCache()

    // 悬空调用 0 条:那条 run 只补一个 `run/end`,不再合成第二条结局。
    expect(prepareSessionEvents(SESSION)).toMatchObject({ status: 'repaired', runs: 1, toolResults: 0 })
    await flushSessionEventLog(SESSION)
    expect(lines().map(line => JSON.parse(line).type).filter(type => type === 'tool/result')).toHaveLength(1)
  })

  it('is idempotent — the second prepare writes nothing', async () => {
    await crashedMidTool()
    prepareSessionEvents(SESSION)
    await flushSessionEventLog(SESSION)
    const after = fs.statSync(getSessionEventsLogPath(SESSION)).size

    expect(prepareSessionEvents(SESSION)).toMatchObject({ status: 'clean', runs: 0 })
    await flushSessionEventLog(SESSION)
    expect(fs.statSync(getSessionEventsLogPath(SESSION)).size).toBe(after)
  })

  it('stops at the first fully closed run instead of reading the whole log', async () => {
    // 前面两个已经收好尾的回合 + 最后一个被杀在半路的。
    for (const index of [1, 2]) {
      appendSessionLogEvent(SESSION, 'user/message', {
        message: { id: `x${index}`, role: 'user', content: 'q', timestamp: index },
      } as never, { surfaceOp: 'append' })
      appendSessionLogEvent(SESSION, 'run/start', {
        runId: `done${index}`, kind: 'send', assistantMessageId: `y${index}`,
      } as never, { surfaceOp: 'append' })
      appendSessionLogEvent(SESSION, 'run/end', { runId: `done${index}`, outcome: 'completed' } as never)
    }
    await crashedMidTool()

    const scan = scanUnclosedRunsOf()
    expect(scan.stoppedAt).toBe('closed-run')
    expect(scan.open.map(run => run.runId)).toEqual(['r1'])
  })

  it('leaves a properly closed run alone', async () => {
    await crashedMidTool()
    appendSessionLogEvent(SESSION, 'tool/result', {
      runId: 'r1', callId: 'c2', isError: false, resultPreview: 'ok', result: { text: 'ok' },
    } as never)
    appendSessionLogEvent(SESSION, 'run/end', { runId: 'r1', outcome: 'completed' } as never)
    await flushSessionEventLog(SESSION)
    resetSessionEventLogCache()

    expect(prepareSessionEvents(SESSION)).toMatchObject({ status: 'clean', runs: 0, toolResults: 0 })
  })

  it('runs at most once per session per process, and can be switched off', async () => {
    await crashedMidTool()
    process.env.ONETHING_SESSION_PREPARE = '0'
    expect(prepareSessionEvents(SESSION)).toMatchObject({ status: 'disabled' })
    delete process.env.ONETHING_SESSION_PREPARE

    prepareSessionEventsOnce(SESSION)
    await flushSessionEventLog(SESSION)
    const size = fs.statSync(getSessionEventsLogPath(SESSION)).size
    prepareSessionEventsOnce(SESSION)
    await flushSessionEventLog(SESSION)
    expect(fs.statSync(getSessionEventsLogPath(SESSION)).size).toBe(size)
  })

  it('is what the first live projection asks for (session open)', async () => {
    await crashedMidTool()
    // 打开会话 = 活投影第一次建起来。prepare 在它之前跑,合成的事件跟着尾巴
    // 进同一份投影 —— 所以第一眼看到的就已经是收尾之后的样子。
    const messages = materializeChatMessages(getLiveSessionProjection(SESSION)).messages
    expect(messages.find(message => message.id === 'a1')?.isStreaming).toBeUndefined()
  })

  it('reports a truncated scan instead of pretending it saw the whole log', async () => {
    await crashedMidTool()
    const buffer = fs.readFileSync(getSessionEventsLogPath(SESSION))
    const reader = {
      size: buffer.length,
      read: (position: number, length: number) =>
        new Uint8Array(buffer.subarray(position, Math.min(buffer.length, position + length))),
    }
    // 窗口小到只够看见最后一两行:扫描必须自报"我只看了个窗口"。
    const scan = scanUnclosedRuns(reader, buffer.length, 64)
    expect(scan.stoppedAt).toBe('window')
  })
})
