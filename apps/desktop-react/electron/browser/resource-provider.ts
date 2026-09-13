/**
 * `browser:` 的实现(原子 K1 的 `ResourceProvider`)。
 *
 * ## 为什么它是 in-process 资源,而不是壳侧 mount(方案 §2.2-3)
 *
 * 主进程**就是** core 进程(React 壳自己装配 backend)。所以:
 *
 *   · `home: 'shell'` 是错的 —— 那一档的寿命是「一次连接」,而内嵌浏览器与 app
 *     同寿(关掉那扇窗浏览器才死,刷新渲染页它一格 tab 都不会掉);
 *   · 经 SSE 绕自己一圈也是错的 —— provider 与内核在同一个进程里,中间那一圈
 *     只会加一次序列化和一次时序。
 *
 * 所以 `main.ts` 装配完之后经 `backend.resources.mount(provider)` 挂上(与
 * `mcp-mount.ts` 同族),`own()` 摘。挂上那一刻起,AI 自动得到一只 `browser` 工具、
 * `resources.read` / `resources.do` 两条 RPC、事件走 `resource:event` → SSE
 * ——**壳与 AI 走的是同一条路**,壳里不存第二份真相(音乐面板判例)。
 *
 * ## 效果按主体分档
 *
 * `plan` 里:`ctx.principal.kind === 'user'` → `effects: []`;其余(agent / system,
 * 含经它们进来的插件)→ 自述里那条上界。理由与 `music-provider.ts` 的
 * `capabilityPlan` 逐字相同 —— 地址栏上那颗「前进」是人自己按的,再弹一张卡问
 * 「准不准你按你刚按的那颗钮」是噪音不是保护(08-18 判例);而模型让一个**登着
 * 账号**的浏览器去一个地址,是带 cookie 以用户身份发请求,那一下值一次同意。
 *
 * 分档在这里而不在权限核:`decidePermission` 至今不读主体,让它开始读主体是凭证级
 * 主体那一片地(09-03 用户搁置)。
 *
 * ## 页面正文经 `untrusted-text` 包一层(方案 §9-3)
 *
 * `page` 读的是**登着账号的页面**,注入面比匿名 fetch 更大。包法与 `web_open`
 * 同一只函数(`@onething/runtime/toolkit/untrusted-text`)—— 模型要认的标记只许有
 * 一种。
 *
 * ## 零 electron import
 *
 * 它只认识一个窄端口 `BrowserOps`(service 实现它)。于是这只文件在 vitest 里
 * 跑得起来:`spec` 过契约校验、`plan` 按主体分档、`read page` 带定界、事件真的发
 * ——全部量得到,一个 Electron 运行时都不用起。
 */

