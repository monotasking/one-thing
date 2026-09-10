import { installSessionLayerForTest } from '../testing/session-layer.js'
/**
 * **投影检查点的落盘面**(工单 4 B)。
 *
 * 核心那道门只有一句话,与 refold 的哲学逐字相同:**两条独立路径折出同一份** ——
 * 「读检查点 + 折它之后那一段」与「从头折整份账本」。
 *
 * 其余每一条都是**反证**:把检查点的某一格改坏,它必须被丢掉、必须退回从头折,
 * 而且必须**不改账本一个字节**。检查点是派生物,删了自己重建 —— 这一套就是那句
 * 话的执法。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../stores/sessions.js', () => ({
  getSession: (id: string) => ({ id, messages: [] }),
  getSessionRaw: (id: string) => ({ id, messages: [] }),
  getSessions: () => [],
  getSessionMessages: () => [],
  getSessionMessagesPage: () => ({ success: true, messages: [], hasMoreBefore: false, hasMoreAfter: false, nextCursor: null, backwardsCursor: null }),
  getSessionUserMessageMarkers: () => [],
  readSessionTranscriptFile: () => undefined,
}))

const { flushSessionEventLog, getSessionEventsLogPath, getSessionProjectionCheckpointPath } =
  await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const {
  getLiveSessionProjection,
  liveSessionProjectionCursor,
  peekSessionAccount,
  resetSessionProjectionCache,
} = await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { sessionReads } = await import('../reads.js')
const {
  loadSessionProjectionCheckpoint,
  peekSessionProjectionCheckpointMeta,
  writeSessionProjectionCheckpoint,
} = await import('../checkpoint-file.js')

const SESSION = 'sess-checkpoint'

let testSessionLayer: ReturnType<typeof installSessionLayerForTest>

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-ckpt-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  testSessionLayer = installSessionLayerForTest()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  resetSessionPrepareCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  await testSessionLayer.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

function turn(index: number): void {
  const userId = `u${index}`
  const assistantId = `a${index}`
  const runId = `r${index}`
  writeSessionEvent(SESSION, 'user/message', {
    message: { id: userId, role: 'user', content: `ask ${index}`, timestamp: index * 10 },
  } as never, { surfaceOp: 'append' })
  writeSessionEvent(SESSION, 'run/start', {
    runId, kind: 'send', assistantMessageId: assistantId, timestamp: index * 10 + 1,
  } as never, { surfaceOp: 'append' })
  writeSessionEvent(SESSION, 'assistant/chunks', {
    runId, requestIndex: index, messageId: assistantId, partIndex: index * 2,
    kind: 'text', time0: 1, dt: [0], text: [`reply ${index}`],
  } as never)
  writeSessionEvent(SESSION, 'run/end', { runId, outcome: 'completed' } as never)
}

async function conversation(from: number, to: number): Promise<void> {
  for (let index = from; index <= to; index++) turn(index)
  await flushSessionEventLog(SESSION)
}

/** 把此刻的活投影写成检查点(生产里的两个挂点都最终调这一只)。 */
async function checkpointNow(): Promise<string> {
  resetSessionProjectionCache()
  const projection = getLiveSessionProjection(SESSION)
  const cursor = liveSessionProjectionCursor(SESSION)!
  const account = peekSessionAccount(SESSION)!
  expect(writeSessionProjectionCheckpoint(SESSION, projection, account, cursor)).toBe('written')
  return getSessionProjectionCheckpointPath(SESSION)
}

/** 现在把这条会话冷载一遍(丢掉内存,从盘上重来),交出可见消息的 id。 */
function coldLoadIds(): string[] {
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  return sessionReads.listMessages(SESSION).messages.map(message => message.id)
}

function ledgerBytes(): number {
  return fs.statSync(getSessionEventsLogPath(SESSION)).size
}

function patchCheckpoint(patch: Record<string, unknown>): void {
  const at = getSessionProjectionCheckpointPath(SESSION)
  const file = JSON.parse(fs.readFileSync(at, 'utf8')) as Record<string, unknown>
  fs.writeFileSync(at, JSON.stringify({ ...file, ...patch }), 'utf8')
}

