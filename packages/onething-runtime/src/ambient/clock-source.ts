import type { EventSpec } from '@onething/core/resource'
import type { AmbientSource, AmbientTimers } from './source.js'
import { SYSTEM_TIMERS } from './source.js'

/** 一天分几段。边界是本地时间的整点。 */
export type DayPart = 'morning' | 'noon' | 'afternoon' | 'evening' | 'lateNight'

/** 各段从几点开始(本地时间)。凌晨 0–5 点算深夜。 */
const PART_STARTS: ReadonlyArray<readonly [hour: number, part: DayPart]> = [
  [6, 'morning'],
  [11, 'noon'],
  [13, 'afternoon'],
  [18, 'evening'],
  [23, 'lateNight'],
]

export function dayPartAt(hour: number): DayPart {
  let part: DayPart = 'lateNight'
  for (const [start, name] of PART_STARTS) if (hour >= start) part = name
  return part
}

/**
 * **时间**:跨进一天里的另一段(早上 / 中午 / 下午 / 傍晚 / 深夜)时报一声 `dayPart`。
 *
 * 只在**跨过去那一刻**报,开机时不补报 —— 打开 app 那一刻「现在是下午」不是一件新鲜事。
 * 计时器只排到下一个整点,不轮询:到点醒来看一眼段落变没变,再排下一个整点。
 */
export class ClockSource implements AmbientSource {
  readonly id = 'clock'
  readonly events: Readonly<Record<string, EventSpec>> = {
    dayPart: {
      title: 'The local time crossed into another part of the day',
      payload: {
        type: 'object',
        properties: {
          part: { type: 'string', enum: ['morning', 'noon', 'afternoon', 'evening', 'lateNight'] },
          hour: { type: 'number', description: 'Local hour, 0-23.' },
        },
        required: ['part', 'hour'],
      },
      moment: { weight: 'normal', gist: '一天到了另一段(早上 / 中午 / 下午 / 傍晚 / 深夜)' },
    },
  }

  constructor(private readonly timers: AmbientTimers = SYSTEM_TIMERS) {}

  snapshot(): Record<string, unknown> {
    const hour = new Date(this.timers.now()).getHours()
    return { hour, part: dayPartAt(hour) }
  }

  start(emit: (event: string, payload: Record<string, unknown>) => void): () => void {
    let stopped = false
    let handle: unknown
    let current = dayPartAt(new Date(this.timers.now()).getHours())
    const schedule = () => {
      if (stopped) return
      const now = new Date(this.timers.now())
      const next = new Date(now)
      next.setHours(now.getHours() + 1, 0, 0, 0)
      handle = this.timers.setTimeout(tick, Math.max(1_000, next.getTime() - now.getTime()))
    }
    const tick = () => {
      if (stopped) return
      const hour = new Date(this.timers.now()).getHours()
      const part = dayPartAt(hour)
      if (part !== current) {
        current = part
        emit('dayPart', { part, hour })
      }
      schedule()
    }
    schedule()
    return () => {
      stopped = true
      this.timers.clearTimeout(handle)
    }
  }
}
