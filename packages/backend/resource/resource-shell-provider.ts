/**
 * K2b-2 —— 一扇壳交上来的那一种资源(`docs/design/atom-2026-09.md` §5 /
 * §10.2「**home 在 shell 的**寿命 = 那扇壳的连接」)。
 *
 * ## 它是一个 provider,不是一种新机制
 *
 * `SessionResourceProvider` 把 `session:` 这个命名空间接到会话命令面上;这一只把
 * **任意一个**命名空间接到一扇壳上。内核这一侧一个字都不知道有「壳资源」这回事:
 * 它看到的仍然是 `ResourceProvider`,仍然走 `ResourceTool` → `ToolRunner` 那一条
 * 管线,授权、效果上界、审计、取消四样与会话那一种逐字同源(§2 不变量 2)。
 *
 * 差别只在**执行落在哪儿**:每一条做法的 `home` 都是 `'shell'`,于是 `ResourceTool`
 * 在 `apply` 那一步把它交给 `ShellDispatch`(`resource-shell-dispatch.ts`),而这只类的
 * `apply` 永远走不到 —— 那不是一句约定,是 `ResourceTool` 的分支写死的。
 *
 * ## `home` 不是壳说了算
 *
 * 反序列化时**不读**壳交上来的 `home`,直接盖 `'shell'`。理由是结构性的:这份
 * 自述的实现整个住在壳里,core 这边没有第二份实现能跑一条 `home: 'core'` 的做法。
 * 让壳声明 `'core'` 只有两种下场 —— 要么被悄悄改写(那 `describe` 就在说谎),要么
 * 登记失败(而 `mountShell` 的契约里只有 `scheme-taken` 一种拒绝理由)。所以它
 * 干脆不是壳能贡献的一格。
 *
 * ## 读也往返一次
 *
 * `ReadSpec` 里的每一条同样只有那扇壳答得出来,所以 `read` 走同一条命令通道
 * (载荷上那一格 `kind: 'read'`)。**读仍然无效果**:`ResourceTool` 的读那一支恒造
 * `Intent.none`,这里一个字都改不了它。
 */

import {
  planFromSpec,
  type ResourceEventHub,
  type ResourceProvider,
  type ResourceReadContext,
  type ResourceSpec,
} from '@onething/backend/resource/resource-api'
import { type ResourceRef } from '@shared/resource/ref'
import { Intent, type PlanContext, type Result, type RunContext } from '@onething/backend/toolkit'
import type { EffectClass } from '@shared/toolkit/effects'
import type {
  SerializedEventSpec,
  SerializedReadSpec,
  SerializedResourceSpec,
} from '@shared/ipc/resources.js'
import type { ShellCommandDispatch } from './resource-shell-dispatch.js'

/**
 * 壳交上来的投影 → 内核认的自述。
 *
 * 三处刻意的不对称,每一处都是「壳不判 core 的事」(§5)的直接后果:
 *   · `when` / `describe` 过不了进程边界,所以没有;`whenGated` 交上来也被忽略
 *     ——「此刻露不露面」是场子判据,判据在 core;
 *   · `home` 一律盖 `'shell'`(见文件头);
 *   · `effects` 原样过 —— 它是**静态上界**,而上界的合法性由
 *     `assertResourceSpec` 在 `registry.register` 里判(不认识的效果类当场抛)。
 *     这里不预先过滤:悄悄丢掉一条不认识的效果 = 把一次登记期的硬错洗成一次
 *     运行期的免检。
 */
export function resourceSpecFromShell(serialized: SerializedResourceSpec): ResourceSpec {
  const reads: Record<string, SerializedReadSpec> = {}
  for (const [name, read] of Object.entries(serialized.reads ?? {})) {
    reads[name] = { title: read.title, query: read.query, result: read.result }
  }

  const ops: ResourceSpec['ops'] = {}
  const mutableOps = ops as Record<string, ResourceSpec['ops'][string]>
  for (const [name, op] of Object.entries(serialized.ops ?? {})) {
    mutableOps[name] = {
      title: op.title,
      params: op.params,
      effects: (op.effects ?? []) as readonly EffectClass[],
      home: 'shell',
      ...(op.entity !== undefined ? { entity: op.entity } : {}),
      ...(op.keymap !== undefined ? { keymap: op.keymap } : {}),
      ...(op.userOnly ? { userOnly: true } : {}),
      ...(typeof op.describeTemplate === 'string' && op.describeTemplate
        ? { describe: (params: unknown) => renderDescribeTemplate(op.describeTemplate as string, params) }
        : {}),
    }
  }

  const events: Record<string, SerializedEventSpec> = {}
  for (const [name, event] of Object.entries(serialized.events ?? {})) {
    events[name] = { title: event.title, payload: event.payload }
  }

  const spec: ResourceSpec = { scheme: serialized.scheme, title: serialized.title, reads, ops, events }
  if (!serialized.state) return spec
  return { ...spec, state: { ...serialized.state } }
}

/** 一条只许人调的壳侧做法被模型 / 插件 / 系统主体调了(自述里 `userOnly`)。plan 期抛。 */
export class ShellOpUserOnlyError extends Error {
  constructor(scheme: string, op: string, principalKind: string) {
    super(
      `${scheme}: ${op} is answered by the person at this machine only — this call is on behalf of ${principalKind}.`,
    )
    this.name = 'ShellOpUserOnlyError'
  }
}

export class ShellResourceProvider implements ResourceProvider<null> {
  readonly spec: ResourceSpec

