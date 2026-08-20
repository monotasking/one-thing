#!/usr/bin/env bun
/**
 * `sessions:verify` —— 事件日志的自证(S2a,§11.1;取代退役的 `sessions:rebuild`)。
 *
 *   bun run sessions:verify [<sessionId> | --all] [--store PATH] [--json] [--quiet]
 *
 * 没有快照可重建了(拍板 6),所以"修"这个动词在事件层没有对象;剩下的只有
 * **看它自不自洽**。五项检查:
 *
 *  1. **seq 连续**:1..N 逐一递增,不重不跳(重复 seq 就是 G12 那种静默错乱);
 *  2. **surface 自洽**:`foldSurface` 的 replace 校验(range 在不在面上、
 *     `sourceEventSeqs` 列全没有);
 *  3. **能折出投影**:`projectChatMessages` 不抛,并数出可见消息;
 *  4. **blob 引用完整**:事件里每一个 `BlobRef` 在 `blobs/` 下都有文件;
 *  5. **未闭合的 run**:全量扫(不像 `prepare` 只看尾部窗口),所以窗口之外的
 *     残留在这里一定看得见;
 *  6. 有 `messages.jsonl` 时,与投影**按 id 序列**对一遍(正文/角色/条数)。
 *     不比字段:messages.jsonl 是脱水形态,字段级判据住在影子断言里
 *     (`sessions:shadow-report`),这里只回答"两边讲的是不是同一段历史"。
 *
 * **只读**:全程 `openSync(…, 'r')`,一个字节都不写(store 也不加锁)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeJsonlLine,
  foldSurface,
  isBlobRef,
  parseSessionLogEventLog,
  projectChatMessages,
  canonicalChatMessage,
  type SessionLogEventRecord,
} from '@onething/core/session'
import { rehydrateSessionFromStorage } from '@onething/runtime/sessions/session-dehydrate'

export interface SessionVerifyIssue {
  kind: 'seq' | 'surface' | 'projection' | 'blob' | 'unclosed-run' | 'messages'
  detail: string
}

export interface SessionVerifyReport {
  sessionId: string
  events: number
  messages: number
  bytes: number
  /** 只有 E0 七类(没有节点)= 事件里还没有这条会话的历史,不是错。 */
  noEventHistory: boolean
  /** 混合覆盖会话:事件覆盖到的后缀占比(legacy 前缀不算错)。 */
  coverage?: string
  issues: SessionVerifyIssue[]
}

export function resolveStorePath(explicit?: string): string {
  return explicit || process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}

function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 事件里出现的全部 blob 引用(附件 / 工具结果 / 图片 part)。 */
function collectBlobHashes(events: readonly SessionLogEventRecord[]): Set<string> {
  const hashes = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== 'object') return
    if (isBlobRef(value)) {
      hashes.add((value as { hash: string }).hash)
      return
    }
    for (const entry of Object.values(value as Record<string, unknown>)) walk(entry, depth + 1)
  }
  for (const event of events) walk(event.data, 0)
  return hashes
}


function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function messagesFromTranscript(text: string): Array<{ id: string } & Record<string, unknown>> | undefined {
  const out: Array<{ id: string } & Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const decoded = decodeJsonlLine<{ id?: string }>(line)
    if (!decoded) return undefined
    if (decoded.t === 'm' && decoded.message?.id) out.push(decoded.message as { id: string } & Record<string, unknown>)
  }
  return out
}

