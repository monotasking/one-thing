/**
 * 会话存储驱动:legacy 整文件 JSON 与 jsonl 会话目录的混合路由。
 *
 * 路由规则(docs/design/session-storage-jsonl.md §7):
 * - 会话在盘上是什么格式,就用什么格式读写(格式跟随数据);
 * - 只有"新建会话"看 newSessionFormat() 开关。
 *
 * jsonl 会话目录:
 *   <sessionsDir>/<id>/meta.json      会话级字段 + 日志摘要(小,整写)
 *   <sessionsDir>/<id>/events.jsonl   事件账本 —— **会话历史的唯一持久化**
 *   <sessionsDir>/<id>/messages.jsonl 存量抄本(只读化石,见下)
 *
 * ## S3w-3 批 6b:消息写半边已删(§15.22)
 *
 * 从前这里按 `SessionWritePlan` 分三级写 `messages.jsonl`(meta / 后缀重写 /
 * 全量重写),批 4 给它加了 `skipMessageWrites()` 岔口、批 6a 把默认扳到停写。
 * 这一批把写代码整段删掉,于是:
 *
 * - **写**:jsonl 会话只写 `meta.json`(会话外壳 + `log` 索引)。`write()` 仍然
 *   收 `SessionWritePlan`,但**不再读它** —— 写计划是命令面 reducer 的产物
 *   (`core/session/commands.ts`),它的退役属于 F 线,不是这里。
 * - **读**:`messages.jsonl` 的读半边**原样保留**(裁定 9a:存量抄本永久原地
 *   只读)。分页 / user marker / `history` 工具 / `verify #6` 的存量对账都还从
 *   它取数;停写之后出生的会话没有这个文件,那些口就返回 `undefined`,调用方
 *   照旧降级(读路早已全线走投影)。
 * - **legacy 整文件会话**(裁定 9b):首触**同步**迁进 `events.jsonl`
 *   (逐条 `message/imported`),不再迁成抄本。见 `migrateLegacySessionNow`。
 *
 * 回滚不再是扳环境变量(两根抄本回滚杆随写代码一起退役),而是 `git revert`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeDurableJson } from '../storage/durable-json.js'
import {
  buildSessionMessagesPageResponse,
  collectTailMessages,
  decodeJsonlLine,
  decodeSessionLogEventLine,
  encodeSessionLogEventLine,
  getMessagesPageFromLogSource,
  scanJsonlLog,
  type GetSessionMessagesPageRequest,
  type GetSessionMessagesPageResponse,
  type IndexedSessionMessage,
  type SessionLogEventRecord,
  type StoredChatMessage,
  type UserMessageMarker,
} from '@onething/core/session'
import type { JsonlLogPageSource } from '@onething/core/session/storage'

export type SessionStorageFormat = 'legacy-json' | 'jsonl'

export interface SessionWritePlan {
  kind: 'meta' | 'message' | 'structural'
  /** kind === 'message' 时:最低脏消息的 seq(1 起);后缀重写从这里开始 */
  dirtySeq?: number
}

export const STRUCTURAL_WRITE_PLAN: SessionWritePlan = { kind: 'structural' }

/** 一条会话的"身份"三格:物理化身 + 归属。索引条目要带的就是这三格。 */
export interface SessionStoredIdentity {
  storageGeneration?: string
  ownerUserId?: string
  ownerWorkspaceId?: string
}

