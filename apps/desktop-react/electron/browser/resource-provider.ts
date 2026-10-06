/**
 * `browser:` 的实现(原子 K1 立;第④步批 2b 起是 Electron 主进程交给后端的**壳侧**命名空间)。
 *
 * ## 为什么它从 in-process 资源变成了壳侧 mount(决策 D4 (A),用户 10-06 拍定)
 *
 * 从前主进程**就是** core 进程(React 壳自己装配 backend),这只 provider 经
 * `backend.resources.mount(provider)` 进程内挂上,文件头那句反对 `home: 'shell'` 的理由是「这一档的寿命是
 * 一次连接,而内嵌浏览器与 app 同寿」。批 2b 起后端是 Electron 拉起的子进程,主进程对后端来说**正是**一扇
 * 连着的壳 —— 那条理由自己消失了。所以现在:自述(`resource-spec.ts`,每条做法 `home: 'shell'`)由
 * `../shell-resources.ts` 经 `resources.mountShell` 交给后端;后端那一侧照旧是同一条管线(授权、效果上界、
 * 审计、取消),命令经 SSE 的 `resource:shell-command` 发到这里,这只类跑完回执;事件经 `resources.emit`
 * 报回去,壳与 AI 看到的仍然是同一条 `resource:event` 路。**渲染层一行不改**(仍走 `resources` RPC)。
 *
 * ## 授权不在这里
 *
 * 「人零效果、模型顶格」与「`respondPermission` 只许人答」两条判据从前写在这只类的 `plan` 里;搬成壳侧
 * 命名空间之后它们落在 core(`ShellResourceProvider.plan` 读自述里的 `userOnly`,用户主体一律零效果)。
 * 这里只剩**参数校验**与**执行**:命令到了说明 core 已经放行,校验失败答一句说得出口的错。
 *
 * ## 页面正文经 `untrusted-text` 包一层(方案 §9-3)
 *
 * `page` 读的是**登着账号的页面**,注入面比匿名 fetch 更大。包法与 `web_open` 同一只函数
 * (`@shared/toolkit/untrusted-text`,第④步批 2b 从后端搬到 `@shared`,两个进程包的是同一对标记)。
 *
 * ## 零 electron import
 *
 * 它只认识一个窄端口 `BrowserOps`(service 实现它)与一只事件出口。于是这只文件在 vitest 里
 * 跑得起来:参数校验、`read page` 带定界、事件真的发 —— 全部量得到,一个 Electron 运行时都不用起。
 */

import { wrapUntrustedText } from '@shared/toolkit/untrusted-text'
import type { BrowserTabState, BrowserZoomDirection } from './tab-state.js'
import { BROWSER_RESOURCE_SCHEME, browserResourceSpec } from './resource-spec.js'

/** 一格 tab 在自述里的形(比 `BrowserTabState` 多一格 `active`)。 */
export interface BrowserTabView extends BrowserTabState {
  readonly active: boolean
}

/**
 * provider 看得见的 service 面 —— **不是整只 `BrowserService`**。
 *
 * 窄成这样,单测才注入得起一只替身;它也把「provider 会不会自己去建视图 / 摆位置」
 * 在类型上答死了:几何与显隐归 `NativeViewLayout`,这里只读表、打电话。
 */
export interface BrowserOps {
  list(): BrowserTabView[]
  activeId(): string | null
  open(init: { url?: string; background?: boolean; profile?: string }): BrowserTabView
  navigate(tabId: string, url: string): void
  back(tabId: string): void
  forward(tabId: string): void
  reload(tabId: string): void
  activate(tabId: string): void
  close(tabId: string): void
  /** 放大 / 缩小 / 回到实际大小(K3)。梯子那把尺子在 `tab-state.nextZoomLevel`。 */
  zoom(tabId: string, level: BrowserZoomDirection): void
  /** 这一格在不在。不在 = 一个说得出口的拒绝,不是一次崩溃。 */
  has(tabId: string): boolean
  readText(tabId: string, maxChars?: number): Promise<string>
  capture(tabId: string): Promise<string | undefined>
  get(tabId: string): BrowserTabView | undefined
  /**
   * 答一次网页权限询问(B3-a)。答**没有**这一问 = `false`,而那不是一次错误:
   * 它的常态是「这一问已经超时结了,而屏幕上那张卡还在人手上」——两边差一拍,
   * 不是谁坏了。调用方据它说一句说得出口的话。
   */
  respondPermission(requestId: string, allow: boolean): boolean
}

