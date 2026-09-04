/**
 * S3a 单测的夹具:一间临时 store、几本**手写的**账本、一条同线程的 Worker。
 *
 * 三条纪律:
 *
 * 1. **不 import backend**。账本是拿 core 的编码器
 *    (`encodeSessionLogEventLine`)一行一行写出来的 —— 派工单原话「用 core 的
 *    事件编码器手写 events.jsonl(不 import backend)」。于是这些用例证明的是
 *    「投影器认得盘上的格式」,而不是「我们自己写的和自己读的一致」。
 * 2. **只在 `mktemp -d` 的临时 store 上跑**,`~/.onething` 一个字节不碰。
 * 3. **Worker 是同线程的**:`MessageChannel` 一头给 `IndexWorkerCore`、另一头给
 *    `IndexWorkerHost`。真 Worker 由 S3b 接;这里要验的是协议与生命周期,
 *    不是 `worker_threads` 会不会起线程。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MessageChannel } from 'node:worker_threads'

import type { DocumentFeed, DocumentFilter } from '@onething/core/search'
import type { SessionLogEventRecord, SessionLogEventType } from '@onething/core/session'
import { encodeSessionLogEventLine } from '@onething/core/session'

import { SqliteIndex } from '../sqlite-index.js'
import { IndexWorkerCore } from '../worker-core.js'
import type { IndexEndpoint } from '../worker-core.js'
import type { IndexWorkerHandle } from '../worker-host.js'

export const MESSAGE_CAPABILITY = 'messages'
export const SESSION_CAPABILITY = 'chats'
export const DAILY_CAPABILITY = 'daily'

/** 与 `runtime/search/capabilities/*` 将来那份 manifest.schema 同形。 */
export const INDEX_SCHEMAS: Record<string, Record<string, { analyzer: string; weight: number }>> = {
  [MESSAGE_CAPABILITY]: {
    content: { analyzer: 'composite', weight: 1 },
    attachments: { analyzer: 'composite', weight: 1.5 },
    reasoning: { analyzer: 'composite', weight: 0.5 },
  },
  [SESSION_CAPABILITY]: {
    title: { analyzer: 'composite', weight: 2 },
  },
  // 与 `capabilities/daily.ts` 那份 `manifest.schema` 逐字同(title 是文件名主干)。
  [DAILY_CAPABILITY]: {
    title: { analyzer: 'composite', weight: 2 },
    content: { analyzer: 'composite', weight: 1 },
  },
}

// ---- 临时 store ---------------------------------------------------------

export interface TempStore {
  root: string
  sessionsDir: string
  indexPath: string
  dispose(): void
}

export function createTempStore(): TempStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-index-'))
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'index'), { recursive: true })
  return {
    root,
    sessionsDir,
    indexPath: path.join(root, 'index', 'search.v1.sqlite'),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

// ---- 手写账本 -----------------------------------------------------------

/** 一条事件的「原料」—— seq 由写者按顺序分配,与真写入口同一条规矩。 */
export interface EventSpec {
  type: SessionLogEventType
  data: unknown
  time?: number
  surfaceOp?: SessionLogEventRecord['surfaceOp']
  sourceEventSeqs?: number[]
}

export const BASE_TIME = 1_780_000_000_000

export class LedgerWriter {
  private seq = 0
  private readonly lines: string[] = []

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true })
  }

  append(spec: EventSpec): number {
    this.seq += 1
    const record = {
      seq: this.seq,
      time: spec.time ?? BASE_TIME + this.seq * 1000,
      type: spec.type,
      data: spec.data,
      ...(spec.surfaceOp !== undefined ? { surfaceOp: spec.surfaceOp } : {}),
      ...(spec.sourceEventSeqs !== undefined ? { sourceEventSeqs: spec.sourceEventSeqs } : {}),
    } as unknown as SessionLogEventRecord
    this.lines.push(encodeSessionLogEventLine(record))
    return this.seq
  }

  /** 直接往文件尾追一行 —— 「另一个进程写的」那一形(不经进程内观察者)。 */
  appendToFile(spec: EventSpec): number {
    const seq = this.append(spec)
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), this.lines[this.lines.length - 1]!)
    return seq
  }

  write(): void {
    fs.writeFileSync(path.join(this.dir, 'events.jsonl'), this.lines.join(''))
  }

  /** 把最后一行写坏(折坏隔离用例的现场)。 */
  writeWithBrokenTail(): void {
    fs.writeFileSync(path.join(this.dir, 'events.jsonl'), `${this.lines.join('')}{"seq":999,"time":1,"type":"user/message","data":`)
  }

  get lastSeq(): number {
    return this.seq
  }
}

export interface MetaSpec {
  name?: string
  workspaceId?: string
  isArchived?: boolean
  createdAt?: number
  updatedAt?: number
}

export function writeMeta(dir: string, sessionId: string, meta: MetaSpec): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: sessionId,
    formatVersion: 2,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...meta,
  }, null, 2))
}

// ---- 一条「典型」会话 ---------------------------------------------------

