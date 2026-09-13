import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { ResourceReadView } from '@shared/ipc/resources'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { configureGitPort } from '../git-port'
import type { GitPort } from '../git-port'
import { configureChatPort } from '../chat-port'
import type { ChatPort } from '../chat-port'
import { chatSources } from '../chat-source'
import {
  diffKey,
  diffQuery,
  diffQueryOf,
  isChangesUpkeepLive,
  openChangeRoots,
  refreshOpenChanges,
  resetChangesSource,
  statusQuery,
  useChangesLive,
  useDiffLive,
  useFileLive,
  fileQuery,
  fileQueryOf,
} from '../changes-source'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'

/**
 * **「改动」面的数据层**(正本 `apps/desktop-react/docs/changes-panel-2026-09.md`
 * §3.3;壳侧 §4 第三组)。
 *
 * 这一组问这一层答的那几句话,一个面板组件都不渲染:
 *  ① `ResourceReadView` 的**四支**各自折成 query 的 `error`,带的是**原话**;
 *  ② `{repo:false}` 是一种**状态**不是错误(落进 `data`,`error` 是空的);
 *  ③ 刷新分两支:**在场**的 `refetch`(真发一发),**不在场**的只 `invalidate`;
 *  ④ `run/end` 到达时**只有环境会话**那一条算数,而且**回放不算**;
 *  ⑤ 在场账是**引用计数**(同一个根两份,关掉一份仍在场);
 *  ⑥ 那条订阅的寿命 = 「屏幕上还有没有改动面」,**不是 import**;
 *  ⑦ 每一发读都带**发起坐标**(`sessionId` = 环境会话)。
 *
 * ④ 走的是**真接缝**:一台真的 `chat-source` 机器 + 一条真的 `run/end` 账本行
 * (与 `events.jsonl` 逐字同形),不是一个测试专用的写口 —— 这一条守的正是
 * 「订阅那一头真的接上了」,拿假写口发一发等于把要守的东西绕过去。
 */

const ROOT = '/repo/a'
const OTHER = '/repo/b'
const ENV_SESSION = 'env-session'
const OTHER_SESSION = 'other-session'
const T0 = 1_700_000_000_000

const ok = (value: unknown): ResourceReadView => ({ kind: 'ok', value }) as ResourceReadView

let reads: {
  ref: string
  name: string
  query?: Record<string, unknown>
  sessionId?: string
}[] = []
let answer: () => ResourceReadView

function installGitPort(): void {
  reads = []
  const port: GitPort = {
    ready: async () => undefined,
    read: vi.fn(async (ref, name, query, sessionId) => {
      reads.push({ ref, name, query, sessionId })
      return answer()
    }),
  }
  configureGitPort(port)
}

/* ── 一台真的会话机器,只为发得出一条 `run/end` ──────────────────────────── */

type Ledger = { seq: number; time: number; type: string; data: unknown }

const created = (sessionId: string): Ledger => ({
  seq: 1,
  time: T0,
  type: 'session/created',
  data: { sessionId },
})

const runStartOf = (seq: number, runId: string, messageId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/start',
  data: { runId, kind: 'chat', assistantMessageId: messageId, timestamp: T0 },
})

const runEndOf = (seq: number, runId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/end',
  data: { runId, outcome: 'completed' },
})

const runEnd = (seq: number): Ledger => runEndOf(seq, 'r1')

/**
 * 起底那一份账本里躺着几**轮已经跑完的** run。
 *
 * 一条有 200 轮历史的会话就是这一形 —— 这一格是那件事的最小夹具:
 * 起底之后监听器该被喊 **0 次**,而不是 `replayed` 次。
 */
let replayed = 0

/** 起底那一份账本:`replayed` 轮已收摊的 run + 一条开着的 `r1`。 */
function seedLedger(sessionId: string): Ledger[] {
  const rows: Ledger[] = [created(sessionId)]
  let seq = 1
  for (let i = 0; i < replayed; i += 1) {
    rows.push(runStartOf((seq += 1), `h${i}`, `m${i}`))
    rows.push(runEndOf((seq += 1), `h${i}`))
  }
  rows.push(runStartOf((seq += 1), 'r1', 'a1'))
  lastSeededSeq = seq
  return rows
}

