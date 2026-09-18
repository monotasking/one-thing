import type { EventSpec } from '@onething/core/resource'
import type { AmbientSource, AmbientTimers } from './source.js'
import { SYSTEM_TIMERS } from './source.js'

/** 天气归成几类:宠物只关心「变了没有」,不关心 113 种天气代码。 */
export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog' | 'storm'

export interface WeatherReading {
  kind: WeatherKind
  /** 服务给的原话(「小雨」「Light rain」)。 */
  description: string
  tempC: number
  /** 哪儿的天气(服务按出口 IP 猜的城市)。 */
  place?: string
}

/** 读一次天气。读不到 = `null`(没网、服务挂了)—— 一次读不到不是一件值得说的事。 */
export type WeatherFetcher = (signal: AbortSignal) => Promise<WeatherReading | null>

/** 多久看一次天。天气按小时变,半小时足够赶上「下起雨来了」。 */
export const WEATHER_POLL_MS = 30 * 60_000
/** 一次读最多等多久。 */
const FETCH_TIMEOUT_MS = 15_000

/**
 * **天气**:看天,变了一类(晴 → 下雨、雨停了……)报一声 `weatherChanged`。
 *
 * 第一次读到只记下、不报 —— 「今天是晴天」在开机那一刻不是新闻;之后每次看天,类别变了才报。
 * 怎么读天是注入的(`WeatherFetcher`):这只类不碰网络,装配层给它一只真的读法。
 */
export class WeatherSource implements AmbientSource {
  readonly id = 'weather'
  readonly events: Readonly<Record<string, EventSpec>> = {
    weatherChanged: {
      title: 'The weather outside changed kind (e.g. it started or stopped raining)',
      payload: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['clear', 'cloudy', 'rain', 'snow', 'fog', 'storm'] },
          from: { type: 'string', description: 'The kind it was before.' },
          description: { type: 'string', description: "The weather service's own words." },
          tempC: { type: 'number' },
          place: { type: 'string' },
        },
        required: ['kind', 'from', 'description', 'tempC'],
      },
      moment: { weight: 'normal', gist: '外面的天气变了(比如下起雨来了、雨停了)' },
    },
  }

  private last: WeatherReading | undefined

  constructor(
    private readonly fetchWeather: WeatherFetcher,
    private readonly timers: AmbientTimers = SYSTEM_TIMERS,
    private readonly pollMs: number = WEATHER_POLL_MS,
  ) {}

  snapshot(): Record<string, unknown> | undefined {
    return this.last ? { ...this.last } : undefined
  }

  start(emit: (event: string, payload: Record<string, unknown>) => void): () => void {
    let stopped = false
    let handle: unknown
    let inflight: AbortController | undefined
    const look = async () => {
      if (stopped) return
      inflight = new AbortController()
      const abort = inflight
      const timeout = this.timers.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
      const reading = await this.fetchWeather(abort.signal).catch(() => null)
      this.timers.clearTimeout(timeout)
      if (stopped) return
      if (reading) {
        const before = this.last
        this.last = reading
        if (before && before.kind !== reading.kind) {
          emit('weatherChanged', {
            kind: reading.kind,
            from: before.kind,
            description: reading.description,
            tempC: reading.tempC,
            ...(reading.place ? { place: reading.place } : {}),
          })
        }
      }
      handle = this.timers.setTimeout(() => void look(), this.pollMs)
    }
    void look()
    return () => {
      stopped = true
      inflight?.abort()
      this.timers.clearTimeout(handle)
    }
  }
}

/**
 * wttr.in 的天气代码(WWO 那一套)→ 类别。表外的一律算多云:认不出不等于出了事。
 * 代码表:https://www.worldweatheronline.com/developer/api/docs/weather-icons.aspx
 */
export function weatherKindOfCode(code: number): WeatherKind {
  if (code === 113) return 'clear'
  if ([200, 386, 389, 392, 395].includes(code)) return 'storm'
  if ([143, 248, 260].includes(code)) return 'fog'
  if ([179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377].includes(code)) return 'snow'
  if ([176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359].includes(code)) return 'rain'
  return 'cloudy'
}

/** wttr.in `?format=j1` 的回复 → 一次读数。形状不对 = `null`。 */
export function parseWttrReply(body: unknown): WeatherReading | null {
  const root = body as {
    current_condition?: Array<{ temp_C?: string; weatherCode?: string; weatherDesc?: Array<{ value?: string }>; lang_zh?: Array<{ value?: string }> }>
    nearest_area?: Array<{ areaName?: Array<{ value?: string }> }>
  } | null
  const now = root?.current_condition?.[0]
  if (!now) return null
  const code = Number(now.weatherCode)
  const tempC = Number(now.temp_C)
  if (!Number.isFinite(code) || !Number.isFinite(tempC)) return null
  const description = now.lang_zh?.[0]?.value?.trim() || now.weatherDesc?.[0]?.value?.trim() || ''
  const place = root?.nearest_area?.[0]?.areaName?.[0]?.value?.trim()
  return { kind: weatherKindOfCode(code), description, tempC, ...(place ? { place } : {}) }
}
