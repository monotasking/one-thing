/**
 * CLI 的 `trace` 命令 —— S3 只读查询面的第三个出口(§12)。
 *
 * 与 `plugin` 同一条:**不经 daemon**。轨迹的事实全在
 * `<store>/sessions/<id>/events.jsonl` 这个纯追加文件里,读它不需要引擎、不需要
 * 会话被激活,也不该要求用户先把 daemon 起起来 —— 排障的时候进程往往正是那个
 * 起不来的东西。`--store` 已经被 `main()` 写进 `ONETHING_STORE_PATH`,
 * `readSessionTrace` 自己经 `getOnethingStorePath()` 解析,这里不碰路径字面量。
 *
 * **只读**:这条路径一个字节都不写回 store。特别地,它走的是
 * `app/session/trace.ts` 那条"活投影不在就读文件"的路,不会触发
 * `prepareSessionEventsOnce` 的补写(见那个文件的头注)。
 *
 * 与 `plugin-command.ts` 同样的打包纪律:下面这些必须是**静态** import ——
 * cli 与 Electron 主进程在同一张 rollup 图里,动态 import 会把整个主进程包
 * 拽进纯 node 进程。
 */
import {
  readSessionTrace,
  readSessionTraceResponseText,
  type ReadSessionTraceOptions,
} from '@onething/app/session/trace.js'
import type {
  SessionTrace,
  SessionTraceRequest,
  SessionTraceRun,
  SessionTraceToolCall,
} from '@onething/core/session'
import { stdout, stdoutRaw } from './stdout.js'

export interface TraceCommandOptions extends ReadSessionTraceOptions {
  json?: boolean
  /** 打这次请求的响应正文(而不是树)。 */
  response?: number
}

export async function traceCommand(
  sessionId: string | undefined,
  options: TraceCommandOptions = {},
): Promise<void> {
  if (!sessionId || !sessionId.trim()) throw new Error('sessionId is required')
  const trace = await readSessionTrace(sessionId.trim(), options)

  if (options.response !== undefined) {
    const run = trace.runs[trace.runs.length - 1]
    if (!run) throw new Error(`no run found in session ${sessionId}`)
    if (!run.runId) {
      // 老文件的合成组没有 runId,也就没有 `assistant/chunks` —— 正文当年就
      // 没有被记下来。说清楚,而不是打一个空串让人以为模型什么都没说。
      throw new Error(`run ${run.key} is a legacy group: response text was never recorded`)
    }
    const body = await readSessionTraceResponseText(sessionId.trim(), run.runId, options.response)
    if (options.json) {
      stdout(JSON.stringify(body, null, 2))
      return
    }
    if (body.reasoning) {
      stdout('--- reasoning ---')
      stdoutRaw(`${body.reasoning}\n`)
      stdout('--- text ---')
    }
    stdoutRaw(`${body.text}\n`)
    return
  }

  if (options.json) {
    stdout(JSON.stringify(trace, null, 2))
    return
  }
  for (const line of formatSessionTrace(trace)) stdout(line)
}

// ============ 格式化(纯函数,单测钉死) ============

/**
 * 树 → 可读的行。**时刻一律相对 run 起点**:绝对时刻在排障时几乎没用,而
 * "首 token 花了 1.2s、工具跑了 340ms"是一眼就能读的东西。
 *
 * 时长在这里现算(纪律 1:树上一个 duration 字段都没有)。
 */
export function formatSessionTrace(trace: SessionTrace): string[] {
  const lines: string[] = []
  const head = [
    `session ${trace.sessionId ?? '(unknown)'}`,
    `${trace.totalRuns} run${trace.totalRuns === 1 ? '' : 's'}`,
    `${trace.eventCount} events`,
  ]
  if (!trace.hasRunEvents) head.push('legacy log (runs are synthetic)')
  lines.push(head.join(' · '))
  if (trace.runs.length !== trace.totalRuns) {
    lines.push(`showing ${trace.runs.length} of ${trace.totalRuns}`)
  }
  if (!trace.runs.length) {
    lines.push('')
    lines.push('  (no runs recorded)')
  }

  for (const run of trace.runs) {
    lines.push('')
    lines.push(...formatRun(run))
  }

  if (trace.compactions.length) {
    lines.push('')
    lines.push('compactions')
    for (const compaction of trace.compactions) {
      lines.push(
        `  seq ${compaction.seq}  ${compaction.status}  ${compaction.compactedMessageCount} messages`
        + (compaction.error ? `  ${compaction.error}` : ''),
      )
    }
  }
  return lines
}

