/**
 * todo-plan —— 待办:每个会话(与全局)一份 markdown 待办文档的存储、文件监视与改动通知,
 * 以及把它作为 `todo:` 资源交给资源面。
 *
 * 对外交出三类东西:
 * - 待办运行时:宿主注入口、取仓库与目录、改动订阅、活跃会话切换通知、删会话时清掉它的 AI 待办、起监视器;
 * - 仓库类 `OnethingTodoPlanStore` 与改动载荷的形状;
 * - `todo:` 资源的规格。
 * 依赖 settings、storage、session、logging 与包根的当前实例槽。
 */

// 待办运行时。
export {
  configureTodoPlanHost,
  deleteSessionAiTodo,
  getTodoPlanDirectory,
  getTodoPlanHostPorts,
  getTodoPlanStore,
  notifyTodoPlanActiveSessionChanged,
  onTodoPlanChanged,
  resetTodoPlanHost,
  startTodoPlanWatcher,
  TodoPlanRuntime,
} from './todo-plan-service.js'
export type { TodoPlanChangeListener, TodoPlanChangeOrigin, TodoPlanHostPorts } from './todo-plan-service.js'

// 仓库与改动载荷。
export { OnethingTodoPlanStore } from './todo-plan-store.js'
export type { TodoPlanChangedPayload } from './todo-plan-store.js'

// `todo:` 资源。
export { TODO_RESOURCE_SCHEME, todoResourceSpec } from './todo-plan-resource-spec.js'
