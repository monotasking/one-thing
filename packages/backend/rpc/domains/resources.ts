/**
 * 资源域 —— 界面 / 脚本进管线的那扇门(原子 K2a,`docs/design/atom-2026-09.md` §4 /
 * §9 K2)。
 *
 * ## 这只文件短得刺眼,那是本单的交付物
 *
 * 四个处理器加起来做**三件事**:铸主体(`principalOf`)、折发起坐标(`sessionId`
 * 可缺席)、把调用交给 `backend.resources`。授权、拦截、效果上界、预算、取消、审计
 * 一个字都不在这里 —— 它们在管线里,而管线是 AI 那条路正在跑的**同一台**
 * `ToolRunner`(§2 不变量 2:「没有第二条路,界面点按钮也走它」)。
 *
 * 对照今天那 24 个手写域:每个域自己在函数第一行判一次谁能做什么,加一个域就要
 * 记得抄一次,漏抄不会有任何东西红 —— 那就是 09-07 留下的「24 域授权迁契约」那笔债。
 * 这个域证明的是那笔债还得掉:一个通用域,零个 scheme 名,授权由管线给。
 *
 * ## 它不读 `context.transport`
 *
 * 一个字都不读。`transport` 今天只回答一个问题(哪条总线回话)加两处脱敏,
 * 而「这个调用方能不能做这件事」是主体与效果的问题(route B,
 * `docs/design/backend-transport-forks-2026-09.md`)。`transport:gate` 是减量棘轮,
 * 新域读一次就把它推回去一格。
 *
 * ## `context.signal` 只当加速器
 *
 * 调用方断线时 HTTP 面会喊停,顺手把它递进管线的 `AbortScope` —— 但管线自己有
 * 边界,不靠它。`RpcDispatchContext.signal` 的头注释写的就是这条:它不是权限、
 * 不是身份,所以也不占 `transport:gate` 那本账。
 */
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type {
  DescribeResourceRequest,
  DoResourceRequest,
  ListResourcesResponse,
  ReadResourceRequest,
  ResourceOutcomeView,
  ResourcesRoutes,
  SerializedEventSpec,
  SerializedOpSpec,
  SerializedReadSpec,
  SerializedResourceSpec,
} from '@shared/ipc/resources.js'
import type { ResourceKernel, ResourceSpec } from '@onething/core/resource'
import type { Outcome, Result } from '@onething/core/toolkit'
import { resultToText } from '@onething/core/toolkit'
import { BackendNotAssembledError, getCurrentBackendInstance } from '../../current.js'
import { principalOf } from '../principal.js'
import type { RpcRouteHandlers } from '../registry.js'

/**
 * 这个进程当前那台内核。
 *
 * 走 `getCurrentBackendInstance()` 而不是 `getCurrentBackend(field)`:资源内核是
 * **实例字段**,不在 `BackendHandle` 那五格窄句柄上(K1 那次的裁定 —— 句柄回答的是
 * "引擎/总线是哪一只",给它开一格等于让 121 个 `getXxx()` 的读法都看得见一件它们
 * 不该碰的东西)。拿不到实例与拿不到那一格,说的是同一句话:还没装配。
 */
function kernel(): ResourceKernel {
  const backend = getCurrentBackendInstance()
  // 无参的那一支:`BackendNotAssembledError` 的 `field` 只收 `BackendHandle` 的键,
  // 而资源内核刻意不在那张窄句柄上(见上)。措辞因此是通用的那一句,不是假装
  // 有这么一格。
  if (!backend) throw new BackendNotAssembledError()
  return backend.resources
}

/**
 * 一份自述 → 可序列化投影。函数(`when` / `describe`)在这里被丢掉,只留一格
 * `whenGated` —— 理由在 `@shared/ipc/resources.ts` 的头注释。
 *
 * 键按字典序遍历,与 `schema.ts` 生成 AI 工具契约时同一个理由:同一份自述换个
 * 书写顺序不该换一份投影(那会让命令面板的排序取决于谁先敲了哪一行)。
 */
