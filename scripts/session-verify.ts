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
 *     **S3w-3 批 6a 起是"存量只读对账"**(§15.19):`ONETHING_SESSION_TRANSCRIPT`
 *     默认 `off` 之后,抄本在切档那一刻**停在原地**,而 `events.jsonl` 继续独走。
 *     所以比对范围按**抄本实际的末条**截断:投影里落在抄本覆盖区之内、抄本却不认识
 *     的消息仍然是洞(红);抄本末条**之后**的那一段是 events 独走的新历史,不再
 *     要求抄本跟上(计数打印,不算异常)。两头的存量语义原样保留:
 *     legacy 前缀(事件账本开记之前)照旧算 uncovered,新会话根本没有
 *     `messages.jsonl` —— 那不是"抄本丢了",那是这条会话生在停写之后。
 *
 * **只读**:全程 `openSync(…, 'r')`,一个字节都不写(store 也不加锁)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeJsonlLine,
  SurfaceIndex,
  // 引用扫描的**单一判据**(§15.12):GC 的孤儿判定与这里的引用完整性检查问的是
  // 同一张表的两侧,判据分家迟早会分出一边删掉另一边认的东西。
  collectSessionBlobRefHashes,
  parseSessionLogEventLog,
  projectChatMessages,
  canonicalChatMessage,
} from '@onething/core/session'
import { dehydrateProjectedMessages } from '@onething/runtime/sessions/session-dehydrate'

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
  /**
   * F6(§13.2):投影**退化**的清单(`blob-missing:…` / `turn-split-fallback:…`)。
   *
   * 与 `issues` 分开:退化说的是这份历史数据本身缺了什么(blob 丢了、老消息
   * 没有回合号),不是"新代码弄坏了旧文件"—— 后者才是 `sessions:verify:gate`
   * 那道棘轮盯的东西。打印,但不进门。
   */
  degraded?: string[]
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
  //
  // 批 P-b(§15.3 第 3 条)新判据:一次 **completed** 的压缩落在一张非空 surface 上
  // 却一格都没遮住 = 静默漏遮 —— 真机 46dcec05 正是这样让模型同时看到摘要和被压掉
  // 的原文(投影 227 条 / 真相 114 条,预算翻倍而两边 token 账都是绿的)。
  // 逐条 push(而不是一次 `foldSurface`)才数得出"这一条压缩遮了几格"。
  const surface = new SurfaceIndex()
  const shadowedNothing: number[] = []
  for (const event of events) {
    const hadSurface = surface.lastSeq() !== undefined
    const before = surface.shadowedCount()
    surface.push(event)
    if (
      event.type === 'session/compacted'
      && (event.data.status ?? 'completed') === 'completed'
      && hadSurface
      && surface.shadowedCount() === before
    ) {
      shadowedNothing.push(event.seq)
    }
  }
  const snapshot = surface.snapshot()
  const violatedSeqs = new Set(snapshot.violations.map(violation => violation.eventSeq))
  for (const violation of snapshot.violations) {
    issues.push({ kind: 'surface', detail: `${violation.type}@${violation.eventSeq}: ${violation.reason}` })
  }
  // 已经落了 violation 的那一条不再重复报(`compact-anchor-unresolved` 说的是同一件事)。
  for (const seq of shadowedNothing) {
    if (violatedSeqs.has(seq)) continue
    issues.push({ kind: 'surface', detail: `session/compacted@${seq}: compact-shadowed-nothing` })
  }

  // 3. 投影
  //
  // F6(§13.2):投影**退化**(blob 换不回来 / 回合重放掉回 collapsed)从前是
  // 静默的 —— 附件凭空变短而两边的账都是绿的。这里把 blob 读口接上(它就在
  // 会话目录里),再把每一次退化按类别数出来。
  let messages: Array<{ id: string; role: string }> = []
  let nodes = 0
  const degraded = new Map<string, number>()
  try {
    const projected = projectChatMessages(events, {
      // #3(§13.13):blob 存的是**原始字节**。二进制正文(image/* 等,附件的
      // `base64Data` / image part 的 `data`)回放成 base64,文本(text/*,或没有
      // mime 的正文占位符路径)回放成 utf8 —— 与宿主的 `sessionProjectionOptions`
      // 同一条分流。utf8 硬解一段图片字节会把它改写成 `�`,两侧当场分叉。
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
      onIssue: issue => {
        const key = `${issue.kind}:${issue.where}`
        degraded.set(key, (degraded.get(key) ?? 0) + 1)
      },
    })
    // #4(§13.13):投影侧过一遍**磁盘同款**的脱水+补水,好和 `messages.jsonl`
    // 逐字节对齐 —— 工具结果里的图片正文两侧一起变成 `[Image: … omitted]` 占位。
    // 只碰 `toolCall.result` / `step.partialResult`(dehydrate 的作用域),附件
    // base64(#3)/ 消息正文 / R-b 生图正文一格不动。补水后回填 partialResult,
    // 与磁盘那份(读盘即脱水态、再补水)走同一条构造法。
    messages = dehydrateProjectedMessages(
      projected.messages as unknown as Array<{ id: string; role: string }>,
    )
    nodes = messages.length
  } catch (error) {
    issues.push({ kind: 'projection', detail: String(error) })
  }
  // 退化**不进 issues**:它说的是这份历史数据本身缺了什么(blob 丢了、老消息
  // 没有回合号),不是"这次改动弄坏了旧文件" —— 后者才是那道棘轮盯的东西。
  // 打印出来,让人看得见;门不受它影响。
  const degradedLines = [...degraded].sort().map(([key, count]) => `${key} ×${count}`)

  // 4. blob 引用
  for (const hash of collectSessionBlobRefHashes(events)) {
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
      // §13.17 裁定三:counterpart 侧走 dehydrateProjectedMessages(clone→dehydrate
      // →rehydrate),与投影侧同一把归一函数 —— 对新形态磁盘是恒等,对老形态把
      // step 上的 changes 归并到顶层、剥 originalContent,三个不对称同源消解,
      // canonical 判官零豁免。
      const hydrated = dehydrateProjectedMessages(real)
      const realById = new Map(hydrated.map(message => [message.id, message]))
      // **存量对账的右边界**(批 6a,§15.19):投影里最后一条抄本还认识的消息。
      // 切 off 之后抄本停在原地、事件独走,所以这一条之后的都属于"抄本管不着的
      // 新历史";它之前的仍然要逐条对上 —— 那才是存量,漏一条就是真的洞。
      // 抄本一条都不认识(整段 legacy 前缀 + 事件另起炉灶)时边界 = -1,
      // 于是全篇都算独走段,与老口径下"unknownProjected 全计"相比只松不紧,
      // 而那种会话本来就靠 coverage 那行看,不靠这条断言。
      let lastCoveredIndex = -1
      for (let i = 0; i < messages.length; i += 1) {
        if (realById.has(messages[i].id)) lastCoveredIndex = i
      }
      let unknownProjected = 0
      let beyondTranscript = 0
      for (const [index, projected] of messages.entries()) {
        const counterpart = realById.get(projected.id)
        if (!counterpart) {
          if (index > lastCoveredIndex) beyondTranscript += 1
          else unknownProjected += 1
          continue
        }
        const a = stableStringify(canonicalChatMessage(counterpart as never))
        const b = stableStringify(canonicalChatMessage(projected as never))
        if (a !== b) {
          issues.push({ kind: 'messages', detail: `canonical differs for message ${projected.id}` })
        }
      }
      if (unknownProjected > 0) {
        // 文案一字不改:`sessions:verify:gate` 的基线按整行匹配,改字面量等于
        // 把两条已知残余"治愈"掉再以新面孔重新出现(§15.19:基线不动)。
        issues.push({ kind: 'messages', detail: `projection has ${unknownProjected} message(s) unknown to messages.jsonl` })
      }
      const covered = messages.length - unknownProjected - beyondTranscript
      const uncovered = hydrated.length - covered
      const parts: string[] = []
      if (uncovered > 0) parts.push(`legacy prefix ${uncovered} uncovered`)
      // 停写之后长出来的那一段:打印,不进门(§15.19 —— 抄本不再被要求跟上)。
      if (beyondTranscript > 0) parts.push(`${beyondTranscript} beyond the transcript (events-only, S3w-3)`)
      coverage = parts.length > 0 ? `covered ${covered}/${hydrated.length} (${parts.join('; ')})` : undefined
      // 顺序:被覆盖的那一段在两边必须同序(独走段两边比不了,不参与)。
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
    ...(degradedLines.length > 0 ? { degraded: degradedLines } : {}),
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
    // F6:退化清单单独打一段(不进门,理由见 `SessionVerifyReport.degraded`)。
    const degradedTotals = new Map<string, number>()
    for (const report of reports) {
      for (const line of report.degraded ?? []) {
        const [key, count] = line.split(' ×')
        degradedTotals.set(key, (degradedTotals.get(key) ?? 0) + (Number(count) || 0))
      }
    }
    if (degradedTotals.size > 0) {
      const sessions = reports.filter(report => report.degraded?.length).length
      console.log(`[verify] 投影退化(不进门,F6):${sessions} 间会话`)
      for (const [key, count] of [...degradedTotals].sort()) console.log(`       ${key} ×${count}`)
    }
    console.log(failed.length === 0 ? '[verify] GATE GREEN' : `[verify] GATE RED (${failed.length} session(s))`)
  }

  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