export function verifySession(sessionsDir: string, sessionId: string): SessionVerifyReport {
  const dir = path.join(sessionsDir, sessionId)
  const eventsText = readTextIfExists(path.join(dir, 'events.jsonl')) ?? ''
  const events = parseSessionLogEventLog(eventsText)
  const issues: SessionVerifyIssue[] = []

  // 1. seq 连续
  for (let index = 0; index < events.length; index++) {
    const expected = index + 1
    if (events[index].seq !== expected) {
      issues.push({ kind: 'seq', detail: `expected seq ${expected} at position ${index}, got ${events[index].seq}` })
      break
    }
  }

  // 2. surface
  for (const violation of foldSurface(events).violations) {
    issues.push({ kind: 'surface', detail: `${violation.type}@${violation.eventSeq}: ${violation.reason}` })
  }

  // 3. 投影
  let messages: Array<{ id: string; role: string }> = []
  let nodes = 0
  try {
    const projected = projectChatMessages(events)
    messages = projected.messages as unknown as Array<{ id: string; role: string }>
    nodes = messages.length
  } catch (error) {
    issues.push({ kind: 'projection', detail: String(error) })
  }

  // 4. blob 引用
  for (const hash of collectBlobHashes(events)) {
    if (!fs.existsSync(path.join(dir, 'blobs', hash))) {
      issues.push({ kind: 'blob', detail: `missing blob ${hash}` })
    }
  }

  // 5. 未闭合的 run(全量)
  const ended = new Set<string>()
  const started = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'run/end') ended.add(event.data.runId)
    else if (event.type === 'run/start') started.set(event.data.runId, event.seq)
  }
  for (const [runId, seq] of started) {
    if (!ended.has(runId)) {
      issues.push({ kind: 'unclosed-run', detail: `run ${runId} started at seq ${seq} has no run/end` })
    }
  }

  // 6. 与 messages.jsonl 对一遍(有的话)
  const transcript = readTextIfExists(path.join(dir, 'messages.jsonl'))
  const hasEventHistory = nodes > 0
  let coverage: string | undefined
  if (transcript && hasEventHistory) {
    const real = messagesFromTranscript(transcript)
    if (!real) {
      issues.push({ kind: 'messages', detail: 'messages.jsonl is corrupt (undecodable line)' })
    } else {
      // 覆盖感知(2026-08-20,§10.16 的教训):未迁移的混合覆盖会话,事件只认识
      // 历史的后缀 —— 全量长度对比对它们恒 FAIL,反而淹没真正的投影回归。
      // 改为:投影认识的消息逐条按 id 对齐做 canonical 比较;投影不认识的
      // (事件账本开记之前的)只计数为 uncovered,不算错。
      // 磁盘上的消息是脱水形态(step.toolCall 被摘、partialResult 待重算);
      // shadow/读面比较的是补水后的形状,这里走同一个函数。
      const hydrated = (rehydrateSessionFromStorage({ messages: real }) as { messages: typeof real }).messages
      const realById = new Map(hydrated.map(message => [message.id, message]))
      let unknownProjected = 0
      for (const projected of messages) {
        const counterpart = realById.get(projected.id)
        if (!counterpart) { unknownProjected += 1; continue }
        const a = stableStringify(canonicalChatMessage(counterpart as never))
        const b = stableStringify(canonicalChatMessage(projected as never))
        if (a !== b) {
          issues.push({ kind: 'messages', detail: `canonical differs for message ${projected.id}` })
        }
      }
      if (unknownProjected > 0) {
        issues.push({ kind: 'messages', detail: `projection has ${unknownProjected} message(s) unknown to messages.jsonl` })
      }
      const uncovered = hydrated.length - (messages.length - unknownProjected)
      coverage = uncovered > 0 ? `covered ${messages.length}/${hydrated.length} (legacy prefix ${uncovered} uncovered)` : undefined
      // 顺序:被覆盖的后缀在两边必须同序
      const coveredIds = hydrated.filter(message => messages.some(p => p.id === message.id)).map(message => message.id)
      if (coveredIds.join(',') !== messages.filter(p => realById.has(p.id)).map(p => p.id).join(',')) {
        issues.push({ kind: 'messages', detail: 'covered message order differs' })
      }
    }
  }

  return {
    sessionId,
    events: events.length,
    messages: nodes,
    bytes: Buffer.byteLength(eventsText, 'utf8'),
    noEventHistory: !hasEventHistory,
    coverage,
    issues,
  }
}

export function listSessionIds(sessionsDir: string): string[] {
  try {
    return fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'legacy-backup')
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function parseArgs(argv: string[]): { sessionId?: string; all: boolean; store?: string; json: boolean; quiet: boolean } {
  const args = { sessionId: undefined as string | undefined, all: false, store: undefined as string | undefined, json: false, quiet: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--all') args.all = true
    else if (arg === '--json') args.json = true
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--store') args.store = argv[++index]
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length)
    else if (!arg.startsWith('-')) args.sessionId = arg
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const store = resolveStorePath(args.store)
  const sessionsDir = path.join(store, 'sessions')
  const ids = args.all || !args.sessionId ? listSessionIds(sessionsDir) : [args.sessionId]

  const reports = ids.map(id => verifySession(sessionsDir, id))
  const failed = reports.filter(report => report.issues.length > 0)

  if (args.json) {
    console.log(JSON.stringify({ store, sessions: reports.length, failed: failed.length, reports }, null, 2))
  } else {
    console.log(`[verify] store=${store} sessions=${reports.length}`)
    for (const report of reports) {
      if (report.issues.length === 0) {
        if (!args.quiet) {
          const note = report.noEventHistory ? ' (no event history yet)' : ''
          console.log(`  ok   ${report.sessionId}  events=${report.events} messages=${report.messages}${note}`)
        }
        continue
      }
      console.log(`  FAIL ${report.sessionId}  events=${report.events} messages=${report.messages}`)
      for (const issue of report.issues.slice(0, 10)) {
        console.log(`       ${issue.kind}: ${issue.detail}`)
      }
      if (report.issues.length > 10) console.log(`       … ${report.issues.length - 10} more`)
    }
    console.log(failed.length === 0 ? '[verify] GATE GREEN' : `[verify] GATE RED (${failed.length} session(s))`)
  }

  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