import type {
  ResourceEventHub,
  ResourceProvider,
  ResourceReadContext,
  ResourceRef,
} from '@onething/core/resource'
import { planFromSpec } from '@onething/core/resource'
import type { PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { Intent } from '@onething/core/toolkit'
import { wrapUntrustedText } from '@onething/runtime/toolkit/untrusted-text'
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

/**
 * **模型 / 插件不许替网页放权限**(B3-a)。
 *
 * 判词整段在 `resource-spec.ts` 的 `respondPermission` 上;一句话:这一问是给
 * 坐在机器前面那个人的,而把它交给一个能被网页正文说服的东西,正是 `page` 读法
 * 反复提醒「那是数据不是指令」所要防的那件事。
 *
 * 它在 **plan** 期抛,不在 apply 期:一次注定不许跑的做法不该先去弹一张权限卡
 * 问人(与 `dir-provider` 对缺席宿主口的那一句同序)。
 */
export class BrowserPermissionNotUserError extends Error {
  constructor(kind: string) {
    super(
      'respondPermission is answered by the person at this machine only — '
      + `this call is on behalf of ${kind}. A page's permission question is not something a model may answer.`,
    )
    this.name = 'BrowserPermissionNotUserError'
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

export class BrowserResourceProvider implements ResourceProvider<BrowserOpPayload> {
  readonly spec = browserResourceSpec

  private readonly ops: BrowserOps
  private hub: ResourceEventHub | undefined

  constructor(ops: BrowserOps) {
    this.ops = ops
  }

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  /** 登记方在 unmount **之后**调。幂等。 */
  dispose(): void {
    this.hub = undefined
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

  async read(name: string, ref: ResourceRef | null, query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    if (name === 'tabs') {
      const activeId = this.ops.activeId()
      return activeId === null ? { tabs: this.ops.list() } : { tabs: this.ops.list(), activeId }
    }

    const tabId = this.tabIdOf(name, ref)
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

    // 走不到:两条读路都先查过读法名在不在自述里。留一句诚实的错。
    throw new TypeError(`Browser resource has no read named ${JSON.stringify(name)}`)
  }

  // ── 做 ───────────────────────────────────────────────────────────────────

  async plan(op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext): Promise<Intent<BrowserOpPayload>> {
    /*
     * **主体闸在最前面**(B3-a)。它排在 `payloadOf` 之前是有意的:一次不许跑的
     * 做法,连「参数写对了没有」都不该去替它检查 —— 那会让一句「你的 requestId
     * 少了一格」看起来像是「参数补齐就能调」。
     */
    if (op === 'respondPermission' && ctx.principal.kind !== 'user') {
      throw new BrowserPermissionNotUserError(ctx.principal.kind)
    }
    const payload = this.payloadOf(op, ref, params)
    return this.planned(op, ref, payload, this.previewOf(payload), ctx)
  }

  async apply(_op: string, intent: Intent<BrowserOpPayload>, ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    switch (payload.op) {
      case 'open': {
        const tab = this.ops.open({
          ...(payload.url !== undefined ? { url: payload.url } : {}),
          background: payload.background,
          ...(payload.profile !== undefined ? { profile: payload.profile } : {}),
        })
        return this.done(ctx, 'Tab opened', `browser:${tab.id}${tab.url ? ` → ${tab.url}` : ' (start page)'} [${tab.profile}]`, payload.op, { tab })
      }
      case 'navigate':
        this.ops.navigate(payload.tabId, payload.url)
        return this.done(ctx, 'Navigating', `browser:${payload.tabId} → ${payload.url}`, payload.op)
      case 'back':
        this.ops.back(payload.tabId)
        return this.done(ctx, 'Went back', `browser:${payload.tabId} back`, payload.op)
      case 'forward':
        this.ops.forward(payload.tabId)
        return this.done(ctx, 'Went forward', `browser:${payload.tabId} forward`, payload.op)
      case 'reload':
        this.ops.reload(payload.tabId)
        return this.done(ctx, 'Reloading', `browser:${payload.tabId} reload`, payload.op)
      case 'activate':
        this.ops.activate(payload.tabId)
        return this.done(ctx, 'Tab activated', `browser:${payload.tabId} is now in front`, payload.op)
      case 'close':
        this.ops.close(payload.tabId)
        return this.done(ctx, 'Tab closed', `browser:${payload.tabId} closed`, payload.op)
      case 'zoom':
        this.ops.zoom(payload.tabId, payload.level)
        return this.done(ctx, 'Zoom changed', `browser:${payload.tabId} zoom ${payload.level}`, payload.op)
      case 'respondPermission': {
        // 答不上的那一问**抛**,不静默 —— 见 `BrowserOps.respondPermission` 的判词。
        if (!this.ops.respondPermission(payload.requestId, payload.allow)) {
          throw new BrowserPermissionRequestUnknownError(payload.requestId)
        }
        return this.done(
          ctx,
          payload.allow ? 'Allowed once' : 'Refused',
          `browser:${payload.tabId} ${payload.allow ? 'allowed' : 'refused'} ${payload.requestId}`,
          payload.op,
        )
      }
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private payloadOf(op: string, ref: ResourceRef | null, params: unknown): BrowserOpPayload {
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
    const tabId = this.tabIdOf(op, ref)
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

  /**
   * 效果按主体分档(见文件头)。
   *
   * 人 = 零效果的 `Intent`。**零效果不等于不留痕迹**:照样落 `tool/audit`、照样发
   * 事件、照样在轨迹里看得见。
   */
  private planned(
    op: string,
    ref: ResourceRef | null,
    payload: BrowserOpPayload,
    title: string,
    ctx: PlanContext,
  ): Intent<BrowserOpPayload> {
    if (ctx.principal.kind === 'user') return Intent.of({ effects: [], payload, preview: { title } })
    return planFromSpec<BrowserOpPayload>(this.spec, op, ref, payload, { title })
  }

  /** 权限卡上那一句人话。地址栏上的 URL 本来就是给人看的,原样带出来。 */
  private previewOf(payload: BrowserOpPayload): string {
    switch (payload.op) {
      case 'open': {
        // 身份出现在人话里 —— 「以哪个身份开」正是这一下值得让人看见的那一格。
        const as = payload.profile ? ` as ${payload.profile}` : ''
        return payload.url ? `Open a browser tab at ${payload.url}${as}` : `Open an empty browser tab${as}`
      }
      case 'navigate': return `Send the browser to ${payload.url}`
      case 'back': return 'Go back in the browser'
      case 'forward': return 'Go forward in the browser'
      case 'reload': return 'Reload the browser tab'
      case 'activate': return 'Bring this browser tab to the front'
      case 'close': return 'Close this browser tab'
      case 'zoom':
        if (payload.level === 'in') return 'Zoom this page in one notch'
        if (payload.level === 'out') return 'Zoom this page out one notch'
        return 'Reset this page to its actual size'
      case 'respondPermission':
        return payload.allow
          ? 'Allow what the page asked for, once'
          : 'Refuse what the page asked for'
    }
  }

  private tabIdOf(member: string, ref: ResourceRef | null): string {
    if (NAMESPACE_MEMBERS.has(member)) return ''
    if (!ref || !ref.path) throw new BrowserRefRequiredError(member)
    return ref.path
  }

  private emit(tabId: string, event: string, payload: unknown): void {
    this.hub?.emit({ scheme: this.spec.scheme, path: tabId }, event, payload)
  }

  private done(
    ctx: RunContext,
    title: string,
    output: string,
    op: string,
    extra: Record<string, unknown> = {},
  ): Result {
    ctx.emit({ type: 'annotate', title, details: { op } })
    return { content: [{ type: 'text', text: output }], details: { op, ...extra } as never }
  }
}
