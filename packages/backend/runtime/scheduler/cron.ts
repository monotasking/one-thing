type CronField = {
  any: boolean
  values: Set<number>
}

type ParsedCron = {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

type ZonedDateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dayOfWeek: number
}

function parseCronNumber(value: string, min: number, max: number, fieldName: string, dayOfWeek = false): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName} cron value: ${value}`)
  }
  const normalized = dayOfWeek && parsed === 7 ? 0 : parsed
  if (normalized < min || normalized > max) {
    throw new Error(`Cron ${fieldName} value out of range: ${value}`)
  }
  return normalized
}

function parseCronField(
  rawField: string,
  min: number,
  max: number,
  fieldName: string,
  dayOfWeek = false,
): CronField {
  const raw = rawField.trim()
  if (!raw) throw new Error(`Missing ${fieldName} cron field`)
  const values = new Set<number>()
  const parts = raw.split(',').map(part => part.trim()).filter(Boolean)
  const any = parts.length === 1 && parts[0] === '*'

  for (const part of parts) {
    const [rangeRaw, stepRaw] = part.split('/')
    const step = stepRaw ? Number.parseInt(stepRaw, 10) : 1
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid ${fieldName} cron step: ${part}`)
    }

    let start = min
    let end = max
    if (rangeRaw !== '*') {
      if (rangeRaw.includes('-')) {
        const [left, right] = rangeRaw.split('-')
        start = parseCronNumber(left, min, max, fieldName, dayOfWeek)
        end = parseCronNumber(right, min, max, fieldName, dayOfWeek)
      } else {
        start = parseCronNumber(rangeRaw, min, max, fieldName, dayOfWeek)
        end = start
      }
    }

    if (start <= end) {
      for (let value = start; value <= end; value += step) {
        values.add(dayOfWeek && value === 7 ? 0 : value)
      }
    } else if (dayOfWeek) {
      for (let value = start; value <= max; value += step) values.add(value === 7 ? 0 : value)
      for (let value = min; value <= end; value += step) values.add(value === 7 ? 0 : value)
    } else {
      throw new Error(`Invalid ${fieldName} cron range: ${part}`)
    }
  }

  return { any, values }
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error('Schedule frequency must be a 5-field cron expression')
  }
  return {
    minute: parseCronField(fields[0], 0, 59, 'minute'),
    hour: parseCronField(fields[1], 0, 23, 'hour'),
    dayOfMonth: parseCronField(fields[2], 1, 31, 'day-of-month'),
    month: parseCronField(fields[3], 1, 12, 'month'),
    dayOfWeek: parseCronField(fields[4], 0, 7, 'day-of-week', true),
  }
}

function getZonedDateParts(date: Date, timezone?: string): ZonedDateParts {
  const options: Intl.DateTimeFormatOptions = {
    ...(timezone ? { timeZone: timezone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
  }

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number.parseInt(parts.find(part => part.type === type)?.value || '0', 10)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = get('hour')
  const minute = get('minute')
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return { year, month, day, hour, minute, dayOfWeek }
}

export function cronMatches(expression: string, date: Date, timezone?: string): boolean {
  const cron = parseCronExpression(expression)
  const parts = getZonedDateParts(date, timezone)
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.day)
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek)
  const dayMatches = cron.dayOfMonth.any && cron.dayOfWeek.any
    ? true
    : cron.dayOfMonth.any
      ? dayOfWeekMatches
      : cron.dayOfWeek.any
        ? dayOfMonthMatches
        : dayOfMonthMatches || dayOfWeekMatches

  return (
    cron.minute.values.has(parts.minute) &&
    cron.hour.values.has(parts.hour) &&
    cron.month.values.has(parts.month) &&
    dayMatches
  )
}

export function cronRunKey(expression: string, date: Date, timezone?: string): string {
  const parts = getZonedDateParts(date, timezone)
  const padded = (value: number) => String(value).padStart(2, '0')
  return `${expression}|${timezone || 'system'}|${parts.year}-${padded(parts.month)}-${padded(parts.day)}T${padded(parts.hour)}:${padded(parts.minute)}`
}

export function currentCronRunAt(expression: string, timezone?: string, from = new Date()): number | undefined {
  if (!cronMatches(expression, from, timezone)) return undefined
  return Math.floor(from.getTime() / 60000) * 60000
}

export function nextCronRunAt(expression: string, timezone?: string, from = new Date()): number | undefined {
  parseCronExpression(expression)
  let cursor = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000)
  const maxMinutes = 366 * 24 * 60
  for (let index = 0; index < maxMinutes; index++) {
    if (cronMatches(expression, cursor, timezone)) return cursor.getTime()
    cursor = new Date(cursor.getTime() + 60000)
  }
  return undefined
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
    return true
  } catch {
    return false
  }
}
