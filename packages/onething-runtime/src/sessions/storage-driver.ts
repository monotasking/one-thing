/**
 * 会话存储驱动:legacy 整文件 JSON 与 jsonl 追加日志的混合路由。
 *
 * 路由规则(docs/design/session-storage-jsonl.md §7):
 * - 会话在盘上是什么格式,就用什么格式读写(格式跟随数据);
 * - 只有"新建会话"看 newSessionFormat() 开关——因此关掉开关即可回滚,
 *   已写成 jsonl 的会话仍然可读可写。
 *
 * jsonl 会话目录:
 *   <sessionsDir>/<id>/meta.json      会话级字段 + 日志摘要(小,整写)
 *   <sessionsDir>/<id>/messages.jsonl 一行一条消息,按 seq 有序
 *
 * 写入按 SessionWritePlan 分级:
 *   meta       只重写 meta.json
 *   message    后缀重写:从最低脏 seq 的字节偏移截断后重追加(流式热路径,O(当前消息))
 *   structural 全量重写(删除/插入/截断/分支等低频结构性修改)
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  buildSessionMessagesPageResponse,
  collectTailMessages,
  decodeJsonlLine,
  encodeJsonlHeaderLine,
  encodeJsonlMessageLine,
  getMessagesPageFromLogSource,
  scanJsonlLog,
  type GetSessionMessagesPageRequest,
  type GetSessionMessagesPageResponse,
  type IndexedSessionMessage,
  type StoredChatMessage,
  type UserMessageMarker,
} from '@onething/core/session'

export type SessionStorageFormat = 'legacy-json' | 'jsonl'

export interface SessionWritePlan {
  kind: 'meta' | 'message' | 'structural'
  /** kind === 'message' 时:最低脏消息的 seq(1 起);后缀重写从这里开始 */
  dirtySeq?: number
}

export const STRUCTURAL_WRITE_PLAN: SessionWritePlan = { kind: 'structural' }

export interface SessionStorageDriver<TSession> {
  /** 该会话当前(或将要)使用的存储格式 */
  format(sessionId: string): SessionStorageFormat
  load(sessionId: string): TSession | undefined
  write(sessionId: string, session: TSession, plan: SessionWritePlan): Promise<void>
  delete(sessionId: string): void
  /**
   * 把当前的消息日志原样复制一份留档,返回留档文件路径(无消息可留时 undefined)。
   *
   * 只复制、不改动:调用方随后自己清空/重写会话。留档**不进任何读取路径**
   * (jsonl 目录里只有 `messages.jsonl` 被扫),与 legacy-backup 同精神。
   */
  archiveMessages(sessionId: string): string | undefined
  /** 不加载整会话的分页;返回 undefined 表示无法服务(调用方降级) */
  getMessagesPage(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse | undefined
  getUserMessageMarkers(sessionId: string): UserMessageMarker[] | undefined
  /** 立即把 legacy 会话迁移为 jsonl;成功(或已是 jsonl)返回 true。惰性迁移也走这里。 */
  migrateToJsonlNow(sessionId: string): Promise<boolean>
}

export interface HybridSessionStorageDriverOptions {
  getSessionsDir(): string
  getLegacySessionPath(sessionId: string): string
  /** 新建会话使用的格式;每次新建时调用,settings 变更即时生效 */
  newSessionFormat(): SessionStorageFormat
  readJsonFile<TValue>(filePath: string, fallback: TValue): TValue
  writeJsonFileAsync(filePath: string, data: unknown): Promise<void>
  deleteJsonFile(filePath: string): void
  /** 惰性迁移触发前的延迟(毫秒),默认 1000;测试可设 0 以确定性触发 */
  migrationDelayMs?: number
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
  /** 每次 write() 递增;迁移提交前比对,期间有写入则放弃本次迁移 */
  const writeGenerations = new Map<string, number>()
  /** 每会话在途写入的 promise;迁移读取 legacy 前先排空,防止在途写重建已迁移的 legacy 文件 */
  const inFlightWrites = new Map<string, Promise<void>>()
  const migrationScheduled = new Set<string>()

  const sessionDir = (sessionId: string) => path.join(options.getSessionsDir(), sessionId)
  const metaPath = (sessionId: string) => path.join(sessionDir(sessionId), 'meta.json')
  const logPath = (sessionId: string) => path.join(sessionDir(sessionId), 'messages.jsonl')

  const jsonlExists = (sessionId: string) => fs.existsSync(metaPath(sessionId)) || fs.existsSync(logPath(sessionId))
  const legacyExists = (sessionId: string) => fs.existsSync(options.getLegacySessionPath(sessionId))

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

  // ============ jsonl 写入 ============

