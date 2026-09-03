/**
 * E2:会话列表投影的**存量回填**(`session/list-projection-backfill.ts`)。
 *
 * 每条按可观察的后果写,而且验过反向:
 *  - 判据:缺计数要扫、有话没预览要扫、**空会话回填后不再被扫**(拿预览缺席
 *    当判据会永扫,这一条就是钉住它的反证);
 *  - 落格:两格补上,而 `updatedAt` 与索引里其余字段**一个字节不动**;
 *  - 预览产地:从后往前找第一条**能出预览**的消息 —— 与增量写侧同结果
 *    (`deriveSessionLastMessagePreview` 规则 5 的"空正文不覆盖"落到回填上);
 *  - 打断:signal 一置,当前这条之后停手,剩下的下次启动接着扫(判据幂等);
 *  - 单条失败:记账继续,不把整趟带崩;
 *  - 抢先:算完之后写侧已经落过更新的格,回填不覆盖;
 *  - 事件账本不在:跳过,不写一个"替没读过的账说话"的 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface TestMeta {
  id: string
  name: string
  updatedAt: number
  messageCount?: number
  lastMessagePreview?: string
  [key: string]: unknown
}

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  index: [] as Array<Record<string, unknown>>,
  failOn: new Set<string>(),
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../stores/sessions.js', () => ({
  getSessionsList: () => state.index,
  updateSessionsIndexMetaForCommands: (
    sessionId: string,
    update: (meta: Record<string, unknown>) => void,
  ): boolean => {
    if (state.failOn.has(sessionId)) throw new Error('index write blew up')
    const meta = state.index.find(entry => entry.id === sessionId)
    if (!meta) return false
    update(meta)
    return true
  },
}))

const { flushSessionEventLog, resetSessionEventLogCache } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { resetSessionProjectionCache } = await import('../projection-cache.js')
const {
  runSessionListProjectionBackfill,
  scheduleSessionListProjectionBackfillOnStartup,
  sessionNeedsListProjectionBackfill,
} = await import('../list-projection-backfill.js')

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-e2-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  state.index = []
  state.failOn = new Set()
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  delete process.env.ONETHING_SESSION_LIST_BACKFILL
})

afterEach(async () => {
  await flushSessionEventLog()
  resetSessionProjectionCache()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
  delete process.env.ONETHING_SESSION_LIST_BACKFILL
  vi.restoreAllMocks()
})

/** 索引里放一条会话(缺两格 = 存量的样子)。 */
function indexSession(id: string, extra: Partial<TestMeta> = {}): TestMeta {
  const meta: TestMeta = { id, name: id, updatedAt: 1_000, ...extra }
  state.index.push(meta as unknown as Record<string, unknown>)
  return meta
}

function meta(id: string): TestMeta {
  return state.index.find(entry => entry.id === id) as unknown as TestMeta
}

/** 造一条真的有事件账本的会话(消息按 `messages` 逐条写进去)。 */
async function seedSession(
  id: string,
  messages: Array<{ id: string; role: string; content: string }>,
): Promise<void> {
  fs.mkdirSync(path.join(state.sessionsDir, id), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, id, 'meta.json'), '{}')
  writeSessionEvent(id, 'session/created', { sessionId: id })
  for (const message of messages) {
    writeSessionEvent(id, 'user/message', {
      message: { ...message, timestamp: 1 },
    })
  }
  await flushSessionEventLog(id)
  // 回填走的是**文件重折**那条路(见模块头);把首次写留下的活投影丢掉,
  // 免得这里其实在测"有活投影"那一支。
  resetSessionProjectionCache(id)
}

const noWait = { wait: async () => undefined, throttleMs: 0 }

// ============ 判据 ============

