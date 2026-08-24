/**
 * project-dirs(项目目录名册)域 —— 结构债 P4c 的第六个域,也是本批唯一一个
 * **带 context 的安全域**(与 `markdown` / `permission-grants` 同型)。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/project-dirs.ts` + `project-dirs-controller.ts` 的手写
 *    IPC 工厂与 `apps/electron/src/main/ipc/project-dirs.ts` 的三行 re-export;
 *  - `preload/bridge.ts` 的五条位置参数包装与 `platform/web.ts` 的五条
 *    `/api/project-dirs*` 镜像;
 *  - `app/server/http.ts` 的五条 REST 路由、`server/runtime.ts` 的 `projectDirs`
 *    facade adapter,以及只服务于它的 `ServerProjectDirsStore` 那一整套 per-owner
 *    存储(`owners/<uid>/<wid>/project-dirs.json`)。
 *
 * **护栏没有丢,它换了住处**。旧 server adapter 在五件套的每条路径上都调
 * `resolveServerWorkspaceFilePath` 夹进 `<workspaceRoot>/<uid>/<wid>`,夹不住就回
 * `{ success:false, code:'WORKSPACE_PATH' }`;桌面那条线从来没有这道夹(用户自己的
 * 机器,说哪就是哪)。批 3 的 `RpcDispatchContext` 补上了输入,所以两种语义可以
 * 由**同一份实现**给出(`app/rpc/sandbox.ts`,三条不变量写在那个文件头):
 *  - `transport:'ipc'`(桌面)→ 未夹紧,与迁移前 `@main` handler 逐字同义;
 *  - `transport:'http'`(server)→ 夹进 sandboxRoot,与迁移前的 adapter 同义,
 *    失败形状连 `code` 一起保持原样。
 *
 * 另一处**迁后 web 行为会变,而且是变对**:被删掉的 web 壳把 `workspaceId` 收下
 * 就丢(参数名一律带下划线),server 那侧的 adapter 也没有 space 维度 —— 于是浏览器里
 * 切空间等于没切,五件套永远打在 default 名册上。走 router 之后 `workspaceId` 真的
 * 传到 `getProjectsStore` 了,web 与桌面从此看见同一份 per-space 名册。
 */
import {
  addOnethingProjectDirForIpc,
  getOnethingProjectDirForIpc,
  listOnethingProjectDirsForIpc,
  removeOnethingProjectDirForIpc,
  updateOnethingProjectDirForIpc,
} from '@onething/runtime/project-dirs'
import { getProjectsStore } from '@onething/runtime/project-dirs/store'
import type { ProjectDirsRoutes } from '@shared/ipc/project-dirs.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { resolveInsideSandbox, resolveRpcSandbox, type RpcSandbox } from '../sandbox.js'
import type { RpcRouteHandlers } from '../registry.js'

/** 夹不住时的答案。逐字沿用 server 那份 —— 渲染层按 `code` 分支的地方不用改。 */
const PATH_ERROR = {
  success: false as const,
  error: 'Project directory path must stay inside the workspace sandbox root.',
  code: 'WORKSPACE_PATH',
}

/** 一组路径全部夹进沙箱;任何一条夹不住,整条请求就拒 —— 不做部分接受。 */
function clampPaths(sandbox: RpcSandbox, paths: string[]): string[] | null {
  const resolved: string[] = []
  for (const path of paths) {
    const inside = resolveInsideSandbox(sandbox, path)
    if (!inside) return null
    resolved.push(inside)
  }
  return resolved
}

export const projectDirsRpcHandlers: RpcRouteHandlers<ProjectDirsRoutes> = {
  // list 不带路径,所以不需要夹;它要两个端口(名册索引 + 逐条详情),投影据此拼摘要。
  async list(request) {
    const store = getProjectsStore(request?.workspaceId)
    return listOnethingProjectDirsForIpc({
      listEntries: () => store.list(),
      getProject: path => store.get(path),
    })
  },
  async get(request, context = DESKTOP_RPC_CONTEXT) {
    const path = resolveInsideSandbox(resolveRpcSandbox(context), request.path)
    if (!path) return PATH_ERROR
    return getOnethingProjectDirForIpc({
      request: { path },
      getProject: targetPath => getProjectsStore(request.workspaceId).get(targetPath),
    })
  },
  async add(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const path = resolveInsideSandbox(sandbox, request.path)
    if (!path) return PATH_ERROR
    // `paths` 缺席 = 只有主根;空数组同样按「没给」处理(旧 adapter 的 `length > 0`)。
    let paths: string[] | undefined
    if (request.paths && request.paths.length > 0) {
      const clamped = clampPaths(sandbox, request.paths)
      if (!clamped) return PATH_ERROR
      paths = clamped
    }
    return addOnethingProjectDirForIpc({
      request: { path, paths, description: request.description },
      addProject: input => getProjectsStore(request.workspaceId).add(input),
    })
  },
  async update(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const path = resolveInsideSandbox(sandbox, request.path)
    if (!path) return PATH_ERROR
    // 这里的 `paths` 是**整表替换**,所以缺席(undefined)与空数组语义不同:
    // 前者 = 不动根列表,后者 = 交一张空表下去,由投影自己判。
    let paths: string[] | undefined
    if (request.paths) {
      const clamped = clampPaths(sandbox, request.paths)
      if (!clamped) return PATH_ERROR
      paths = clamped
    }
    return updateOnethingProjectDirForIpc({
      request: { path, description: request.description, paths },
      updateProject: (targetPath, patch) =>
        getProjectsStore(request.workspaceId).update(targetPath, patch),
    })
  },
  async remove(request, context = DESKTOP_RPC_CONTEXT) {
    const path = resolveInsideSandbox(resolveRpcSandbox(context), request.path)
    if (!path) return PATH_ERROR
    return removeOnethingProjectDirForIpc({
      request: { path },
      removeProject: targetPath => getProjectsStore(request.workspaceId).remove(targetPath),
    })
  },
}

