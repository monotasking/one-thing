/**
 * Markdown 附件服务的装配层半边 —— 适配器装配 + 工作区沙箱守卫。
 *
 * 主线 T 批 3：本模块唯一的消费者是 `app/rpc/domains/markdown.ts`。批 3 之前
 * 它只装配适配器（桌面无沙箱概念），沙箱守卫住在 `apps/server/src/runtime.ts`
 * 里那一串 `*ServerMarkdown*` helper 上；`RpcDispatchContext` 把 request context
 * 补进通用信封之后，守卫搬到这里，两个宿主共用同一份实现。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  obsidianAttachmentRootStaysInside,
  type MarkdownAssetResolution,
  type MarkdownSaveAttachmentsResponse,
  type OnethingMarkdownAssetServiceAdapters,
} from '@onething/runtime/markdown'
import { isPathInside, resolveInsideSandbox, type RpcSandbox } from '../../rpc/sandbox.js'
import { getSettings } from '../../stores/settings.js'
import { getConnectedDirectories } from '../../stores/connected-directories.js'
import { getVariablesStore } from '@onething/runtime/variables/store-bound'

/**
 * **停留在全局层**(批 B2)。markdown 附件根服务的是笔记编辑器:它的请求坐标是
 * 一个文档路径,整条链路上没有会话,也没有一条诚实的路能补出会话号 —— 编辑器
 * 可以在没有任何会话打开时使用。猜「当前空间」会让同一份文档在不同时刻解析出
 * 不同的附件根,比只认全局层更糟。等编辑器本身带上会话/空间语境时再接。
 *
 * 沙箱化（主线 T 批 3）：夹紧时两个根都要重算 —— 附件目录夹进沙箱，笔记根
 * **清空**。清空不是偷懒：笔记根来自变量系统与接入目录，是**宿主机器上的用户
 * 数据**，在联网宿主上没有一条落在该 owner 沙箱里，逐条夹的结果必然是空集。
 * 这与迁移前 server 的 `createServerMarkdownAdapters`（`getNoteRoots: () => []`）
 * 逐字同义。
 */
function markdownRuntimeAdapters(sandbox: RpcSandbox): OnethingMarkdownAssetServiceAdapters {
  if (sandbox.confined) {
    const root = sandbox.root
    const editor = getSettings().general.editor
    return {
      getEditorSettings: () => ({
        markdownNoteAttachmentDirectory: clampAttachmentDirectory(
          editor?.markdownNoteAttachmentDirectory,
          root,
        ),
        markdownProjectAttachmentDirectory: clampAttachmentDirectory(
          editor?.markdownProjectAttachmentDirectory,
          root,
        ),
      }),
      getNoteRoots: () => [],
    }
  }
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

/**
 * 设置里的附件目录夹进沙箱；夹不住就当没配（回落到编辑器自己的默认行为），
 * 而不是报错 —— 这是一条**设置**，不是本次请求的输入，用户在桌面上配的绝对
 * 路径在联网宿主上落不进沙箱是常态，不该让每一次附件保存都失败。
 *
 * `~` / `$HOME/` 一律丢弃：联网宿主上没有「用户家目录」这个概念可言。
 */
function clampAttachmentDirectory(value: string | undefined, sandboxRoot: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('$HOME/')) return undefined
  const target = resolve(isAbsolute(trimmed) ? trimmed : join(sandboxRoot, trimmed))
  return isPathInside(target, sandboxRoot) ? target : undefined
}

/** 把 wiki 链接 / 尖括号 / `|` 别名 / `#` 锚点剥掉，露出真正的路径部分。 */
function cleanMarkdownTarget(rawTarget: string): string {
  let target = rawTarget.trim()
  const wiki = target.match(/^!?\[\[([\s\S]+)\]\]$/)
  if (wiki) target = wiki[1].trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
  target = target.split('|')[0].trim()
  target = target.split('#')[0].trim()
  try {
    return decodeURI(target)
  } catch {
    return target
  }
}

/**
 * 链接目标指向沙箱外了吗。
 *
 * 与 `apps/server` 的 `isServerMarkdownTargetSafe` 逐字同义：锚点与非 `file:`
 * 的 URL scheme 直接放行（那不是文件系统访问），`file:` 与绝对路径按解析后的
 * 路径判，相对路径先拒掉 `..` / `~` 段再按文档目录解析。
 */
