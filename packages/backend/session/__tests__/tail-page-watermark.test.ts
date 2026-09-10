import { installSessionLayerForTest } from '../testing/session-layer.js'
/**
 * **尾页读法 + 账本水位**(工单 4 A)。
 *
 * 三句话:
 *
 *  1. **页与水位出自同一个快照**。这一条是整条读法存在的理由 —— 水位比页新一条
 *     = 一条消息永远消失,旧一条 = 同一段正文折两遍,两种都是静默的。所以这里
 *     有一条**反证**:把它拆成"先取页、再取水位"两拍,当场量得出漂移。
 *  2. **两条路(内存 / 文件)给同一个答案**。冷载走文件路(那正是这一单要治的
 *     病:55MB 的账本只读尾巴),活跃会话走内存路。
 *  3. **一页里带引用不带正文**。同一条带附件的消息,整份抄本那条读法给回 base64,
 *     首屏这一页给回 `{hash,bytes}` —— 判据是"这一页是拿来上屏的"。
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

const { flushSessionEventLog, getSessionEventsLogPath } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { getLiveSessionProjection, resetSessionProjectionCache } = await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { sessionReads } = await import('../reads.js')
const { putSessionBlob } = await import('../blob-store.js')

const SESSION = 'sess-tail'

let testSessionLayer: ReturnType<typeof installSessionLayerForTest>

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-tail-'))
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

async function conversation(turns: number): Promise<void> {
  for (let index = 1; index <= turns; index++) turn(index)
  await flushSessionEventLog(SESSION)
}

/** 冷载的形状:内存里什么都没有,读只能走文件那条路。 */
function goCold(): void {
  resetSessionProjectionCache()
  resetSessionEventReadCache()
}

/** 账本此刻最后一条事件的 seq(独立于被测代码的第二条算法)。 */
function ledgerLastSeq(): number {
  const lines = fs.readFileSync(getSessionEventsLogPath(SESSION), 'utf8').trim().split('\n')
  return (JSON.parse(lines[lines.length - 1]) as { seq: number }).seq
}

function tailPage(limit: number, before?: string) {
  const request = before
    ? { sessionId: SESSION, limit, cursor: before, direction: 'older' as const }
    : { sessionId: SESSION, limit, anchor: 'tail' as const }
  return sessionReads.pageMessagesAtWatermark(request)
}

describe('tail page — the newest page by default', () => {
  it('hands back the last N messages, oldest first, with the ledger watermark', async () => {
    await conversation(5)
    goCold()

    const snapshot = tailPage(4)!
    expect(snapshot.page.messages?.map(message => message.id)).toEqual(['u4', 'a4', 'u5', 'a5'])
    expect(snapshot.page.hasMoreBefore).toBe(true)
    expect(snapshot.watermark).toBe(ledgerLastSeq())
  })

  it('walks up to the head with nextBefore and stops there', async () => {
    await conversation(4)
    goCold()

    const seen: string[] = []
    let cursor: string | undefined
    let guard = 0
    for (;;) {
      const snapshot = tailPage(3, cursor)!
      seen.unshift(...(snapshot.page.messages ?? []).map(message => message.id))
      if (!snapshot.page.hasMoreBefore) break
      cursor = snapshot.page.nextCursor ?? undefined
      expect(cursor).toBeTruthy()
      expect(++guard).toBeLessThan(10)
    }
    expect(seen).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4'])
  })

  it('reports the same page and watermark on the memory path as on the file path', async () => {
    await conversation(4)

    goCold()
    const fromFile = tailPage(3)!
    // 把活投影建起来 —— 下一次读走内存那条路。
    getLiveSessionProjection(SESSION)
    const fromMemory = tailPage(3)!

    expect(fromMemory.page.messages?.map(message => message.id))
      .toEqual(fromFile.page.messages?.map(message => message.id))
    expect(fromMemory.page.hasMoreBefore).toBe(fromFile.page.hasMoreBefore)
    expect(fromMemory.watermark).toBe(fromFile.watermark)
  })

  it('has no history to fold for a session with no events', () => {
    expect(tailPage(24)).toBeUndefined()
  })
})

