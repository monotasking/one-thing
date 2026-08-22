/**
 * files(文件面)域的渲染侧客户端 —— 结构债 P4c 第八批。
 *
 * 十四条数据面走通用 `rpc:invoke` / `POST /api/rpc`;**一条推送不在这里** ——
 * `onWorkspaceFileChanged` 仍然是 `platformApi` 上的订阅(桌面
 * `ipcRenderer.on(FILE_WATCH_EVENT)`、web `/api/files/watch/events` SSE),
 * router 今天没有推送面。
 *
 * 被删掉的壳方法有一半是**位置参数**的(`readFileContent(path, maxSize)`、
 * `renamePath(old, new)`、`statPath(path)`)。这里一律是信封:
 * `filesApi.readContent({ path, maxSize })`、`filesApi.rename({ oldPath, newPath })`、
 * `filesApi.stat({ path })` —— 与 themes / oauth 同判例,不包一层旧签名。
 */
import { filesRouter } from '@shared/ipc/files.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const filesApi = createRouterClient(filesRouter, request =>
  platformApi.rpcInvoke(request),
)
