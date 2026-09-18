import type { ResourceEventHub, ResourceProvider, ResourceReadContext, ResourceRef } from '@onething/core/resource'
import type { Intent, PlanContext, Result, RunContext } from '@onething/core/toolkit'
import {
  AMBIENT_HERE_PATH,
  AMBIENT_RESOURCE_SCHEME,
  ambientResourceSpecFor,
  type AmbientSource,
} from '@onething/runtime/ambient'
import { getLogger } from '../logging/index.js'

const log = getLogger('ambient')

/**
 * **`ambient:here`** —— 外界那几件事(时间、天气……)的资源面(09-19)。
 *
 * 只做接线:`attach` 时让每只来源开始听,它们报的事实经 hub 发出去 —— 于是它们走的是所有资源事实走的
 * 那一条路(bridge → 总线 → 宠物子系统读 `moment`、SSE 给壳)。这里不认识任何一只来源,也不认识宠物。
 * 一只来源 `start` 抛了只记一笔,别的来源照常。
 */
export class AmbientResourceProvider implements ResourceProvider<never> {
  readonly spec
  private stops: Array<() => void> = []

  constructor(private readonly sources: readonly AmbientSource[]) {
    this.spec = ambientResourceSpecFor(sources)
  }

  attach(hub: ResourceEventHub): void {
    this.dispose()
    for (const source of this.sources) {
      try {
        this.stops.push(
          source.start((event, payload) =>
            hub.emit({ scheme: AMBIENT_RESOURCE_SCHEME, path: AMBIENT_HERE_PATH }, event, payload),
          ),
        )
      } catch (error) {
        log.warn('ambient source failed to start', { source: source.id }, error)
      }
    }
  }

  /** 停掉每只来源。幂等;登记方在摘掉 scheme 之后调(与音乐 / 宠物同一条顺序)。 */
  dispose(): void {
    const stops = this.stops
    this.stops = []
    for (const stop of stops) {
      try {
        stop()
      } catch (error) {
        log.warn('ambient source failed to stop', {}, error)
      }
    }
  }

  async read(name: string, _ref: ResourceRef | null, _query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    if (name !== 'now') throw new TypeError(`Ambient resource has no read named ${JSON.stringify(name)}`)
    const out: Record<string, unknown> = {}
    for (const source of this.sources) {
      const snapshot = source.snapshot()
      if (snapshot) out[source.id] = snapshot
    }
    return out
  }

  async plan(op: string, _ref: ResourceRef | null, _params: unknown, _ctx: PlanContext): Promise<Intent<never>> {
    throw new TypeError(`Ambient resource has no op named ${JSON.stringify(op)}`)
  }

  async apply(op: string, _intent: Intent<never>, _ctx: RunContext): Promise<Result> {
    throw new TypeError(`Ambient resource has no op named ${JSON.stringify(op)}`)
  }
}