describe('projection checkpoint — the gate', () => {
  it('folds the same history with a checkpoint as without one', async () => {
    await conversation(1, 3)
    await checkpointNow()
    // 检查点之后又聊了两轮 —— 冷载要把这一段折到检查点上。
    await conversation(4, 5)

    const withCheckpoint = coldLoadIds()
    expect(peekSessionProjectionCheckpointMeta(SESSION)?.lastSeq).toBe(12)

    // 另一条独立路径:删掉检查点,整份账本从头折。
    fs.rmSync(getSessionProjectionCheckpointPath(SESSION), { force: true })
    const withoutCheckpoint = coldLoadIds()

    expect(withCheckpoint).toEqual(withoutCheckpoint)
    expect(withCheckpoint).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5'])
  })

  it('resumes from the ledger byte the checkpoint covers', async () => {
    await conversation(1, 3)
    await checkpointNow()
    const covered = ledgerBytes()
    await conversation(4, 4)

    const restored = loadSessionProjectionCheckpoint(SESSION)
    expect(restored?.lastSeq).toBe(12)
    expect(restored?.fromByte).toBe(covered)
    // 尾巴那一段才是要折的:检查点覆盖到的字节一个也不重读。
    expect(restored!.fromByte).toBeLessThan(ledgerBytes())
  })

  it('carries the surface across the checkpoint, so a delete stays deleted', async () => {
    await conversation(1, 3)
    writeSessionEvent(SESSION, 'message/deleted', { messageId: 'u2' } as never, {
      surfaceOp: { op: 'replace', start: 5, end: 5 }, sourceEventSeqs: [5],
    })
    await flushSessionEventLog(SESSION)
    await checkpointNow()
    await conversation(4, 4)

    const withCheckpoint = coldLoadIds()
    fs.rmSync(getSessionProjectionCheckpointPath(SESSION), { force: true })
    expect(withCheckpoint).toEqual(coldLoadIds())
    expect(withCheckpoint).not.toContain('u2')
  })
})

