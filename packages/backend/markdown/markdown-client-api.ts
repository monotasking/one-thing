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
} from '@onething/backend/markdown'
import { markdownRouter, type MarkdownRoutes } from '@shared/ipc/markdown.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import {
  clampResolvedAsset,
  clampSavedAttachments,
  prepareMarkdownRequest,
} from '@onething/backend/markdown/asset-sandbox'
import { resolveRpcSandbox } from '@onething/backend/http-server/http-server-sandbox.js'
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'

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


/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `markdown` 的契约与处理者。 */
export const MARKDOWN_CLIENT_API = defineClientApi({ id: 'rpc:markdown', router: markdownRouter, handlers: markdownRpcHandlers })
