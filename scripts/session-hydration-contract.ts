#!/usr/bin/env bun
/**
 * `sessions:hydration-contract` —— **补水形状合同**(S3w-1 的核心验收,
 * `docs/design/session-event-sourcing-2026-08.md` §14.4)。
 *
 *   bun run sessions:hydration-contract [<sessionId> | --all] [--store PATH]
 *                                       [--json] [--quiet] [--limit N]
 *
 * 断言一句话:
 *
 *   **投影补水 + rehydrate + sanitize  ≡  loadJsonl + rehydrate + sanitize**
 *
 * 冷加载补水是 §14.7 排第一的风险:store 是翻译器的取材面,补水形状的任何漂移
 * 都会**反射进新写出的事件**。这道门是批 1 为"把补水默认翻成投影"立的:翻档
 * 之前先对全量真机会话把这句话验一遍。**档位本身已随 F4-a 退役**(§16.11
 * 拍板 5,补水从此无条件走投影),这道门却留着 —— 它验的是那句等式,不是那根杆。
 *
 * ## 两侧是怎么造出来的(与产品代码同一条链,不是另写一遍)
 *
 * | | 抄本侧(老路) | 投影侧(今天唯一那条路) |
 * |---|---|---|
 * | 消息 | `messages.jsonl` → `scanJsonlLog`(= 驱动的 `loadJsonl`) | `events.jsonl` → `projectChatMessages`(= `eventsListMessages` 背后那一个),摘掉位置字段 `seq`(同 `session/hydrate.ts`) |
 * | 外壳 | `meta.json` | **同一份** `meta.json` —— 补水只换消息那一格 |
 * | 补水 | `rehydrateSessionFromStorage`(重建 `step.toolCall` / `partialResult`) | 同一个函数(仓库的岔口在它上游) |
 * | 启动修复 | `sanitizeSessionOnStartup` | 同一个函数(`repairOnFirstTouch` 在两条路的下游) |
 *
 * 比较走 `canonicalChatMessage` —— 影子与 `sessions:verify` 用的**同一个法官**,
 * 不开任何本地豁免。两侧比之前都过一遍 `dehydrateProjectedMessages`
 * (clone→dehydrate→rehydrate),这是 `sessions:verify` #6 立下的既有口径
 * (§13.17 裁定三):磁盘那份是脱水态,工具结果里的图片正文两侧一起归到
 * `[Image: … omitted]` 占位,三个已知不对称同源消解,判官零豁免。
 *
 * ## 跳过与已知残余
 *
 *  - `noEvents` —— 事件里折不出消息(未迁移老会话 / legacy 整文件 / 只有 E0
 *    七类):**产品代码在这种会话上根本不会补水**(`hydrateSessionMessagesFromProjection`
 *    返回 undefined),所以它不是合同的对象;
 *  - `noTranscript` —— 没有 `messages.jsonl`(纯事件会话):老路没有对象可比;
 *  - **抄本末条之后那一段** —— 批 6a 起抄本停写、批 6b 起写代码已删,`events.jsonl`
 *    继续独走。所以比对范围按**抄本实际的末条**截断(与 `session-verify.ts` #6 同
 *    口径):独走段只计数、只打印,不判红;抄本覆盖区之内的洞仍然是洞;
 *  - `partialCoverage` —— 事件只覆盖历史的后缀(混合覆盖会话)。这类**记为
 *    FAIL 的一个独立类**而不是静默跳过:翻档之后它们的 store 会少掉 legacy 前缀,
 *    这正是翻默认前必须先看清的那件事;
 *  - `sessions:verify:gate` 基线在册的会话按基线同款方式**跳过并计数**
 *    (`--baseline` 指的就是那份文件),理由:那些红线先于本批存在,合同不该
 *    替它们背锅,但也不许静默 —— 报告里单列一行。
 *
 * **全程只读**:一个字节都不写(store 不加锁,不 truncate 坏行 —— `loadJsonl`
 * 会修坏行,这里只按 `scanJsonlLog` 的判定读到有效长度为止)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalChatMessage,
  projectChatMessages,
  parseSessionLogEventLog,
  sanitizeSessionOnStartup,
  scanJsonlLog,
} from '@onething/core/session'
import {
  dehydrateProjectedMessages,
  rehydrateSessionFromStorage,
} from '@onething/runtime/sessions/session-dehydrate'

type AnyMessage = { id: string; role?: string } & Record<string, unknown>

export type HydrationContractStatus =
  | 'pass'
  | 'fail'
  | 'no-events'
  | 'no-transcript'
  | 'baseline-skip'

export interface HydrationContractReport {
  sessionId: string
  status: HydrationContractStatus
  /** 投影侧的可见消息数。 */
  projected: number
  /** 抄本侧的消息数。 */
  transcript: number
  /** 差异摘要,每条一句话(最多 `MAX_DIFFS` 条)。 */
  diffs: string[]
  /** 差异归类(报告的"逐类分析"就是这一列的直方图)。 */
  classes: string[]
}

