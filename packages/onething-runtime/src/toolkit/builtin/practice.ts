/**
 * R3a 移植 —— `practice`。§4 的 `ReadOnlyTool` 一族。
 *
 * 描述、参数、输出文案逐字沿用旧 `tools/builtin/practice.ts`;账本读写全部在
 * adapters 后面(`practice/` 那套纯逻辑),这里一行都不重写。
 *
 * **无效果**:它写的是用户自己的练习账本,旧实现没有 `analyze`(permissionGuard
 * `safe`),权限层今天看到的就是空的。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type {
  OnethingPracticeLedgerRecord,
  OnethingPracticeRecordInput,
} from '../../practice/types.js'
import type {
  OnethingPracticeBucket,
  OnethingPracticeSummaryGranularity,
  OnethingPracticeSummaryResult,
} from '../../practice/summary.js'
import { defineInput } from '../contract.js'
import { ReadOnlyTool } from '../families/read-only.js'

export interface PracticeToolAdapters {
  log(input: Omit<OnethingPracticeRecordInput, 'kind' | 'source'>): OnethingPracticeLedgerRecord | Promise<OnethingPracticeLedgerRecord>
  query(request: { granularity: OnethingPracticeSummaryGranularity; count?: number }): Promise<OnethingPracticeSummaryResult>
  recent(days?: number, limit?: number): Promise<OnethingPracticeLedgerRecord[]>
}

export const PracticeInputSchema = z.object({
  action: z
    .enum(['log', 'query'])
    .describe(
      'log: append one exercise entry the user just reported. query: read aggregated history (plus recent entries) to summarize or advise.',
    ),
  name: z
    .string()
    .optional()
    .describe('For log: the activity name as the user said it, e.g. 「俯卧撑」「跑步」.'),
  sets: z.number().optional().describe('For log: number of sets, e.g. 3 in 3×20.'),
  repsPerSet: z.number().optional().describe('For log: reps per set, e.g. 20 in 3×20.'),
  durationMin: z.number().optional().describe('For log: duration in minutes, for time-based exercise like running.'),
  note: z.string().optional().describe('For log: optional free-form remark from the user.'),
  granularity: z
    .enum(['day', 'week', 'month'])
    .optional()
    .describe('For query: bucket size. Defaults to day (last 14 days).'),
  count: z.number().optional().describe('For query: how many trailing buckets.'),
})

export const PRACTICE_DESCRIPTION = `Log and review the user's practice: kegel sessions, pomodoro focus rounds, and physical exercise.

- log: when the user reports exercise done outside the app's timers ("刚做了 3 组俯卧撑,每组 20 个", "跑了半小时"), record it — name plus sets×repsPerSet or durationMin. Do not log kegel or pomodoro sessions yourself; the timer records those.
- query: when the user asks about their practice, or you want grounding for a summary or a progression suggestion, read the aggregates first and base every number on them. Suggestions (e.g. longer holds) are conversation only — never present them as applied changes.`

const PracticeContract = defineInput(PracticeInputSchema)

export type PracticeInput = z.infer<typeof PracticeInputSchema>

function formatBucket(bucket: OnethingPracticeBucket): string | null {
  if (bucket.records === 0) return null
  const parts: string[] = []
  if (bucket.kegel.sessions > 0) {
    parts.push(`凯格尔 ${bucket.kegel.sessions} 次(完成 ${bucket.kegel.completedSessions})· ${bucket.kegel.reps} rep`)
  }
  if (bucket.pomodoro.sessions > 0) {
    const cats = bucket.pomodoro.byCategory
      .map((c) => `${c.key} ${c.sessions}/${c.minutes}′`)
      .join(' ')
    parts.push(`番茄 ${bucket.pomodoro.sessions} 轮 ${bucket.pomodoro.minutes}′(${cats})`)
  }
  for (const ex of bucket.exercise.byName) {
    const volume = ex.reps > 0 ? `${ex.sets} 组 ${ex.reps} 个` : `${ex.durationMin}′`
    parts.push(`${ex.key} ${volume}`)
  }
  return `${bucket.bucketKey} · ${parts.join(' · ')}`
}

function formatRecent(records: OnethingPracticeLedgerRecord[]): string {
  if (records.length === 0) return ''
  const lines = records.slice(0, 10).map((record) => {
    const date = new Date(record.ts)
    const stamp = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    if (record.kind === 'kegel' && record.kegel) {
      return `${stamp} 凯格尔 ${record.kegel.repsDone} rep · 组 ${record.kegel.setsDone}/${record.kegel.setsTarget}`
    }
    if (record.kind === 'pomodoro' && record.pomodoro) {
      return `${stamp} 番茄·${record.name} ${record.pomodoro.elapsedMin}′${record.pomodoro.completed ? '' : '(中断)'}`
    }
    const ex = record.exercise
    const volume = ex?.sets && ex.repsPerSet ? `${ex.sets}×${ex.repsPerSet}` : ex?.durationMin ? `${ex.durationMin}′` : ''
    return `${stamp} ${record.name} ${volume}`.trimEnd()
  })
  return `\n最近条目:\n${lines.join('\n')}`
}

export class PracticeTool extends ReadOnlyTool<PracticeInput> {
  private readonly adapters: PracticeToolAdapters

  readonly spec: ToolSpec = {
    id: 'practice',
    title: 'Practice',
    description: PRACTICE_DESCRIPTION,
    input: PracticeContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(adapters: PracticeToolAdapters) {
    super()
    this.adapters = adapters
  }

  protected async perform(input: PracticeInput, ctx: RunContext): Promise<Result> {
    if (input.action === 'log') {
      const name = input.name?.trim()
      if (!name) {
        return this.done(ctx, '缺少名称', 'log 需要 name:用户报的项目名(如「俯卧撑」),配 sets×repsPerSet 或 durationMin。', { action: input.action })
      }
      const record = await this.adapters.log({
        name,
        note: input.note,
        exercise: {
          sets: input.sets,
          repsPerSet: input.repsPerSet,
          durationMin: input.durationMin,
        },
      })
      const volume = record.exercise?.sets && record.exercise.repsPerSet
        ? `${record.exercise.sets}×${record.exercise.repsPerSet}`
        : record.exercise?.durationMin
          ? `${record.exercise.durationMin}′`
          : ''
      return this.done(
        ctx,
        '已记上',
        `${record.name} ${volume} 已入账(${new Date(record.ts).toLocaleString()})。`.replace('  ', ' '),
        { action: input.action },
      )
    }

    const granularity = input.granularity ?? 'day'
    const [summary, recent] = await Promise.all([
      this.adapters.query({ granularity, count: input.count }),
      this.adapters.recent(),
    ])
    const lines = summary.buckets
      .map(formatBucket)
      .filter((line): line is string => line !== null)
    const body = lines.length > 0 ? lines.join('\n') : '所选区间内没有练习记录。'
    return this.done(ctx, '练习账本', `${body}${formatRecent(recent)}`, { action: input.action })
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createPracticeTool(adapters: PracticeToolAdapters): PracticeTool {
  return new PracticeTool(adapters)
}
