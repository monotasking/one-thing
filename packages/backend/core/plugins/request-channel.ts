/**
 * 插件请求通道 —— UI(renderer/web)→ 插件方向的唯一通路(设计文档 §5 R2)。
 *
 * 三条从第一天就必须在的语义:
 *  - **requestId**:每次调用可寻址,否则 abort/progress 无从投递;
 *  - **abort**:宿主的工具执行上下文里 abortSignal 是一等公民,插件通道没有的话
 *    第一个产品级长任务就撞墙;
 *  - **progress**:同上,长任务必须能吐中间态。
 *
 * 宪法第 2 条(过线皆可序列化)在这里落到运行期:payload / result / progress
 * 都要过一次浅校验。将来把插件搬进子进程时,这条边界原样变成 RPC —— 现在纵容
 * 一个函数或 Map 过线,那天就是全量 API 重写。
 */

export interface CorePluginRequestContext {
  /** 本次调用的地址。abort 与 progress 都按它路由。 */
  readonly requestId: string
  /** 调用方撤销时触发。插件应当据此提前收工。 */
  readonly abortSignal: AbortSignal
  /** 中间态上报;payload 必须 JSON-可序列化。 */
  progress(payload: unknown): void
}

/** payload / 返回值都必须 JSON-可序列化(宪法第 2 条)。 */
export type CorePluginRequestHandler = (
  payload: unknown,
  ctx: CorePluginRequestContext,
) => unknown | Promise<unknown>

export type CorePluginRequestResult =
  | { success: true; requestId: string; result: unknown }
  | {
    success: false
    requestId: string
    error: string
    aborted?: boolean
    timedOut?: boolean
    /**
     * 这一次是被**降级短路**掉的,插件根本没有被调用(R7)。
     *
     * UI 据此渲染专门的降级态(而不是又一个普通错误 + Retry):
     * 连败达阈之后再点一次没有意义,除非用户明确说"再试一次"。
     */
    degraded?: boolean
    /** 被降级的界面,例如 `panel:logs`。 */
    surface?: string
  }

export interface CorePluginRequestInput {
  pluginId: string
  action: string
  payload?: unknown
  /**
   * 省略时**由 core 生成**(registry.nextRequestId,带单调序列号)。
   *
   * 宿主不要自己预生成:`Date.now()` 毫秒精度在同毫秒并发下会撞号,而撞号的
   * 代价是先到的 AbortController 失联、先 settle 的一方把另一方的登记也删掉。
   * 生成的 id 随结果回传(CorePluginRequestResult.requestId),调用方拿它 abort。
   */
  requestId?: string
  /** 进度上报的出口(宿主决定投到哪条通道)。 */
  onProgress?(input: { requestId: string; pluginId: string; action: string; payload: unknown }): void
  /**
   * 绕过降级闸放行**一次**(R7)。
   *
   * 只有用户在降级态上明确点"再试一次"时才为真 —— 自动重试、轮询、刷新都不带
   * 它,否则降级就白降了。这一次若成功,recordSuccess 会把界面放回来。
   */
  bypassDegraded?: boolean
}

export const PLUGIN_REQUEST_ABORTED_ERROR = 'Plugin request aborted'

/**
 * 浅校验"能不能过线"。
 *
 * **它保证什么**:深度 4 层以内的形状错误(函数、Symbol、BigInt、Map/Set、
 * Promise、TypedArray、类实例、非有限数)当场被拒;循环引用**无论多深**都能抓到
 * (WeakSet 已访问集,O(n),与深度无关)。
 *
 * **它不保证什么**:超过 `maxDepth` 层的形状错误会逃逸 —— 请求通道用默认的 4 层,
 * 因为它在每次插件调用上,完备遍历一棵大对象是白付的代价。H 线把插件搬进子进程、
 * 边界变成真 RPC 时,序列化会由结构化克隆强制,届时重估这个折中。
 *
 * **调用方可以加深**:`maxDepth` 是参数而不是常量,因为"够深"取决于被扫的东西。
 * 描述树(R5 面板)就必须传一个大得多的值:它的节点上限是 12 层,而 list 的 items
 * 恰好落在默认第 4 层 —— 用默认值扫,item 的 payload / button 的 payload 里的函数
 * 一个也扫不到,"禁函数成员"这句承诺就成了半句。
 *
 * **Date 的语义差异**:这里放行 Date,但它过 IPC(structured clone)会保持 Date,
 * 过 HTTP(JSON.stringify)会变成 ISO 字符串。两个宿主拿到的类型不同 ——
 * 插件要跨端一致的话,自己转成字符串或时间戳。
 */
