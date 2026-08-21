import { describe, expect, it } from 'vitest'
import {
  cronMatches,
  currentCronRunAt,
  isValidTimezone,
  nextCronRunAt,
  parseCronExpression,
} from '@onething/runtime/scheduler'

describe('scheduler cron helpers', () => {
  it('validates 5-field cron expressions', () => {
    expect(() => parseCronExpression('0 3 * * *')).not.toThrow()
    expect(() => parseCronExpression('*/15 9-17 * * 1-5')).not.toThrow()
    expect(() => parseCronExpression('0 3 * *')).toThrow(/5-field/)
    expect(() => parseCronExpression('61 3 * * *')).toThrow(/out of range/)
  })

  it('matches the current zoned minute and computes the next run', () => {
    const date = new Date('2026-05-16T19:00:30.000Z')
    expect(cronMatches('0 3 * * *', date, 'Asia/Shanghai')).toBe(true)
    expect(currentCronRunAt('0 3 * * *', 'Asia/Shanghai', date)).toBe(Date.parse('2026-05-16T19:00:00.000Z'))
    expect(nextCronRunAt('0 3 * * *', 'Asia/Shanghai', date)).toBe(Date.parse('2026-05-17T19:00:00.000Z'))
  })

  it('validates IANA timezones', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true)
    expect(isValidTimezone('Not/AZone')).toBe(false)
  })
})
