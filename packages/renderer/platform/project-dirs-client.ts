/**
 * project-dirs(项目目录名册)域的渲染侧客户端 —— 结构债 P4c。
 *
 * 形状照 `spaces-client.ts` 的判例:壳外一个模块 + 通用 `platformApi.rpcInvoke`,
 * 四壳零改动;**不包一层旧签名** —— 被删掉的五个壳方法是位置参数的
 * (`projectDirsAdd(path, description, paths, workspaceId)`),这里一律是信封:
 * `projectDirsApi.add({ path, description, paths, workspaceId })`。
 *
 * 顺手修掉的一处说谎:web 壳原来把 `workspaceId` 收下就丢(参数名带下划线),
 * 浏览器里切空间等于没切。走这条通道之后它真的传下去了。
 */
import { projectDirsRouter } from '@shared/ipc/project-dirs.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const projectDirsApi = createRouterClient(projectDirsRouter, request =>
  platformApi.rpcInvoke(request),
)
