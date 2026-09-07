/**
 * 会话事件日志的写入口与读取器。
 *
 * 落在既有的 per-session 目录里:`sessions/<id>/events.jsonl`,与 `meta.json`、
 * `messages.jsonl` 并排。纯增量,永不改写。
 *
 * ## S1a 的纪律翻转(§10.3)
 *
 * E0 时这里是一本**旁路账本**,四条纪律都按"记账坏了不能影响聊天"写:
 * 自己从不建目录、写失败 warnOnce 吞掉、不 fsync、seq 只在进程内单调。
 * 事件正在成为唯一事实,于是四条逐一翻过来:
 *
 * 1. **会话目录由事件层创建** —— 但**只有 `session/created` 有这个权力**(B4)。
 *    别的类型仍然只往已经存在的目录里追加:legacy 整文件会话(`sessions/<id>.json`)
 *    天然没有目录,凭空给它建一个会让 `storage-driver.jsonlExists()` 把它误判成
 *    空的 jsonl 会话,整份历史当场消失。同一批里 `jsonlExists` 也开始认
 *    `events.jsonl`,鸡生蛋因此消失:新会话的第一条事件就把目录立起来。
 * 2. **写失败不再静默** —— 计进 `<store>/log/session-shadow-stats.json` 的
 *    `appendFailures`,每会话 warn 一次(`event-stats.ts`)。**S3w-3 批 6b 起
 *    无条件上抛**(裁定 7,从前是 `ONETHING_SESSION_TRANSCRIPT=off` 那一档的
 *    特例,而那个开关已随抄本写代码退役):抄本不在了,`events.jsonl` 是唯一
 *    持久化,写不进去不是"影子少一笔"而是"账本少一笔",必须让调用方感知得到
 *    (`SessionEventWriteError`)。检查点和后续同步写口都传播失败;写队列永久停止,
 *    不允许跳过失败事件继续追加。
 * 3. **语义检查点 fsync** —— `flushSessionEventLog(sessionId, throughSeq?)`
 *    固定目标水位,等待真实追加并 fsync;首次还同步文件及祖先目录项。
 *    调模型前 / 调工具前 / 响应收齐 / run 结束各一次(dsh 判例)。
 *    300ms 节流那种"按时间刷"换成"按语义刷":崩溃时丢的是"还没到检查点的那
 *    一小段",而不是"随机的 300ms"。
 * 4. **G12 跨进程守卫** —— 首次启用读文件 lastSeq;之后按字节数比对,发现文件
 *    比我们写进去的还长(别的进程写过)就**拒写**(S3w-0b:从"重装计数器继续写"
 *    升级而来,见 `guardForeignWriter`),绝不盲写。
 *    `surfaceOp replace` 是按 seq 区间遮蔽的,重复 seq 会变成静默的历史错乱。
 *
 * 类型与纯编解码在 core(`@onething/core/session`);这里只负责路径、文件、
 * 计数器与队列。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { BackendNotAssembledError, getCurrentBackendSafe } from '../current.js'
import {
  encodeSessionLogEventLine,
  collectSessionBlobRefHashes,
  parseSessionLogEventLog,
  type SessionLogEventDataFor,
  type SessionLogEventRecord,
  type SessionLogEventType,
  type SessionSurfaceOp,
} from '@onething/core/session'
import {
  findLastSessionEventInLog,
  parseSessionEventLog,
  scanSessionEventLogCounters,
  type SessionEventDataFor,
  type SessionEventRecord,
  type SessionEventType,
} from '@onething/runtime/sessions/session-events'
import {
  getOnethingSessionsDir,
} from '@onething/runtime/storage'
import {
  countSessionEventFailure,
  flushSessionEventStats,
  isSessionShadowEnabled,
} from './event-stats.js'

import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')


export const SESSION_EVENTS_LOG_FILENAME = 'events.jsonl'

/**
 * 事件账本写不进去(§14.6 裁定 7;S3w-3 批 6b 起**无条件**抛)。
 *
 * `events.jsonl` 是唯一持久化,写不进去不再是"影子少一笔"而是"账本少一笔",
 * 于是从计数自吞升级为**命令失败上抛**:调用方(命令面 / 引擎收尾链)必须感知
 * 得到。从前这只在 `ONETHING_SESSION_TRANSCRIPT=off` 那一档成立,而那个开关已
 * 随抄本写代码一起退役 —— 观察期结束了。
 */
export class SessionEventWriteError extends Error {
  readonly sessionId: string
  /** First sequence whose persistence this failure prevents. */
  readonly seq?: number
  readonly operation?: 'append' | 'open' | 'sync' | 'directory' | 'encode' | 'blob'
  constructor(sessionId: string, what: string, options?: {
    cause?: unknown
    seq?: number
    operation?: SessionEventWriteError['operation']
  }) {
    super(`session event log write failed (${what}): ${sessionId}`)
    this.name = 'SessionEventWriteError'
    this.sessionId = sessionId
    this.seq = options?.seq
    this.operation = options?.operation
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause
  }
}

/** G12 守卫的最小间隔:每次 append 都 stat 一遍文件是纯浪费。 */
const FOREIGN_WRITER_CHECK_INTERVAL_MS = 500

/**
 * 影子投影的**尾巴**上限(S1b)。
 *
 * 影子期的活投影要"每来一条事件推一条"才能做到 O(新事件),而它拿不到写入口的
 * 回调(装配层禁止 import 期副作用)。于是写入口把刚分配好的记录挂在这条尾巴上,
 * 消费者(`session/shadow.ts`)按需取走 —— 一次请求 / 一次 run 收尾各取一次。
 *
 * **F1(§16.6)之后它降级成兜底**:活投影已经建起来的会话由同步可见观察者
 * (`registerSessionLogEventAppendObserver`)当场折进去,尾巴只服务"这条会话
 * 还没有活投影"的那一段 —— 观察者不许为了折一条事件去读整份文件建表。
 * 尾巴仍然照常攒(取走时 `seq <= lastSeq` 天然幂等),这样"活投影第一次建起来"
 * 那一刻既有文件、也有这个进程刚写下还没落盘的那几条。
 * 上限只是**防呆**:一次请求之内攒满 20 万条事件不可能发生,真发生了宁可让影子
 * 从文件重折一遍,也不能让一条永不消费的队列吃光内存。
 */