/** 最后那条起底行的 seq —— 活到达那一条要接在它后面(接不上就是缺号重折)。 */
let lastSeededSeq = 2

let eventSubs: ((envelope: SessionEventEnvelope) => void)[] = []

function installChatPort(): void {
  eventSubs = []
  const port: ChatPort = {
    ready: async () => undefined,
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async (sessionId: string) => ({ events: seedLedger(sessionId) as never }),
    readBlob: async () => ({}),
    onSessionEvent: (callback: (envelope: SessionEventEnvelope) => void) => {
      eventSubs.push(callback)
      return () => void eventSubs.splice(eventSubs.indexOf(callback), 1)
    },
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  } as unknown as ChatPort
  configureChatPort(port)
}

/** 一条真的 `run/end` 落到那台机器的折叠上。 */
function emitRunEnd(sessionId: string): void {
  // **接在起底那一条后面**:缺号会触发重折,那一路不经过 `feedLedger`。
  const seq = lastSeededSeq + 1
  const envelope: SessionEventEnvelope = {
    sessionId,
    sequence: seq,
    timestamp: T0,
    event: { type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT, record: runEnd(seq) } as never,
  }
  for (const fn of [...eventSubs]) fn(envelope)
}

/** 推屏按帧合并 —— 断言前把那一帧等掉。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** 「这一份改动面在场」。走的是**产品那条唯一的登记口**(`useChangesLive`)。 */
let held: (() => void)[] = []
function hold(root: string): () => void {
  const view = renderHook(() => useChangesLive(root))
  const off = () => view.unmount()
  held.push(off)
  return () => {
    act(() => off())
    held = held.filter((x) => x !== off)
  }
}
/** 「正看着这一个文件的两版原文」(批 ③-b:改动面吃的是这一族)。 */
function holdFile(root: string, path: string): () => void {
  const view = renderHook(() => useFileLive(root, path))
  const off = () => view.unmount()
  held.push(off)
  return () => {
    act(() => off())
    held = held.filter((x) => x !== off)
  }
}
/** 「正看着这一格 diff」。走的是产品那条唯一的登记口。 */
function holdDiff(root: string, path: string): () => void {
  const view = renderHook(() => useDiffLive(root, path))
  const off = () => view.unmount()
  held.push(off)
  return () => {
    act(() => off())
    held = held.filter((x) => x !== off)
  }
}
function releaseAll(): void {
  for (const off of [...held]) act(() => off())
  held = []
}

beforeEach(() => {
  replayed = 0
  resetChangesSource()
  answer = () =>
    ok({ repo: true, root: ROOT, branch: 'main', files: [], stat: { add: 0, del: 0, files: 0 } })
  installGitPort()
  installChatPort()
  useExposeStore.setState({ ...initialExposeState, envSessionId: ENV_SESSION })
})

afterEach(() => {
  releaseAll()
  chatSources.resetAll()
  configureChatPort(undefined)
  configureGitPort(undefined)
  resetChangesSource()
})

describe('结局四支折成 query 的 error,带的是后端原话', () => {
  it('denied → `reason` 原样', async () => {
    answer = () => ({ kind: 'denied', reason: 'outside the sandbox' }) as ResourceReadView
    await statusQuery.get(ROOT).ensure()
    expect(statusQuery.get(ROOT).get().error).toBe('outside the sandbox')
  })

  it('failed → `error.message` 原样', async () => {
    answer = () =>
      ({ kind: 'failed', error: { message: 'git: command not found' } }) as ResourceReadView
    await statusQuery.get(ROOT).ensure()
    expect(statusQuery.get(ROOT).get().error).toBe('git: command not found')
  })

  it('invalid → `message` 原样', async () => {
    answer = () => ({ kind: 'invalid', message: 'path is required' }) as ResourceReadView
    await statusQuery.get(ROOT).ensure()
    expect(statusQuery.get(ROOT).get().error).toBe('path is required')
  })

  it('**`{repo:false}` 不是错误** —— 它落进 data,error 是空的', async () => {
    answer = () => ok({ repo: false })
    await statusQuery.get(ROOT).ensure()
    const snap = statusQuery.get(ROOT).get()
    expect(snap.error).toBeUndefined()
    expect(snap.data).toEqual({ repo: false })
  })
})

