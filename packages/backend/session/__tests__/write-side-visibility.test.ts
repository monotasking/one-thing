import { installSessionLayerForTest } from '../testing/session-layer.js'
/**
 * **F1 合同:写侧同步可见**(`docs/design/session-event-sourcing-2026-08.md` §16.6)。
 *
 * 钉的是一条时序纪律:一条事件被写入口分配到 seq 的那一刻,**还没排队落盘之前**,
 * 它就已经在这个进程的每一份活状态上了 —— 活投影(`projection-cache.ts`)与
 * 活 surface(`event-surface.ts`)。于是"命令内读得到自己刚写的"不再是"每个读口
 * 都记得先 drain 一次"的约定,而是写入口自己保证的机制。
 *
 * ## 为什么断言用 `peekSessionProjection` 而不是 `getLiveSessionProjection`
 *
 * `getLiveSessionProjection` **自己会 drain 尾巴**:惰性折的年代它也照样返回含
 * 这条事件的投影,拿它断言等于什么都没钉住。`peekSessionProjection` 只看缓存、
 * 一步都不推进 —— 只有"写的时候就折了"才让它看得见。
 *
 * **反证**(F1 的回退判据):把 `writeSessionEvent` 里那句
 * `notifySessionLogEventAppended` 删掉(推进退回 drain 时惰性),本文件的
 * 投影三例与 surface 一例当场全红。
 *
 * 与 `event-translator-write-side-read.test.ts` 同款harness:跑**真的**事件日志 /
 * 投影 / surface,只替身最底下的会话仓库。三条代表面(13 条命令不逐条):
 * `appendMessage` / `patchMessage` / `truncateFrom`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  messages: new Map<string, ChatMessage[]>(),
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../stores/sessions.js', () => ({
  getSession: (id: string) => ({ id, messages: state.messages.get(id) ?? [] }),
  getSessionRaw: (id: string) => ({ id, messages: state.messages.get(id) ?? [] }),
  getSessions: () => [],
  getSessionMessages: (id: string) => state.messages.get(id),
  getSessionMessagesPage: () => ({ success: true, messages: [] }),
  getSessionUserMessageMarkers: () => [],
  readSessionTranscriptFile: () => undefined,
}))

const { sessionCommandEvents } = await import('../command-events.js')
const { flushSessionEventLog, resetSessionEventLogCache } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { resetSessionSurfaceCache, sessionSurface } = await import('../event-surface.js')
const { resetSessionRuns } = await import('../runs.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { getLiveSessionProjection, peekSessionProjection, resetSessionProjectionCache } =
  await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { checkSessionRefold, resetSessionRefoldSampling } = await import('../refold.js')

const SESSION = 'f1-visibility'

let testSessionLayer: ReturnType<typeof installSessionLayerForTest>


beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-f1-visible-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map()
  testSessionLayer = installSessionLayerForTest()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  resetSessionPrepareCache()
  resetSessionRefoldSampling()
})

afterEach(async () => {
  await flushSessionEventLog()
  await testSessionLayer.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 活投影**不推进地**看一眼:只有同步折过的事件才在这里面。 */
function peekedMessageIds(): string[] {
  const projection = peekSessionProjection(SESSION)
  expect(projection).toBeDefined()
  return (projection?.nodes ?? []).filter(node => !node.hidden).map(node => node.messageId)
}

function peekedNode(messageId: string) {
  return peekSessionProjection(SESSION)?.nodes.find(node => node.messageId === messageId)
}

/** 活投影必须**先建起来** —— 观察者不许为了折一条事件去读整份文件建表。 */
function openLiveProjection(): void {
  getLiveSessionProjection(SESSION)
}

describe('F1:命令产出的事件在 append 返回前已经在活投影上(§16.6)', () => {
  it('appendMessage:翻译调用返回时,不推进的活投影里已经有这条消息', () => {
    openLiveProjection()
    expect(peekedMessageIds()).toEqual([])

    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })

    // 没 await、没 flush、没有任何一次读口的 drain。
    expect(peekedMessageIds()).toEqual(['u1'])
  })

  it('patchMessage:补丁当场落在活投影的那条节点上', () => {
    openLiveProjection()
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })

    sessionCommandEvents.patchMessage(SESSION, 'u1', { metadata: { tag: 'f1' } } as Partial<ChatMessage>)

    expect((peekedNode('u1')?.patch as Record<string, unknown> | undefined)?.metadata).toEqual({
      tag: 'f1',
    })
  })

  it('truncateFrom(regenerate):遮蔽当场生效,活投影里那条已经 hidden', () => {
    openLiveProjection()
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'first',
      timestamp: 1000,
    })
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u2',
      role: 'user',
      content: 'second',
      timestamp: 2000,
    })
    expect(peekedMessageIds()).toEqual(['u1', 'u2'])

    sessionCommandEvents.truncateFrom(SESSION, { messageId: 'u2', inclusive: true }, { now: 3000 })

    expect(peekedMessageIds()).toEqual(['u1'])
  })
})