export const JSON_CHECK_MAX_DEPTH = 4

export function describeNonSerializable(
  value: unknown,
  path = 'value',
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
  maxDepth: number = JSON_CHECK_MAX_DEPTH,
): string | null {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return kind === 'number' && !Number.isFinite(value as number)
      ? `${path} is a non-finite number (${String(value)})`
      : null
  }
  if (kind === 'undefined') {
    // 顶层 undefined 等价于"没有 payload";对象成员里的 undefined 会被 JSON 丢掉,
    // 但那是无声丢失,不是形状错误 —— 放行,别为它报错。
    return null
  }
  if (kind === 'function') return `${path} is a function`
  if (kind === 'symbol') return `${path} is a symbol`
  if (kind === 'bigint') return `${path} is a bigint`

  // 循环检测独立于深度上限:一个 5 层深的自引用照样会让 JSON.stringify 抛,
  // 深度先返回的话就漏了。
  if (seen.has(value as object)) return `${path} is a circular reference`
  seen.add(value as object)

  if (Array.isArray(value)) {
    if (depth >= maxDepth) return null
    for (let index = 0; index < value.length; index += 1) {
      const found = describeNonSerializable(value[index], `${path}[${index}]`, depth + 1, seen, maxDepth)
      if (found) return found
    }
    return null
  }

  if (value instanceof Date) return null
  if (value instanceof Map) return `${path} is a Map (use a plain object)`
  if (value instanceof Set) return `${path} is a Set (use an array)`
  if (value instanceof Promise) return `${path} is a Promise`
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return `${path} is a typed array (use a plain array or base64 string)`
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) {
    return `${path} is a class instance (${(value as object).constructor?.name || 'unknown'}); pass a plain object`
  }

  if (depth >= maxDepth) return null

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const found = describeNonSerializable(child, `${path}.${key}`, depth + 1, seen, maxDepth)
    if (found) return found
  }
  return null
}

export function assertPluginPayloadSerializable(value: unknown, label: string): void {
  const problem = describeNonSerializable(value, label)
  if (problem) {
    throw new Error(`Plugin request payload must be JSON-serializable: ${problem}`)
  }
}

export function normalizePluginRequestAction(action: string): string {
  return action.trim()
}

export function pluginRequestErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Plugin request failed'
}

/**
 * 在飞请求登记簿 —— abort 要能找到那个 AbortController。
 *
 * 单独成类是为了让 manager 与将来的子进程宿主共用同一套寻址语义。
 */
export class CorePluginRequestRegistry {
  private readonly inFlight = new Map<string, { controller: AbortController; pluginId: string }>()
  private sequence = 0

  nextRequestId(pluginId: string): string {
    this.sequence += 1
    return `${pluginId}#${Date.now().toString(36)}-${this.sequence}`
  }

  /**
   * 登记一次在飞请求。
   *
   * 撞号**直接拒绝**而不是覆盖:Map.set 静默覆盖会让先到的 AbortController
   * 失联(再也 abort 不掉),并且先 settle 的一方会把另一方的登记一起删掉。
   * 宁可让这一次请求失败,也不要两个请求共用一个地址。
   */
  begin(requestId: string, pluginId: string): AbortController | null {
    if (this.inFlight.has(requestId)) return null
    const controller = new AbortController()
    this.inFlight.set(requestId, { controller, pluginId })
    return controller
  }

  has(requestId: string): boolean {
    return this.inFlight.has(requestId)
  }

  end(requestId: string): void {
    this.inFlight.delete(requestId)
  }

  abort(requestId: string): boolean {
    const entry = this.inFlight.get(requestId)
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  /** 插件被拆除时,它名下所有在飞请求一并中止 —— 否则它们会在真空里跑完。 */
  abortForPlugin(pluginId: string): number {
    let aborted = 0
    for (const [requestId, entry] of this.inFlight) {
      if (entry.pluginId !== pluginId) continue
      entry.controller.abort()
      this.inFlight.delete(requestId)
      aborted += 1
    }
    return aborted
  }

  /** refresh / shutdown 的整树拆除 —— 一个都不许留在真空里跑完。 */
  abortAll(): number {
    let aborted = 0
    for (const [, entry] of this.inFlight) {
      entry.controller.abort()
      aborted += 1
    }
    this.inFlight.clear()
    return aborted
  }

  size(): number {
    return this.inFlight.size
  }
}