describe('projection checkpoint — a mismatch is discarded, never repaired', () => {
  /** 每一条反证的形状相同:改坏一格 → 检查点作废 → 从头折的答案照旧,账本没动。 */
  async function expectDiscarded(patch: Record<string, unknown>): Promise<void> {
    await conversation(1, 3)
    await checkpointNow()
    await conversation(4, 4)
    const ledgerBefore = fs.readFileSync(getSessionEventsLogPath(SESSION), 'utf8')
    const expected = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']

    patchCheckpoint(patch)
    expect(loadSessionProjectionCheckpoint(SESSION)).toBeUndefined()
    // 作废的检查点当场删掉 —— 留着它只会让下一次读再判一遍同一件事。
    expect(fs.existsSync(getSessionProjectionCheckpointPath(SESSION))).toBe(false)
    // 从头折,一条不少。
    expect(coldLoadIds()).toEqual(expected)
    // **账本一个字节都没动** —— 检查点对不上时改的永远是检查点,不是账本。
    expect(fs.readFileSync(getSessionEventsLogPath(SESSION), 'utf8')).toBe(ledgerBefore)
  }

  it('discards a checkpoint whose ledgerBytes is wrong', async () => {
    // 字节数改错 = 这份投影与账本的哪一段对应说不清了。这一条正是设计说的
    // 「检查点字节数改错 → 对不上就丢弃从头折」。
    await expectDiscarded({ ledgerBytes: 4 })
  })

  it('discards a checkpoint that claims more bytes than the ledger has', async () => {
    await expectDiscarded({ ledgerBytes: 999_999_999 })
  })

  it('discards a checkpoint whose last-line fingerprint does not match', async () => {
    // 长度对、内容不对 —— 只有指纹那一道拦得住(账本被重写正是这个形状)。
    await expectDiscarded({ lastLineSha256: 'f'.repeat(64) })
  })

  it('discards a checkpoint whose ledger was rewritten to the very same length', async () => {
    // **只有末行指纹那一道拦得住的那种**:字节数一模一样、内容变了。账本被外来
    // 写手重写正是这个形状(G12),而前三道门(版本 / 会话 id / 字节数)会全部
    // 放行。这一条因此是指纹那一道存在的唯一理由。
    await conversation(1, 3)
    await checkpointNow()
    const logPath = getSessionEventsLogPath(SESSION)
    const before = fs.readFileSync(logPath, 'utf8')
    const lines = before.trimEnd().split('\n')
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
    // 同长度改写:把末行的 outcome 换成一个等长的别的词。
    const rewritten = JSON.stringify({ ...last, data: { ...(last.data as object), outcome: 'aborted__' } })
    expect(rewritten.length).not.toBe(0)
    lines[lines.length - 1] = rewritten.padEnd(lines[lines.length - 1].length, ' ').slice(0, lines[lines.length - 1].length)
    fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8')
    expect(fs.readFileSync(logPath, 'utf8').length).toBe(before.length)

    expect(loadSessionProjectionCheckpoint(SESSION)).toBeUndefined()
    expect(fs.existsSync(getSessionProjectionCheckpointPath(SESSION))).toBe(false)
  })

  it('discards a checkpoint whose lastSeq disagrees with that line', async () => {
    await expectDiscarded({ lastSeq: 999 })
  })

  it('discards a checkpoint written for another session', async () => {
    await expectDiscarded({ sessionId: 'somebody-else' })
  })

  it('discards a checkpoint from another codec version', async () => {
    await conversation(1, 3)
    await checkpointNow()
    const at = getSessionProjectionCheckpointPath(SESSION)
    const file = JSON.parse(fs.readFileSync(at, 'utf8')) as { payload: { version: number } }
    file.payload.version += 1
    fs.writeFileSync(at, JSON.stringify(file), 'utf8')
    expect(loadSessionProjectionCheckpoint(SESSION)).toBeUndefined()
    expect(coldLoadIds()).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  })

  it('discards a corrupt file without touching the ledger', async () => {
    await conversation(1, 2)
    await checkpointNow()
    const ledgerBefore = fs.readFileSync(getSessionEventsLogPath(SESSION), 'utf8')
    fs.writeFileSync(getSessionProjectionCheckpointPath(SESSION), '{ not json', 'utf8')
    expect(loadSessionProjectionCheckpoint(SESSION)).toBeUndefined()
    expect(coldLoadIds()).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(fs.readFileSync(getSessionEventsLogPath(SESSION), 'utf8')).toBe(ledgerBefore)
  })
})

describe('projection checkpoint — the write refuses what it cannot vouch for', () => {
  it('answers "behind" when the projection is not folded through the ledger tail', async () => {
    await conversation(1, 3)
    resetSessionProjectionCache()
    const projection = getLiveSessionProjection(SESSION)
    const account = peekSessionAccount(SESSION)!
    // 账本此刻末行的 seq 是 12;拿一个别的数去写 = 这份投影与这个字节数不是同一
    // 时刻的事实。写入口必须拒绝,而不是写下一份会让冷载少折一段的假备忘。
    expect(writeSessionProjectionCheckpoint(SESSION, projection, account, 7)).toBe('behind')
    expect(fs.existsSync(getSessionProjectionCheckpointPath(SESSION))).toBe(false)
  })

  it('skips a ledger whose last line is still half-written', async () => {
    await conversation(1, 2)
    resetSessionProjectionCache()
    const projection = getLiveSessionProjection(SESSION)
    const cursor = liveSessionProjectionCursor(SESSION)!
    const account = peekSessionAccount(SESSION)!
    // 末尾补半行(崩溃截断的形状):`ledgerBytes` 落不到行首,这一次就不写。
    fs.appendFileSync(getSessionEventsLogPath(SESSION), '{"seq":99,"ty', 'utf8')
    expect(writeSessionProjectionCheckpoint(SESSION, projection, account, cursor)).toBe('skipped')
    expect(fs.existsSync(getSessionProjectionCheckpointPath(SESSION))).toBe(false)
  })
})