const MAX_DIFFS = 8

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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * 一侧的完整补水链:外壳 + 消息 → `rehydrate` → `sanitizeSessionOnStartup`。
 *
 * `sanitize` 返回 `undefined` = 没什么可修(它是 COW 的),那就用原样那一份 ——
 * 与 `loadSessionWithAdapters` 里 `sanitizeSession` 的用法逐字相同。
 */
function hydrate(shell: Record<string, unknown>, messages: AnyMessage[]): AnyMessage[] {
  const session = rehydrateSessionFromStorage({ ...shell, messages }) as Record<string, unknown>
  const repaired = sanitizeSessionOnStartup(session as never) as Record<string, unknown> | undefined
  const out = (repaired ?? session).messages as AnyMessage[]
  return dehydrateProjectedMessages(out)
}

/** 差异的归类:报告要能按类说话,而不是甩 400 条 `canonical differs`。 */
function classify(detail: string): string {
  if (detail.startsWith('count')) return 'count'
  if (detail.startsWith('order')) return 'order'
  if (detail.startsWith('missing-in-projection')) return 'missing-in-projection'
  if (detail.startsWith('missing-in-transcript')) return 'missing-in-transcript'
  const field = /canonical differs .* at (?<path>[^\s]+)/.exec(detail)?.groups?.path
  return field ? `field:${field}` : 'canonical'
}

/** 两份 canonical 之间第一处不同的字段路径(给"逐类分析"用)。 */
function firstDiffPath(a: unknown, b: unknown, at = ''): string | undefined {
  if (stableStringify(a) === stableStringify(b)) return undefined
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object'
    && Array.isArray(a) === Array.isArray(b)
  if (!bothObjects) return at || '(root)'
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
  for (const key of [...keys].sort()) {
    const found = firstDiffPath(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      at ? `${at}.${key}` : key,
    )
    if (found) return found
  }
  return at || '(root)'
}

