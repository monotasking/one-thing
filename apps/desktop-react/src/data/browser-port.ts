import { resourcesRouter } from '@shared/ipc/resources'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'
import type {
  NativeViewBounds,
  NativeViewBridge,
  NativeViewPush,
  NativeViewRequest,
} from '../../electron/native-view-protocol'

/**
 * 内嵌浏览器与主进程之间的那一层**端口**(B2,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.2-4;照
 * `data/music-port.ts` 的形)。
 *
 * ── 它有**两口井**,而那不是设计上的犹豫 ────────────────────────────────
 * 一个内嵌浏览器在壳这边要走两条完全不同的路,而它们的分界与「数据面 / 窗口
 * 系统」那条线逐字重合(`electron/browser/native-view-ipc.ts` 的文件头):
 *
 *  · **数据面**(三口 `read / do / onResourceEvent`)—— 开一格、去一个地址、
 *    读正文、列 tab。走 `POST /api/rpc` 的 `resources` 域,**与 AI 同一条路**
 *    (音乐先例:真源不在壳里,壳与模型不该各走各的)。所以这三口的形状是
 *    `resources` 那个域的形状,**一个浏览器的字都没有**:地址、读法名、做法名
 *    全部由调用方给,表住在 `browser-source.ts`。
 *  · **窗口系统**(`nativeView.send / on`)—— 「这片叶此刻的矩形、显隐、堆叠序
 *    是多少」。它不是数据:一帧几何没有结局、没有权限、不该落审计,而且每帧
 *    都在发。它走 preload 挂出来的那一条 IPC(`host:native-view`),词汇表在
 *    `electron/native-view-protocol.ts` —— 主进程 / preload / 渲染层三边共用
 *    一份,不各写一遍字面量。
 *
 * 把后者塞进 RPC 会让每一帧背上一次 Promise 往返;把前者塞进 IPC 会让 AI 与
 * 用户走两条路(那正是 444f915f 刚刚拆掉的病)。所以是两口,不是一口。
 *
 * ── `nativeView` 可以是 `undefined`,而那是**一个状态不是一次失败** ───────
 * `--mode web` 没有主进程,preload 不存在,这一格就是 `undefined`。消费方据它
 * 画「此宿主没有内嵌浏览器;页开在桌面里」那一档(方案 §9-12:网页壳连着桌面
 * core 时 `describe` 照样列得出 `browser`,AI 说「开个页」会开在桌面那扇窗里
 * —— 那是「一个 core」的形,不是 bug)。
 *
 * ── 签名口径与结局口径 ──────────────────────────────────────────────────
 * 与 `music-port.ts` 逐字相同:位置参数进来、信封出去;`read` 交四支、`do` 交
 * 五支,**一支都不在这一层折**(在这里把 `denied` 抛成异常,面板就再也分不出
 * 「人说了不」与「真炸了」)。折成什么形状是 `browser-source.ts` 的事。
 */

/** 一条到了的资源事实。`event` 是自述 `events` 里的名字。 */
export interface BrowserResourceEvent {
  /** `<scheme>:<path>`,出事的那个资源。 */
  ref: string
  /** `opened` / `closed` / `navigated` / `loading`。 */
  event: string
  payload: unknown
}

export interface BrowserPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  read(ref: string, name: string, query?: Record<string, unknown>): Promise<ResourceReadView>
  do(ref: string, op: string, params?: Record<string, unknown>): Promise<ResourceOutcomeView>
  /** 订这个前缀底下的资源事实。返回退订。 */
  onResourceEvent(prefix: string, callback: (event: BrowserResourceEvent) => void): () => void
  /**
   * 原生视图那条管道。**这台宿主没有内嵌浏览器时是 `undefined`** —— 见文件头。
   */
  nativeView: NativeViewBridge | undefined
}

let port: BrowserPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureBrowserPort(next: BrowserPort | undefined): void {
  port = next
  if (next === undefined) pending = undefined
}

/** 事件载荷 → 这一条认不认。名字与形都对得上才算数(SSE 是广播)。 */
function asResourceEvent(data: unknown): BrowserResourceEvent | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.ref !== 'string' || typeof row.event !== 'string') return null
  return { ref: row.ref, event: row.event, payload: row.payload }
}

/** preload 挂出来的那一格。取不到 = 这台宿主没有原生视图(诚实降级,不兜底猜)。 */
function hostNativeView(): NativeViewBridge | undefined {
  const host = (globalThis as unknown as { window?: { onethingHost?: { nativeView?: NativeViewBridge } } })
    .window?.onethingHost
  return host?.nativeView
}

/**
 * 真实现是**惰性**建的,理由与 `music-port` / `files-port` 逐字相同:它要的是
 * 那个连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<BrowserPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const resources = client.api(resourcesRouter)
  return {
    ready: () => whenConnected(),
    read: (ref, name, query) => resources.read({ ref, name, ...(query ? { query } : {}) }),
    do: (ref, op, params) => resources.do({ ref, op, ...(params ? { params } : {}) }),
    onResourceEvent: (prefix, callback) =>
      /*
       * **`onAny` 而不是 `on('resource:event')`** —— 与 `music-port.ts` 那一处
       * 逐字同一个理由:`EventHub.on` 的键收窄在 `TransportEvents` 那三条上,
       * 而 `resource:event` 是一条**全局事件**,不在那张表里。
       */
      client.events.onAny((frame) => {
        if (frame.name !== 'resource:event') return
        const fact = asResourceEvent(frame.data)
        if (!fact || !fact.ref.startsWith(prefix)) return
        callback(fact)
      }),
    nativeView: hostNativeView(),
  }
}

let pending: Promise<BrowserPort> | undefined

export function browserPort(): Promise<BrowserPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

/**
 * **同步**问一句「这台宿主有没有原生视图」。
 *
 * 占位格与叶要在第一次渲染就答得出「画视图还是画那句降级文案」——
 * 等一个 Promise 会让 web 壳先闪一格空白的浏览器框。这一口不碰传输面,
 * 所以同步是对的;被换掉的端口优先(测试要模拟两档)。
 */
export function nativeViewBridge(): NativeViewBridge | undefined {
  return port ? port.nativeView : hostNativeView()
}

export type { NativeViewBounds, NativeViewBridge, NativeViewPush, NativeViewRequest }
