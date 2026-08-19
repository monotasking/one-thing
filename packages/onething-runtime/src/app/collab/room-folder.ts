/**
 * 群 folder —— 一个群随手放东西的地方(docs/design/collab-team-v2.md §7)。
 *
 * 定义只有一句:**roomFolder(room) = workingDirectory ?? <store>/rooms/<id>/**。
 * 房间自己设过工作目录就以它为准(尊重用户设置,不改变现存房间的执行语义);
 * 没设过就自动给一个,首次需要时才建。
 *
 * 为什么值得单独一个概念:union 之后群里的成员本来就有 write/edit,"把文档
 * 放哪儿"从一个需要新工具的问题退化成一个需要 cwd 的问题。给了 cwd,「随手
 * 放个文档」自动成立。
 *
 * 顺带统一了 W17 的一处错位:卡上的 evidence 此前按 workingDirectory 相对化,
 * 而没设 workingDirectory 的房间只能显示绝对路径,于是"卡上的文件名"和
 * "folder 里的文件名"是两套东西。基准换成 roomFolder 之后它们是同一套。
 *
 * 生命周期:删房间时 folder **保留不删**(数据安全默认)——`disposeCollabRoom`
 * 清的是运行时与 collab/ 下的账,不是人放进去的东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as store from '../store.js'
import { getStorePath } from '../stores/paths.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.room')


/** 自动分配的群 folder 根目录名。 */
export const COLLAB_ROOMS_DIR = 'rooms'

/**
 * 这个群的 folder 路径。不建目录 —— 只回答"在哪儿"。
 *
 * 非房间会话返回 undefined:工作台和常驻会话都通过它们的 roomSessionId 问,
 * 问错了地方应该得到"没有",而不是一个凭空捏造的目录。
 */
export function collabRoomFolder(roomSessionId: string): string | undefined {
  const session = store.getSession(roomSessionId)
  if (session?.kind !== 'room') return undefined
  const configured = session.workingDirectory?.trim()
  if (configured) return configured
  return path.join(getStorePath(), COLLAB_ROOMS_DIR, roomSessionId)
}

/**
 * 同上,但保证目录存在 —— 要往里写东西之前用它。
 *
 * 建不出来就返回 undefined 而不是抛:一个建不了目录的房间仍然应该能聊天,
 * 只是没有 cwd 可给(调用方退回旧行为:不设工作目录)。
 */
export function ensureCollabRoomFolder(roomSessionId: string): string | undefined {
  const folder = collabRoomFolder(roomSessionId)
  if (!folder) return undefined
  try {
    fs.mkdirSync(folder, { recursive: true })
  } catch (error) {
    log.error('room folder create failed', { roomSessionId, folder }, error)
    return undefined
  }
  // 自动分配的 folder 落到房间的 workingDirectory 上,一次。
  //
  // 它本来就是这个房间的工作目录,只是此前没人写下来;写下来之后每一个既有
  // 读者(看板的交付物解析、渲染进程的相对路径还原、房间设置面板)自动看得见
  // 同一个答案,不必各自再实现一遍 `?? <store>/rooms/<id>` 这条回退。
  // 用户设过的目录走不到这里(collabRoomFolder 直接返回它)。
  const session = store.getSession(roomSessionId)
  if (session && !session.workingDirectory) {
    store.updateSessionWorkingDirectory(roomSessionId, folder)
  }
  return folder
}

/* ── 只读列目录(docs/design/agent-im-chat-ui.md §3.2「文件」块)───────────── */

/** 浅层递归:folder 自己 + 两层子目录。再深就不是"随手放东西的地方"了。 */
const FOLDER_MAX_DEPTH = 2
/** 条目上限。一个被当成工作目录用的 folder 可能是整个代码仓库。 */
const FOLDER_MAX_ENTRIES = 300

export interface CollabRoomFolderEntry {
  /** 相对 folder 的路径,永远 `/` 分隔。 */
  relativePath: string
  path: string
  size: number
  mtimeMs: number
}

export interface CollabRoomFolderListing {
  folder?: string
  entries: CollabRoomFolderEntry[]
  /** 目录还没建过 —— 不是错误,是空。 */
  missing: boolean
  truncated: boolean
}

/** 噪音目录:一个被设成代码仓库的 workingDirectory 里,这些不是"人放的东西"。 */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'out'])

/**
 * 列出这个房间 folder 里的文件。**只读**,不建目录 —— 问"有什么"不该有副作用。
 *
 * 隐藏文件与噪音目录(node_modules/.git/…)不进列表:folder 的语义是"随手放
 * 东西的地方",不是文件管理器。列不动就当空,不抛 —— 空文件页比一页报错有用。
 */
export function listCollabRoomFolder(roomSessionId: string): CollabRoomFolderListing {
  const folder = collabRoomFolder(roomSessionId)
  if (!folder) return { entries: [], missing: true, truncated: false }
  if (!fs.existsSync(folder)) return { folder, entries: [], missing: true, truncated: false }

  const entries: CollabRoomFolderEntry[] = []
  let truncated = false

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (truncated) return
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (truncated) return
      if (dirent.name.startsWith('.') || SKIPPED_DIRS.has(dirent.name)) continue
      const absolute = path.join(dir, dirent.name)
      const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (depth < FOLDER_MAX_DEPTH) walk(absolute, relativePath, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      if (entries.length >= FOLDER_MAX_ENTRIES) {
        truncated = true
        return
      }
      let size = 0
      let mtimeMs = 0
      try {
        const stat = fs.statSync(absolute)
        size = stat.size
        mtimeMs = stat.mtimeMs
      } catch {
        // 列得出名字但 stat 不到:仍然成行,只是没有大小/时间。
      }
      entries.push({ relativePath, path: absolute, size, mtimeMs })
    }
  }

  walk(folder, '', 0)
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath))
  return { folder, entries, missing: false, truncated }
}