export function checkSession(sessionsDir: string, sessionId: string): HydrationContractReport {
  const dir = path.join(sessionsDir, sessionId)
  const diffs: string[] = []
  const classes: string[] = []
  const push = (detail: string): void => {
    classes.push(classify(detail))
    if (diffs.length < MAX_DIFFS) diffs.push(detail)
  }

  // ---- 外壳:两侧共用同一份 meta.json(补水只换消息那一格)
  const metaText = readTextIfExists(path.join(dir, 'meta.json'))
  let shell: Record<string, unknown> = { id: sessionId }
  if (metaText) {
    try {
      const { formatVersion: _v, log: _log, ...rest } = JSON.parse(metaText) as Record<string, unknown>
      shell = { ...rest, id: sessionId }
    } catch {
      // meta 坏了两侧一样坏,不是补水的事 —— 用最小外壳继续。
    }
  }

  // ---- 新路:events.jsonl → 投影
  const events = parseSessionLogEventLog(readTextIfExists(path.join(dir, 'events.jsonl')) ?? '')
  let projectedMessages: AnyMessage[] = []
  try {
    projectedMessages = projectChatMessages(events, {
      // 与 `sessions:verify` 同一条 blob 分流(#3,§13.13):二进制回放成 base64,
      // 文本回放成 utf8 —— utf8 硬解图片字节会把它改写成 `�`,两侧当场分叉。
      resolveBlob: ref => {
        let buffer: Buffer
        try {
          buffer = fs.readFileSync(path.join(dir, 'blobs', ref.hash))
        } catch {
          return undefined
        }
        const wantsBase64 = typeof ref.mime === 'string' && ref.mime.length > 0 && !ref.mime.startsWith('text/')
        return wantsBase64 ? buffer.toString('base64') : buffer.toString('utf8')
      },
    }).messages as unknown as AnyMessage[]
  } catch (error) {
    push(`projection threw: ${String(error)}`)
  }
  // `session/hydrate.ts` 摘掉位置字段 `seq`,这里同款(投影不产出位置)。
  projectedMessages = projectedMessages.map(message => {
    const { seq: _position, ...rest } = message as AnyMessage & { seq?: number }
    return rest as AnyMessage
  })

  if (projectedMessages.length === 0) {
    // 产品代码在这种会话上根本不补水,合同没有对象。
    return { sessionId, status: 'no-events', projected: 0, transcript: 0, diffs, classes }
  }

  // ---- 老路:messages.jsonl → scanJsonlLog(= 驱动 loadJsonl 的那一步)
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(path.join(dir, 'messages.jsonl'))
  } catch {
    return {
      sessionId,
      status: 'no-transcript',
      projected: projectedMessages.length,
      transcript: 0,
      diffs,
      classes,
    }
  }
  const scan = scanJsonlLog<AnyMessage>(buffer)
  const transcriptMessages = scan.entries.map(entry => entry.message)

  // ---- 两侧各走完整补水链
  const fromTranscript = hydrate(shell, transcriptMessages)
  const fromProjection = hydrate(shell, projectedMessages)

  const transcriptById = new Map(fromTranscript.map(message => [message.id, message]))
  const projectionIds = new Set(fromProjection.map(message => message.id))

  /**
   * **存量对账的右边界**(S3w-3 批 6b,§15.22;口径与 `session-verify.ts` #6 逐字
   * 相同 —— 那边批 6a 就改过,这边当时漏了)。
   *
   * 抄本自批 6a 停写、批 6b 删码之后**永久停在停写那一刻**,而 `events.jsonl`
   * 继续独走。于是"投影 ≡ 抄本"这句话只在**抄本还认识的那一段**上成立;那一段
   * 之后的每一条都是抄本管不着的新历史。不设这条边界的话,这道门会在每一条**还
   * 在用**的会话上恒红,而且红得一天比一天多 —— 那不是合同破了,是合同问错了。
   *
   * 边界 = 投影里**最后一条抄本还认识的**消息。它之前的洞仍然是洞(漏一条就是
   * 真的漏),它之后的只计数、只打印。抄本一条都不认识时边界 = -1,全篇算独走段。
   */
  let lastCoveredIndex = -1
  for (const [index, projected] of fromProjection.entries()) {
    if (transcriptById.has(projected.id)) lastCoveredIndex = index
  }

  let unknownProjected = 0
  let beyondTranscript = 0
  for (const [index, projected] of fromProjection.entries()) {
    const counterpart = transcriptById.get(projected.id)
    if (!counterpart) {
      if (index > lastCoveredIndex) beyondTranscript += 1
      else unknownProjected += 1
      continue
    }
    const a = canonicalChatMessage(counterpart as never)
    const b = canonicalChatMessage(projected as never)
    if (stableStringify(a) === stableStringify(b)) continue
    push(`canonical differs for ${projected.id} at ${firstDiffPath(a, b) ?? '(root)'}`)
  }
  if (unknownProjected > 0) push(`missing-in-transcript: ${unknownProjected} projected message(s)`)
  if (beyondTranscript > 0) classes[`beyond-transcript(events-only)`] = (classes[`beyond-transcript(events-only)`] ?? 0) + beyondTranscript

  const uncovered = fromTranscript.filter(message => !projectionIds.has(message.id))
  if (uncovered.length > 0) {
    push(`missing-in-projection: ${uncovered.length} transcript message(s) (legacy prefix?)`)
  }
  // 条数只在**被覆盖的那一段**上比(独走段两边比不了,不参与)。
  const coveredCount = fromProjection.length - unknownProjected - beyondTranscript
  const transcriptCovered = fromTranscript.filter(message => projectionIds.has(message.id)).length
  if (transcriptCovered !== coveredCount) {
    push(`count differs on the covered range: transcript ${transcriptCovered} vs projection ${coveredCount}`)
  }
  const coveredOrder = fromTranscript.filter(message => projectionIds.has(message.id)).map(message => message.id)
  const projectedOrder = fromProjection.filter(message => transcriptById.has(message.id)).map(message => message.id)
  if (coveredOrder.join(',') !== projectedOrder.join(',')) push('order differs on the covered range')

  return {
    sessionId,
    status: diffs.length > 0 ? 'fail' : 'pass',
    projected: fromProjection.length,
    transcript: fromTranscript.length,
    diffs,
    classes,
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

/**
 * `sessions:verify:gate` 的基线里点了名的会话(已知先于本批存在的红线)。
 * 基线每行的形状是 `<sessionId> <kind>: <detail>`,`#` 开头是注释。
 */
function readBaselineSessions(baselinePath: string): Set<string> {
  const ids = new Set<string>()
  const text = readTextIfExists(baselinePath)
  if (!text) return ids
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const id = line.split(/\s+/)[0]
    if (id) ids.add(id)
  }
  return ids
}