describe('两条读法各打各的地址', () => {
  it('status 打 `git:<workdir>`,不带 query', async () => {
    await statusQuery.get(ROOT).ensure()
    expect(reads).toEqual([
      { ref: `git:${ROOT}`, name: 'status', query: undefined, sessionId: ENV_SESSION },
    ])
  })

  it('diff 打同一个地址,`path` 是**仓库根相对**那一段', async () => {
    answer = () => ok({ path: 'src/a.ts', text: '@@', binary: false, truncated: false })
    await diffQueryOf(ROOT, 'src/a.ts').ensure()
    expect(reads).toEqual([
      { ref: `git:${ROOT}`, name: 'diff', query: { path: 'src/a.ts' }, sessionId: ENV_SESSION },
    ])
  })

  it('**键按 (root, path) 两段**:同一条相对路径在两个仓里是两格', () => {
    expect(diffQueryOf(ROOT, 'src/a.ts')).not.toBe(diffQueryOf(OTHER, 'src/a.ts'))
    expect(diffQueryOf(ROOT, 'src/a.ts')).toBe(diffQueryOf(ROOT, 'src/a.ts'))
  })
})

describe('刷新:在场 refetch,不在场 invalidate', () => {
  it('在场的那一格真发一发,不在场的只标脏', async () => {
    await statusQuery.get(ROOT).ensure()
    await statusQuery.get(OTHER).ensure()
    expect(reads.length).toBe(2)

    hold(ROOT)
    await settle()
    expect(openChangeRoots()).toEqual([ROOT])

    refreshOpenChanges()
    await settle()

    // 在场那一格真发了一发(第一发是 `ensure`,第二发是这次 refetch);
    // 不在场那一格一发都没有。
    expect(reads.filter((r) => r.ref === `git:${ROOT}`).length).toBe(2)
    expect(reads.filter((r) => r.ref === `git:${OTHER}`).length).toBe(1)
    // 但不在场那一格确实脏了:下一次 `ensure` 会重新去问。
    await statusQuery.get(OTHER).ensure()
    expect(reads.filter((r) => r.ref === `git:${OTHER}`).length).toBe(2)
  })

  it('**正看着的那一格 diff 也重问**(在场账,不是整族一刀切标脏)', async () => {
    answer = () => ok({ path: 'src/a.ts', text: '@@', binary: false, truncated: false })
    holdDiff(ROOT, 'src/a.ts')
    await settle()
    const mine = () => reads.filter((r) => r.name === 'diff').length
    expect(mine()).toBe(1)

    refreshOpenChanges()
    await settle()
    expect(mine()).toBe(2)
  })

  it('**正看着的那个文件两版原文也重问**(`file` 那一族同一条规矩)', async () => {
    answer = () => ok({ path: 'src/a.ts', head: null, work: { text: 'x', binary: false, truncated: false, bytes: 1 } })
    holdFile(ROOT, 'src/a.ts')
    await settle()
    const mine = () => reads.filter((r) => r.name === 'file').length
    expect(mine()).toBe(1)

    refreshOpenChanges()
    await settle()
    expect(mine()).toBe(2)
  })

  it('没在看的那个文件只标脏,一发都不发;空 path 那格照旧跳过', async () => {
    answer = () => ok({ path: 'src/b.ts', head: null, work: { text: 'x', binary: false, truncated: false, bytes: 1 } })
    await fileQueryOf(ROOT, 'src/b.ts').ensure()
    const before = reads.length
    refreshOpenChanges()
    await settle()
    expect(reads.length).toBe(before)
    await fileQuery.get(diffKey(ROOT, 'src/b.ts')).ensure()
    expect(reads.length).toBe(before + 1)
    // 空 path 那一格:订着也不发。
    const off = fileQueryOf(ROOT, '').subscribe(() => {})
    const at = reads.length
    refreshOpenChanges()
    await settle()
    expect(reads.length).toBe(at)
    off()
  })

  it('没在看的那一格 diff 只标脏,一发都不发', async () => {
    answer = () => ok({ path: 'src/b.ts', text: '@@', binary: false, truncated: false })
    await diffQueryOf(ROOT, 'src/b.ts').ensure()
    const before = reads.length
    refreshOpenChanges()
    await settle()
    expect(reads.length).toBe(before)
    // 但确实脏了。
    await diffQuery.get(diffKey(ROOT, 'src/b.ts')).ensure()
    expect(reads.length).toBe(before + 1)
  })

  it('**「还没选中」那格占位(空 path)一发都不发**,哪怕它正被订着', async () => {
    /*
     * **订上它**是这一条的关键:面板没选中行时 `useQuery(diffQueryOf(root, ''))`
     * 真的订着这一格,而 `invalidate()` 对**被订着**的那一格是就地后台补拉
     * (上一条用例钉的那句内核事实)。所以不跳过的话,每一次 run/end 都会换来
     * 一发 `path: ''` 的真请求 —— 一个后端只能拒绝的问题。
     */
    const off = diffQueryOf(ROOT, '').subscribe(() => {})
    const before = reads.length
    refreshOpenChanges()
    await settle()
    expect(reads.length).toBe(before)
    expect(diffQuery.get(diffKey(ROOT, '')).get().dataRev).toBe(0)
    off()
  })

  /*
   * **一条内核事实**,写成用例免得它哪天变了没人发现:`Query.invalidate()` 在
   * **有订阅者**时就地后台补拉(`data/kernel/query.ts` 的 `invalidate`:
   * `if (listeners.size > 0) void start(true)`)。`refreshOpenChanges` 那条
   * 「在场 / 不在场」的分流因此是**显式**的而不是必需的 —— 判据的产地该是这只
   * 文件自己的在场账,不是「恰好有没有人订阅」这条内核内部性质。
   */
  it('内核:`invalidate()` 对**被订着**的那一格就地后台补拉', async () => {
    await statusQuery.get(OTHER).ensure()
    const before = reads.length
    const off = statusQuery.get(OTHER).subscribe(() => {})
    statusQuery.invalidate(OTHER)
    await settle()
    expect(reads.length).toBe(before + 1)
    off()
  })
})