describe('tail page — the page and the watermark come from one snapshot', () => {
  it('does not let an append after the read move the watermark', async () => {
    await conversation(3)
    goCold()

    const snapshot = tailPage(2)!
    const before = snapshot.watermark

    turn(4)
    await flushSessionEventLog(SESSION)

    // 快照就是快照:账本长了,那一次读交出来的水位一格不动 —— 壳因此知道
    // "第 `before` 条之后的都还没折过",SSE 上补的正是新落的那几条。
    expect(snapshot.watermark).toBe(before)
    expect(ledgerLastSeq()).toBeGreaterThan(before)
  })

  it('opens the ledger exactly once per page read — that is what makes it one snapshot', async () => {
    await conversation(3)
    goCold()

    // **机制上的判据**,不是巧合上的:一次 `withEventReader` = 一次 `openSync` =
    // 一份定格的 `size`。页与水位都只看得见那些字节。改成"先取页、再单独问一次
    // 水位"就必然是**两次** open —— 两次之间落的事件会进水位而不进页,壳按水位
    // 跳过它,那条消息静默消失。所以这一条数的就是 open 的次数。
    const ledger = getSessionEventsLogPath(SESSION)
    const realOpen = fs.openSync
    let opens = 0
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: never, ...rest: never[]) => {
      if (file === ledger) opens += 1
      return (realOpen as never as (...args: never[]) => number)(file, ...rest)
    }) as never)
    try {
      const snapshot = tailPage(2)!
      expect(snapshot.watermark).toBe(ledgerLastSeq())
      expect(opens).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('counter-proof: taking the page and the watermark in two beats drifts', async () => {
    await conversation(3)
    goCold()

    // 「分两拍取」的形状:先取页,让出一次事件环(真机上那期间引擎照写不误),
    // 再单独问一次水位。
    const page = sessionReads.pageMessages({ sessionId: SESSION, anchor: 'tail', limit: 2 })
    turn(4)
    await flushSessionEventLog(SESSION)
    goCold()
    const laterWatermark = tailPage(2)!.watermark

    const newestInPage = Math.max(...(page.messages ?? []).map(message => (message as { seq?: number }).seq ?? 0))
    // 水位跑到了页的前面 —— 壳会按它跳过 `(newestInPage, laterWatermark]` 这一段,
    // 而那一段既不在页里、SSE 上也不会再来一次:两条消息静默消失。
    expect(laterWatermark).toBeGreaterThan(newestInPage)

    // 同一时刻用一次读拿到的两样,永远对得上:水位不会跑到页的更前面去
    // (页是尾页,所以页里最新那条就是账本上最新的那条**消息**;水位是最新的
    // 那条**事件**,而 `run/end` 之类不产生消息的事件排在它后面,故 >=)。
    goCold()
    const atomic = tailPage(2)!
    const newestInAtomicPage = Math.max(...(atomic.page.messages ?? []).map(m => (m as { seq?: number }).seq ?? 0))
    expect(atomic.watermark).toBeGreaterThanOrEqual(newestInAtomicPage)
    expect(atomic.watermark).toBe(ledgerLastSeq())
  })
})

describe('tail page — blobs travel as references', () => {
  /** 一条带附件的用户消息:正文在 blob store 里,事件行上只有引用。 */
  async function turnWithAttachment(): Promise<void> {
    const bytes = Buffer.from('an attachment that lives in the blob store')
    const stored = putSessionBlob(SESSION, bytes, 'image/png')
    writeSessionEvent(SESSION, 'user/message', {
      message: {
        id: 'u-blob',
        role: 'user',
        content: 'look at this',
        timestamp: 1,
        attachments: [{ name: 'shot.png', mimeType: 'image/png', base64Data: stored }],
      },
    } as never, { surfaceOp: 'append' })
    await flushSessionEventLog(SESSION)
  }

  it('keeps the reference on the page while the whole transcript inlines it', async () => {
    await turnWithAttachment()
    goCold()

    const paged = tailPage(4)!.page.messages?.[0] as unknown as {
      attachments: Array<{ base64Data: unknown }>
    }
    // 一页里那一格仍然是引用 —— 屏幕要的是"有一张图",不是那几 MB 字节。
    expect(paged.attachments[0].base64Data).toMatchObject({ hash: expect.any(String), bytes: expect.any(Number) })

    goCold()
    const whole = sessionReads.listMessages(SESSION).messages[0] as unknown as {
      attachments: Array<{ base64Data: unknown }>
    }
    // 整份抄本那条读法一格没动:它的读者(模型历史 / 导出)要的就是正文。
    expect(typeof whole.attachments[0].base64Data).toBe('string')
  })
})

/* ─────────────────────────────────────────────────────────────────────────
 * 工单 5 —— 页那一层的两格新形状。
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * 一次落了结局的工具调用。三格结果(`toolCalls[].result` / `steps[].toolCall.result`
 * / `steps[].result`)由投影**从这一条事件**折出来 —— 所以侧表那一手抽的是
 * 真投影的产物,不是测试自己摆出来的三份字符串。
 */
async function turnWithTool(text: string): Promise<void> {
  writeSessionEvent(SESSION, 'user/message', {
    message: { id: 'u-tool', role: 'user', content: 'run it', timestamp: 1 },
  } as never, { surfaceOp: 'append' })
  writeSessionEvent(SESSION, 'run/start', {
    runId: 'r-tool', kind: 'send', assistantMessageId: 'a-tool', timestamp: 2,
  } as never, { surfaceOp: 'append' })
  writeSessionEvent(SESSION, 'tool/call', {
    runId: 'r-tool', callId: 'c-tool', name: 'bash', argumentsRaw: '{}', messageId: 'a-tool',
  } as never)
  writeSessionEvent(SESSION, 'tool/result', {
    runId: 'r-tool', callId: 'c-tool', isError: false, result: { text },
  } as never)
  writeSessionEvent(SESSION, 'run/end', { runId: 'r-tool', outcome: 'completed' } as never)
  await flushSessionEventLog(SESSION)
}