const SHADOW_TAIL_MAX = 200_000

/**
 * 尾巴要不要攒 —— **有没有内存里的消费者**。
 *
 * S1b 时消费者只有影子断言,所以判据是"影子开着吗"。S2a 起活投影同时是产品
 * 读路的取数来源,于是判据放大成两条之一 —— 而 S3w-3 批 6b 烧掉
 * `ONETHING_SESSION_READ` 之后,读路那条恒真:**尾巴永远在攒**,因为产品线的
 * 每一次读都从活投影上取。这个函数留着是为了让"为什么恒真"有个说得清的落点,
 * 不是为了将来还能关掉。
 */
function wantsEventTail(): boolean {
  return true
}

/**
 * 内存活投影**在被维护**吗(即写入口那条尾巴有没有在攒)。
 *
 * refold 自洽环(`refold.ts`)要拿"内存活投影"当比对的一侧,而那份投影靠这条
 * 尾巴增量推进 —— 尾巴关着的时候它会停在第一次折出来的那一刻,拿它去比只会
 * 比出"文件多了一段"的假不等。判据只该有一份,所以由这里对外说。
 */
export function sessionEventTailEnabled(): boolean {
  return wantsEventTail()
}

interface SessionEventLogState {
  /** false = 这个会话不记事件(legacy 整文件格式),见 resolveEnabled。 */
  enabled: boolean
  lastSeq: number
  lastRequestIndex: number
  /** 每会话一条写入链:保证落盘顺序 == 调用顺序。 */
  queue: Promise<void>
  /** Real completion for each accepted event, installed before notifying readers. */
  writes: Map<number, Promise<void>>
  /** Serializes checkpoints, independently of subsequent appends. */
  checkpoints: Promise<void>
  durableSeq: number
  /** The first checkpoint also makes the file and its directory entries durable. */
  directoriesSynced: boolean
  /** blob 目录链的首次屏障已经做过;之后每个新 blob 只需要 `blobs/` 自己那一级。 */
  blobDirectoriesSynced: boolean
  blobDependencies: Map<number, Set<string>>
  durableBlobs: Set<string>
  /**
   * 内容已经**核对过**的 blob(工单 4 C12)。与 `durableBlobs` 不是一回事:
   * 那张表记「已经 fsync 到盘上」,失败重试时会被清掉重来;这张表记「读过一遍、
   * 算过一次 sha256、对得上」。校验是内容寻址的,同一个 hash 在同一进程里
   * 不会有第二个答案 —— 而一份 blob 可以有几 MB,重试路上再整读整算一遍是白烧,
   * 而且烧在耐久路径上(用户正等着这一轮落盘)。fsync 照旧每次都做。
   */
  verifiedBlobs: Set<string>
  pendingIO: number
  pendingCheckpoints: Set<Promise<void>>
  /**
   * 我们相信这份文件有多少字节(已落盘 + 在途)。G12 守卫拿它与真实大小比:
   * 真实的更大 = 有第二个写者。
   */
  expectedBytes: number
  lastForeignCheckAt: number
  /**
   * G12(S3w-0b):这份文件被**别的进程**写过。
   *
   * 一旦为真就再也不翻回去:这个进程已经不是唯一写者,它内存里的 seq 与文件
   * 上的 seq 从此各说各话,继续追加只会制造 `surfaceOp` 遮错区间的静默错乱。
   * 于是此后每一次 append 都拒写并记账(见 `appendSessionLogEvent`)。
   */
  foreignWriter: boolean
  /**
   * S3w-2(裁定 7):这个会话的**落盘队列上出过错**。
   *
   * append 是排队异步落盘的,所以"写失败"这件事天生比调用它的那一句晚 ——
   * 没有任何同步返回值能当场说出它。于是把失败**粘住**:后续 append 直接抛,
   * 检查点按目标水位拒绝,调用方不会把“已接受”误当成“已可靠保存”。
   *
   * 一旦粘上就不翻回去:一段丢掉的事件补不回来,后面写得再顺也不改变
   * "这份文件缺了一截"这个事实。
   */
  writeFailure?: SessionEventWriteError
  /** Keep lower-prefix sync failures even if a later append already failed. */
  failures: SessionEventWriteError[]
  /** 影子投影还没取走的记录(见 `SHADOW_TAIL_MAX`)。关闸时永远是空的。 */
  shadowTail: SessionLogEventRecord[]
  /** 尾巴溢出过 = 这一段事件没进活投影,消费者必须从文件重折。 */
  shadowTailOverflowed: boolean
  /**
   * F13(§13.2):**这个进程刚写下的信封**(只记 `findLastSessionEventSync`
   * 真正被问到的那两类)。
   *
   * 那个函数读的是**文件**,而这里的写是排队异步落盘的 —— 刚写下的
   * `request/tools` 很可能还不在盘上,于是下一次询问读回上一次的指纹,那 40KB
   * 的工具目录被原样再写一遍。内存这一份是权威,文件读退回冷启动兜底。
   * 只记两类是为了不把 40KB 的目录按会话数留在内存里。
   */
  lastByType: Map<string, SessionLogEventRecord>
  /**
   * §16.22:这本账**钉死**的落点。启用那一刻解析一次,之后一律用它。
   *
   * 从前每一处都现算 `getSessionEventsLogPath(sessionId)`,而那个函数一路走到
   * `getOnethingStorePath()` → `process.env.ONETHING_STORE_PATH || os.homedir()`
   * —— 它读的是**调用那一刻**的进程环境。append 的落盘是排队异步的:seq 在
   * 同步段分配,`appendFile` 的路径却要等队列回调跑到才解析。测试用换 `HOME`
   * 隔离 store 时,那个回调常常跨过 HOME 恢复点,于是字节写进了**真机库**,
   * 而且零异常、零记账(seq 与 expectedBytes 都记在临时库那份 state 上,真机
   * 那份文件只看到一段凭空插进来的行 —— 真机 room-1 的断号即此)。
   *
   * 钉死的语义边界:一个会话的账本属于**它启用时的那个 store**。生产里 store
   * 路径整个进程只解析出一个值,所以这条纪律对生产逐字节无变化;跨 store 的
   * 只有测试,而那正是要挡的。测试换 store 后想重新认路,走
   * `resetSessionEventLogCache()`(所有 store 相关测试本来就这么做)。
   */
  logPath: string
}

