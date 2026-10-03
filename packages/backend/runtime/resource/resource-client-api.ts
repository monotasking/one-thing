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
import {
  resourcesRouter,
  type DescribeResourceRequest,
  type DoResourceRequest,
  type EmitShellResourceEventRequest,
  type ListResourcesResponse,
  type MountShellResourceRequest,
  type MountShellResourceResponse,
  type ReadResourceRequest,
  type ResourceOutcomeView,
  type ResourceReadView,
  type ResourcesRoutes,
  type SerializedResourceSpec,
  type ShellAckResponse,
  type ShellResultRequest,
  type UnmountShellResourcesRequest,
} from '@shared/ipc/resources.js'
import type { ResourceKernel } from './resource-api.js'
import { BackendNotAssembledError, getCurrentBackendInstance } from '@onething/backend/current.js'
import { principalOf } from '@onething/backend/http-server/http-server-principal.js'
import type { ShellMountRegistry } from '@onething/backend/runtime/resource'
import { serializeOutcome, serializeReadOutcome, serializeSpec } from './resource-wire-views.js'
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'

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
 * 这个进程当前那本壳侧登记簿(K2b-2)。与 `kernel()` 同一条读法、同一句「还没装配」。
 */
function shells(): ShellMountRegistry {
  const backend = getCurrentBackendInstance()
  if (!backend) throw new BackendNotAssembledError()
  return backend.shellResources
}

/**
 * 一次调用的坐标。**`sessionId` 缺席就是缺席** —— 不拿 `ref` 里那条会话顶上:
 * 那样审计会读成「A 自己改了自己」(K1 留账,K2a 的答案是保留坐标 +
 * `<store>/audit/resource.jsonl`,见 `runtime/toolkit/audit-sink.ts`)。
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

  /**
   * 读(K2c-2:它不再走「做」那条管线)。
   *
   * 处理器这一侧因此比 `do` 还短:`ReadOutcome` 的四支**本来就是纯数据**,只有
   * `failed` 那一支带着一只 `Error` 要摊平(名字给判定读、消息给人读、堆栈一个字
   * 不过网络,与 `serializeOutcome` 逐字同一条)。`ok` 直接带 `value` —— 读到的那个
   * 值原样进 JSON 信封,不再序列化成文本再让调用方解回来。
   */
  async read(
    request: ReadResourceRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<ResourceReadView> {
    const outcome = await kernel().read(
      request?.ref ?? '',
      request?.name ?? '',
      request?.query ?? {},
      callOptions(context, request?.sessionId),
    )
    return serializeReadOutcome(outcome)
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

  /**
   * 一扇壳交自述(K2b-2,§10.2「home 在 shell 的寿命 = 那扇壳的连接」)。
   *
   * 铸主体的规则与 `do` 逐字相同 —— 「这台机器上多一种能力」本身就是一次改动,
   * 一个说不出自己是谁的联网调用方不该做得成。`shellId` 是**坐标不是身份**:
   * 它决定命令往哪儿发,决定不了谁能做什么。
   */
  async mountShell(
    request: MountShellResourceRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<MountShellResourceResponse> {
    principalOf(context)
    return shells().mountShell(request?.shellId ?? '', request?.spec as SerializedResourceSpec)
  },

  /** 撤掉这扇壳的全部 scheme。幂等 —— 撤一扇已经不在的壳是成功。 */
  async unmountShell(
    request: UnmountShellResourcesRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<ShellAckResponse> {
    principalOf(context)
    await shells().unmountShell(request?.shellId ?? '')
    return { ok: true }
  },

  /**
   * 一条壳命令的回执。
   *
   * 两道判定,一道都不能省:铸主体(与 `do` 同规则),以及 `shellId` 登记过没有 ——
   * 命令是**广播**出去的(SSE 没有定向投递),所以「谁能替这次调用收场」必须在这里
   * 判一次。对不上账的 `callId` 不是错(超时之后才回来的回执是正常的),陌生的
   * `shellId` 是错。
   */
  async shellResult(
    request: ShellResultRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<ShellAckResponse> {
    principalOf(context)
    shells().settleResult(request?.shellId ?? '', request?.callId ?? '', request?.result)
    return { ok: true }
  },

  /**
   * 一条壳报上来的**事实**(K2b-2b,§10.3 的 `opened` / `closed` / `deleted`)。
   *
   * 与 `shellResult` 同两道判定(铸主体 + `shellId` 登记过),多一道:`ref` 的
   * 命名空间要**归这扇壳** —— 判据在 `ShellMountRegistry.emitEvent` 里,因为
   * 「谁交了哪几个 scheme」这本账只有它有。这里照旧只做转手。
   *
   * 事实进 core 之后骑的是 K2a 那条既有的路(provider → hub → 事件桥 →
   * 全局事件 `resource:event` → SSE),一条新通道都不开。
   */
  async emit(
    request: EmitShellResourceEventRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<ShellAckResponse> {
    principalOf(context)
    shells().emitEvent(request?.shellId ?? '', request?.ref ?? '', request?.event ?? '', request?.payload)
    return { ok: true }
  },
}

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `resources` 的契约与处理者。 */
export const RESOURCES_CLIENT_API = defineClientApi({ id: 'rpc:resources', router: resourcesRouter, handlers: resourcesRpcHandlers })
