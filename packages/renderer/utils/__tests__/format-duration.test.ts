import { describe, expect, it } from 'vitest'
import { formatDuration } from '../format-duration'
import { formatToolDuration } from '@/stores/helpers/tool-activity-view'
import { formatElapsed } from '@/composables/useGenerationStatus'

/**
 * 三种口径的输出被逐字节钉死在这里。这张表抄自合并前的三份实现
 * (`tool-activity-view.formatToolDuration` / `MessageBubble.formatWorkDuration` /
 * `useGenerationStatus.formatElapsed`)的实际输出,包括看起来不像话但确实存在的
 * 两处:`tool` 在 59_999ms 处 toFixed 进位成 `60.0s`、在 119_999ms 处成 `1m60.0s`。
 * 合并只准搬家,不准顺手"修正"。
 */
const TABLE: Array<[ms: number, tool: string, work: string, elapsed: string]> = [
  [-1, '0.1s', '', '0s'],
  [0, '0.1s', '', '0s'],
  [1, '0.1s', '', '0s'],
  [50, '0.1s', '', '0s'],
  [99, '0.1s', '', '0s'],
  [100, '0.1s', '', '0s'],
  [101, '0.1s', '', '0s'],
  [500, '0.5s', '', '0s'],
  [999, '1.0s', '', '0s'],
  [1000, '1.0s', '1.0s', '1s'],
  [1500, '1.5s', '1.5s', '1s'],
  [9999, '10.0s', '10.0s', '9s'],
  [10_000, '10.0s', '10s', '10s'],
  [10_500, '10.5s', '11s', '10s'],
  [59_999, '60.0s', '60s', '59s'],
  [60_000, '1m00.0s', '1:00', '1:00'],
  [61_500, '1m01.5s', '1:01', '1:01'],
  [65_000, '1m05.0s', '1:05', '1:05'],
  [119_999, '1m60.0s', '1:59', '1:59'],
  [120_000, '2m00.0s', '2:00', '2:00'],
  [3_599_000, '59m59.0s', '59:59', '59:59'],
  [3_600_000, '60m00.0s', '60:00', '60:00'],
  [5_400_000, '90m00.0s', '90:00', '90:00'],
]

describe('formatDuration', () => {
  it.each(TABLE)('%i ms → tool "%s" / work "%s" / elapsed "%s"', (ms, tool, work, elapsed) => {
    expect(formatDuration(ms, { style: 'tool' })).toBe(tool)
    expect(formatDuration(ms, { style: 'work' })).toBe(work)
    expect(formatDuration(ms, { style: 'elapsed' })).toBe(elapsed)
  })

  it('三种口径互不相同 —— 合并没有把它们抹平', () => {
    expect(formatDuration(500, { style: 'tool' })).not.toBe(formatDuration(500, { style: 'work' }))
    expect(formatDuration(10_500, { style: 'work' })).not.toBe(formatDuration(10_500, { style: 'elapsed' }))
    expect(formatDuration(65_000, { style: 'tool' })).not.toBe(formatDuration(65_000, { style: 'elapsed' }))
  })
})

describe('调用点仍然输出同样的字节', () => {
  it.each(TABLE)('%i ms', (ms, tool, _work, elapsed) => {
    expect(formatToolDuration(ms)).toBe(tool)
    expect(formatElapsed(ms)).toBe(elapsed)
  })
})
