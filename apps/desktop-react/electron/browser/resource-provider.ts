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
import type { BrowserTabState } from './tab-state.js'
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
  open(init: { url?: string; background?: boolean }): BrowserTabView
  navigate(tabId: string, url: string): void
  back(tabId: string): void
  forward(tabId: string): void
  reload(tabId: string): void
  activate(tabId: string): void
  close(tabId: string): void
  /** 这一格在不在。不在 = 一个说得出口的拒绝,不是一次崩溃。 */
  has(tabId: string): boolean
  readText(tabId: string, maxChars?: number): Promise<string>
  capture(tabId: string): Promise<string | undefined>
  get(tabId: string): BrowserTabView | undefined
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

export type BrowserOpPayload =
  | { readonly op: 'open'; readonly url?: string; readonly background: boolean }
  | { readonly op: 'navigate'; readonly tabId: string; readonly url: string }
  | { readonly op: 'back' | 'forward' | 'reload' | 'activate' | 'close'; readonly tabId: string }

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

  emitClosed(tabId: string): void {
    this.emit(tabId, 'closed', { id: tabId })
  }

  emitNavigated(tab: BrowserTabView): void {
    this.emit(tab.id, 'navigated', { ...tab })
  }

  emitLoading(tab: BrowserTabView): void {
    this.emit(tab.id, 'loading', { id: tab.id, loading: tab.loading })
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
        })
        return this.done(ctx, 'Tab opened', `browser:${tab.id}${tab.url ? ` → ${tab.url}` : ' (start page)'}`, payload.op, { tab })
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
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private payloadOf(op: string, ref: ResourceRef | null, params: unknown): BrowserOpPayload {
    if (op === 'open') {
      const url = stringParam(params, 'url')
      const background = (params as { background?: unknown } | undefined)?.background === true
      return url ? { op, url, background } : { op, background }
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
      case 'open': return payload.url ? `Open a browser tab at ${payload.url}` : 'Open an empty browser tab'
      case 'navigate': return `Send the browser to ${payload.url}`
      case 'back': return 'Go back in the browser'
      case 'forward': return 'Go forward in the browser'
      case 'reload': return 'Reload the browser tab'
      case 'activate': return 'Bring this browser tab to the front'
      case 'close': return 'Close this browser tab'
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