describe('tail page — the open-run seam guard', () => {
  /**
   * 水位那一刻**还开着**的那条 run(工单 5 ③)。
   *
   * 壳按水位接 SSE 是「在一份空状态上接着折」,而一条在水位之前就开张的 run,
   * 它后面的 delta 在空状态上一条都落不下(归约器 `state.runs.get` 落空就 break)。
   * 所以这一格不是读数是**判据**:在场 = 这一次壳只能走整份账本。
   *
   * 反证:把 `activeRun` 那一格摘掉 → 第一条断言红(而屏幕上的症状是「切回一条
   * 正在跑的会话,后面的字一个都不上屏」——静默的)。
   */
  it('says a run was still open at the watermark, and stays silent once it closed', async () => {
    writeSessionEvent(SESSION, 'user/message', {
      message: { id: 'u-open', role: 'user', content: 'go', timestamp: 1 },
    } as never, { surfaceOp: 'append' })
    writeSessionEvent(SESSION, 'run/start', {
      runId: 'r-open', kind: 'send', assistantMessageId: 'a-open', timestamp: 2,
    } as never, { surfaceOp: 'append' })
    await flushSessionEventLog(SESSION)

    // 活投影在场(引擎正在跑这条会话)—— 那正是这一格答得出来的唯一场合。
    getLiveSessionProjection(SESSION)
    expect(tailPage(4)!.activeMessageId).toBe('a-open')

    writeSessionEvent(SESSION, 'run/end', { runId: 'r-open', outcome: 'completed' } as never)
    await flushSessionEventLog(SESSION)
    expect(tailPage(4)!.activeMessageId).toBeUndefined()
  })

  /**
   * 文件那一支恒缺席,而那**不是漏答**:没有活投影 = 这个进程里没有引擎在跑这条
   * 会话 = 不会有属于它的 SSE 事件到达。
   */
  it('never claims an open run on the cold file path', async () => {
    await conversation(2)
    goCold()
    expect(tailPage(4)!.activeMessageId).toBeUndefined()
  })
})

describe('tool result — one call, three slots, one read', () => {
  /**
   * 工单 5 ②:页把大结果换成 `{bytes, hash}` 之后,正文由这条读法取回。
   *
   * 它按 **`callId`** 找那一只工具,只 `materializeStep` 它一步 —— 而不是像
   * `getMessage` 那样把整条会话物化一遍。触发点是「人点开了一张工具卡」,
   * 让一次展开付一次整会话物化正是本单在治的那类病。
   */
  it('hands back the body of each of the three slots by call id', async () => {
    await turnWithTool('the whole output')
    getLiveSessionProjection(SESSION)

    expect(sessionReads.toolResult(SESSION, 'c-tool', 'result')?.value).toBeDefined()
    // `text` 槽 = `step.result`,给人看的那段正文。
    expect(sessionReads.toolResult(SESSION, 'c-tool', 'text')?.value).toBe('the whole output')
  })

  it('says nothing rather than an empty body when that call is not there', async () => {
    await turnWithTool('the whole output')
    getLiveSessionProjection(SESSION)
    expect(sessionReads.toolResult(SESSION, 'no-such-call', 'result')).toBeUndefined()
  })
})

describe('tail page — a brand-new session has an empty page, not a missing one', () => {
  /**
   * **账本在、只是还没有消息**(2026-09-10 工单 5 修的一条真 bug)。
   *
   * 刚建出来的会话账本里已经有 `session/created`(它不是一条消息)。从前这条
   * 读法把「折不出消息」一律当成「没有账本」交回上层,上层于是答**水位 0** ——
   * 而账本此刻在 seq 1。壳按 0 接 SSE,下一条事件是 seq 2,判成缺号、排一次
   * 三秒节流的重取:屏幕上是「新会话里发第一句话,三秒不上屏」。
   * `gate:chat-follow` 的「隔壁那片叶真的收到了流」就是它的形。
   *
   * 反证:把 `watermark <= 0` 那道判据改成恒真(= 回到从前一律交回上层)→
   * 第一条断言红。
   */
  it('reports the real ledger watermark for a session whose ledger holds no messages yet', async () => {
    writeSessionEvent(SESSION, 'session/created', { sessionId: SESSION } as never)
    await flushSessionEventLog(SESSION)
    goCold()

    const snapshot = tailPage(24)
    expect(snapshot).toBeDefined()
    expect(snapshot!.page.messages).toEqual([])
    // 账本在 —— 水位说的就是它此刻在哪儿,不是 0。
    expect(snapshot!.watermark).toBe(ledgerLastSeq())
    expect(snapshot!.watermark).toBeGreaterThan(0)
  })

  it('still hands the question back when there is no ledger at all (a legacy session)', () => {
    goCold()
    // 一个字都没写过 —— 这条读法答不了,交回给上层走化石那条路。
    expect(tailPage(24)).toBeUndefined()
  })
})
