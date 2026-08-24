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
 *  - `packages/backend/server/http.ts` 的九条 REST 路由与
 *    `server/runtime.ts` 里那套**只被这九条路由用到**的 per-owner
 *    `ServerSchedulerRuntime`(自己一台 Scheduler + 自己的 userTasks/runHistory,
 *    落在 `owners/<uid>/<wid>/scheduler/`)。删掉之后 server 与桌面吃的是同一台
 *    `@onething/backend/wiring/scheduler` —— 也就是 `createOnethingBackend` 在
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
import type { SchedulerRoutes } from '@shared/ipc/scheduler.js'
import type {
  SchedulerRunDetailDTO,
  SchedulerRunRecordDTO,
  SchedulerTaskSnapshotDTO,
} from '@shared/ipc/scheduler.js'
import { toJsonValue } from '@shared/json.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { getScheduler } from '@onething/runtime/scheduler/scheduler-bound'
import {
  getSchedulerRunDetail,
  listSchedulerRunDetails,
  saveSchedulerRunDetail,
} from '@onething/runtime/scheduler/run-history-bound.wiring'
import type { SchedulerRunRecord } from '@onething/runtime/scheduler'
import {
  createUserSchedulerTask,
  deleteUserSchedulerTask,
  isUserSchedulerTask,
  setUserSchedulerTaskEnabled,
  updateUserSchedulerTask,
} from '../../wiring/scheduler/user-tasks.js'
import type { DeleteOnethingUserSchedulerTaskOptions, OnethingSchedulerIpcLogger } from '@onething/runtime/scheduler/ipc-operations'
import type { OnethingSchedulerUserTaskLogger } from '@onething/runtime/scheduler/user-tasks'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { SchedulerUpdateTaskRequest } from '@shared/ipc.js'
import type { ListOnethingSchedulerTasksOptions, RunOnethingSchedulerTaskNowOptions, SetOnethingSchedulerTaskEnabledOptions, UpdateOnethingUserSchedulerTaskOptions, ListOnethingSchedulerRunsOptions, GetOnethingSchedulerRunOptions } from '@onething/runtime/scheduler/ipc-operations'

const log = getLogger('rpc.scheduler')
/** 旧线传的是裸 `console`;结构化 logger 的鸭子端口替身(area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingSchedulerIpcLogger & OnethingSchedulerUserTaskLogger = consolePort(log)

/** 运行记录 → 运行详情。三个方法共用同一份,`result` 必须先落成 JSON。 */
function toRunDetail(record: SchedulerRunRecord): SchedulerRunDetailDTO {
  return createOnethingSchedulerRunDetailFromRecord({
    ...record,
    result: toJsonValue(record.result),
  }) as SchedulerRunDetailDTO
}

export const schedulerRpcHandlers: RouteHandlers<SchedulerRoutes> = {
  async list() {
    const listOnethingSchedulerTasksOptions: ListOnethingSchedulerTasksOptions<SchedulerTaskSnapshotDTO> & { logger?: OnethingSchedulerIpcLogger | undefined; } = {
      listTasks: () => getScheduler().list() as SchedulerTaskSnapshotDTO[],
      logger: consoleLog,
    };
    return listOnethingSchedulerTasksForIpc(listOnethingSchedulerTasksOptions)
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
    const runOnethingSchedulerTaskNowOptions: RunOnethingSchedulerTaskNowOptions<SchedulerRunRecord, SchedulerRunDetailDTO> & { logger?: OnethingSchedulerIpcLogger | undefined; } = {
      id: request.id,
      force: request.force,
      runNow: (id, options) => getScheduler().runNow(id, options),
      isUserTask: isUserSchedulerTask,
      toRunDetail,
      saveRunDetail: saveSchedulerRunDetail,
      logger: consoleLog,
    };
    return runOnethingSchedulerTaskNowForIpc(runOnethingSchedulerTaskNowOptions) as Promise<{ success: true; record: SchedulerRunRecordDTO } | { success: false; error: string }>
  },
  async setEnabled(request) {
    const setOnethingSchedulerTaskEnabledOptions: SetOnethingSchedulerTaskEnabledOptions<SchedulerTaskSnapshotDTO> & { logger?: OnethingSchedulerIpcLogger | undefined; } = {
      id: request.id,
      enabled: request.enabled,
      isUserTask: isUserSchedulerTask,
      setUserTaskEnabled: setUserSchedulerTaskEnabled,
      setSchedulerTaskEnabled: (id, enabled) =>
        getScheduler().setEnabled(id, enabled) as SchedulerTaskSnapshotDTO | undefined,
      logger: consoleLog,
    };
    return setOnethingSchedulerTaskEnabledForIpc(setOnethingSchedulerTaskEnabledOptions)
  },
  async createTask(request) {
    return createOnethingUserSchedulerTaskForIpc({
      request,
      createUserTask: createUserSchedulerTask,
      logger: consoleLog,
    }) as Promise<{ success: true; task: SchedulerTaskSnapshotDTO } | { success: false; error: string }>
  },
  async updateTask(request) {
    const updateOnethingUserSchedulerTaskOptions: UpdateOnethingUserSchedulerTaskOptions<SchedulerUpdateTaskRequest, SchedulerTaskSnapshotDTO> & { logger?: OnethingSchedulerIpcLogger | undefined; } = {
      request,
      isUserTask: isUserSchedulerTask,
      updateUserTask: updateUserSchedulerTask,
      logger: consoleLog,
    };
    return updateOnethingUserSchedulerTaskForIpc(updateOnethingUserSchedulerTaskOptions) as Promise<{ success: true; task: SchedulerTaskSnapshotDTO } | { success: false; error: string }>
  },
  async deleteTask(request) {
    const deleteOnethingUserSchedulerTaskOptions: DeleteOnethingUserSchedulerTaskOptions & { logger?: OnethingSchedulerUserTaskLogger } = {
      id: request.id,
      isUserTask: isUserSchedulerTask,
      deleteUserTask: deleteUserSchedulerTask,
      logger: consoleLog,
    };
    return deleteOnethingUserSchedulerTaskForIpc(deleteOnethingUserSchedulerTaskOptions)
  },
  // 存过的运行详情优先;一条都没有时回落到任务快照里的 recentRuns。
  async listRuns(request) {
    const listOnethingSchedulerRunsOptions: ListOnethingSchedulerRunsOptions<SchedulerRunRecord, SchedulerTaskSnapshotDTO, SchedulerRunDetailDTO> & { logger?: OnethingSchedulerIpcLogger | undefined; } = {
      taskId: request.taskId,
      limit: request.limit,
      listSavedRuns: listSchedulerRunDetails,
      getTaskStatus: taskId =>
        getScheduler().getStatus(taskId) as SchedulerTaskSnapshotDTO | undefined,
      toRunDetail,
      logger: consoleLog,
    };
    return listOnethingSchedulerRunsForIpc(listOnethingSchedulerRunsOptions)
  },
  async getRun(request) {
    const getOnethingSchedulerRunOptions: GetOnethingSchedulerRunOptions<SchedulerRunRecord, SchedulerTaskSnapshotDTO, SchedulerRunDetailDTO> & { logger?: OnethingSchedulerIpcLogger | undefined; } = {
      taskId: request.taskId,
      runId: request.runId,
      getSavedRun: getSchedulerRunDetail,
      getTaskStatus: taskId =>
        getScheduler().getStatus(taskId) as SchedulerTaskSnapshotDTO | undefined,
      toRunDetail,
      logger: consoleLog,
    };
    return getOnethingSchedulerRunForIpc(getOnethingSchedulerRunOptions)
  },
}

