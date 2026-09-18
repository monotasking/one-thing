import type { EventSpec, JsonSchema, ResourceSpec } from '@onething/core/resource'
import type { AmbientSource } from './source.js'

export const AMBIENT_RESOURCE_SCHEME = 'ambient'
export const AMBIENT_HERE_PATH = 'here'

const EMPTY: JsonSchema = { type: 'object', properties: {}, required: [] }

export class DuplicateAmbientEventError extends Error {
  constructor(readonly event: string) {
    super(`Two ambient sources both declare the event ${JSON.stringify(event)}`)
    this.name = 'DuplicateAmbientEventError'
  }
}

/**
 * `ambient:` 的自述:**由来源表并出来**,不是手写的一张表。每只来源的事件原样收进来(带着它自己的
 * `moment`),读法只有一条 `now`(每只来源此刻知道什么)。
 *
 * 不做成模型工具(`exposure.aiTool: false`):模型本来就从变量里知道现在几点;它是给「旁观者」
 * (宠物)看的一组事实,不是给模型用的一件东西。
 */
export function ambientResourceSpecFor(sources: readonly AmbientSource[]): ResourceSpec {
  const events: Record<string, EventSpec> = {}
  for (const source of sources) {
    for (const [name, spec] of Object.entries(source.events)) {
      if (name in events) throw new DuplicateAmbientEventError(name)
      events[name] = spec
    }
  }
  return {
    scheme: AMBIENT_RESOURCE_SCHEME,
    title: 'What is going on outside the app: time of day, weather (address: ambient:here)',
    exposure: { aiTool: false },
    reads: {
      now: {
        title: 'What each ambient source knows right now, keyed by source id',
        query: EMPTY,
        result: { type: 'object', properties: {}, required: [] },
      },
    },
    ops: {},
    events,
  }
}
