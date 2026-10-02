import type { ContextVariable, VariableProvider } from '../types.js'

const NAME = 'datetime'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Format local time at hour granularity: "2026-07-10 09:00 +08:00".
 * Hour granularity keeps consecutive turns byte-identical most of the time,
 * so the per-turn <context-update> injection stays deduplicated.
 */
export function formatHourGranularity(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00 ${offset}`
}

/**
 * Read-only state provider exposing the current local time. Variables only
 * ever reach the model through the <context-update> tail block, never the
 * system-prompt prefix.
 */
export class DateTimeProvider implements VariableProvider {
  readonly id = 'datetime'
  readonly priority = 20

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(): ContextVariable[] {
    return [{
      name: NAME,
      value: formatHourGranularity(this.now()),
      readonly: true,
      state: true,
      description: 'Current local time (hour granularity)',
    }]
  }

  claims(name: string): boolean {
    return name === NAME
  }
}
