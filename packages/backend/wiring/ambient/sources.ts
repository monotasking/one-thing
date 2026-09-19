import { ClockSource, parseWttrReply, WeatherSource, type AmbientSource, type WeatherFetcher } from '@onething/runtime/ambient'
import { createAppFetch } from '../../provider-binding/bound-fetch.js'

/**
 * **外界来源表**(09-19)。加一只来源 = 在这里加一行(它自己的类住在 `@onething/runtime/ambient`)。
 *
 * 天气读的是 wttr.in(免 key,按出口 IP 猜城市;走应用的代理设置,与模型请求同一只 fetch):
 * 每 30 分钟一发,只在「晴 / 多云 / 雨 / 雪 / 雾 / 雷」这一类变了时报。
 */
export function defaultAmbientSources(): AmbientSource[] {
  /*
   * 09-19 暂时关掉(用户:「他现在自己到点就 trigger 了,然后开始说话,这好烦啊…别这样,先关掉,
   * 等我有空想想怎么做」)。来源类与资源面都留着,等他想好怎么触发再把这一行放回来:
   *   return [new ClockSource(), new WeatherSource(wttrWeather())]
   * 表是空的 = 不起计时器、不问天气、宠物收不到任何外界时刻。
   */
  return []
}

/** 两只来源的造法留着(测试与将来重开用),只是出厂表里暂时不放。 */
export function builtinAmbientSources(): AmbientSource[] {
  return [new ClockSource(), new WeatherSource(wttrWeather())]
}

const WTTR_URL = 'https://wttr.in/?format=j1&lang=zh'

export function wttrWeather(fetchImpl = createAppFetch({ policy: 'default' })): WeatherFetcher {
  return async signal => {
    const response = await fetchImpl(WTTR_URL, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return parseWttrReply(await response.json())
  }
}
