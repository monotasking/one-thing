/**
 * R1 移植 —— `time`。§4 的 `ReadOnlyTool` 一族里最纯的一个:没有副作用、没有沙箱、
 * 没有取消点,整只工具就是"把参数交给纯函数,把结果投出去"。
 *
 * 描述与参数逐字沿用旧 `tools/builtin/time.ts`(2026-08-18 刚精简过);计算全部在
 * `tools/builtin/time-runtime.ts` 里,这里一行都不重写。
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { textResult } from '@onething/core/toolkit'
import {
  executeCoreTimeTool,
  type CoreTimeArgs,
} from '../../tools/builtin/time-runtime.js'
import { defineInput } from '../contract.js'
import { ReadOnlyTool } from '../families/read-only.js'

export const TimeInputSchema = z.object({
  action: z.enum(['now', 'convert', 'diff', 'add'])
    .describe('now = current time, convert = change timezone, diff = compare two instants, add = add a duration.'),
  timezone: z.string().optional()
    .describe('Default timezone for parsing and output. IANA name (Asia/Shanghai) or offset (UTC+08:00). Defaults to system timezone.'),
  format: z.enum(['full', 'date', 'time', 'iso', 'compact']).optional()
    .describe('Output format.'),
  time: z.string().optional()
    .describe('Input time for convert/add: ISO with offset, local datetime, epoch ms, or "now".'),
  from_timezone: z.string().optional()
    .describe('Source timezone when time has no offset.'),
  to_timezone: z.string().optional()
    .describe('Output timezone for convert/add/now.'),
  start_time: z.string().optional()
    .describe('Start time for diff.'),
  start_timezone: z.string().optional()
    .describe('Timezone for start_time when it has no offset.'),
  end_time: z.string().optional()
    .describe('End time for diff. Defaults to now.'),
  end_timezone: z.string().optional()
    .describe('Timezone for end_time when it has no offset.'),
  amount: z.number().optional()
    .describe('Duration amount for add. Can be negative.'),
  unit: z.enum(['millisecond', 'second', 'minute', 'hour', 'day', 'week']).optional()
    .describe('Duration unit for add/diff. Days/weeks are exact 24h/7d.'),
})

export const TIME_DESCRIPTION =
  'Timezone-aware time utility: current time (now), timezone conversion (convert), difference between two instants (diff), exact duration arithmetic (add). Prefer IANA timezone names; fixed offsets like UTC+08:00 also work. Provide a *_timezone when a datetime has no explicit offset.'

const TimeContract = defineInput(TimeInputSchema)

export type TimeInput = z.infer<typeof TimeInputSchema>

export class TimeTool extends ReadOnlyTool<TimeInput> {
  readonly spec: ToolSpec = {
    id: 'time',
    title: 'Time',
    description: TIME_DESCRIPTION,
    input: TimeContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'parallel',
  }

  protected async perform(input: TimeInput, ctx: RunContext): Promise<Result> {
    ctx.emit({
      type: 'partial',
      result: {
        content: [{ type: 'text', text: `Calculating time ${input.action}...` }],
        details: { phase: 'running', action: input.action },
      },
    })

    const outcome = executeCoreTimeTool(input as CoreTimeArgs)
    ctx.emit({
      type: 'annotate',
      title: outcome.status.title,
      details: toJsonObject(outcome.status.metadata),
    })
    ctx.emit({ type: 'annotate', title: outcome.title, details: toJsonObject(outcome.metadata) })

    return textResult(outcome.output, toJsonObject(outcome.metadata))
  }
}

export function createTimeTool(): TimeTool {
  return new TimeTool()
}