describe('在场账是**引用计数**', () => {
  it('同一个根两份,关掉一份仍在场', async () => {
    hold(ROOT)
    const releaseSecond = hold(ROOT)
    await settle()
    expect(openChangeRoots()).toEqual([ROOT])

    releaseSecond()
    await settle()
    // 第一份还开着 —— 若这本账是 `Set`,这里会当场变成空的。
    expect(openChangeRoots()).toEqual([ROOT])

    const before = reads.length
    refreshOpenChanges()
    await settle()
    expect(reads.length).toBe(before + 1)
  })
})

describe('那条订阅的寿命 = 屏幕上还有没有改动面', () => {
  it('import 之后是**不订**的;第一份到场才接,最后一份离场就退', async () => {
    // 出厂(`beforeEach` 里 `resetChangesSource()` 刚跑过)= 不订。
    expect(isChangesUpkeepLive()).toBe(false)

    const releaseA = hold(ROOT)
    const releaseB = hold(OTHER)
    await settle()
    expect(isChangesUpkeepLive()).toBe(true)

    releaseA()
    await settle()
    expect(isChangesUpkeepLive()).toBe(true)

    releaseB()
    await settle()
    expect(isChangesUpkeepLive()).toBe(false)
  })
})

describe('`run/end` 只对**环境会话**、而且只对**活到达**刷新(走真接缝)', () => {
  it('**回放不算**:起底那一份账本里的 `run/end` 一次都不发', async () => {
    hold(ROOT)
    await settle()
    const before = reads.length

    // 这条会话的账本里躺着三条 `run/end`(一条有 200 轮历史的会话就是这一形)。
    replayed = 3
    chatSources.acquire(ENV_SESSION)
    await settle()

    expect(reads.length).toBe(before)
  })

  it('之后**活到一条** → 重问一次', async () => {
    replayed = 3
    chatSources.acquire(ENV_SESSION)
    await settle()
    hold(ROOT)
    await settle()
    const before = reads.length

    emitRunEnd(ENV_SESSION)
    await settle()
    expect(reads.length).toBe(before + 1)
  })

  it('别的会话跑完一轮 → 一格不动', async () => {
    chatSources.acquire(ENV_SESSION)
    chatSources.acquire(OTHER_SESSION)
    await settle()
    hold(ROOT)
    await settle()
    const before = reads.length

    emitRunEnd(OTHER_SESSION)
    await settle()
    expect(reads.length).toBe(before)
  })
})