/** 会记在内存里的类型(见 `lastByType`)。 */
const REMEMBERED_LAST_EVENT_TYPES = new Set<string>(['request/tools', 'request/header'])

export interface SessionEventLogStoreHandle {
  storePath: string
  sessionsDir: string
  states: Map<string, SessionEventLogState>
  accepting: boolean
  drained: boolean
  release?: Promise<void>
  assertSessionWritable?(sessionId: string): void
  flush(): Promise<void>
  drainAndRelease(): Promise<void>
}

function activeStore(): SessionEventLogStoreHandle | undefined {
  try {
    const owner = getCurrentBackendSafe()?.journalStore
    return owner?.drained ? undefined : owner
  } catch (error) {
    if (error instanceof BackendNotAssembledError) return undefined
    throw error
  }
}

function sessionLogStates(): Map<string, SessionEventLogState> {
  return activeStore()?.states ?? new Map()
}

function canonicalPath(input: string): string {
  const absolute = path.resolve(input)
  try { return fs.realpathSync.native(absolute) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(absolute)
    if (parent === absolute) throw error
    return path.join(canonicalPath(parent), path.basename(absolute))
  }
}

/** Backend acquires this after StoreLease and before initializing any session writers. */
export function acquireSessionEventLogStore(storePath: string, options: { sessionsDir?: string } = {}): SessionEventLogStoreHandle {
  const existing = activeStore()
  if (existing) throw new Error(`session event log store is already owned: ${existing.storePath}`)
  const owner: SessionEventLogStoreHandle = {
    storePath: canonicalPath(storePath),
    sessionsDir: canonicalPath(options.sessionsDir ?? path.join(storePath, 'sessions')),
    states: new Map(),
    accepting: true,
    drained: false,
    flush(): Promise<void> {
      if (owner.drained) return Promise.reject(new Error('session event log store has been released'))
      return Promise.all([...owner.states].map(([id, state]) => flushOneSessionEventLog(id, undefined, state))).then(() => undefined)
    },
    drainAndRelease(): Promise<void> {
      if (owner.release) return owner.release
      owner.accepting = false
      owner.release = (async () => {
        let failure: unknown
        try { await owner.flush() } catch (error) { failure = error }
        // Promise.all may reject before other sessions finish. Never hand off the owner
        // while any append/checkpoint can still touch its paths; a stall keeps this pending.
        const pending = [...owner.states.values()].flatMap(state => [state.queue, ...state.pendingCheckpoints])
        await Promise.allSettled(pending)
        flushSessionEventStats()
        owner.drained = true
        owner.states.clear()
        if (failure) throw failure
      })()
      return owner.release
    },
  }
  return owner
}

/** Blob producers use the same owner and sticky failure gate as event producers. */
export function assertSessionEventLogWritable(sessionId: string): void {
  const owner = activeStore()
  if (!owner?.accepting) throw new Error('session event log store is not accepting writes')
  owner.assertSessionWritable?.(sessionId)
  const state = ensureState(sessionId)
  if (state.writeFailure) throw state.writeFailure
}

export function failSessionEventDependency(sessionId: string, cause: unknown): SessionEventWriteError {
  const state = ensureState(sessionId)
  return rememberWriteFailure(state, sessionId, state.lastSeq + 1, 'blob', cause)
}

function sessionDirPath(sessionId: string): string {
  return path.join(activeStore()?.sessionsDir ?? getOnethingSessionsDir(), sessionId)
}

export function getSessionEventsLogPath(sessionId: string): string {
  return path.join(sessionDirPath(sessionId), SESSION_EVENTS_LOG_FILENAME)
}

export function getSessionBlobsDirPath(sessionId: string): string {
  return path.join(sessionDirPath(sessionId), 'blobs')
}

/**
 * 事件日志只往**已经存在**的会话目录里追加。
 *
 * 唯一的例外是 `session/created`(见 `ensureSessionEventDir`):会话创建这一刻
 * 目录还没有,而"第一条事件就是 `session/created`"正是 S1a 要立起来的纪律。
 * 其余类型仍然一个不建 —— 少一条能造目录的路,就少一种打穿 store 的方式。
 */
function resolveEnabled(sessionId: string): boolean {
  return fs.existsSync(sessionDirPath(sessionId))
}

/**
 * 这个会话的账本落点。启用过就用钉死的那份(见 `SessionEventLogState.logPath`),
 * 没启用过才现算 —— "还没有账本"的会话本来就该按当前 store 去找。
 */
function sessionLogPathFor(sessionId: string): string {
  return sessionLogStates().get(sessionId)?.logPath || getSessionEventsLogPath(sessionId)
}

/** 若目录已出现则就地启用:恢复计数器与字节数。失败保持 disabled。 */
function tryEnable(state: SessionEventLogState, sessionId: string): void {
  try {
    if (!resolveEnabled(sessionId)) return
    // §16.22:启用 = 认路。这一处与 `ensureSessionEventDir` 是**仅有的**两个
    // 解析点,之后一切读写都吃 `state.logPath`。
    const logPath = getSessionEventsLogPath(sessionId)
    reloadCounters(state, logPath)
    state.logPath = logPath
    state.enabled = true
  } catch (error) {
    rememberWriteFailure(state, sessionId, state.lastSeq + 1, 'open', error)
  }
}

/** 从盘上那份文件重新装载 seq / requestIndex / 字节数。 */
function reloadCounters(state: SessionEventLogState, logPath: string): void {
  if (!fs.existsSync(logPath)) {
    state.expectedBytes = 0
    return
  }
  const text = fs.readFileSync(logPath, 'utf8')
  const counters = scanSessionEventLogCounters(text)
  if (counters.lastSeq > state.lastSeq) state.lastSeq = counters.lastSeq
  if (counters.lastRequestIndex > state.lastRequestIndex) {
    state.lastRequestIndex = counters.lastRequestIndex
  }
  state.expectedBytes = Buffer.byteLength(text, 'utf8')
  for (const event of parseSessionLogEventLog(text)) {
    const hashes = collectEventBlobDependencies(event)
    if (hashes.size) state.blobDependencies.set(event.seq, hashes)
  }
}

