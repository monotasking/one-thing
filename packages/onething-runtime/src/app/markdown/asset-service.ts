import {
  findOnethingObsidianVaultRoot,
  resolveOnethingMarkdownAsset,
  saveOnethingMarkdownAttachments,
  type MarkdownAssetResolution,
  type MarkdownResolveAssetRequest,
  type MarkdownSaveAttachmentsRequest,
  type MarkdownSaveAttachmentsResponse,
  type OnethingMarkdownAssetServiceAdapters,
} from '@onething/runtime/markdown'
import { getSettings } from '../stores/settings.js'
import { getConnectedDirectories } from '../stores/connected-directories.js'
import { getVariablesStore } from '../variables/store/index.js'

/**
 * **停留在全局层**(批 B2)。markdown 附件根服务的是笔记编辑器:它的请求坐标是
 * 一个文档路径,整条链路上没有会话,也没有一条诚实的路能补出会话号 —— 编辑器
 * 可以在没有任何会话打开时使用。猜「当前空间」会让同一份文档在不同时刻解析出
 * 不同的附件根,比只认全局层更糟。等编辑器本身带上会话/空间语境时再接。
 */
function markdownRuntimeAdapters(): OnethingMarkdownAssetServiceAdapters {
  return {
    getEditorSettings: () => getSettings().general.editor || {},
    getNoteRoots: () => {
      const store = getVariablesStore()
      return [
        store.getUserNoteDir(),
        store.getWorkNoteDir(),
        ...getConnectedDirectories(),
      ]
    },
  }
}

export const findObsidianVaultRoot = findOnethingObsidianVaultRoot

export async function resolveMarkdownAsset(
  request: MarkdownResolveAssetRequest,
): Promise<MarkdownAssetResolution> {
  return resolveOnethingMarkdownAsset(request, markdownRuntimeAdapters())
}

export async function saveMarkdownAttachments(
  request: MarkdownSaveAttachmentsRequest,
): Promise<MarkdownSaveAttachmentsResponse> {
  return saveOnethingMarkdownAttachments(request, markdownRuntimeAdapters())
}
