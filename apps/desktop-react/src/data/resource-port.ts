import { resourcesRouter } from '@shared/ipc/resources'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

/**
 * 任何一块面经 `resources` 域取数的那一层**端口**(从 `music-port.ts` 抽出来,
 * 待办是它的第二个消费者 —— `apps/desktop-react/docs/todo-2026-09.md` §4)。
 *
 * 形状就是 `resources` 那个域的形状:`read(ref, name, query)` / `do(ref, op, params)` /
 * `onResourceEvent(prefix, cb)`。地址、读法名、做法名全部由调用方给,这一层**一个
 * 命名空间的名字都不认识** —— 判词在 `@shared/ipc/resources.ts` 头上「一个域,零个 scheme 名」。
 *
 * ── 为什么是一个「槽」类,而不是一只共享的模块单例 ─────────────────────────
 * 每个消费方要能**单独**换掉自己的端口(测试、规格页、MusicLab 那种假数据台)。
 * 一只全局槽的话,给音乐面装的假端口会顺带把待办面也换掉。所以每个领域
 * `new ResourcePortSlot()` 一格,真实现共用 `createResourcePort()` 这一份。
 *
 * 结局原样交出去,不在这里翻译(`read` 四支、`do` 五支),折成什么由消费方决定。
 */

/** 一条到了的资源事实。`event` 是自述 `events` 里的名字。 */
export interface ResourceEventFact {
  /** `<scheme>:<path>`,出事的那个资源。 */
  ref: string
  event: string
  payload: unknown
}

export interface ResourcePort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  read(ref: string, name: string, query?: Record<string, unknown>): Promise<ResourceReadView>
  do(ref: string, op: string, params?: Record<string, unknown>): Promise<ResourceOutcomeView>
  /** 订这个前缀底下的资源事实。返回退订。 */
  onResourceEvent(prefix: string, callback: (event: ResourceEventFact) => void): () => void
}

/** 事件载荷 → 这一条认不认。名字与形都对得上才算数(SSE 是广播)。 */
export function asResourceEvent(data: unknown): ResourceEventFact | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.ref !== 'string' || typeof row.event !== 'string') return null
  return { ref: row.ref, event: row.event, payload: row.payload }
}

/**
 * 真实现。**惰性**:它要的是连通之后才存在的客户端,而端口被换掉的测试根本不该
 * 把连通面拖进来(与 `files-port` / `sessions-port` 同一条理由)。
 */
export async function createResourcePort(): Promise<ResourcePort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const resources = client.api(resourcesRouter)
  return {
    ready: () => whenConnected(),
    read: (ref, name, query) => resources.read({ ref, name, ...(query ? { query } : {}) }),
    do: (ref, op, params) => resources.do({ ref, op, ...(params ? { params } : {}) }),
    onResourceEvent: (prefix, callback) =>
      /*
       * `onAny` 而不是 `on('resource:event')`:`EventHub.on` 的键收窄在
       * `TransportEvents` 那三条上,而 `resource:event` 是一条全局事件,不在那张表里。
       */
      client.events.onAny((frame) => {
        if (frame.name !== 'resource:event') return
        const fact = asResourceEvent(frame.data)
        if (!fact || !fact.ref.startsWith(prefix)) return
        callback(fact)
      }),
  }
}

/** 一个领域一格。`get()` 惰性建真实现;`configure()` 换掉它(传 undefined 恢复)。 */
export class ResourcePortSlot {
  private injected: ResourcePort | undefined
  private pending: Promise<ResourcePort> | undefined

  configure(next: ResourcePort | undefined): void {
    this.injected = next
  }

  get(): Promise<ResourcePort> {
    if (this.injected) return Promise.resolve(this.injected)
    this.pending ??= createResourcePort()
    return this.pending
  }
}