export class BrowserTabUnknownError extends Error {
  constructor(tabId: string) {
    super(`${BROWSER_RESOURCE_SCHEME}:${tabId} is not an open tab`)
    this.name = 'BrowserTabUnknownError'
  }
}

export class BrowserRefRequiredError extends Error {
  constructor(member: string) {
    super(`${member} acts on one tab — address it as ${BROWSER_RESOURCE_SCHEME}:<tabId>`)
    this.name = 'BrowserRefRequiredError'
  }
}

export class BrowserUrlRequiredError extends Error {
  constructor() {
    super('url is required, and must be an http(s) address')
    this.name = 'BrowserUrlRequiredError'
  }
}

export class BrowserPermissionRequestUnknownError extends Error {
  constructor(requestId: string) {
    super(`No permission question is waiting under id ${requestId} — it was answered, timed out, or its tab closed`)
    this.name = 'BrowserPermissionRequestUnknownError'
  }
}

export class BrowserPermissionParamsError extends Error {
  constructor() {
    super('respondPermission needs a requestId (string) and allow (boolean)')
    this.name = 'BrowserPermissionParamsError'
  }
}

/**
 * 缩放那一格收的是三个词之一(K3)。**认不出就拒**,不回落成 `reset` ——
 * 一次写错了参数的调用悄悄把页面缩回 100%,看起来会像是「它就是这么设计的」。
 */
export class BrowserZoomLevelError extends Error {
  constructor(got: string) {
    super(`zoom takes level: 'in' | 'out' | 'reset' — got ${JSON.stringify(got)}`)
    this.name = 'BrowserZoomLevelError'
  }
}

const ZOOM_DIRECTIONS: ReadonlySet<string> = new Set(['in', 'out', 'reset'])

export type BrowserOpPayload =
  | { readonly op: 'open'; readonly url?: string; readonly background: boolean; readonly profile?: string }
  | { readonly op: 'navigate'; readonly tabId: string; readonly url: string }
  | { readonly op: 'back' | 'forward' | 'reload' | 'activate' | 'close'; readonly tabId: string }
  | { readonly op: 'zoom'; readonly tabId: string; readonly level: BrowserZoomDirection }
  | { readonly op: 'respondPermission'; readonly tabId: string; readonly requestId: string; readonly allow: boolean }

/** 命名空间级的两条(没有实例地址);其余都要一格 tab。 */
const NAMESPACE_MEMBERS: ReadonlySet<string> = new Set(['tabs', 'open'])