describe('扫描判据', () => {
  it('缺 messageCount 要扫;空会话补上 0 之后不再被扫', () => {
    expect(sessionNeedsListProjectionBackfill({})).toBe(true)
    // 空会话:0 是真值,预览合法缺席 —— 拿预览缺席当判据这里会永远返回 true。
    expect(sessionNeedsListProjectionBackfill({ messageCount: 0 })).toBe(false)
  })

  it('有话却没预览要扫(老写者留下的孤零零计数)', () => {
    expect(sessionNeedsListProjectionBackfill({ messageCount: 3 })).toBe(true)
    expect(sessionNeedsListProjectionBackfill({ messageCount: 3, lastMessagePreview: 'hi' }))
      .toBe(false)
  })
})

// ============ 落格 ============

describe('回填落格', () => {
  it('补上两格,而 updatedAt 与其余字段一个字节不动', async () => {
    await seedSession('s1', [
      { id: 'm1', role: 'user', content: '第一句' },
      { id: 'm2', role: 'assistant', content: '最后一句' },
    ])
    indexSession('s1', { name: '原来的名字', lastModel: 'deepseek-v4' })

    const report = await runSessionListProjectionBackfill(noWait)

    expect(report).toMatchObject({ candidates: 1, filled: 1, failed: 0, aborted: false })
    expect(meta('s1').messageCount).toBe(2)
    expect(meta('s1').lastMessagePreview).toBe('最后一句')
    // 不抬 updatedAt:回填不是内容变更,抬了会把整库顶到列表顶端。
    expect(meta('s1').updatedAt).toBe(1_000)
    expect(meta('s1').name).toBe('原来的名字')
    expect(meta('s1').lastModel).toBe('deepseek-v4')
  })

  it('空会话落 messageCount: 0 且不落预览 —— 再跑一趟它已经不在名单里', async () => {
    await seedSession('empty', [])
    indexSession('empty')

    await runSessionListProjectionBackfill(noWait)

    expect(meta('empty').messageCount).toBe(0)
    expect(meta('empty').lastMessagePreview).toBeUndefined()

    const second = await runSessionListProjectionBackfill(noWait)
    expect(second.candidates).toBe(0)
  })

  it('预览从后往前找第一条有正文的话(空正文的尾消息不洗掉上一句)', async () => {
    await seedSession('s2', [
      { id: 'm1', role: 'user', content: '这句有正文' },
      // 流式刚开出来的助手占位:正文还是空的。增量写侧规则 5 不覆盖上一格,
      // 回填要同结果就必须回头找。
      { id: 'm2', role: 'assistant', content: '' },
    ])
    indexSession('s2')

    await runSessionListProjectionBackfill(noWait)

    expect(meta('s2').messageCount).toBe(2)
    expect(meta('s2').lastMessagePreview).toBe('这句有正文')
  })

  it('事件账本不在的会话跳过 —— 不写一个替没读过的账说话的 0', async () => {
    indexSession('no-ledger')

    const report = await runSessionListProjectionBackfill(noWait)

    expect(report).toMatchObject({ candidates: 1, filled: 0, skippedNoLedger: 1 })
    expect(meta('no-ledger').messageCount).toBeUndefined()
  })
})

// ============ 节流 / 打断 / 失败 ============

