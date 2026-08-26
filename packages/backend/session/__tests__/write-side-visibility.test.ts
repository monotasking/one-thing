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
 * **反证**(F1 的回退判据):把 `appendSessionLogEvent` 里那句
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

const { sessionEventTranslator } = await import('../event-translator.js')
const { appendSessionLogEvent, flushSessionEventLog, resetSessionEventLogCache } = await import(
  '../event-log.js'
)
const { resetSessionSurfaceCache, sessionSurface } = await import('../event-surface.js')
const { resetSessionRuns } = await import('../runs.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { getLiveSessionProjection, peekSessionProjection, resetSessionProjectionCache } =
  await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { checkSessionRefold, resetSessionRefoldSampling } = await import('../refold.js')

const SESSION = 'f1-visibility'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-f1-visible-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map()
  resetSessionEventLogCache()
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

    sessionEventTranslator.appendMessage(SESSION, {
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
    sessionEventTranslator.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })

    sessionEventTranslator.patchMessage(SESSION, 'u1', { metadata: { tag: 'f1' } } as Partial<ChatMessage>)

    expect((peekedNode('u1')?.patch as Record<string, unknown> | undefined)?.metadata).toEqual({
      tag: 'f1',
    })
  })

  it('truncateFrom(regenerate):遮蔽当场生效,活投影里那条已经 hidden', () => {
    openLiveProjection()
    sessionEventTranslator.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'first',
      timestamp: 1000,
    })
    sessionEventTranslator.appendMessage(SESSION, {
      id: 'u2',
      role: 'user',
      content: 'second',
      timestamp: 2000,
    })
    expect(peekedMessageIds()).toEqual(['u1', 'u2'])

    sessionEventTranslator.truncateFrom(SESSION, { messageId: 'u2', inclusive: true }, undefined)

    expect(peekedMessageIds()).toEqual(['u1'])
  })
})

describe('F1:活 surface 也由写入口推进 —— 两扇门都算数(§16.6)', () => {
  it('走 appendSessionLogEvent 落的 tool/result 也进得了写侧 surface', async () => {
    // `tool/result` 既是 surface 节点、又只从采集点走 `appendSessionLogEvent`
    // 那扇门(`session-event-recorder.ts`)。F1 之前写侧的活 surface 永远看不见它
    // (core `declaredMessageGap` 注释里的真机病历 `ec2437ff`),F1 之后看得见。
    const surface = sessionSurface(SESSION)
    sessionEventTranslator.appendMessage(SESSION, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })
    const before = surface.order().length

    const seq = appendSessionLogEvent(
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
    sessionEventTranslator.appendMessage(SESSION, {
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
    sessionEventTranslator.appendMessage(SESSION, {
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