function stringParam(params: unknown, key: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

function numberParam(params: unknown, key: string): number | undefined {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 事件出口:`../shell-resources.ts` 把它接到 `resources.emit`。`path` = tab id(命名空间级的事实是空串)。 */
export type BrowserEventSink = (path: string, event: string, payload: unknown) => void

export class BrowserResourceProvider {
  readonly spec = browserResourceSpec

  private readonly ops: BrowserOps
  private sink: BrowserEventSink | undefined

  constructor(ops: BrowserOps) {
    this.ops = ops
  }

  /** 接上事件出口(登记上了之后)。 */
  attach(sink: BrowserEventSink): void {
    this.sink = sink
  }

  /** 摘掉事件出口。幂等;之后的事实一条都不发。 */
  dispose(): void {
    this.sink = undefined
  }

  // ── 事件(由 service 的 observer 转手过来;发的是**事实**)────────────────

  emitOpened(tab: BrowserTabView): void {
    this.emit(tab.id, 'opened', { id: tab.id, url: tab.url })
  }

  /**
   * 一个网页自己开了一格 tab(2026-09-12)。载荷逐格对着自述里那一条。
   *
   * `background` 由 `active` **推**出来,不另存一格:一格前台开出来的 tab 在
   * `service.open` 那一刻就成了活动 tab(那正是「前台」的定义),所以这两个词
   * 说的是同一件事,而多存一格就是多一个会对不上的产地。
   */
  emitSpawned(tab: BrowserTabView, openerId: string): void {
    this.emit(tab.id, 'spawned', {
      id: tab.id,
      url: tab.url,
      openerId,
      background: !tab.active,
    })
  }

  /**
   * 拦了一发(配额见 `service.ts` 的 `SPAWN_BURST`)。**发在 opener 的地址上** ——
   * 被拦的那一格根本不存在,没有自己的地址可言。
   */
  emitSpawnBlocked(openerId: string, url: string): void {
    this.emit(openerId, 'spawnBlocked', { openerId, url })
  }

  emitClosed(tabId: string): void {
    this.emit(tabId, 'closed', { id: tabId })
  }

  emitNavigated(tab: BrowserTabView): void {
    this.emit(tab.id, 'navigated', { ...tab })
  }

  emitLoading(tab: BrowserTabView): void {
    this.emit(tab.id, 'loading', { id: tab.id, loading: tab.loading })
  }

  /** 一个网页在要一格能力(B3-a)。载荷逐格对着自述里那一条。 */
  emitPermissionRequested(event: {
    tabId: string
    requestId: string
    permission: string
    origin: string
  }): void {
    this.emit(event.tabId, 'permissionRequested', { ...event })
  }

  /** 那一问结了(答了 / 超时 / 这一格没了)。判词在自述那一条上。 */
  emitPermissionResolved(event: {
    tabId: string
    requestId: string
    allow: boolean
    reason: 'answered' | 'timeout' | 'gone'
  }): void {
    this.emit(event.tabId, 'permissionResolved', { ...event })
  }

  /** 一次下载的三态。 */
  emitDownload(event: {
    tabId: string
    filename: string
    state: 'started' | 'done' | 'failed'
    path: string
  }): void {
    this.emit(event.tabId, 'download', { ...event })
  }

  // ── 读 ───────────────────────────────────────────────────────────────────

  /** 一条读法。`path` = tab id(`tabs` 是命名空间级的,`path` 为空串)。 */
  async read(name: string, path: string, query: unknown): Promise<unknown> {
    if (name === 'tabs') {
      const activeId = this.ops.activeId()
      return activeId === null ? { tabs: this.ops.list() } : { tabs: this.ops.list(), activeId }
    }

    const tabId = this.tabIdOf(name, path)
    const tab = this.ops.get(tabId)
    if (!tab) throw new BrowserTabUnknownError(tabId)

    if (name === 'page') {
      const maxChars = numberParam(query, 'maxChars')
      const text = await this.ops.readText(tabId, maxChars)
      return {
        title: tab.title,
        url: tab.url,
        /*
         * **包起来交,而不是裸交**(§9-3)。`source` 带上真实地址 —— 「外部」
         * 具体外到哪儿,模型和读审计的人都该看得见。
         *
         * 截断在两处各做一次不是重复:`readText` 那一刀是**不把 50MB 拽进主进程**
         * (量的是取回来的字数),这里那一刀是包法自己的上限。两把尺子同一个数时
         * 第二刀恒不触发,而它存在是为了「谁改了其中一处」的那一天。
         */
        text: wrapUntrustedText(text, { source: tab.url || tab.title || `browser:${tabId}`, ...(maxChars !== undefined ? { maxChars } : {}) }),
      }
    }

    if (name === 'screenshot') {
      const dataUrl = await this.ops.capture(tabId)
      // 拍不到就是没有那一格,不编一张白图。
      return dataUrl ? { dataUrl } : {}
    }

    throw new TypeError(`Browser resource has no read named ${JSON.stringify(name)}`)
  }

  // ── 做 ───────────────────────────────────────────────────────────────────

  /**
   * 一条做法(core 已经放行之后)。先校验参数(写错了的调用答一句说得出口的错,不是一次崩溃),
   * 再打电话;答一句给模型 / 审计看的结果文本。
   */
  async run(op: string, path: string, params: unknown): Promise<string> {
    const payload = this.payloadOf(op, path, params)
    switch (payload.op) {
      case 'open': {
        const tab = this.ops.open({
          ...(payload.url !== undefined ? { url: payload.url } : {}),
          background: payload.background,
          ...(payload.profile !== undefined ? { profile: payload.profile } : {}),
        })
        return `browser:${tab.id}${tab.url ? ` → ${tab.url}` : ' (start page)'} [${tab.profile}]`
      }
      case 'navigate':
        this.ops.navigate(payload.tabId, payload.url)
        return `browser:${payload.tabId} → ${payload.url}`
      case 'back':
        this.ops.back(payload.tabId)
        return `browser:${payload.tabId} back`
      case 'forward':
        this.ops.forward(payload.tabId)
        return `browser:${payload.tabId} forward`
      case 'reload':
        this.ops.reload(payload.tabId)
        return `browser:${payload.tabId} reload`
      case 'activate':
        this.ops.activate(payload.tabId)
        return `browser:${payload.tabId} is now in front`
      case 'close':
        this.ops.close(payload.tabId)
        return `browser:${payload.tabId} closed`
      case 'zoom':
        this.ops.zoom(payload.tabId, payload.level)
        return `browser:${payload.tabId} zoom ${payload.level}`
      case 'respondPermission': {
        // 答不上的那一问**抛**,不静默 —— 见 `BrowserOps.respondPermission` 的判词。
        if (!this.ops.respondPermission(payload.requestId, payload.allow)) {
          throw new BrowserPermissionRequestUnknownError(payload.requestId)
        }
        return `browser:${payload.tabId} ${payload.allow ? 'allowed' : 'refused'} ${payload.requestId}`
      }
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private payloadOf(op: string, path: string, params: unknown): BrowserOpPayload {
    if (op === 'open') {
      const url = stringParam(params, 'url')
      const background = (params as { background?: unknown } | undefined)?.background === true
      /*
       * 身份**缺席就是缺席**(B3-b),不在这里回落成 `default`:回落的那一格
       * 事实住在 service(它现问设置里的缺省身份)。在这里替它拍板 = 同一句话
       * 两个产地,而其中一个还赶不上用户刚刚改过的设置。
       */
      const profile = stringParam(params, 'profile')
      return {
        op,
        ...(url ? { url } : {}),
        background,
        ...(profile ? { profile } : {}),
      }
    }
    const tabId = this.tabIdOf(op, path)
    if (!this.ops.has(tabId)) throw new BrowserTabUnknownError(tabId)
    if (op === 'navigate') {
      const url = stringParam(params, 'url')
      if (!url) throw new BrowserUrlRequiredError()
      return { op, tabId, url }
    }
    if (op === 'back' || op === 'forward' || op === 'reload' || op === 'activate' || op === 'close') {
      return { op, tabId }
    }
    if (op === 'zoom') {
      const level = stringParam(params, 'level')
      if (!ZOOM_DIRECTIONS.has(level)) throw new BrowserZoomLevelError(level)
      return { op, tabId, level: level as BrowserZoomDirection }
    }
    if (op === 'respondPermission') {
      const requestId = stringParam(params, 'requestId')
      const allow = (params as { allow?: unknown } | undefined)?.allow
      // 两格都必填,而 `allow` 必须是**真布尔** —— 收一个 undefined 当「拒」会让
      // 一次少写了参数的调用看起来像一次有意的拒绝。
      if (!requestId || typeof allow !== 'boolean') throw new BrowserPermissionParamsError()
      return { op, tabId, requestId, allow }
    }
    throw new TypeError(`Browser resource has no op named ${JSON.stringify(op)}`)
  }

  private tabIdOf(member: string, path: string): string {
    if (NAMESPACE_MEMBERS.has(member)) return ''
    if (!path) throw new BrowserRefRequiredError(member)
    return path
  }

  private emit(tabId: string, event: string, payload: unknown): void {
    this.sink?.(tabId, event, payload)
  }
}