  /*
   * 它不记「哪扇壳交的」(第④步批 1,决策 D276):一个住在壳里的命名空间可以有好几扇壳同时
   * 认领(桌面窗口 + 浏览器壳交的是同一份自述),这只 provider 在第一扇登记时装上、最后一扇
   * 走时摘下。命令发给哪一扇是派发器的事(`ShellCommandDispatch.pick`)。
   */
  private readonly dispatch: ShellCommandDispatch
  private hub: ResourceEventHub | undefined

  constructor(spec: ResourceSpec, dispatch: ShellCommandDispatch) {
    this.spec = spec
    this.dispatch = dispatch
  }

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  /**
   * 壳发一条事实(§10.3 的 `opened` / `closed` / `deleted` 三条通用名就落在这里)。
   *
   * **今天没有调用方** —— 壳把事件送回 core 的那条路还没有(K2b-2b 留账:建议加一条
   * `resources.emit` RPC)。这一格现在就在,是因为 `attach` 是 `ResourceProvider` 的
   * 一半:一个收下总线却永远不用它的 provider,读起来像是忘了写。
   */
  emit(path: string, event: string, payload: unknown): void {
    this.hub?.emit({ scheme: this.spec.scheme, path }, event, payload)
  }

  async read(name: string, ref: ResourceRef | null, query: unknown, ctx: ResourceReadContext): Promise<unknown> {
    const text = await this.dispatch.read(this.spec.scheme, name, ref, query, ctx.signal, ctx.callerId)
    return parseShellPayload(text)
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext): Promise<Intent<null>> {
    const declared = Object.prototype.hasOwnProperty.call(this.spec.ops, op) ? this.spec.ops[op] : undefined
    /*
     * **只许人调的做法**(自述里 `userOnly`,第④步批 2b):非用户主体当场拒,排在一切之前 ——
     * 一次注定不许跑的做法不该先弹一张权限卡去问人。判据在 core(授权一律在 core),壳只自述。
     */
    if (declared?.userOnly && ctx.principal.kind !== 'user') throw new ShellOpUserOnlyError(this.spec.scheme, op, ctx.principal.kind)
    /*
     * **人亲手按的不问**(第④步批 2b,与 core 侧 `browser` / `music` / `todo` / `session` 几只 provider 的
     * `plan` 同一条判例,08-18):用户主体零效果 —— 地址栏上那颗「前进」是人自己按的,再弹一张卡问
     * 「准不准你按你刚按的那颗钮」是噪音不是保护。零效果不等于不留痕迹:照样落审计、照样发事件。
     * 内置浏览器搬出 core 进程之前,这一条住在它自己的 provider 里;搬成壳交的命名空间之后,壳那一侧
     * 已经不在授权路上,所以这句话落在这里,对所有壳交的命名空间一视同仁。
     */
    // 卡上那句人话:壳交了模板就按这一次的参数渲染(「Send the browser to https://…」),没交就是标题。
    const title = declared ? (declared.describe?.(params) || declared.title) : undefined
    if (declared && ctx.principal.kind === 'user') {
      return Intent.of<null>({ effects: [], payload: null, preview: { title: title ?? declared.title } })
    }
    // 其余主体:效果按自述的**静态上界**造。壳侧的做法没有「按参数分档」的判据(那种判据只有
    // 实现知道,而实现在另一个进程里),所以上界就是它的具体效果。`planFromSpec`
    // 自己会对不在自述里的 op 抛 —— 那一句是硬错,不是一条零效果的免检计划。
    return planFromSpec<null>(this.spec, op, ref, null, title ? { title } : undefined)
  }

  async apply(op: string, _intent: Intent<null>, _ctx: RunContext): Promise<Result> {
    // 到不了:这份自述里每一条做法的 `home` 都是 `'shell'`(反序列化时盖的),而
    // `ResourceTool.apply` 对 `home: 'shell'` 走的是 `ShellDispatch`。留一句诚实的
    // 错而不是静默返回 —— `apply` 是公开方法,手搓一个 Intent 直接调它的调用方
    // 该当场听见这句话。
    throw new TypeError(
      `Resource ${this.spec.scheme}: op ${JSON.stringify(op)} runs in the shell; it never applies in this process`,
    )
  }
}

/**
 * `describeTemplate` 的渲染(见 `@shared/ipc/resources` 那一格的说明):`{name}` → 参数里那一格的字符串
 * (数字 / 布尔照 `String()`,别的形状当没有);`[...]` 那一段里只要有一个 `{name}` 没值,整段不出现。
 * 渲染出来是空串就答空串,调用方退回标题。
 */
export function renderDescribeTemplate(template: string, params: unknown): string {
  const fields = params && typeof params === 'object' ? params as Record<string, unknown> : {}
  const valueOf = (name: string): string => {
    const value = fields[name]
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : ''
  }
  const fill = (text: string): string => text.replace(/\{(\w+)\}/g, (_, name: string) => valueOf(name))
  const optional = template.replace(/\[([^\]]*)\]/g, (_, inner: string) => {
    const names = [...inner.matchAll(/\{(\w+)\}/g)].map(match => match[1]!)
    return names.every(name => valueOf(name) !== '') ? fill(inner) : ''
  })
  return fill(optional).trim()
}

/**
 * 回执里那段文本 → 读法的返回值。
 *
 * 壳把答案 `JSON.stringify` 进 `text`(回执契约只有一格文本 —— 让它带一格
 * `unknown` 载荷等于在同一条通道上开第二种形状)。解不开就把原文交出去:一条读法
 * 返回一句人话是合法的,而把它当成一次失败会让「这条读法写得糙」变成「这次调用炸了」。
 */
function parseShellPayload(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