export interface SessionStorageDriver<TSession> {
  /** Complete initial metadata, including its immutable generation, before publication. */
  initialize?(sessionId: string, session: TSession): void
  /**
   * 只读盘上的身份三格,**不补水消息**(工单 5 §3)。
   *
   * 索引落盘时要给每条补上代际与归属,从前那份只从 LRU 取 —— 一条被挤出缓存的
   * 会话于是写出一条**没有代际**的索引条目,而代际正是删除墓碑唯一的判据。
   * 布局是驱动的知识(`<sessions>/<id>/meta.json` 还是 `<sessions>/<id>.json`),
   * 所以这一口开在驱动上,不是让仓库自己去拼路径。
   */
  readIdentity?(sessionId: string): SessionStoredIdentity | undefined
  /** 该会话当前(或将要)使用的存储格式 */
  format(sessionId: string): SessionStorageFormat
  load(sessionId: string): TSession | undefined
  /**
   * 落盘。**只写会话外壳**(`meta.json`)—— 消息写半边已随 S3w-3 批 6b 删除。
   *
   * `plan` 保留在签名里但不再被读:它是命令面 reducer 的产物,退役归 F 线。
   */
  write(sessionId: string, session: TSession, plan: SessionWritePlan): Promise<void>
  delete(sessionId: string): void
  /** 不加载整会话的分页;返回 undefined 表示无法服务(调用方降级) */
  getMessagesPage(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse | undefined
  getUserMessageMarkers(sessionId: string): UserMessageMarker[] | undefined
  /**
   * legacy 整文件会话的首触迁移(裁定 9b):`sessions/<id>.json` → 会话目录
   * (`meta.json` + `events.jsonl` 逐条 `message/imported`),原件移进 legacy-backup。
   * 已是会话目录布局(或没有 legacy 文件)时是 no-op,返回值即"迁完了吗"。
   *
   * **不影响 `load()` 交出什么**:那一次仍然把手里读到的 legacy 会话(带消息)
   * 原样交出去;迁移是为了让**下一次**冷加载能从事件里折出它。
   */
  migrateLegacySessionNow(sessionId: string): boolean
}

export interface HybridSessionStorageDriverOptions {
  getSessionsDir(): string
  getLegacySessionPath(sessionId: string): string
  /** 新建会话使用的格式;每次新建时调用,settings 变更即时生效 */
  newSessionFormat(): SessionStorageFormat
  readJsonFile<TValue>(filePath: string, fallback: TValue): TValue
  writeJsonFileAsync(filePath: string, data: unknown): Promise<void>
  deleteJsonFile(filePath: string): void
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void; error?(...args: unknown[]): void }
}

interface SessionLike {
  id?: string
  messages?: unknown[]
}

interface JsonlLineRef {
  offset: number
  length: number
  id?: string
  role?: string
}

interface JsonlSessionState {
  lines: JsonlLineRef[]
  fileSize: number
  markers?: UserMessageMarker[]
}

interface JsonlMetaFile {
  formatVersion: number
  log?: { messageCount?: number; lastSeq?: number; compactedAt?: number }
  [key: string]: unknown
}

const JSONL_META_FORMAT_VERSION = 2

function messageIdentity(message: unknown): { id?: string; role?: string } {
  if (!message || typeof message !== 'object') return {}
  const record = message as { id?: unknown; role?: unknown }
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    role: typeof record.role === 'string' ? record.role : undefined,
  }
}

function messageMarker(message: unknown, seq: number): UserMessageMarker | undefined {
  if (!message || typeof message !== 'object') return undefined
  const record = message as { id?: unknown; role?: unknown; timestamp?: unknown; content?: unknown }
  if (record.role !== 'user' || typeof record.id !== 'string') return undefined
  const content = typeof record.content === 'string' ? record.content : ''
  return {
    id: record.id,
    seq,
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : 0,
    preview: content.replace(/\s+/g, ' ').trim().slice(0, 80),
  }
}

export const LEGACY_BACKUP_DIR_NAME = 'legacy-backup'

