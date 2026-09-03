/**
 * 进程当前实例槽(方案 `docs/design/backend-composition-root-2026-09.md` 的 A2,§2.2)。
 *
 * **整个 `packages/backend` 里唯一允许的模块级 `let`。** A2 之前有三个:
 * `events/index.ts` 的 `eventBus`/`streamChannel`、`session/index.ts` 转给 core 的
 * 那一份、`wiring/engine/index.ts` 的 `streamEngine`/`onethingRuntime`。三份各自
 * "已存在 → warn → return",于是"装配 → 关机 → 再装配"这条路谁也说不清是谁的
 * 尸体还在。现在只有这一份,由 `OnethingBackend.assemble` 立、由 `dispose()` 清。
 *
 * 121 个 `getXxx()` 访问器一个不改地保留 —— 它们从"各自读自己那份 `let`"变成
 * "读这里的当前实例"。
 *
 * ## 装配中途的可见性(方案 §5 风险 1)
 *
 * `assemble` 在**第一步**就把句柄装进来,而不是等 35 步跑完。原因是装配中途就有
 * 人在问:`installSessionLedgerEventBroadcaster()` / `registerBuiltinTriggers()` /
 * `createMainStreamEngineRuntime()` 都在自己那一行调 `getEventBus()`。所以句柄的
 * 五个字段是 **getter**:填了的读得到,没填的抛 `BackendNotAssembledError('engine')`
 * —— 与 A2 之前"未初始化就抛"逐字同义。
 *
 * ## 句柄不是类
 *
 * `BackendHandle` 是只含字段的窄接口,不是 `OnethingBackend` 本身:`events/index.ts`
 * 要读它,而 `backend.ts` 要 import `events/index.ts`。窄接口住在这个叶子文件里,
 * 那条环就不存在。(下面对 `wiring/engine/index.js` 的 `import type` 是**纯类型**,
 * 编译期即被抹掉,不产生运行期边。)
 */
import type { EventBus } from './events/event-bus.js'
import type { StreamChannel } from './events/stream-channel.js'
import type { SessionManager } from '@onething/core/session'
import type { StreamEngine } from './wiring/engine/stream-engine-bound.js'
import type { MainOnethingRuntime } from './wiring/engine/index.js'
import type { OnethingBackend } from './backend.js'

/**
 * 没有当前实例(或当前实例的这一格还没建好)。
 *
 * 错误信息带字段名:装配中途踩到这条的人需要知道"我要的是 engine,而它排在
 * 第 14 步"——只说"没装配"会把一个顺序问题伪装成一个环境问题。
 */
export class BackendNotAssembledError extends Error {
  readonly field?: keyof BackendHandle

  constructor(field?: keyof BackendHandle) {
    super(
      field
        ? `[Backend] "${field}" is not available: no backend is assembled in this process, or assembly has not reached that step yet.`
        : '[Backend] No backend is assembled in this process. Call createOnethingBackend(...) first.',
    )
    this.name = 'BackendNotAssembledError'
    this.field = field
  }
}

/**
 * 一个进程里已经有活实例时又装配一次。
 *
 * A2 之前这条路**静默返回第一份**(三个单例模块各自 warn 一声就 return),而
 * 整次装配其实还是会失败 —— 失败在第 31 步 RPC 域的重复挂载守卫上,那时
 * stores / settings / provider 迁移 / 凭证升级 / 事件系统 / 引擎 / 权限 / 工具
 * 目录已经又跑了一遍且不可回滚。A2 把这声拒绝挪到 `assemble` 的第一行:一步都
 * 不跑,并且说的是真话。
 */
export class BackendAlreadyAssembledError extends Error {
  constructor() {
    super(
      '[Backend] A backend is already assembled in this process. Call dispose() on it before assembling another.',
    )
    this.name = 'BackendAlreadyAssembledError'
  }
}

/**
 * 进程当前实例对外的**全部**面:五个字段,没有方法。
 *
 * 这里刻意不放 `dispose()` —— 关机是实例(`OnethingBackend`)的事,而这个槽只
 * 负责回答"现在这个进程里的引擎/总线是哪一只"。
 */