describe('F1:活 surface 也由写入口推进 —— 两扇门都算数(§16.6)', () => {
  it('走 writeSessionEvent 落的 tool/result 也进得了写侧 surface', async () => {
    // `tool/result` 既是 surface 节点、又只从采集点走 `writeSessionEvent`
    // 那扇门(`session-event-recorder.ts`)。F1 之前写侧的活 surface 永远看不见它
    // (core `declaredMessageGap` 注释里的真机病历 `ec2437ff`),F1 之后看得见。
    const surface = sessionSurface(SESSION)
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })
    const before = surface.order().length

    const seq = writeSessionEvent(
      SESSION,
      'tool/result',
      { callId: 'c1', ok: true } as never,
      { surfaceOp: 'append' },
    )

    expect(seq).toBeDefined()
    expect(surface.order()).toContain(seq)
    expect(surface.order().length).toBe(before + 1)

    // 写侧看到的这一串,与读侧从**文件字节**折出来的那一串逐字相同 ——
    // 两侧同源正是 F1 要立的那条纪律。
    await flushSessionEventLog(SESSION)
    const { foldSurface } = await import('@onething/core/session')
    const { readSessionLogEventsSync } = await import('../event-log.js')
    expect(foldSurface(readSessionLogEventsSync(SESSION)).order).toEqual(surface.order())
  })
})

describe('F1 崩溃窗口:活投影领先磁盘时 refold 跳过而不是报红(§16.4)', () => {
  it('折在前、落盘在后 —— 那一段没落盘时游标对不齐,refold skipped 而不是 mismatch', async () => {
    openLiveProjection()
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'landed',
      timestamp: 1000,
    })
    await flushSessionEventLog(SESSION)
    // 先证明这道门此刻是**通电**的:两侧同源同形 → match(否则下面的 skipped
    // 可能只是因为 refold 整个跑不起来)。
    await expect(checkSessionRefold(SESSION)).resolves.toBe('match')

    // 崩溃窗口:这一条折进了活投影,但它那次落盘永远没有发生(进程在语义
    // fsync 检查点之前消失)。把 appendFile 换成"答应了但什么都没写"就是它。
    const append = vi
      .spyOn(fs.promises, 'appendFile')
      .mockImplementation((async () => undefined) as never)
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u2',
      role: 'user',
      content: 'lost with the process',
      timestamp: 2000,
    })
    await flushSessionEventLog(SESSION)
    append.mockRestore()

    // 活投影领先磁盘一条。
    expect(peekedMessageIds()).toEqual(['u1', 'u2'])
    // 文件末条 seq < 定格游标 → 这次采样**不算数**,不进 refoldChecks,更不报红。
    await expect(checkSessionRefold(SESSION)).resolves.toBe('skipped')
  })
})

/**
 * **F1-a 收口**(§16.15):`rangeFrom` 不吞"归属节点在段外"的尾随 `tool/result`。
 *
 * F1 让写侧的活 surface 看得见 `tool/result` 之后,edit-resend 的 replace 区间
 * 顺手圈进了**别人家**的那一格 —— 工具在途时用户插一句话,在途那次调用的结局
 * 就排在那句话后面落到 surface 上。读侧的工具结果剪枝据此把一次还活着的调用
 * 整个摘掉(真机 `ef079fd7` 两条坏区间)。
 *
 * **反证**:把 `trimForeignTrailingToolResults` 换回 `order.slice(at)`,
 * 第一例当场红(区间与 `sourceEventSeqs` 都会多出那一格)。
 */
describe('F1-a:截断区间不吞别人家的 tool/result(§16.15)', () => {
  it('在途 run 的 tool/result 排在插话之后 —— 它不进这次截断的区间', () => {
    const surface = sessionSurface(SESSION)
    // 上一条 run 与它在途的那次调用。
    const runStart = writeSessionEvent(
      SESSION,
      'run/start',
      { runId: 'r1', kind: 'send', assistantMessageId: 'a1' } as never,
      { surfaceOp: 'append' },
    )
    writeSessionEvent(
      SESSION,
      'tool/call',
      { runId: 'r1', callId: 'c1', name: 'bash', argumentsRaw: '{}', messageId: 'a1' } as never,
    )
    // 用户就在工具在途时插了一句话。
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u2',
      role: 'user',
      content: 'wait',
      timestamp: 2000,
    })
    // 在途那次调用的结局**排在插话后面**落到 surface 上。
    const foreignResult = writeSessionEvent(
      SESSION,
      'tool/result',
      { runId: 'r1', callId: 'c1', isError: false, resultPreview: 'ok' } as never,
      { surfaceOp: 'append' },
    )
    expect(surface.order()).toEqual([runStart, surface.seqOf('u2'), foreignResult])

    const range = surface.rangeFrom('u2')
    // 只切到插话那一格为止:结局那一格归属的 `run/start` 还在段外。
    expect(range).toEqual({ start: surface.seqOf('u2'), end: surface.seqOf('u2'), seqs: [surface.seqOf('u2')] })
  })

  it('归属就在段内的 tool/result 照旧跟着遮 —— 收口只针对"别人家"', () => {
    const surface = sessionSurface(SESSION)
    sessionCommandEvents.appendMessage(SESSION, {
      id: 'u2',
      role: 'user',
      content: 'wait',
      timestamp: 2000,
    })
    // 这条 run 整个生在插话**之后**:它的结局与它自己一起被遮才是对的。
    const runStart = writeSessionEvent(
      SESSION,
      'run/start',
      { runId: 'r2', kind: 'send', assistantMessageId: 'a2' } as never,
      { surfaceOp: 'append' },
    )
    writeSessionEvent(
      SESSION,
      'tool/call',
      { runId: 'r2', callId: 'c2', name: 'bash', argumentsRaw: '{}', messageId: 'a2' } as never,
    )
    const ownResult = writeSessionEvent(
      SESSION,
      'tool/result',
      { runId: 'r2', callId: 'c2', isError: false, resultPreview: 'ok' } as never,
      { surfaceOp: 'append' },
    )

    expect(surface.rangeFrom('u2')?.seqs).toEqual([surface.seqOf('u2'), runStart, ownResult])
  })
})