function isTargetInsideSandbox(documentPath: string, sandboxRoot: string, rawTarget: string): boolean {
  const trimmed = rawTarget.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('#')) return true

  const target = cleanMarkdownTarget(rawTarget)
  if (!target) return true
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !target.toLowerCase().startsWith('file:')) return true

  if (target.toLowerCase().startsWith('file:')) {
    try {
      return isPathInside(fileURLToPath(target), sandboxRoot)
    } catch {
      return false
    }
  }

  if (isAbsolute(target)) return isPathInside(resolve(target), sandboxRoot)
  const parts = target.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.includes('..') || parts.includes('~')) return false
  return isPathInside(resolve(dirname(documentPath), target), sandboxRoot)
}

// Obsidian vault 配置的逃逸面判定是**产品逻辑**,住 runtime 的
// markdown/asset-service(那里本来就有 ObsidianConfig/readObsidianConfig 全套
// 原语);本层只当适配器,把沙箱根喂给它。T 批 3 曾在这里重新发明过一份,
// boundary 的 "owns Markdown asset service" 规则抓的就是那次越界。

export interface PreparedMarkdownRequest {
  documentPath: string
  workspaceRoot?: string
  adapters: OnethingMarkdownAssetServiceAdapters
}

export type PrepareMarkdownResult = PreparedMarkdownRequest | { error: string }

/**
 * 请求入口守卫：把 documentPath / workspaceRoot / rawTarget / vault 配置四处
 * 全部夹进沙箱，任何一处越界就返回一句错误（而不是抛）——调用方把它折成各自
 * 方法的失败形状。
 *
 * 未夹紧时只解析、不设限，逐字保留迁移前 `@main` handler 的行为：桌面上
 * documentPath 就是用户机器上的真实路径，没有可夹的东西。
 */
export async function prepareMarkdownRequest(
  sandbox: RpcSandbox,
  request: { documentPath?: unknown; workspaceRoot?: unknown; rawTarget?: unknown },
): Promise<PrepareMarkdownResult> {
  const documentPath = typeof request.documentPath === 'string'
    ? resolveInsideSandbox(sandbox, request.documentPath)
    : null
  if (!documentPath) {
    return { error: 'Markdown document path must stay inside the workspace sandbox root.' }
  }

  const requestedWorkspaceRoot = typeof request.workspaceRoot === 'string' && request.workspaceRoot
    ? resolveInsideSandbox(sandbox, request.workspaceRoot)
    : sandbox.confined ? sandbox.root : undefined
  if (typeof request.workspaceRoot === 'string' && request.workspaceRoot && !requestedWorkspaceRoot) {
    return { error: 'Markdown workspace root must stay inside the workspace sandbox root.' }
  }

  if (sandbox.confined) {
    if (
      typeof request.rawTarget === 'string'
      && !isTargetInsideSandbox(documentPath, sandbox.root, request.rawTarget)
    ) {
      return { error: 'Markdown asset target must stay inside the workspace sandbox root.' }
    }
    if (!(await obsidianAttachmentRootStaysInside(documentPath, sandbox.root))) {
      return { error: 'Markdown attachment configuration must stay inside the workspace sandbox root.' }
    }
  }

  return {
    documentPath,
    workspaceRoot: requestedWorkspaceRoot ?? undefined,
    adapters: markdownRuntimeAdapters(sandbox),
  }
}

/**
 * 出口守卫：解析器可能顺着 vault / 附件目录走出沙箱，入口夹紧不代表出口安全。
 * 越界的资产降级成 `missing` 而不是把绝对路径回给调用方（路径本身也是信息）。
 */
export function clampResolvedAsset(
  sandbox: RpcSandbox,
  asset: MarkdownAssetResolution,
): MarkdownAssetResolution {
  if (!sandbox.confined || !asset.absolutePath) return asset
  if (isPathInside(asset.absolutePath, sandbox.root)) return asset
  return {
    kind: 'missing',
    rawTarget: asset.rawTarget,
    error: 'Markdown asset path must stay inside the workspace sandbox root.',
  }
}

/** 出口守卫（写入面）：只要有一个附件落在沙箱外，整批算失败。 */
export function clampSavedAttachments(
  sandbox: RpcSandbox,
  result: MarkdownSaveAttachmentsResponse,
): MarkdownSaveAttachmentsResponse {
  if (!sandbox.confined || !result.success || !result.attachments?.length) return result
  if (result.attachments.every(attachment => isPathInside(attachment.absolutePath, sandbox.root))) {
    return result
  }
  return {
    success: false,
    error: 'Markdown attachments must stay inside the workspace sandbox root.',
    code: 'WORKSPACE_PATH',
  }
}