export interface BackendHandle {
  readonly eventBus: EventBus
  readonly streamChannel: StreamChannel
  readonly sessionManager: SessionManager
  readonly engine: StreamEngine
  readonly runtime: MainOnethingRuntime
}

/** 装配途中的句柄内容:填一格是一格。 */
export type BackendHandleParts = {
  -readonly [K in keyof BackendHandle]?: BackendHandle[K]
}

/**
 * 读一格,没填就抛。`OnethingBackend` 的五个 getter 与 `createBackendHandle`
 * 都走这一句 —— "没建好 = 抛,不是 undefined"只有一个产地。
 */
export function requireBackendField<K extends keyof BackendHandle>(
  parts: BackendHandleParts,
  field: K,
): BackendHandle[K] {
  const value = parts[field]
  if (value === undefined) throw new BackendNotAssembledError(field)
  return value as BackendHandle[K]
}

/**
 * 把一份"填一格是一格"的产物包成句柄。getter **按需读** `parts`,所以装配可以
 * 边跑边填,而句柄早就在槽里了。
 *
 * 生产上由 `OnethingBackend` 自己实现同一套 getter(它还要带 `own`/`dispose`);
 * 这个工厂给的是**不需要整只 backend** 的场景 —— 只想要事件系统的那几份单测,
 * 从前它们调 `initializeEventSystem()`,现在调 `createEventSystem()` 再把产物
 * 装进槽里。
 */
export function createBackendHandle(parts: BackendHandleParts): BackendHandle {
  return {
    get eventBus() {
      return requireBackendField(parts, 'eventBus')
    },
    get streamChannel() {
      return requireBackendField(parts, 'streamChannel')
    },
    get sessionManager() {
      return requireBackendField(parts, 'sessionManager')
    },
    get engine() {
      return requireBackendField(parts, 'engine')
    },
    get runtime() {
      return requireBackendField(parts, 'runtime')
    },
  }
}

let current: BackendHandle | null = null

/** 装配开头装进来,`dispose()` 末尾清成 `null`。别的地方不该调。 */
export function setCurrentBackend(handle: BackendHandle | null): void {
  current = handle
}

/**
 * 当前实例。没有就抛。
 *
 * `field` 只影响错误信息:调用方说得出自己要哪一格,踩到的人就少走一段路。
 */
export function getCurrentBackend(field?: keyof BackendHandle): BackendHandle {
  if (!current) throw new BackendNotAssembledError(field)
  return current
}

/** 当前实例或 `null` —— 给"有就用,没有就算了"的产地(关机途中、轻量单测)。 */
export function getCurrentBackendSafe(): BackendHandle | null {
  return current
}

/**
 * 当前槽里那只**完整的 `OnethingBackend` 实例**,或 `null`(C1,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
 *
 * 为什么不是把 `mcp` / `acp` 加进 `BackendHandle`:句柄回答的是"这个进程里的引擎/
 * 总线是哪一只",给的是那 121 个 `getXxx()`;子系统的调用方只有两类 —— 装配自己,
 * 和拿得到实例的宿主/域处理器。给句柄开一格等于让所有 `getXxx()` 的读法都看得见
 * 一件它们不该碰的东西。
 *
 * 判据是"**它 own 得了 disposer 吗**":`createBackendHandle()` 造出来的窄句柄
 * (只想要事件系统的那些轻量单测在用)没有 `own`,真实例有。`import type` 是纯类型
 * (编译期抹掉),所以这里不多一条指向 `backend.ts` 的运行期边 —— 与本文件顶上对
 * `wiring/engine/index.js` 那句同一个理由。
 *
 * 拿不到就 `null`,由调用点自己退化(设置域在没有活实例时直接调 manager,与 C1
 * 之前逐字相同)—— 这个函数不抛。
 */
export function getCurrentBackendInstance(): OnethingBackend | null {
  const handle = current as Partial<OnethingBackend> | null
  return typeof handle?.own === 'function' ? (handle as OnethingBackend) : null
}
