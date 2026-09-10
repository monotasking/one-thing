import { resourcesRouter } from '@shared/ipc/resources'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

/**
 * 音乐面取数与 core 之间的那一层**端口**(音乐收尾 · 壳半边,正本
 * `docs/design/atom-2026-09.md` §4「RPC 域」/ §6;后端那一半是 444f915f)。
 *
 * ── 三口,而且**一个音乐的字都没有** ────────────────────────────────────
 * 这只端口的形状是 `resources` 那个域的形状,不是 `music` 域的形状:
 * `read(ref, name, query)` / `do(ref, op, params)` / `onResourceEvent(prefix, cb)`。
 * 地址、读法名、做法名全部由调用方给 —— 换句话说**它不认识 `music:radio`**,
 * 也不认识 `pause`。判据与 `@shared/ipc/resources.ts` 头注释那句「一个域,零个
 * scheme 名」逐字相同:面板要的那十几件事是**数据**(住在 `music-source.ts` 的
 * 那张表里),不是这一层的分支。
 *
 * 反面写法是照 `music` 域开一只十四条方法的端口。那正是 444f915f 那一笔刚刚
 * 拆掉的东西:界面点按钮与模型调工具走两条不同的路,于是「电台开着时 next 走
 * skipToNextRadioSong」这类只有后端知道的分档,在界面那条路上会被静默丢掉。
 *
 * ── `onResourceEvent` 为什么收一个 `prefix` ─────────────────────────────
 * `resource:event` 是**一条广播**:会话改名、目录变化、MCP 工具表换了,全都骑在
 * 同一个事件名上。订阅方要的从来是「我那个命名空间的事」,所以过滤写在这一层
 * (一次字符串前缀比较),而不是让每个消费者各写一遍 `ref.startsWith(...)`。
 * 它**不认识 `music:`** —— 那三个字符由调用方给。
 *
 * ── 签名口径:位置参数进来,信封出去 ────────────────────────────────────
 * 与 `files-port.ts` 逐字同一条:router 一律收对象,端口这一层用位置参数
 * (端口是给判据层用的窄面,不是给网线用的信封),真实现负责那一次包装。
 *
 * ── 结局原样交出去,**不在这里翻译** ────────────────────────────────────
 * `read` 交的是 `ResourceReadView`(四支)、`do` 交的是 `ResourceOutcomeView`
 * (五支),一支都不折。「被拒绝不是错误」那条纪律(契约头注释)只有在结局
 * 完整地过了这一层之后才成立:在这里把 `denied` 抛成异常,面板就再也分不出
 * 「人说了不」与「真炸了」。折成什么形状是 `music-source.ts` 的事,而它折的
 * 理由(mutation 要靠一次 throw 才会回滚乐观补丁)写在那只文件里。
 */

/** 一条到了的资源事实。`event` 是自述 `events` 里的名字。 */
export interface MusicResourceEvent {
  /** `<scheme>:<path>`,出事的那个资源。 */
  ref: string
  /** 自述 `events` 里的名字(`nowPlayingChanged` / `radioOpened` / …)。 */
  event: string
  payload: unknown
}

export interface MusicPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  read(
    ref: string,
    name: string,
    query?: Record<string, unknown>,
  ): Promise<ResourceReadView>
  do(
    ref: string,
    op: string,
    params?: Record<string, unknown>,
  ): Promise<ResourceOutcomeView>
  /** 订这个前缀底下的资源事实。返回退订。 */
  onResourceEvent(prefix: string, callback: (event: MusicResourceEvent) => void): () => void
}

let port: MusicPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureMusicPort(next: MusicPort | undefined): void {
  port = next
}

/** 事件载荷 → 这一条认不认。名字与形都对得上才算数(SSE 是广播)。 */
function asResourceEvent(data: unknown): MusicResourceEvent | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.ref !== 'string' || typeof row.event !== 'string') return null
  return { ref: row.ref, event: row.event, payload: row.payload }
}

/**
 * 真实现是**惰性**建的,理由与 `files-port` / `sessions-port` 逐字相同:它要的是
 * 那个连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<MusicPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const resources = client.api(resourcesRouter)
  return {
    ready: () => whenConnected(),
    read: (ref, name, query) =>
      resources.read({ ref, name, ...(query ? { query } : {}) }),
    do: (ref, op, params) => resources.do({ ref, op, ...(params ? { params } : {}) }),
    onResourceEvent: (prefix, callback) =>
      /*
       * **`onAny` 而不是 `on('resource:event')`** —— 与 `resources/shell-host.ts`
       * 那一处逐字同一个理由:`EventHub.on` 的键收窄在 `TransportEvents` 那三条上
       * (`@onething/client`),而 `resource:event` 是一条**全局事件**,不在那张表
       * 里。给那张表加一行要改 `packages/client`,那是那个包自己的一次改动。
       * `onAny` 正是为这一档留的口(「含表里没登记的名字」是它自己的判词)。
       */
      client.events.onAny((frame) => {
        if (frame.name !== 'resource:event') return
        const fact = asResourceEvent(frame.data)
        if (!fact || !fact.ref.startsWith(prefix)) return
        callback(fact)
      }),
  }
}

let pending: Promise<MusicPort> | undefined

export function musicPort(): Promise<MusicPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