  /**
   * 从 `fromSeq` 起把消息编码成 jsonl 文本,并按 `startOffset` 直接算出每行的
   * 字节偏移 —— P0.4:偏移一次算准,不再先 `offset: 0` 占位、写完再回头逐行改
   * (`JsonlLineRef` 恰好带 id/role,`session:check` 的形状判据会把它当成消息,
   * 那种"先建后改"的写法在这里也确实没必要)。
   */
  function encodeSuffix(
    messages: unknown[],
    fromSeq: number,
    startOffset: number,
  ): { text: string; refs: JsonlLineRef[]; endOffset: number } {
    let text = ''
    let offset = startOffset
    const refs: JsonlLineRef[] = []
    for (let seq = fromSeq; seq <= messages.length; seq++) {
      const line = encodeJsonlMessageLine(seq, messages[seq - 1])
      const length = Buffer.byteLength(line, 'utf8')
      refs.push({ length, offset, ...messageIdentity(messages[seq - 1]) })
      offset += length
      text += line
    }
    return { text, refs, endOffset: offset }
  }

  async function rewriteAll(sessionId: string, session: TSession): Promise<void> {
    const messages = Array.isArray(session.messages) ? session.messages : []
    const header = encodeJsonlHeaderLine(session.id ?? sessionId)
    const { text, refs, endOffset } = encodeSuffix(messages, 1, Buffer.byteLength(header, 'utf8'))

    const dir = sessionDir(sessionId)
    await fs.promises.mkdir(dir, { recursive: true })
    // 先 meta 后 log:崩在中间只是 meta 领先(log 为真相,count 不一致良性);
    // 反序会留下"有 log 无 meta"的不可读会话。
    await writeMeta(sessionId, session)
    const target = logPath(sessionId)
    const tmp = target + '.tmp'
    await fs.promises.writeFile(tmp, header + text, 'utf-8')
    await fs.promises.rename(tmp, target)

    states.set(sessionId, { lines: refs, fileSize: endOffset })
  }

  async function writeSuffix(sessionId: string, session: TSession, dirtySeq: number): Promise<void> {
    const state = states.get(sessionId)
    const messages = Array.isArray(session.messages) ? session.messages : []
    // 状态缺失、脏点越界(比状态多跳了不止一个 append)都退化为全量重写
    if (!state || dirtySeq < 1 || dirtySeq > state.lines.length + 1 || dirtySeq > messages.length + 1) {
      await rewriteAll(sessionId, session)
      return
    }

    const keepLines = dirtySeq - 1
    const truncateAt = keepLines < state.lines.length
      ? state.lines[keepLines].offset
      : state.fileSize
    const { text, refs, endOffset } = encodeSuffix(messages, dirtySeq, truncateAt)

    const handle = await fs.promises.open(logPath(sessionId), 'r+')
    try {
      await handle.truncate(truncateAt)
      if (text.length > 0) {
        await handle.write(text, truncateAt, 'utf-8')
      }
    } finally {
      await handle.close()
    }

    state.lines = [...state.lines.slice(0, keepLines), ...refs]
    state.fileSize = endOffset
    state.markers = undefined
    await writeMeta(sessionId, session)
  }

  async function writeJsonl(sessionId: string, session: TSession, plan: SessionWritePlan): Promise<void> {
    if (plan.kind === 'meta' && fs.existsSync(logPath(sessionId))) {
      await writeMeta(sessionId, session)
      return
    }
    if (plan.kind === 'message' && typeof plan.dirtySeq === 'number') {
      await writeSuffix(sessionId, session, plan.dirtySeq)
      return
    }
    await rewriteAll(sessionId, session)
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

    return getMessagesPageFromLogSource<StoredChatMessage>(request, {
      totalCount: ensured.lines.length,
      readRange: (startSeq, endSeq) => readLineRange(sessionId, ensured, startSeq, endSeq),
      resolveAnchorSeq: messageId => {
        const index = ensured.lines.findIndex(line => line.id === messageId)
        return index === -1 ? undefined : index + 1
      },
    })
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

  // ============ legacy → jsonl 惰性迁移 ============

  async function migrateToJsonlNow(sessionId: string): Promise<boolean> {
    if (jsonlExists(sessionId)) return true
    const legacyPath = options.getLegacySessionPath(sessionId)
    if (!fs.existsSync(legacyPath)) return false

    // 先排空该会话在途的 legacy 写入:否则一个在捕获 generation 之前发起、尚未落盘的写入
    // 会让迁移读到旧内容,并在提交后重建 legacy 文件,使新数据永久落在无人读取的 backup 里。
    await inFlightWrites.get(sessionId)

    // 排空后同步捕获代际并读取,二者之间无 await,保证读到的是最新已落盘内容。
    const generation = writeGenerations.get(sessionId) ?? 0
    const session = options.readJsonFile<TSession | null>(legacyPath, null)
    if (!session) return false
    const messages = Array.isArray(session.messages) ? session.messages : []

    // 写入暂存目录,校验通过后才原子换入——jsonl 目录一旦可见即为完整数据
    const stagingDir = sessionDir(sessionId) + '.migrating'
    try {
      await fs.promises.rm(stagingDir, { recursive: true, force: true })
      await fs.promises.mkdir(stagingDir, { recursive: true })

      let text = encodeJsonlHeaderLine(typeof session.id === 'string' ? session.id : sessionId)
      messages.forEach((message, index) => {
        text += encodeJsonlMessageLine(index + 1, message)
      })
      await fs.promises.writeFile(path.join(stagingDir, 'messages.jsonl'), text, 'utf-8')
      await fs.promises.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(buildMeta(session), null, 2), 'utf-8')

      // 逐条校验:条数一致且每条消息 id 对得上
      const scan = scanJsonlLog<unknown>(await fs.promises.readFile(path.join(stagingDir, 'messages.jsonl')))
      const verified = !scan.recovered
        && scan.entries.length === messages.length
        && scan.entries.every((entry, index) =>
          messageIdentity(entry.message).id === messageIdentity(messages[index]).id)
      if (!verified) {
        throw new Error('migrated jsonl log failed verification')
      }

      // 提交在同一个同步 tick 内完成:期间有写入(代际变化 / 在途写入)或 jsonl 已出现则放弃
      if (
        (writeGenerations.get(sessionId) ?? 0) !== generation ||
        inFlightWrites.has(sessionId) ||
        jsonlExists(sessionId)
      ) {
        await fs.promises.rm(stagingDir, { recursive: true, force: true })
        return jsonlExists(sessionId)
      }
      fs.renameSync(stagingDir, sessionDir(sessionId))
      const backupDir = path.join(options.getSessionsDir(), LEGACY_BACKUP_DIR_NAME)
      fs.mkdirSync(backupDir, { recursive: true })
      fs.renameSync(legacyPath, path.join(backupDir, path.basename(legacyPath)))
      states.delete(sessionId)
      logger?.info?.(`[Sessions] migrated ${sessionId} to jsonl (${messages.length} messages)`)
      return true
    } catch (error) {
      logger?.error?.(`[Sessions] jsonl migration failed for ${sessionId}:`, error)
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      return false
    }
  }