describe('节流、打断与单条失败', () => {
  it('每条之间歇一次(节流参数就是那个歇的时长)', async () => {
    await seedSession('a', [{ id: 'm1', role: 'user', content: 'a' }])
    await seedSession('b', [{ id: 'm1', role: 'user', content: 'b' }])
    indexSession('a')
    indexSession('b')
    const waited: number[] = []

    await runSessionListProjectionBackfill({
      throttleMs: 37,
      wait: async ms => {
        waited.push(ms)
      },
    })

    expect(waited).toEqual([37, 37])
  })

  it('signal 一置就停手,剩下的下次启动接着扫', async () => {
    await seedSession('a', [{ id: 'm1', role: 'user', content: 'a' }])
    await seedSession('b', [{ id: 'm1', role: 'user', content: 'b' }])
    indexSession('a')
    indexSession('b')
    const signal = { aborted: false }

    const report = await runSessionListProjectionBackfill({
      signal,
      throttleMs: 1,
      // 第一条跑完就关停(歇那一下正是关停信号到达的窗口)。
      wait: async () => {
        signal.aborted = true
      },
    })

    expect(report).toMatchObject({ candidates: 2, filled: 1, aborted: true })
    expect(meta('a').messageCount).toBe(1)
    expect(meta('b').messageCount).toBeUndefined()

    // 判据天然幂等:下一趟只剩没跑到的那条。
    const second = await runSessionListProjectionBackfill(noWait)
    expect(second.candidates).toBe(1)
    expect(meta('b').messageCount).toBe(1)
  })

  it('单条失败记账继续,不把整趟带崩', async () => {
    await seedSession('bad', [{ id: 'm1', role: 'user', content: 'x' }])
    await seedSession('good', [{ id: 'm1', role: 'user', content: 'y' }])
    indexSession('bad')
    indexSession('good')
    state.failOn.add('bad')

    const report = await runSessionListProjectionBackfill(noWait)

    expect(report).toMatchObject({ candidates: 2, filled: 1, failed: 1 })
    expect(meta('good').lastMessagePreview).toBe('y')
  })

  it('流式中的会话本轮跳过', async () => {
    await seedSession('busy', [{ id: 'm1', role: 'user', content: 'x' }])
    indexSession('busy')

    const report = await runSessionListProjectionBackfill({
      ...noWait,
      isSessionBusy: id => id === 'busy',
    })

    expect(report).toMatchObject({ skippedBusy: 1, filled: 0 })
    expect(meta('busy').messageCount).toBeUndefined()
  })

  it('算完之后写侧已经落过更新的格 —— 回填不覆盖', async () => {
    await seedSession('raced', [{ id: 'm1', role: 'user', content: 'old' }])
    indexSession('raced')

    const report = await runSessionListProjectionBackfill({
      ...noWait,
      // 让出事件环那一刻写侧抢先(真机上就是一条新消息落了格)。
      isSessionBusy: id => {
        const entry = meta(id)
        entry.messageCount = 9
        entry.lastMessagePreview = '写侧刚写的'
        return false
      },
    })

    expect(report).toMatchObject({ filled: 0, skippedFresh: 1 })
    expect(meta('raced').lastMessagePreview).toBe('写侧刚写的')
    expect(meta('raced').messageCount).toBe(9)
  })
})

// ============ 装配口 ============

describe('启动挂点', () => {
  it('默认开;ONETHING_SESSION_LIST_BACKFILL=0 关掉', () => {
    const cancel = scheduleSessionListProjectionBackfillOnStartup({ delayMs: 60_000 })
    expect(cancel).toBeTypeOf('function')
    cancel?.()

    process.env.ONETHING_SESSION_LIST_BACKFILL = '0'
    expect(scheduleSessionListProjectionBackfillOnStartup({ delayMs: 60_000 })).toBeUndefined()
  })

  /**
   * C0 R3。理由与 `blob-gc` 那条逐字相同:这里的 `setTimeout` 也 `unref` 过,
   * `process.getActiveResourcesInfo()` 看不见,只有 `vi.getTimerCount()` 看得见。
   *
   * 反证(实跑过):把 `list-projection-backfill.ts` 里 disposer 的
   * `clearTimeout(timer)` 摘掉 → 最后一句红(`expected 1 to be +0`)。
   */
  it('C0 R3:cancel 之后不留定时器(unref 的也算)', () => {
    vi.useFakeTimers()
    try {
      expect(vi.getTimerCount()).toBe(0)
      const cancel = scheduleSessionListProjectionBackfillOnStartup({ delayMs: 60_000 })
      expect(vi.getTimerCount()).toBe(1)
      cancel?.()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