export interface TypicalSessionOptions {
  sessionId: string
  /** 助手那一轮收不收尾(`run/end`)。false = 流式中,不该出文档。 */
  endRun?: boolean
  /** 助手那一轮碰过的文件(`tool/call` 的 path)。 */
  touchedFile?: string
  /** 一条超长正文(> 64KB)走 blob 的用户消息。 */
  bigMessage?: boolean
}

/**
 * 写一本「像真的」的账本:用户消息 → run → 两段 text delta → part-end →
 * request/end → (可选 tool/call) → run/end。
 */
export function writeTypicalSession(store: TempStore, options: TypicalSessionOptions): LedgerWriter {
  const dir = path.join(store.sessionsDir, options.sessionId)
  const writer = new LedgerWriter(dir)
  const assistantId = `a-${options.sessionId}`

  writer.append({ type: 'session/created', data: { sessionId: options.sessionId } })
  writer.append({
    type: 'user/message',
    surfaceOp: 'append',
    data: { message: { id: `u-${options.sessionId}`, role: 'user', content: '身份牌已经私发四人了', timestamp: BASE_TIME + 2000 } },
  })
  if (options.bigMessage === true) {
    writer.append({
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        message: {
          id: `big-${options.sessionId}`,
          role: 'user',
          // 65KB 的正文 —— 真写入口会把它落进 blob,这里的重点是「投影器扛得住
          // 一份大正文」,而 blob 解析那条路由 `resolveBlob` 端口负责(§5.5)。
          content: `超长正文开头 ${'零'.repeat(70_000)} 超长正文结尾`,
          timestamp: BASE_TIME + 2500,
        },
      },
    })
  }
  writer.append({
    type: 'run/start',
    surfaceOp: 'append',
    data: {
      runId: `r-${options.sessionId}`,
      kind: 'send',
      assistantMessageId: assistantId,
      timestamp: BASE_TIME + 3000,
    },
  })
  writer.append({
    type: 'assistant/chunks',
    data: {
      runId: `r-${options.sessionId}`,
      requestIndex: 1,
      messageId: assistantId,
      partIndex: 0,
      kind: 'text',
      time0: BASE_TIME + 3100,
      dt: [0, 10],
      text: ['索引重建大约五秒,', '期间还能查旧数据'],
    },
  })
  writer.append({
    type: 'assistant/part-end',
    data: {
      runId: `r-${options.sessionId}`,
      requestIndex: 1,
      messageId: assistantId,
      partIndex: 0,
      kind: 'text',
      len: 20,
    },
  })
  if (options.touchedFile !== undefined) {
    writer.append({
      type: 'tool/call',
      data: {
        callId: `c-${options.sessionId}`,
        argumentsRaw: JSON.stringify({ path: options.touchedFile, oldText: 'a', newText: 'b' }),
        name: 'edit',
        resolvedToolId: 'edit',
        displayName: 'edit',
        messageId: assistantId,
        runId: `r-${options.sessionId}`,
      },
    })
  }
  writer.append({ type: 'request/end', data: { requestIndex: 1, runId: `r-${options.sessionId}` } })
  if (options.endRun !== false) {
    writer.append({ type: 'run/end', data: { runId: `r-${options.sessionId}`, outcome: 'completed' } })
  }
  writer.write()
  return writer
}

// ---- 同线程 Worker ------------------------------------------------------

export interface SameThreadWorker {
  handle: IndexWorkerHandle
  core: IndexWorkerCore
  index: SqliteIndex
  /** 模拟崩溃:把 error + exit 都喊一遍(真 Worker 崩就是这两下)。 */
  crash(): void
}

export interface SameThreadWorkerOptions {
  indexPath: string
  feeds: readonly DocumentFeed<string>[]
  filters?: readonly DocumentFilter[]
  debounceMs?: number
}

/**
 * `MessageChannel` 的一头给 core、另一头给 host。**这就是派工单里那句「测试里传
 * `MessageChannel` 的 port1 + 同线程跑的 `IndexWorkerCore`(port2)」**。
 */
export function createSameThreadWorker(options: SameThreadWorkerOptions): SameThreadWorker {
  const channel = new MessageChannel()
  const index = new SqliteIndex({ path: options.indexPath })
  const core = new IndexWorkerCore({
    endpoint: channel.port2 as unknown as IndexEndpoint,
    index,
    feeds: options.feeds,
    ...(options.filters !== undefined ? { filters: options.filters } : {}),
    schemas: INDEX_SCHEMAS,
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
  })
  core.start()

  const errorListeners: Array<(error: Error) => void> = []
  const exitListeners: Array<(code: number) => void> = []
  let terminated = false

  const handle: IndexWorkerHandle = {
    endpoint: channel.port1 as unknown as IndexEndpoint,
    onError: listener => errorListeners.push(listener),
    onExit: listener => exitListeners.push(listener),
    terminate: () => {
      if (terminated) return
      terminated = true
      core.dispose()
      index.close()
      channel.port1.close()
      channel.port2.close()
    },
  }

  return {
    handle,
    core,
    index,
    crash: () => {
      if (terminated) return
      terminated = true
      core.dispose()
      index.close()
      channel.port1.close()
      channel.port2.close()
      for (const listener of errorListeners) listener(new Error('simulated worker crash'))
      for (const listener of exitListeners) listener(1)
    },
  }
}