  function scheduleMigration(sessionId: string): void {
    if (migrationScheduled.has(sessionId)) return
    if (options.newSessionFormat() !== 'jsonl') return
    migrationScheduled.add(sessionId)
    setTimeout(() => {
      void migrateToJsonlNow(sessionId).then(done => {
        // 因并发写入放弃时,解除标记,让后续 load() 在写入平静后重新触发迁移。
        if (!done) migrationScheduled.delete(sessionId)
      })
    }, options.migrationDelayMs ?? 1000)
  }

  // ============ 驱动实现 ============

  return {
    format,

    load(sessionId) {
      if (jsonlExists(sessionId)) return loadJsonl(sessionId)
      const legacy = options.readJsonFile<TSession | null>(options.getLegacySessionPath(sessionId), null) ?? undefined
      if (legacy) scheduleMigration(sessionId)
      return legacy
    },

    async write(sessionId, session, plan) {
      writeGenerations.set(sessionId, (writeGenerations.get(sessionId) ?? 0) + 1)
      const writePromise = format(sessionId) === 'jsonl'
        ? writeJsonl(sessionId, session, plan)
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
      states.delete(sessionId)
      if (jsonlExists(sessionId)) {
        try {
          fs.rmSync(sessionDir(sessionId), { recursive: true, force: true })
        } catch (error) {
          logger?.error?.(`[Sessions] failed to delete jsonl session dir ${sessionId}:`, error)
        }
      }
      if (legacyExists(sessionId)) {
        options.deleteJsonFile(options.getLegacySessionPath(sessionId))
      }
    },

    archiveMessages(sessionId) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
      try {
        if (jsonlExists(sessionId)) {
          const source = logPath(sessionId)
          if (!fs.existsSync(source)) return undefined
          const target = path.join(sessionDir(sessionId), `messages.cleared-${stamp}.jsonl`)
          fs.copyFileSync(source, target)
          return target
        }
        const legacyPath = options.getLegacySessionPath(sessionId)
        if (!fs.existsSync(legacyPath)) return undefined
        // legacy 会话没有独立的消息文件,整份会话就是那条日志 —— 留档因此落在
        // 会话目录之外的 legacy-backup 里,免得一个 `<id>.cleared-*.json` 躺在
        // sessions 根目录里读起来像另一条会话。
        const backupDir = path.join(options.getSessionsDir(), LEGACY_BACKUP_DIR_NAME)
        fs.mkdirSync(backupDir, { recursive: true })
        const target = path.join(backupDir, `${sessionId}.cleared-${stamp}.json`)
        fs.copyFileSync(legacyPath, target)
        return target
      } catch (error) {
        logger?.error?.(`[Sessions] messages archive failed for ${sessionId}:`, error)
        return undefined
      }
    },

    getMessagesPage(request) {
      if (!jsonlExists(request.sessionId)) return undefined
      try {
        return getJsonlMessagesPage(request)
      } catch (error) {
        logger?.error?.(`[Sessions] jsonl page read failed for ${request.sessionId}:`, error)
        return undefined
      }
    },

    getUserMessageMarkers(sessionId) {
      if (!jsonlExists(sessionId)) return undefined
      try {
        return getJsonlUserMessageMarkers(sessionId)
      } catch (error) {
        logger?.error?.(`[Sessions] jsonl markers read failed for ${sessionId}:`, error)
        return undefined
      }
    },

    migrateToJsonlNow,
  }
}