function parseArgs(argv: string[]): {
  sessionId?: string
  all: boolean
  store?: string
  json: boolean
  quiet: boolean
  limit?: number
  baseline?: string
} {
  const args = {
    sessionId: undefined as string | undefined,
    all: false,
    store: undefined as string | undefined,
    json: false,
    quiet: false,
    limit: undefined as number | undefined,
    baseline: undefined as string | undefined,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--all') args.all = true
    else if (arg === '--json') args.json = true
    else if (arg === '--quiet') args.quiet = true
    else if (arg === '--store') args.store = argv[++index]
    else if (arg.startsWith('--store=')) args.store = arg.slice('--store='.length)
    else if (arg === '--limit') args.limit = Number(argv[++index])
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length))
    else if (arg === '--baseline') args.baseline = argv[++index]
    else if (arg.startsWith('--baseline=')) args.baseline = arg.slice('--baseline='.length)
    else if (!arg.startsWith('-')) args.sessionId = arg
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const store = resolveStorePath(args.store)
  const sessionsDir = path.join(store, 'sessions')
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const baseline = readBaselineSessions(
    args.baseline ?? path.join(repo, 'docs/audit/session-verify-baseline-2026-08-20.txt'),
  )

  let ids = args.all || !args.sessionId ? listSessionIds(sessionsDir) : [args.sessionId]
  if (args.limit && args.limit > 0) ids = ids.slice(0, args.limit)

  // 基线在册的会话**照跑**(覆盖面不打折),只是它的红降级成 `baseline-skip`
  // 并计数 —— 那些残余先于本批存在,合同不替它们背锅,也不静默。
  const reports: HydrationContractReport[] = ids.map(id => {
    const report = checkSession(sessionsDir, id)
    if (report.status === 'fail' && baseline.has(id)) return { ...report, status: 'baseline-skip' }
    return report
  })

  const byStatus = new Map<HydrationContractStatus, number>()
  const classHistogram = new Map<string, number>()
  for (const report of reports) {
    byStatus.set(report.status, (byStatus.get(report.status) ?? 0) + 1)
    for (const entry of report.classes) {
      classHistogram.set(entry, (classHistogram.get(entry) ?? 0) + 1)
    }
  }
  const failed = reports.filter(report => report.status === 'fail')

  if (args.json) {
    console.log(JSON.stringify({ store, sessions: reports.length, failed: failed.length, reports }, null, 2))
  } else {
    console.log(`[hydration] store=${store} sessions=${reports.length}`)
    for (const report of reports) {
      if (report.status === 'fail') {
        console.log(`[hydration] failed: ${report.sessionId} (projection ${report.projected} / transcript ${report.transcript})`)
        for (const detail of report.diffs) console.log(`    ${detail}`)
      } else if (!args.quiet) {
        console.log(`[hydration] ok: ${report.sessionId} ${report.status === 'pass' ? `(${report.projected} messages)` : `(${report.status})`}`)
      }
    }
    console.log('\n[hydration] by status:')
    for (const [status, count] of [...byStatus].sort()) console.log(`  ${String(status).padEnd(16)} ${count}`)
    if (classHistogram.size > 0) {
      console.log('\n[hydration] diff classes:')
      for (const [entry, count] of [...classHistogram].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${entry.padEnd(40)} ${count}`)
      }
    }
  }

  console.log(`\n[hydration] complete: ${reports.length} session(s), ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