function collectEventBlobDependencies(event: SessionLogEventRecord, encoded?: string): Set<string> {
  const hashes = collectSessionBlobRefHashes([event])
  // Synthesized images also store references inside text rather than a BlobRef object.
  for (const match of (encoded ?? JSON.stringify(event.data)).matchAll(/onething-blob:\/\/([0-9a-f]{16})(?![0-9a-f])/g)) {
    hashes.add(match[1])
  }
  return hashes
}

function ensureState(sessionId: string): SessionEventLogState {
  const owner = activeStore()
  if (!owner) throw new Error('session event log store has no owner')
  const states = owner.states
  const existing = states.get(sessionId)
  if (existing) {
    if (!existing.enabled && !existing.writeFailure) tryEnable(existing, sessionId)
    return existing
  }

  const state: SessionEventLogState = {
    enabled: false,
    lastSeq: 0,
    lastRequestIndex: 0,
    queue: Promise.resolve(),
    writes: new Map(),
    checkpoints: Promise.resolve(),
    durableSeq: 0,
    directoriesSynced: false,
    blobDirectoriesSynced: false,
    blobDependencies: new Map(),
    durableBlobs: new Set(),
    verifiedBlobs: new Set(),
    pendingIO: 0,
    pendingCheckpoints: new Set(),
    expectedBytes: 0,
    lastForeignCheckAt: 0,
    foreignWriter: false,
    failures: [],
    shadowTail: [],
    shadowTailOverflowed: false,
    lastByType: new Map(),
    logPath: '',
  }
  tryEnable(state, sessionId)
  states.set(sessionId, state)
  return state
}

function rememberWriteFailure(
  state: SessionEventLogState,
  sessionId: string,
  seq: number,
  operation: NonNullable<SessionEventWriteError['operation']>,
  cause: unknown,
): SessionEventWriteError {
  if (cause instanceof SessionEventWriteError && state.failures.includes(cause)) return cause
  const failure = new SessionEventWriteError(sessionId, operation, { cause, seq, operation })
  state.failures.push(failure)
  if (!state.writeFailure) {
    state.writeFailure = failure
    // This report is independent of the failed event file and must never replace its error.
    try {
      countSessionEventFailure(sessionId, cause, `event log ${operation} failed`)
    } catch { /* retain the original persistence failure */ }
  }
  return failure
}

/**
 * G12:别的进程写过这份文件吗?返回 `true` = 有,本次 append 必须**拒写**。
 *
 * 判据是**字节数**,不是 seq:seq 要 parse 整份文件,而"文件比我们写进去的还长"
 * 是一次 stat 就能答的问题(我们自己的在途写入已经算进 `expectedBytes`,所以
 * 队列没排空不会误报)。
 *
 * ## S3w-0b:从"重装计数器继续写"升级为"拒写"(§14.6 裁定 3 / §15.4)
 *
 * 从前发现外写者是**重新装载计数器并 warn 后照写**。那在影子期还说得过去
 * (messages.jsonl 才是真相),但事件正在成为唯一账本:两个写者各自在内存里数
 * seq,重装只是把这一次接到别人的尾巴后面,下一次别人又接到我们后面 ——
 * 交错写出来的 `surfaceOp: replace` 区间指向的是**对方的** seq,遮蔽从此静默
 * 错乱,而校验照样放行(那个 seq 在面上确实存在)。比 messages.jsonl 的双写
 * (最后写者赢)严重一个量级(§14.7 风险③)。
 *
 * 所以判定一次就**一路拒到底**:这个进程已经不是唯一写者,它写下去的每一条都
 * 是错乱的种子。拒写只记账(`appendFailures` + 每会话一次 warn),**不上抛**
 * —— 观察期里 messages.jsonl 还在写,拒写该记账不该打扰(命令失败语义留到
 * S3w-2 随裁定 7 一起翻转)。
 *
 * 进程级单写者由 one-core 发现文件(`run/http.json` 启动拒绝)承担;这道拒写
 * 兜的是它盖不住的残余窗口(两个 `server:start` 互不拒绝、`--force` 绕过)。
 */
function guardForeignWriter(state: SessionEventLogState, sessionId: string): boolean {
  if (state.foreignWriter) return true
  const now = Date.now()
  if (now - state.lastForeignCheckAt < FOREIGN_WRITER_CHECK_INTERVAL_MS) return false
  state.lastForeignCheckAt = now
  let size: number
  try {
    // §16.22:这一句本来就在同步段上,但它必须 stat **队列将要写的那份文件** ——
    // 拿现算的路径去比一份别的 store 的字节数,得出的"外写者在场"是假的。
    size = fs.statSync(state.logPath).size
  } catch {
    // 文件还不存在 / stat 失败:什么都不做,append 自己会报错并计数。
    return false
  }
  if (size <= state.expectedBytes) return false
  state.foreignWriter = true
  log.warn('another writer appended to the session event log; refusing to append', {
    sessionId,
    ourSeq: state.lastSeq,
    ourBytes: state.expectedBytes,
    fileBytes: size,
  })
  return true
}

/**
 * 会话创建这一刻把目录立起来,让 `session/created` 成为第一条事件(§10.3 ①)。
 * 只有 `appendSessionLogEvent('session/created', …)` 会走到这里。
 */
function ensureSessionEventDir(state: SessionEventLogState, sessionId: string): void {
  if (state.enabled) return
  try {
    fs.mkdirSync(sessionDirPath(sessionId), { recursive: true })
    // §16.22:第二个(也是最后一个)解析点 —— 见 `tryEnable`。
    const logPath = getSessionEventsLogPath(sessionId)
    reloadCounters(state, logPath)
    state.logPath = logPath
    state.enabled = true
  } catch (error) {
    throw rememberWriteFailure(state, sessionId, state.lastSeq + 1, 'directory', error)
  }
}