export function createHybridSessionStorageDriver<TSession extends SessionLike>(
  options: HybridSessionStorageDriverOptions,
): SessionStorageDriver<TSession> {
  const states = new Map<string, JsonlSessionState>()
  const logger = options.logger
  /** 每会话在途写入的 promise;legacy 首触迁移见到它就让这一轮,防止在途写重建已迁移的 legacy 文件 */
  const inFlightWrites = new Map<string, Promise<void>>()

  const sessionDir = (sessionId: string) => path.join(options.getSessionsDir(), sessionId)
  const metaPath = (sessionId: string) => path.join(sessionDir(sessionId), 'meta.json')
  const logPath = (sessionId: string) => path.join(sessionDir(sessionId), 'messages.jsonl')

  const eventsPath = (sessionId: string) => path.join(sessionDir(sessionId), 'events.jsonl')

  /**
   * 这条会话是不是 jsonl 布局。
   *
   * S1a(§10.3 ①)起 `events.jsonl` 也算数:会话创建时**事件层先建目录并写
   * `session/created`**,`meta.json` / `messages.jsonl` 要等那 300ms 节流窗口
   * 之后才落盘。少认这一格的话,那个窗口里的 `format()` 会把一条崭新的 jsonl
   * 会话判成 legacy(B4 的鸡生蛋),而删掉快照之后更是整份历史消失。
   */
  const jsonlExists = (sessionId: string) =>
    fs.existsSync(metaPath(sessionId))
    || fs.existsSync(logPath(sessionId))
    || fs.existsSync(eventsPath(sessionId))
  const legacyExists = (sessionId: string) => fs.existsSync(options.getLegacySessionPath(sessionId))
  /**
   * 这条会话**盘上有抄本**吗 —— 分页与 marker 两口的服务判据(S3w-3 批 6b)。
   *
   * 从前它们问的是 `jsonlExists()`("是不是 jsonl 布局"),因为那时候一条 jsonl
   * 会话必然带着 `messages.jsonl`。停写之后**不再必然**:批 6a 起出生的会话只有
   * `meta.json` + `events.jsonl`。而问错了不是少答一句 —— `loadJsonl` 会给这种会话
   * 存下一份 `lines: []` 的行表,分页于是从"给不出"(`undefined`,调用方降级)
   * 变成**理直气壮的空页**(`success:true, totalCount:0`),把调用方的降级链整条
   * 短路掉。真机上这条错答被 `sessionReads.pageMessages` 的事件侧挡在前面,
   * server 的 echo/test 仓库没有事件侧,一读就是空。
   */
  const hasTranscript = (sessionId: string) => fs.existsSync(logPath(sessionId))

  function format(sessionId: string): SessionStorageFormat {
    if (jsonlExists(sessionId)) return 'jsonl'
    if (legacyExists(sessionId)) return 'legacy-json'
    return options.newSessionFormat()
  }

  // ============ meta ============

  function buildMeta(session: TSession): JsonlMetaFile {
    const { messages, ...rest } = session as SessionLike & Record<string, unknown>
    const count = Array.isArray(messages) ? messages.length : 0
    return {
      ...rest,
      formatVersion: JSONL_META_FORMAT_VERSION,
      log: { messageCount: count, lastSeq: count },
    }
  }

  async function writeMeta(sessionId: string, session: TSession): Promise<void> {
    await options.writeJsonFileAsync(metaPath(sessionId), buildMeta(session))
  }

  // ============ jsonl 写入(S3w-3 批 6b 起:只剩会话外壳)============

  /**
   * 落盘一条 jsonl 会话:**只写 `meta.json`**。
   *
   * 消息写半边(`encodeSuffix` / `writeSuffix` / `rewriteAll`)已删,`messages.jsonl`
   * 一个字节也不动 —— 存量那份从此永远停在停写那一刻(裁定 9a:原地只读),盘上
   * 它与内存里的 `states` 行表因此天然一致,分页读那条路仍然自洽。
   *
   * 目录仍要保证在:事件层通常已经用 `session/created` 建过它了,但那条路只有新
   * 会话走得到,而 `meta.json` 是这里唯一的落点。
   */
  async function writeJsonl(sessionId: string, session: TSession): Promise<void> {
    await fs.promises.mkdir(sessionDir(sessionId), { recursive: true })
    await writeMeta(sessionId, session)
  }

  // ============ jsonl 读取 ============

  function loadJsonl(sessionId: string): TSession | undefined {
    const meta = options.readJsonFile<JsonlMetaFile | null>(metaPath(sessionId), null)
    if (!meta) return undefined

    let buffer: Buffer
    try {
      buffer = fs.readFileSync(logPath(sessionId))
    } catch {
      buffer = Buffer.alloc(0)
    }

    const scan = scanJsonlLog<unknown>(buffer)
    if (scan.recovered) {
      logger?.warn?.(`[Sessions] jsonl log recovered for ${sessionId}: truncating to ${scan.validByteLength} bytes`)
      try {
        fs.truncateSync(logPath(sessionId), scan.validByteLength)
      } catch (error) {
        logger?.error?.(`[Sessions] jsonl log repair failed for ${sessionId}:`, error)
      }
    }

    const { formatVersion, log, ...rest } = meta
    void formatVersion
    void log
    const session = { ...rest, messages: scan.entries.map(entry => entry.message) } as unknown as TSession

    states.set(sessionId, {
      lines: scan.entries.map(entry => ({
        offset: entry.byteOffset,
        length: entry.byteLength,
        ...messageIdentity(entry.message),
      })),
      fileSize: scan.validByteLength,
    })
    return session
  }

  function ensureJsonlState(sessionId: string): JsonlSessionState | undefined {
    const cached = states.get(sessionId)
    if (cached) return cached
    if (!loadJsonl(sessionId)) return undefined
    return states.get(sessionId)
  }

  function readLineRange<TMessage extends StoredChatMessage>(
    sessionId: string,
    state: JsonlSessionState,
    startSeq: number,
    endSeq: number,
  ): Array<IndexedSessionMessage<TMessage>> | undefined {
    if (startSeq > endSeq) return []
    if (startSeq < 1 || endSeq > state.lines.length) return undefined

    const first = state.lines[startSeq - 1]
    const last = state.lines[endSeq - 1]
    const windowLength = last.offset + last.length - first.offset
    const buffer = Buffer.alloc(windowLength)

    const fd = fs.openSync(logPath(sessionId), 'r')
    try {
      fs.readSync(fd, buffer, 0, windowLength, first.offset)
    } finally {
      fs.closeSync(fd)
    }

    const decoder = new TextDecoder()
    const items: Array<IndexedSessionMessage<TMessage>> = []
    for (let seq = startSeq; seq <= endSeq; seq++) {
      const ref = state.lines[seq - 1]
      const lineBytes = buffer.subarray(ref.offset - first.offset, ref.offset - first.offset + ref.length)
      const decoded = decodeJsonlLine<TMessage>(decoder.decode(lineBytes).replace(/\n$/, ''))
      if (!decoded || decoded.t !== 'm' || decoded.seq !== seq) return undefined
      items.push({ seq, message: decoded.message })
    }
    return items
  }

  function getJsonlMessagesPage(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse | undefined {
    const sessionId = request.sessionId
    const state = states.get(sessionId)

    // 冷路径 + tail 形请求:反向尾读,不做全量扫描
    const isTailRequest = !request.cursor && (!request.anchor || request.anchor === 'tail')
    if (!state && isTailRequest) {
      let fd: number
      try {
        fd = fs.openSync(logPath(sessionId), 'r')
      } catch {
        return undefined
      }
      try {
        const size = fs.fstatSync(fd).size
        const reader = {
          size,
          read: (position: number, length: number) => {
            const chunk = Buffer.alloc(Math.min(length, size - position))
            fs.readSync(fd, chunk, 0, chunk.length, position)
            return chunk
          },
        }
        const limit = Math.max(1, Math.min(300, Math.floor(request.limit ?? 16)))
        const tail = collectTailMessages<StoredChatMessage>(reader, limit)
        if (!tail) return undefined
        const totalCount = tail.items.length > 0
          ? tail.items[tail.items.length - 1].seq
          : 0
        return buildSessionMessagesPageResponse(
          sessionId,
          tail.items.map(item => ({ seq: item.seq, message: item.message })),
          totalCount,
        )
      } finally {
        fs.closeSync(fd)
      }
    }

    const ensured = state ?? ensureJsonlState(sessionId)
    if (!ensured) return undefined

    const jsonlLogPageSource: JsonlLogPageSource<StoredChatMessage> = {
      totalCount: ensured.lines.length,
      readRange: (startSeq, endSeq) => readLineRange(sessionId, ensured, startSeq, endSeq),
      resolveAnchorSeq: messageId => {
        const index = ensured.lines.findIndex(line => line.id === messageId)
        return index === -1 ? undefined : index + 1
      },
    };
    return getMessagesPageFromLogSource<StoredChatMessage>(request, jsonlLogPageSource)
  }

  function getJsonlUserMessageMarkers(sessionId: string): UserMessageMarker[] | undefined {
    const state = ensureJsonlState(sessionId)
    if (!state) return undefined
    if (state.markers) return state.markers

    const markers: UserMessageMarker[] = []
    for (let seq = 1; seq <= state.lines.length; seq++) {
      if (state.lines[seq - 1].role !== 'user') continue
      const items = readLineRange<StoredChatMessage>(sessionId, state, seq, seq)
      if (!items) return undefined
      const marker = messageMarker(items[0]?.message, seq)
      if (marker) markers.push(marker)
    }
    state.markers = markers
    return markers
  }

  // ============ legacy 整文件 → 事件账本 的首触迁移(裁定 9b)============

  /**
   * 一条 `message/imported` 事件行。
   *
   * 与 `scripts/migrate-sessions-events.mjs` 的 `makeImportedRecord` **逐字段同形**
   * (那边是批量运维口,这边是首触口):`time` 取消息自己的 `timestamp`(迁移不给
   * 历史重新盖时间戳)、`data.synthetic` 让合成的账与记下来的账分得清、
   * `surfaceOp: 'append'` 让它在 surface 上按顺序落成消息节点。`synthetic` 不在
   * `SessionMessageImportedEventData` 里 —— 它是**迁移的带内幂等标记**
   * (`coverageState` 认的就是 `message/imported` 这个类型),故意留在契约外。
   */
  function importedEventLine(message: unknown, seq: number): string {
    const timestamp = (message as { timestamp?: unknown } | null | undefined)?.timestamp
    return encodeSessionLogEventLine({
      seq,
      time: typeof timestamp === 'number' ? timestamp : 0,
      type: 'message/imported',
      data: { message, synthetic: true },
      surfaceOp: 'append',
    } as unknown as SessionLogEventRecord)
  }

  /** 逐条校验:条数一致且每条消息 id 对得上(与从前迁抄本时同一道门)。 */
  function verifyImportedEvents(file: string, messages: readonly unknown[]): boolean {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(line => line.length > 0)
    if (lines.length !== messages.length) return false
    return lines.every((line, index) => {
      const record = decodeSessionLogEventLine(line)
      if (!record || record.type !== 'message/imported') return false
      const imported = (record.data as { message?: unknown }).message
      return messageIdentity(imported).id === messageIdentity(messages[index]).id
    })
  }

  /**
   * legacy 整文件会话(`sessions/<id>.json`)的首触迁移 —— **同步**,在 `load()`
   * 里一口气做完(S3w-3 批 6b,裁定 9b)。
   *
   * **为什么必须同步**:事件层"这条会话记不记账"的判据是**会话目录在不在**
   * (`event-log.ts` 的 `resolveEnabled`)。legacy 会话没有目录,于是从加载到迁移
   * 完成之间的每一条事件都被静默丢掉 —— 从前那 1 秒惰性窗口无所谓(真相在
   * `messages.jsonl` 里),现在事件是唯一账本,丢掉就是丢历史。同步做完之后,第
   * 一条命令跑起来时目录与 imported 都已在盘上,`ensureState` 一读就接上号。
   *
   * **只走全量导入这一档**:能走到这里 = `jsonlExists()` 为假 = 这条会话连
   * `events.jsonl` 都没有,所以运维脚本那套"覆盖感知合并 / 整体重编号"
   * (`planNativeMerge` / `shiftEventRecord`)在这条路上**结构性用不到** —— 没有
   * 既有事件可合、可平移。既有事件的会话请走
   * `scripts/migrate-sessions-events.mjs --apply`。
   *
   * 先写暂存目录、校验、再原子换入:会话目录一旦可见即为完整数据。
   */
  function migrateLegacySessionNow(sessionId: string, loaded?: TSession): boolean {
    if (jsonlExists(sessionId)) return true
    const legacyPath = options.getLegacySessionPath(sessionId)
    if (!fs.existsSync(legacyPath)) return false
    // 在途的 legacy 写入还没落盘:这一轮不迁(会读到旧内容,提交后又被那次写入
    // 重建成 legacy 文件,新数据永久落进无人读取的 backup)。下次冷加载再试。
    if (inFlightWrites.has(sessionId)) return false

    const session = loaded ?? options.readJsonFile<TSession | null>(legacyPath, null)
    if (!session) return false
    const messages = Array.isArray(session.messages) ? session.messages : []

    const stagingDir = sessionDir(sessionId) + '.migrating'
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true })
      fs.mkdirSync(stagingDir, { recursive: true })

      let text = ''
      messages.forEach((message, index) => {
        text += importedEventLine(message, index + 1)
      })
      const stagedEvents = path.join(stagingDir, 'events.jsonl')
      fs.writeFileSync(stagedEvents, text, 'utf-8')
      fs.writeFileSync(path.join(stagingDir, 'meta.json'), JSON.stringify(buildMeta(session), null, 2), 'utf-8')
      if (!verifyImportedEvents(stagedEvents, messages)) {
        throw new Error('imported event log failed verification')
      }

      // 读到提交之间一个 await 都没有 —— 从前那道"代际比对"的窗口结构性消失了。
      if (jsonlExists(sessionId)) {
        fs.rmSync(stagingDir, { recursive: true, force: true })
        return true
      }
      fs.renameSync(stagingDir, sessionDir(sessionId))
      const backupDir = path.join(options.getSessionsDir(), LEGACY_BACKUP_DIR_NAME)
      fs.mkdirSync(backupDir, { recursive: true })
      fs.renameSync(legacyPath, path.join(backupDir, path.basename(legacyPath)))
      states.delete(sessionId)
      logger?.info?.(`[Sessions] imported legacy session ${sessionId} into events (${messages.length} messages)`)
      return true
    } catch (error) {
      logger?.error?.(`[Sessions] legacy session import failed for ${sessionId}:`, error)
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      } catch {
        // 暂存目录清不掉不是迁移失败的理由,下一轮 rmSync 会再来一次。
      }
      return false
    }
  }

  // ============ 驱动实现 ============

  return {
    format,

    initialize(sessionId, session) {
      if (jsonlExists(sessionId) || legacyExists(sessionId)) throw new Error(`Session id already exists: ${sessionId}`)
      // 目录屏障的上界是 `sessions/`(工单 5 §2):再往上是用户主目录与整块卷。
      if (options.newSessionFormat() === 'jsonl') writeDurableJson(metaPath(sessionId), buildMeta(session), options.getSessionsDir())
      else writeDurableJson(options.getLegacySessionPath(sessionId), session, options.getSessionsDir())
    },

    readIdentity(sessionId) {
      const record = jsonlExists(sessionId)
        ? options.readJsonFile<SessionStoredIdentity | null>(metaPath(sessionId), null)
        : options.readJsonFile<SessionStoredIdentity | null>(options.getLegacySessionPath(sessionId), null)
      if (!record) return undefined
      return {
        ...(record.storageGeneration ? { storageGeneration: record.storageGeneration } : {}),
        ...(record.ownerUserId ? { ownerUserId: record.ownerUserId } : {}),
        ...(record.ownerWorkspaceId ? { ownerWorkspaceId: record.ownerWorkspaceId } : {}),
      }
    },

    load(sessionId) {
      if (jsonlExists(sessionId)) return loadJsonl(sessionId)
      const legacy = options.readJsonFile<TSession | null>(options.getLegacySessionPath(sessionId), null) ?? undefined
      if (!legacy) return undefined
      // legacy 整文件:**首触同步迁进事件账本**(裁定 9b)。迁成没迁成都**交出手里
      // 这一份**(带消息)—— 那正是迁移的输入,与迁完再读回来的投影逐条同源。
      //
      // 不改成"迁完 `loadJsonl()` 再读一遍":那样交出去的是 `meta.json` 那层空壳,
      // 消息要靠装配层的投影补水才填得回来,而**不是每只仓库都装了补水**
      // (server 的 echo/test 那只就没装)。没装的那只会把这条会话读成空 —— 一次
      // 只为了少走一条 if 而造出的历史消失。迁移是为了让**下一次**冷加载能从事件里
      // 折出它,不是为了让**这一次**读不到。
      migrateLegacySessionNow(sessionId, legacy)
      return legacy
    },

    async write(sessionId, session, plan) {
      // 写计划已不再被读(消息写半边删于 S3w-3 批 6b);签名保留见接口注释。
      void plan
      const writePromise = format(sessionId) === 'jsonl'
        ? writeJsonl(sessionId, session)
        : options.writeJsonFileAsync(options.getLegacySessionPath(sessionId), session)
      // 登记在途写入,供惰性迁移排空;失败也算完成(migration 会另行处理)。
      const token = writePromise.then(() => {}, () => {})
      inFlightWrites.set(sessionId, token)
      try {
        await writePromise
      } finally {
        if (inFlightWrites.get(sessionId) === token) {
          inFlightWrites.delete(sessionId)
        }
      }
    },

    delete(sessionId) {
      // A previous partial removal may already have removed meta.json. Its
      // remaining event/blob directory is still part of this deletion.
      if (fs.existsSync(sessionDir(sessionId))) {
        try {
          fs.rmSync(sessionDir(sessionId), { recursive: true, force: true })
        } catch (error) {
          logger?.error?.(`[Sessions] failed to delete jsonl session dir ${sessionId}:`, error)
          throw error
        }
      }
      if (legacyExists(sessionId)) {
        const legacyPath = options.getLegacySessionPath(sessionId)
        options.deleteJsonFile(legacyPath)
        // The historical JSON helper reports failure as false and logs it.
        // A deletion checkpoint must not mistake that adapter result for success.
        try {
          fs.statSync(legacyPath)
          throw new Error(`Failed to delete legacy session file: ${legacyPath}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      states.delete(sessionId)
    },

    getMessagesPage(request) {
      if (!hasTranscript(request.sessionId)) return undefined
      try {
        return getJsonlMessagesPage(request)
      } catch (error) {
        logger?.error?.(`[Sessions] jsonl page read failed for ${request.sessionId}:`, error)
        return undefined
      }
    },

    getUserMessageMarkers(sessionId) {
      if (!hasTranscript(sessionId)) return undefined
      try {
        return getJsonlUserMessageMarkers(sessionId)
      } catch (error) {
        logger?.error?.(`[Sessions] jsonl markers read failed for ${sessionId}:`, error)
        return undefined
      }
    },

    migrateLegacySessionNow,
  }
}