function formatRun(run: SessionTraceRun): string[] {
  const lines: string[] = []
  const label = run.runId || `${run.key} (synthetic)`
  const parts = [`run ${label}`]
  if (run.kind) parts.push(run.kind)
  parts.push(run.outcome ?? 'open')
  if (run.model) parts.push(run.provider ? `${run.provider}/${run.model}` : run.model)
  if (run.agentId) parts.push(`agent=${run.agentId}`)
  lines.push(parts.join(' · '))

  const origin = run.startTime
  if (run.trigger?.preview) lines.push(`  trigger  ${run.trigger.preview}`)
  if (run.skillUsed) lines.push(`  skill    ${run.skillUsed}`)
  if (run.error) lines.push(`  error    ${run.error.name ? `${run.error.name}: ` : ''}${run.error.message}`)
  if (run.startTime !== undefined && run.endTime !== undefined) {
    lines.push(`  elapsed  ${formatDuration(run.endTime - run.startTime)}`)
  }

  for (const request of run.requests) lines.push(...formatRequest(request, origin))
  return lines
}

function formatRequest(request: SessionTraceRequest, origin: number | undefined): string[] {
  const lines: string[] = []
  const head = [`request #${request.requestIndex}`]
  if (request.model) head.push(request.model)
  if (request.systemPromptHash) head.push(`sys=${request.systemPromptHash.slice(0, 8)}`)
  if (request.toolCount !== undefined) head.push(`tools=${request.toolCount}`)
  if (request.recipeMessageCount !== undefined) head.push(`history=${request.recipeMessageCount}`)
  lines.push(`  ${stamp(request.startTime, origin)}  ${head.join(' · ')}`)

  if (request.firstTokenTime !== undefined) {
    lines.push(`  ${stamp(request.firstTokenTime, origin)}    first token`)
  }
  for (const call of request.toolCalls) lines.push(...formatToolCall(call, origin))
  for (const error of request.errors) {
    lines.push(
      `  ${stamp(error.time, origin)}    error  attempt ${error.attempt}`
      + `${error.willRetry ? ' (will retry)' : ''}  ${error.message}`,
    )
  }
  if (request.endTime !== undefined) {
    const tail: string[] = ['end']
    const finish = request.finishReason ?? request.stopReason
    if (finish) tail.push(finish)
    if (request.usage) {
      const usage = request.usage as Record<string, number | undefined>
      const cells = [
        usage.inputTokens !== undefined ? `in=${usage.inputTokens}` : '',
        usage.outputTokens !== undefined ? `out=${usage.outputTokens}` : '',
        usage.cacheReadTokens ? `cacheR=${usage.cacheReadTokens}` : '',
        usage.cacheWriteTokens ? `cacheW=${usage.cacheWriteTokens}` : '',
      ].filter(Boolean)
      if (cells.length) tail.push(cells.join(' '))
    }
    // parts 是指纹不是正文:说清有几段、多长,正文用 `--response` 取。
    if (request.parts.length) {
      tail.push(request.parts.map(part => `${part.kind}:${part.len}`).join(','))
    }
    lines.push(`  ${stamp(request.endTime, origin)}    ${tail.join('  ')}`)
  }
  return lines
}

function formatToolCall(call: SessionTraceToolCall, origin: number | undefined): string[] {
  const lines: string[] = []
  const head = [`tool ${call.name}`]
  if (call.audit?.effects.length) head.push(`[${call.audit.effects.join(',')}]`)
  if (call.audit?.asked) head.push(call.audit.decision === 'deny' ? 'denied' : 'approved')
  lines.push(`  ${stamp(call.callTime, origin)}    ${head.join(' ')}  ${oneLine(call.argumentsRaw, 80)}`)
  if (call.resultTime !== undefined) {
    const status = call.isError ? 'error' : call.audit?.outcome ?? 'ok'
    lines.push(
      `  ${stamp(call.resultTime, origin)}      ↳ ${status}`
      + `  ${formatDuration(call.resultTime - call.callTime)}`
      + `  ${oneLine(call.resultPreview ?? (call.resultRef ? `<blob ${call.resultRef.bytes}B>` : ''), 80)}`,
    )
  } else {
    // 没配到结果:执行中,或者进程崩在中途。两者从日志里分不出来,也不猜。
    lines.push(`  ${' '.repeat(8)}      ↳ (no result recorded)`)
  }
  if (call.permission?.reason) {
    lines.push(`  ${' '.repeat(8)}      ↳ permission: ${oneLine(call.permission.reason, 80)}`)
  }
  return lines
}

/** 相对 run 起点的时刻。起点未知(老日志缺 run/start)就退回 `--------`。 */
function stamp(time: number | undefined, origin: number | undefined): string {
  if (time === undefined) return '        '
  if (origin === undefined) return '   ·    '
  return `+${formatDuration(time - origin)}`.padStart(8)
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

function oneLine(text: string, limit: number): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}