/**
 * F1(§16.6):**写侧同步可见钩子**。
 *
 * 一条事件被分配到 seq 的那一刻,还在**同一个同步段里**就交给进程内的活状态
 * (活投影 `projection-cache.ts` / 活 surface `event-surface.ts`)。真实写入 Promise
 * 必须先绑定,使观察者重入检查点也包含这条事件。调用方拿到 seq 返回值时,
 * 这条事件已经在内存的每一份活状态上了 —— 不必等落盘,也不必等下一次读把尾巴
 * 折进去。
 *
 * 三条纪律:
 *
 * 1. **只推进已经存在的活状态**。观察者见到一条自己还没建表的会话必须原地返回 ——
 *    建表意味着一次同步全文件读,把它挂在写路径上就是把 §7.2 M7 点名的那口 IO
 *    搬进了每一次 append。没建表的那一段仍由取走式尾巴(`shadowTail`)兜着,
 *    活状态第一次建起来时一并折进去。
 * 2. **注册发生在运行期,不在 import 期**(装配层的 import 纯净栅栏)。观察者由
 *    消费者自己在"第一次建表"的路径上注册,所以只 import 这个模块不会改变任何
 *    进程状态。
 * 3. **观察者抛出不许打断记账**。这里逐个 try/catch 并记一行 error:活投影折坏了
 *    最坏是那份缓存不可信(消费者自己丢缓存,下一次读从文件整份重折),但这条
 *    事件必须照样落盘 —— `events.jsonl` 是唯一持久化。
 */
/**
 * F4-c c3-a:落这一行的人对**活状态**说的两句话。
 *
 * 只有 `assistant/chunks` 用得上:定律二把它判成存储编码之后,它装的那几条逻辑
 * delta 在**盖章那一刻**就已经进过折叠了(`foldLiveSessionLogicalDelta`)——
 * 再折一遍就是同一段正文进两次。活 surface 那一侧不受影响(它记的是 seq 与节点
 * 归属,与折不折无关),所以这两格只有活投影会读。
 */
export interface SessionLogEventAppendHints {
  /** 这一行的内容已经折进活投影了,观察者只推游标、不再折。 */
  projectionPreFolded?: boolean
  /** 它提前折进去了几条(活投影据此减掉"领先磁盘"的计数)。 */
  preFoldedDeltaCount?: number
}

export type SessionLogEventAppendObserver = (
  sessionId: string,
  record: SessionLogEventRecord,
  hints?: SessionLogEventAppendHints,
) => void

const appendObservers = new Set<SessionLogEventAppendObserver>()

/** 注册一个同步可见观察者。返回注销函数(测试与会话删除用)。 */
export function registerSessionLogEventAppendObserver(
  observer: SessionLogEventAppendObserver,
): () => void {
  appendObservers.add(observer)
  return () => {
    appendObservers.delete(observer)
  }
}

function notifySessionLogEventAppended(
  sessionId: string,
  record: SessionLogEventRecord,
  hints?: SessionLogEventAppendHints,
): void {
  for (const observer of appendObservers) {
    try {
      observer(sessionId, record, hints)
    } catch (error) {
      // 纪律 3:折坏了不许把这条事件挡在磁盘外面。
      log.error(
        'live fold of an appended session event failed',
        { sessionId, seq: record.seq, type: record.type },
        error,
      )
    }
  }
}

/**
 * 追加一条 v2 事件。返回分配到的 seq(会话不记账时返回 undefined)。
 * 调用方拿 seq 做因果引用(`tool/result.sourceSeq`、`surfaceOp` 的 range)。
 *
 * F1 起这个函数**返回之前**活投影与活 surface 已经含有这条事件(见
 * `registerSessionLogEventAppendObserver`);落盘仍然是排队异步的。
 *
 * **`options.time`(§17.7.1 批 2 裁定 1:时钟同源)**:调用方**已经取过一次刻**
 * 并且要拿同一个数去盖别处时,把它递进来。今天唯一的用法是命令面 ——
 * 一条命令取一次 `now()`,既盖这条事件、又递给老 reducer 去写 `updatedAt`,
 * 于是"账折叠出来的时刻"与"store 上那一格"是**同一个数**而不是两次读表
 * (影子对拍不许留容差窗)。不递就照旧现读。
 */