function serializeSpec(spec: ResourceSpec): SerializedResourceSpec {
  const reads: Record<string, SerializedReadSpec> = {}
  for (const name of Object.keys(spec.reads).sort()) {
    const read = spec.reads[name]
    reads[name] = { title: read.title, query: read.query, result: read.result }
  }

  const ops: Record<string, SerializedOpSpec> = {}
  for (const name of Object.keys(spec.ops).sort()) {
    const op = spec.ops[name]
    ops[name] = {
      title: op.title,
      params: op.params,
      effects: [...op.effects],
      home: op.home,
      ...(op.when ? { whenGated: true } : {}),
      ...(op.entity !== undefined ? { entity: op.entity } : {}),
      ...(op.keymap !== undefined ? { keymap: op.keymap } : {}),
    }
  }

  const events: Record<string, SerializedEventSpec> = {}
  for (const name of Object.keys(spec.events).sort()) {
    const event = spec.events[name]
    events[name] = { title: event.title, payload: event.payload }
  }

  const projected: SerializedResourceSpec = { scheme: spec.scheme, title: spec.title, reads, ops, events }
  if (!spec.state) return projected

  const state: NonNullable<SerializedResourceSpec['state']> = {}
  for (const name of Object.keys(spec.state).sort()) {
    const entry = spec.state[name]
    state[name] = { title: entry.title, schema: entry.schema, volatility: entry.volatility }
  }
  return { ...projected, state }
}

/**
 * `Outcome` → 可序列化投影。五支一一对应。
 *
 * `ok` 那一支走 `resultToText` —— 与模型看到的**逐字相同**的那段文本(`toModelText`
 * 对 `ok` 就是这一句)。不另写一个「给界面的格式」:同一次调用在 AI 眼里和在界面
 * 眼里说的是两句话,就是「一条管线」这句话开始漏气的地方(要结构化载荷是 K2b 的
 * 事,那时加的是 `details` 一格,不是第二种文本)。
 *
 * `failed` 只留错误的名字与一句话:类名给判定读,消息给人读,堆栈一个字不过网络。
 */
function textOf(result: Result): string {
  return resultToText(result)
}

function serializeOutcome(outcome: Outcome): ResourceOutcomeView {
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'ok', text: textOf(outcome.result) }
    case 'invalid':
      return { kind: 'invalid', message: outcome.message }
    case 'denied':
      return { kind: 'denied', reason: outcome.reason }
    case 'aborted':
      return {
        kind: 'aborted',
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.partial ? { partial: textOf(outcome.partial) } : {}),
      }
    case 'failed':
      return { kind: 'failed', error: { name: outcome.error.name, message: outcome.message } }
  }
}

/**
 * 一次调用的坐标。**`sessionId` 缺席就是缺席** —— 不拿 `ref` 里那条会话顶上:
 * 那样审计会读成「A 自己改了自己」(K1 留账,K2a 的答案是保留坐标 +
 * `<store>/audit/resource.jsonl`,见 `wiring/toolkit/audit-sink.ts`)。
 */
function callOptions(context: RpcDispatchContext, sessionId?: string) {
  return {
    principal: principalOf(context),
    ...(sessionId ? { sessionId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }
}

export const resourcesRpcHandlers: RpcRouteHandlers<ResourcesRoutes> = {
  async list(
    _input: Record<string, never>,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<ListResourcesResponse> {
    // 列表也要主体:一份「这台机器上有哪些能力」的清单本身就是信息。判据与 read /
    // do 同一条,所以规则也只有一条(见 `principal.ts`)。
    principalOf(context)
    return {
      schemes: kernel().registry.list().map(spec => ({ scheme: spec.scheme, title: spec.title })),
    }
  },

  async describe(
    request: DescribeResourceRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<SerializedResourceSpec> {
    principalOf(context)
    const spec = kernel().registry.get(request?.scheme ?? '')
    // 抛而不是回 `null`:「没有这种资源」与「有,但它什么都不能做」是两件事,
    // 后者是一份空表。派发器把抛出去的那一句折成 `{ ok:false, error }`。
    if (!spec) throw new Error(`No resource is registered for scheme: ${request?.scheme ?? ''}`)
    return serializeSpec(spec)
  },

  async read(
    request: ReadResourceRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<ResourceOutcomeView> {
    const outcome = await kernel().read(
      request?.ref ?? '',
      request?.name ?? '',
      request?.query ?? {},
      callOptions(context, request?.sessionId),
    )
    return serializeOutcome(outcome)
  },

  async do(
    request: DoResourceRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<ResourceOutcomeView> {
    const outcome = await kernel().do(
      request?.ref ?? '',
      request?.op ?? '',
      request?.params ?? {},
      callOptions(context, request?.sessionId),
    )
    return serializeOutcome(outcome)
  },
}
