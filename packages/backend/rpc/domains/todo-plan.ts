/**
 * Todo / plan 的**数据面**（主线 T1 第一批，部分迁移）。
 *
 * `apps/electron/src/main/ipc/todo-plan.ts` 没有整只删掉，它收缩成了只剩窗口面
 * （open / hide / toggle / setPinned）与 `configureTodoPlanHost` 的注入——那四条
 * 直接操作 BrowserWindow，属于宿主原生，永远不该到这里来。
 *
 * `revealDirectory` 反而可以：它走的是 `configureTodoPlanHost({ revealDirectory })`
 * 端口，未注入端口的宿主（server / CLI daemon）自然降级成 no-op，而不是报错。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import type { TodoPlanRoutes } from '@shared/ipc/todo-plan.js'
import {
  createOnethingTodoNoteForIpc,
  deleteOnethingTodoNoteForIpc,
  getOnethingTodoPlanForIpc,
  renameOnethingTodoNoteForIpc,
  revealOnethingTodoPlanDirectoryForIpc,
  updateOnethingTodoPlanDocumentForIpc,
} from '@onething/runtime/todo-plan'
import {
  canRevealTodoPlanDirectory,
  createUserTodoNote,
  deleteUserTodoNote,
  readTodoPlanSnapshot,
  renameUserTodoNote,
  revealTodoPlanDirectory,
  updateTodoPlanDocument,
} from '../../wiring/todo-plan/store.js'

export const todoPlanRpcHandlers: RouteHandlers<TodoPlanRoutes> = {
  async get(request) {
    return getOnethingTodoPlanForIpc({
      request,
      readSnapshot: readTodoPlanSnapshot,
    })
  },
  async create(request) {
    return createOnethingTodoNoteForIpc({
      request,
      createUserNote: createUserTodoNote,
    })
  },
  async update(request) {
    return updateOnethingTodoPlanDocumentForIpc({
      request,
      updateDocument: updateTodoPlanDocument,
    })
  },
  async rename(request) {
    return renameOnethingTodoNoteForIpc({
      request,
      renameUserNote: renameUserTodoNote,
    })
  },
  async delete(request) {
    return deleteOnethingTodoNoteForIpc({
      request,
      deleteUserNote: deleteUserTodoNote,
    })
  },
  async revealDirectory() {
    // 端口没注入的宿主(server / CLI)照实说不支持,而不是让 no-op 冒充成功
    // ——迁移前 server 给的就是这句实话,传输面统一不该把它换成一句假话。
    if (!canRevealTodoPlanDirectory()) {
      return {
        success: false,
        error: 'Opening the todo plan directory is not available in this host.',
      }
    }
    return revealOnethingTodoPlanDirectoryForIpc({
      revealDirectory: revealTodoPlanDirectory,
    })
  },
}