export function appendSessionLogEvent<TType extends SessionLogEventType>(
  sessionId: string,
  type: TType,
  data: SessionLogEventDataFor<TType>,
  options: {
    surfaceOp?: SessionSurfaceOp
    sourceEventSeqs?: number[]
    /** 事件的落账时刻。缺省 `Date.now()`;见上面「时钟同源」。 */
    time?: number
  } & SessionLogEventAppendHints = {},
): number | undefined {
  assertSessionEventLogWritable(sessionId)
  let state: SessionEventLogState
  try {
    state = ensureState(sessionId)
  } catch {
    return undefined
  }
  if (state.writeFailure) throw state.writeFailure
  if (type === 'session/created') ensureSessionEventDir(state, sessionId)
  if (!state.enabled) return undefined

  // G12(S3w-0b):外写者在场 = 本次拒写。记一笔失败(每会话 warn 一次由
  // `countSessionEventFailure` 负责),而且**上抛**(裁定 7):抄本不在了,一条
  // "悄悄没写进去"的事件就是一段永远补不回来的历史。
  if (guardForeignWriter(state, sessionId)) {
    const error = new Error('another writer appended to this event log')
    countSessionEventFailure(sessionId, error, 'foreign writer detected; append refused')
    throw new SessionEventWriteError(sessionId, 'foreign writer detected', { cause: error })
  }

  const seq = state.lastSeq + 1
  const record = {
    seq,
    time: options.time ?? Date.now(),
    type,
    data,
    ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
    ...(options.sourceEventSeqs !== undefined ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
  } as SessionLogEventRecord
  let line: string
  try {
    line = encodeSessionLogEventLine(record)
  } catch (error) {
    throw rememberWriteFailure(state, sessionId, seq, 'encode', error)
  }
  state.lastSeq = seq
  if (REMEMBERED_LAST_EVENT_TYPES.has(type)) state.lastByType.set(type, record)
  state.expectedBytes += Buffer.byteLength(line, 'utf8')
  const blobs = collectEventBlobDependencies(record, line)
  if (blobs.size) state.blobDependencies.set(seq, blobs)

  // Bind the completion before publishing seq: observers may synchronously flush or append.
  const logPath = state.logPath
  state.pendingIO++
  const write = state.queue.then(async () => {
    if (state.writeFailure) throw state.writeFailure
    try {
      await fs.promises.appendFile(logPath, line, 'utf8')
    } catch (error) {
      throw rememberWriteFailure(state, sessionId, seq, 'append', error)
    }
  }).finally(() => { state.pendingIO-- })
  state.queue = write
  state.writes.set(seq, write)
  // Observe rejection without converting the stored completion into success.
  void write.catch(() => undefined)

  // Keep the tail ordered even when an observer appends another event synchronously.
  if (wantsEventTail()) {
    if (state.shadowTail.length >= SHADOW_TAIL_MAX) {
      state.shadowTail = []
      state.shadowTailOverflowed = true
    }
    state.shadowTail.push(record)
  }

  notifySessionLogEventAppended(sessionId, record, {
    ...(options.projectionPreFolded !== undefined
      ? { projectionPreFolded: options.projectionPreFolded }
      : {}),
    ...(options.preFoldedDeltaCount !== undefined
      ? { preFoldedDeltaCount: options.preFoldedDeltaCount }
      : {}),
  })

  return seq
}

/**
 * E0 的七类入口。形状与调用点一字不动(`toolkit/audit-sink.ts`、recorder 的
 * 老分支都还在用),内部走同一条 v2 路 —— 两个写者写同一份文件是 G12 想挡的
 * 那种错乱,进程内更不该自己制造一份。
 */
export function appendSessionEvent<TType extends SessionEventType>(
  sessionId: string,
  type: TType,
  data: SessionEventDataFor<TType>,
): number | undefined {
  return appendSessionLogEvent(
    sessionId,
    type as SessionLogEventType,
    data as SessionLogEventDataFor<SessionLogEventType>,
  )
}

/** 分配下一个 requestIndex(会话内单调递增,跨重启从文件恢复)。 */
export function nextSessionRequestIndex(sessionId: string): number | undefined {
  let state: SessionEventLogState
  try {
    state = ensureState(sessionId)
  } catch {
    return undefined
  }
  if (!state.enabled) return undefined
  state.lastRequestIndex += 1
  return state.lastRequestIndex
}

/** 这个会话在记账吗(目录已经在了)。 */
export function isSessionEventLogEnabled(sessionId: string): boolean {
  try {
    return ensureState(sessionId).enabled
  } catch {
    return false
  }
}

/**
 * 同步取回该会话日志里某类型的最后一条记录。
 *
 * 给"要不要写"这类必须**同步**作答的判定用(seq 是同步分配的,一旦让判定
 * 走异步,事件顺序就会乱)。调用方自己缓存结果 —— 这里每次都真读文件。
 */
export function findLastSessionEventSync<TType extends SessionEventType>(
  sessionId: string,
  type: TType,
): Extract<SessionEventRecord, { type: TType }> | undefined {
  // F13:**先问这个进程自己刚写过什么**(见 `lastByType`),文件是冷启动兜底。
  const remembered = sessionLogStates().get(sessionId)?.lastByType.get(type)
  if (remembered) return remembered as Extract<SessionEventRecord, { type: TType }>
  try {
    // §16.22:读侧也吃钉死的落点 —— 判定"要不要写"的依据必须来自**我们自己
    // 那本账**,读到别的 store 的同名会话只会得出一个说不通的答案。
    const logPath = sessionLogPathFor(sessionId)
    if (!fs.existsSync(logPath)) return undefined
    return findLastSessionEventInLog(fs.readFileSync(logPath, 'utf8'), type)
  } catch {
    return undefined
  }
}

/**
 * 固定该会话(或全部会话)当前已接受的水位,等待落盘并 fsync。
 * `throughSeq` 可指定已接受的较早目标;非法/未来序号拒绝。后续追加不会延长
 * 本次等待,已持久化的前缀也不受更晚写入失败影响。成功仍返回 void。
 *
 * fsync 的理由:`appendFile` 回来只说明字节交给了内核页缓存,断电/内核崩溃后
 * 那一段就没了。语义检查点(调模型前 / 调工具前 / 响应收齐 / run 结束)是
 * "这一刻的事实必须在盘上"的地方,所以在这几处、也只在这几处付这个代价。
 */
export async function flushSessionEventLog(sessionId?: string, throughSeq?: number): Promise<void> {
  if (sessionId) {
    await flushOneSessionEventLog(sessionId, throughSeq)
    return
  }
  if (throughSeq !== undefined) throw new RangeError('throughSeq requires a sessionId')
  await Promise.all([...sessionLogStates()].map(([id, state]) => flushOneSessionEventLog(id, undefined, state)))
}

/**
 * §16.22:排空 + fsync 一个会话,**路径在 await 之前取**。
 *
 * fsync 是 `await state.queue` 之后才做的事,从前 `fsyncSessionLog(sessionId)`
 * 在那之后现算路径 —— 与 append 是同一类延迟解析。这里在第一个 await 之前把
 * 钉死的落点取出来,fsync 到的就一定是刚刚排空的那份文件。
 *
 * 没有 state = 这个进程没往这个会话写过任何东西,自然也没有在途写入要刷 ——
 * 从前那一次 fsync 打开的是"当前 store 里同名会话"的文件,能刷到什么纯属巧合。
 */
function flushOneSessionEventLog(sessionId: string, throughSeq?: number, state = sessionLogStates().get(sessionId)): Promise<void> {
  const target = throughSeq ?? state?.lastSeq ?? 0
  if (!Number.isSafeInteger(target) || target < 0 || target > (state?.lastSeq ?? 0)) {
    return Promise.reject(new RangeError(`invalid event log checkpoint ${target}: ${sessionId}`))
  }
  if (!state) return Promise.resolve()
  if (target === 0) return state.writeFailure ? Promise.reject(state.writeFailure) : Promise.resolve()
  if (target <= state.durableSeq) return Promise.resolve()
  const logPath = state.logPath
  // An absent completion is a prefix read from disk, never a future append.
  const write = state.writes.get(target) ?? Promise.resolve()
  // Queue only a checkpoint whose target write has completed. A checkpoint through a
  // later, stalled write must not prevent an independent earlier prefix from syncing.
  state.pendingIO++
  const checkpoint = write.then(() => {
    const sync = state.checkpoints.catch(() => undefined).then(async () => {
      if (target <= state.durableSeq) return
      const earlierFailure = state.failures.find(failure => failure.seq! <= target)
      if (earlierFailure) throw earlierFailure
      let operation: NonNullable<SessionEventWriteError['operation']> = 'open'
      let failureSeq = state.durableSeq + 1
      let handle: fs.promises.FileHandle | undefined
      try {
        const blobs = new Set<string>()
        const firstBlobSeq = new Map<string, number>()
        for (const [seq, hashes] of state.blobDependencies) {
          if (seq <= target) for (const hash of hashes) if (!state.durableBlobs.has(hash)) {
            blobs.add(hash)
            firstBlobSeq.set(hash, Math.min(seq, firstBlobSeq.get(hash) ?? seq))
          }
        }
        operation = 'blob'
        for (const hash of blobs) {
          failureSeq = firstBlobSeq.get(hash)!
          // 首个 blob 走整条链(`blobs/` 这一级可能是刚创建的,它的父目录也要看得见
          // 这个新名字);之后每个新 blob 只需要 `blobs/` 自己(工单 5 §2 的 once 闸)。
          await syncSessionBlob(logPath, hash, state.verifiedBlobs, state.blobDirectoriesSynced)
        }
        failureSeq = state.durableSeq + 1
        operation = 'open'
        handle = await fs.promises.open(logPath, 'r+')
        operation = 'sync'
        await handle.sync()
        if (!state.directoriesSynced) {
          operation = 'directory'
          await syncSessionLogDirectories(logPath, sessionsRootOf(logPath))
        }
        // A concurrent later append failure cannot invalidate this durable prefix.
        const concurrentFailure = state.failures.find(failure => failure.seq! <= target)
        if (concurrentFailure) throw concurrentFailure
        state.directoriesSynced = true
        if (blobs.size) state.blobDirectoriesSynced = true
        state.durableSeq = Math.max(state.durableSeq, target)
        for (const hash of blobs) state.durableBlobs.add(hash)
        for (const seq of state.writes.keys()) {
          if (seq <= state.durableSeq) state.writes.delete(seq)
        }
        for (const seq of state.blobDependencies.keys()) if (seq <= target) state.blobDependencies.delete(seq)
      } catch (error) {
        throw rememberWriteFailure(state, sessionId, failureSeq, operation, error)
      } finally {
        await handle?.close().catch(() => undefined)
      }
    })
    state.checkpoints = sync
    return sync
  }).finally(() => {
    state.pendingIO--
    state.pendingCheckpoints.delete(checkpoint)
  })
  state.pendingCheckpoints.add(checkpoint)
  void checkpoint.catch(() => undefined)
  return checkpoint
}

/** POSIX needs a directory barrier; Win32 FlushFileBuffers flushes file metadata. */
export const SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32'
export const SESSION_EVENT_DURABILITY_STRATEGY = process.platform === 'win32'
  ? 'windows-file-metadata' as const
  : 'posix-file-and-directories' as const

/** `<store>/sessions` —— 目录屏障的上界,见 `syncSessionLogDirectories`。 */
function sessionsRootOf(logPath: string): string {
  return path.dirname(path.dirname(logPath))
}

async function syncSessionBlob(logPath: string, hash: string, verified: Set<string>, blobDirectoriesSynced: boolean): Promise<void> {
  if (!/^[a-f0-9]{16}$/.test(hash)) throw new Error(`invalid session blob reference: ${hash}`)
  const blobPath = path.join(path.dirname(logPath), 'blobs', hash)
  const handle = await fs.promises.open(blobPath, 'r+')
  try {
    // 校验只做一次(工单 4 C12);fsync 每次都做 —— 前者是关于内容的事实,
    // 后者是关于这一次落盘的事实。
    if (!verified.has(hash)) {
      const content = await handle.readFile()
      const actual = createHash('sha256').update(content).digest('hex').slice(0, 16)
      if (actual !== hash) throw new Error(`session blob content does not match its reference: ${hash}`)
      verified.add(hash)
    }
    await handle.sync()
    await syncSessionLogDirectories(blobPath, blobDirectoriesSynced ? path.dirname(blobPath) : sessionsRootOf(logPath))
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * 账本(或它的 blob)所在目录链的屏障,**上界是 `sessions/`**(工单 5 §2,triage A2)。
 *
 * 屏障要保证的是"这个新文件名在它的父目录里可见";`<store>/sessions/<id>/` 是这次
 * 可能刚被创建的那一级,`sessions/` 是它的父级 —— 到此为止。再往上是 `<store>`、
 * 用户主目录、整块卷:与这一次追加没有因果关系,而 fsync 一个热目录的代价是真金白银。
 * 与 `durable-json.ts` 的 `syncDirectoryChain` 同一条口径(那边是同步版本;这里的
 * 写路是 async 的,共用一份实现就等于在流式主路径上引入一次同步 fsync)。
 */
async function syncSessionLogDirectories(logPath: string, sessionsDir: string): Promise<void> {
  if (!SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED) {
    // Windows uses the writable file handle's FlushFileBuffers barrier above, including
    // creation metadata. Opening a directory with Node's POSIX-like API is not required.
    // Microsoft: https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching
    // CreateFileW, Caching Behavior (new empty-file metadata also requires flushing):
    // https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
    // libuv src/win/fs.c fs__sync_impl calls FlushFileBuffers; GENERIC_WRITE is why all
    // event/blob handles use r+, not r. Release verification must run on local NTFS.
    return
  }
  const boundary = path.resolve(sessionsDir)
  for (let directory = path.resolve(path.dirname(logPath)); ; directory = path.dirname(directory)) {
    const handle = await fs.promises.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
    if (directory === boundary) break
    if (path.dirname(directory) === directory) break
  }
}

/**
 * 关停时的**默认排空预算**(§15.12(a))。
 *
 * 排空要有上限,是因为退出这条路上没有人等得起一次卡住的 fsync:Electron 的
 * `before-quit` 不被 await(第一个 await 之后就在和进程消失赛跑),
 * `apps/server` 的 SIGTERM 之后编排器很快就是 SIGKILL。2s 是"磁盘正常时绰绰
 * 有余、磁盘不正常时不把退出钉死"的那一档 —— 而超时**记账不阻退出**,
 * 因为"没刷干净"必须说出来,不能假装干净。
 */
export const SESSION_EVENT_SHUTDOWN_FLUSH_TIMEOUT_MS = 2000

/**
 * 排空**全部活跃会话**的事件队列并 fsync,带时限(关停链专用,§15.12(a))。
 *
 * 与 `flushSessionEventLog()`(不传 sessionId)是同一件事,多的只有两样:
 * 一个说得出用途的名字(关停表里 `flushAllPendingSaves` 排的是 messages.jsonl
 * 的节流队列,两者一眼要能分开),和一个**时限**。
 *
 * 超时不抛也不阻退出:返回 `{timedOut:true}`,调用方记一行 warn。剩下的在途
 * 写入随进程一起消失 —— 那正是 §14.7 风险②说的那一段,现在它至少是**看得见的**。
 */
export async function flushAllSessionEventLogs(
  options: { timeoutMs?: number } = {},
): Promise<{ timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? SESSION_EVENT_SHUTDOWN_FLUSH_TIMEOUT_MS
  if (sessionLogStates().size === 0) return { timedOut: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = await Promise.race([
      flushSessionEventLog().then(() => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), timeoutMs)
        // 计时器自己不该把进程留住:它只是罩子,不是任务。
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }),
    ])
    return { timedOut }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 关停链上的**事件账本收尾**:排空 + fsync,然后把统计表落盘(§15.12(a)(b))。
 *
 * 两件事写在一个函数里,是为了让**顺序**只有一个地方定义:排空过程本身可能
 * 记上几笔 `appendFailures`(队列尾巴上那几条正是最容易失败的),统计表必须
 * 排在它之后落盘,否则门读到的是少一截的账。
 *
 * 三条关停链(Electron `before-quit` / `createOnethingBackend.shutdown` /
 * `HeadlessBackend.shutdown`)各调一次;`apps/server` 的 SIGTERM 经
 * `serverRuntime.shutdown()` 落到同一处,因此同在那 5s 预算里。
 */
export async function flushSessionEventLedger(
  options: { timeoutMs?: number } = {},
): Promise<{ timedOut: boolean }> {
  try {
    const result = await flushAllSessionEventLogs(options)
    if (result.timedOut) {
      log.warn('session event log flush timed out during shutdown', {
        sessions: sessionLogStates().size,
        timeoutMs: options.timeoutMs ?? SESSION_EVENT_SHUTDOWN_FLUSH_TIMEOUT_MS,
      })
    }
    return result
  } finally {
    flushSessionEventStats()
  }
}

/**
 * 读回整份事件日志(**只有七类**)。老消费者(轨迹面板、rpc 域)走这条。
 * 容忍崩溃截断的尾部半行。文件不存在 = 没有事件,返回空数组。
 */
export async function readSessionEvents(sessionId: string): Promise<SessionEventRecord[]> {
  try {
    // §16.22:路径在**进 await 之前**解析(`sessionLogPathFor` 是同步的),
    // 且吃钉死的落点 —— 与写侧读同一份文件。
    const text = await fs.promises.readFile(sessionLogPathFor(sessionId), 'utf8')
    return parseSessionEventLog(text)
  } catch {
    return []
  }
}

/** 读回整份事件日志(**v2 全集**)。投影 / surface 索引走这条。 */
export async function readSessionLogEvents(sessionId: string): Promise<SessionLogEventRecord[]> {
  try {
    const text = await fs.promises.readFile(sessionLogPathFor(sessionId), 'utf8')
    return parseSessionLogEventLog(text)
  } catch {
    return []
  }
}

/**
 * 取走这个会话**还没被影子投影消费**的那一段事件(S1b)。
 *
 * 记录是写入口刚分配 seq 的那一份原件(与写进文件的逐字节同一条),所以消费者
 * 不必等落盘、也不必重读文件 —— 这就是"每请求 O(新事件)"的来处。
 *
 * `overflowed:true` 表示中间断过档(见 `SHADOW_TAIL_MAX`),消费者要从文件重折。
 */
export function drainSessionLogEventTail(
  sessionId: string,
): { records: SessionLogEventRecord[]; overflowed: boolean } {
  const state = sessionLogStates().get(sessionId)
  if (!state) return { records: [], overflowed: false }
  const records = state.shadowTail
  const overflowed = state.shadowTailOverflowed
  state.shadowTail = []
  state.shadowTailOverflowed = false
  return { records, overflowed }
}

/** 同步版:surface 索引首次建表要在同步路径上作答(seq 是同步分配的)。 */
export function readSessionLogEventsSync(sessionId: string, options?: { strict?: boolean }): SessionLogEventRecord[] {
  try {
    const text = fs.readFileSync(sessionLogPathFor(sessionId), 'utf8')
    const records = parseSessionLogEventLog(text)
    if (options?.strict && records.length !== text.split(/\r?\n/).filter(line => line.trim()).length) {
      throw new Error(`Invalid session event record while checking execution recovery: ${sessionId}`)
    }
    return records
  } catch (error) {
    if (options?.strict) throw error
    return []
  }
}

/** 清空进程内缓存(计数器 / 队列)。会话删除与测试用。 */
export function assertSessionEventLogIdle(sessionIds: readonly string[]): void {
  const states = sessionLogStates()
  for (const id of sessionIds) {
    if ((states.get(id)?.pendingIO ?? 0) > 0) throw new Error(`Session event log still has pending IO: ${id}`)
  }
}

export function resetSessionEventLogCache(sessionId?: string): void {
  const states = sessionLogStates()
  const resetting = sessionId ? [states.get(sessionId)].filter(Boolean) : [...states.values()]
  if (resetting.some(state => state!.pendingIO > 0)) throw new Error('cannot reset a session event log with pending IO')
  if (sessionId) {
    states.delete(sessionId)
    return
  }
  states.clear()
}
