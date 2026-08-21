/**
 * scheduler(定时任务)域 —— 结构债 P4c 的第一个域。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/scheduler.ts` 那个手写 IPC 工厂(九条 handle 的
 *    通道表 + 九份请求类型)与 `apps/electron/src/main/ipc/scheduler.ts` 把它
 *    接到 `getScheduler()` 上的那层壳;
 *  - `packages/renderer/platform/{web,index}` 里九条 `/api/scheduler/*` 的镜像
 *    与 `preload/bridge.ts` 的九条包装(渲染侧本来就没有调用点 —— 面板是后来
 *    没做的,所以这一域是**真正的零行为变化**);
 *  - `packages/onething-runtime/src/app/server/http.ts` 的九条 REST 路由与
 *    `server/runtime.ts` 里那套**只被这九条路由用到**的 per-owner
 *    `ServerSchedulerRuntime`(自己一台 Scheduler + 自己的 userTasks/runHistory,
 *    落在 `owners/<uid>/<wid>/scheduler/`)。删掉之后 server 与桌面吃的是同一台
 *    `@onething/app/scheduler` —— 也就是 `createOnethingBackend` 在
 *    `configureAppScheduler()` 里装好的那一台,而不是第二台引擎。
 *
 * 这一层只做一件事:**把端口接到 `@onething/runtime/scheduler` 的依赖注入投影上**。
 * 判定、降级(`{ success:false, error }` 的包法)、缺省(runNow 的 `force ?? true`、
 * listRuns 的 recent 回退)全在那批 `*ForIpc` 里,传输面不复述它们 —— 逐条对着
 * 旧文件抄的正是这几处形状:
 *  - `runNow` / `listRuns` / `getRun` 的 `toRunDetail` 都要先把 `record.result`
 *    过一遍 `toJsonValue`(运行结果是任意值,DTO 那一格只收 JSON);
 *  - `setEnabled` / `deleteTask` / `updateTask` 靠 `isUserSchedulerTask` 分叉:
 *    用户任务改自己的账本再重挂,内置/插件任务只动调度器的开关位。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import {
  createOnethingSchedulerRunDetailFromRecord,
  createOnethingUserSchedulerTaskForIpc,
  deleteOnethingUserSchedulerTaskForIpc,
  getOnethingSchedulerRunForIpc,
  getOnethingSchedulerTaskForIpc,
  listOnethingSchedulerRunsForIpc,
  listOnethingSchedulerTasksForIpc,
  runOnethingSchedulerTaskNowForIpc,
  setOnethingSchedulerTaskEnabledForIpc,
  updateOnethingUserSchedulerTaskForIpc,
} from '@onething/runtime/scheduler'
import { schedulerRouter, type SchedulerRoutes } from '@shared/ipc/scheduler.js'
import type {
  SchedulerRunDetailDTO,
  SchedulerRunRecordDTO,
  SchedulerTaskSnapshotDTO,
} from '@shared/ipc/scheduler.js'
import { toJsonValue } from '@shared/json.js'
import { consolePort, getLogger } from '../../logging/index.js'
import { getScheduler } from '../../scheduler/index.js'
import {
  getSchedulerRunDetail,
  listSchedulerRunDetails,
  saveSchedulerRunDetail,
} from '../../scheduler/run-history.js'
import type { SchedulerRunRecord } from '../../scheduler/types.js'
import {
  createUserSchedulerTask,
  deleteUserSchedulerTask,
  isUserSchedulerTask,
  setUserSchedulerTaskEnabled,
  updateUserSchedulerTask,
} from '../../scheduler/user-tasks.js'
import { registerRouterHandlers } from '../registry.js'

const log = getLogger('rpc.scheduler')
/** 旧线传的是裸 `console`;结构化 logger 的鸭子端口替身(area ① 统一后删)。 */
const consoleLog = consolePort(log)

/** 运行记录 → 运行详情。三个方法共用同一份,`result` 必须先落成 JSON。 */
function toRunDetail(record: SchedulerRunRecord): SchedulerRunDetailDTO {
  return createOnethingSchedulerRunDetailFromRecord({
    ...record,
    result: toJsonValue(record.result),
  }) as SchedulerRunDetailDTO
}

export const schedulerRpcHandlers: RouteHandlers<SchedulerRoutes> = {
  async list() {
    return listOnethingSchedulerTasksForIpc({
      listTasks: () => getScheduler().list() as SchedulerTaskSnapshotDTO[],
      logger: consoleLog,
    })
  },
  async get(request) {
    return getOnethingSchedulerTaskForIpc({
      id: request.id,
      getTaskStatus: id =>
        getScheduler().getStatus(id) as SchedulerTaskSnapshotDTO | undefined,
      logger: consoleLog,
    })
  },
  // `force` 的缺省(true)住在投影里 —— 传输面只把键递过去。
  async runNow(request) {
    return runOnethingSchedulerTaskNowForIpc({
      id: request.id,
      force: request.force,
      runNow: (id, options) => getScheduler().runNow(id, options),
      isUserTask: isUserSchedulerTask,
      toRunDetail,
      saveRunDetail: saveSchedulerRunDetail,
      logger: consoleLog,
    }) as Promise<{ success: true; record: SchedulerRunRecordDTO } | { success: false; error: string }>
  },
  async setEnabled(request) {
    return setOnethingSchedulerTaskEnabledForIpc({
      id: request.id,
      enabled: request.enabled,
      isUserTask: isUserSchedulerTask,
      setUserTaskEnabled: setUserSchedulerTaskEnabled,
      setSchedulerTaskEnabled: (id, enabled) =>
        getScheduler().setEnabled(id, enabled) as SchedulerTaskSnapshotDTO | undefined,
      logger: consoleLog,
    })
  },
  async createTask(request) {
    return createOnethingUserSchedulerTaskForIpc({
      request,
      createUserTask: createUserSchedulerTask,
      logger: consoleLog,
    }) as Promise<{ success: true; task: SchedulerTaskSnapshotDTO } | { success: false; error: string }>
  },
  async updateTask(request) {
    return updateOnethingUserSchedulerTaskForIpc({
      request,
      isUserTask: isUserSchedulerTask,
      updateUserTask: updateUserSchedulerTask,
      logger: consoleLog,
    }) as Promise<{ success: true; task: SchedulerTaskSnapshotDTO } | { success: false; error: string }>
  },
  async deleteTask(request) {
    return deleteOnethingUserSchedulerTaskForIpc({
      id: request.id,
      isUserTask: isUserSchedulerTask,
      deleteUserTask: deleteUserSchedulerTask,
      logger: consoleLog,
    })
  },
  // 存过的运行详情优先;一条都没有时回落到任务快照里的 recentRuns。
  async listRuns(request) {
    return listOnethingSchedulerRunsForIpc({
      taskId: request.taskId,
      limit: request.limit,
      listSavedRuns: listSchedulerRunDetails,
      getTaskStatus: taskId =>
        getScheduler().getStatus(taskId) as SchedulerTaskSnapshotDTO | undefined,
      toRunDetail,
      logger: consoleLog,
    })
  },
  async getRun(request) {
    return getOnethingSchedulerRunForIpc({
      taskId: request.taskId,
      runId: request.runId,
      getSavedRun: getSchedulerRunDetail,
      getTaskStatus: taskId =>
        getScheduler().getStatus(taskId) as SchedulerTaskSnapshotDTO | undefined,
      toRunDetail,
      logger: consoleLog,
    })
  },
}

export function registerSchedulerRpcDomain(): () => void {
  return registerRouterHandlers(schedulerRouter, schedulerRpcHandlers)
}
