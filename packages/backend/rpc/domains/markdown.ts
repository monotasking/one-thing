/**
 * `markdown` 域 —— 主线 T 批 3 的第一个「带 context 的安全域」。
 *
 * 迁移前它横穿五处：`channels.ts` 两个常量、`@main/ipc/markdown.ts`、
 * `preload/bridge.ts`、`platform/web.ts`、`apps/server` 的两条 HTTP 路由 + 一整
 * 套 `*ServerMarkdown*` 沙箱 helper。批 1 因为「通用信封不带 request context」
 * 把它退了回去；批 3 的 `RpcDispatchContext` 补上输入，护栏搬进
 * `app/markdown/asset-service.ts`，桌面与 server 从此共用同一份实现：
 *
 * - `transport:'ipc'`（桌面）→ 未夹紧，与迁移前 `@main` handler 逐字同义；
 * - `transport:'http'`（server）→ 夹进 `<workspaceRoot>/<uid>/<wid>`，与迁移前
 *   `prepareServerMarkdownRequest` + `sanitizeServerMarkdownAsset` 同义。
 *
 * 失败形状保持两个方法各自原样：`resolveAsset` 回 `{success:false,error}`，
 * `saveAttachments` 额外带 `code:'WORKSPACE_PATH'` —— 迁移前 server 就是这么答的，
 * 渲染层的分支不用改。
 */
import {
  resolveOnethingMarkdownAsset,
  resolveOnethingMarkdownAssetForIpc,
  saveOnethingMarkdownAttachments,
  saveOnethingMarkdownAttachmentsForIpc,
} from '@onething/runtime/markdown'
import { markdownRouter, type MarkdownRoutes } from '@shared/ipc/markdown.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import {
  clampResolvedAsset,
  clampSavedAttachments,
  prepareMarkdownRequest,
} from '../../wiring/markdown/asset-service.js'
import { resolveRpcSandbox } from '../sandbox.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

export const markdownRpcHandlers: RpcRouteHandlers<MarkdownRoutes> = {
  async resolveAsset(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const prepared = await prepareMarkdownRequest(sandbox, request ?? {})
    if ('error' in prepared) return { success: false, error: prepared.error }
    if (typeof request?.rawTarget !== 'string' || !request.rawTarget) {
      return { success: false, error: 'Markdown asset target is required.' }
    }

    return resolveOnethingMarkdownAssetForIpc({
      request: {
        documentPath: prepared.documentPath,
        workspaceRoot: prepared.workspaceRoot,
        rawTarget: request.rawTarget,
      },
      resolveAsset: async markdownRequest => clampResolvedAsset(
        sandbox,
        await resolveOnethingMarkdownAsset(markdownRequest, prepared.adapters),
      ),
    })
  },

  async saveAttachments(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const prepared = await prepareMarkdownRequest(sandbox, request ?? {})
    if ('error' in prepared) {
      return { success: false, error: prepared.error, code: 'WORKSPACE_PATH' }
    }

    return saveOnethingMarkdownAttachmentsForIpc({
      request: {
        documentPath: prepared.documentPath,
        workspaceRoot: prepared.workspaceRoot,
        files: Array.isArray(request?.files) ? request.files : [],
      },
      saveAttachments: async markdownRequest => clampSavedAttachments(
        sandbox,
        await saveOnethingMarkdownAttachments(markdownRequest, prepared.adapters),
      ),
    })
  },
}

/**
 * 直接注册（不经 feature 基座）。装配走 `app/rpc/index.ts` 的 feature 名册；
 * 这个入口留给**域级测试**——它要的是一个域，不是整套 feature 生命周期。
 */
export function registerMarkdownRpcDomain(): () => void {
  return registerRouterHandlers(markdownRouter, markdownRpcHandlers)
}
