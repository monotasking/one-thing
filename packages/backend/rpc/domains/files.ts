/**
 * files(文件面)域 —— 结构债 P4c 第八批,十四条数据面整只从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/files.ts` 的手写 IPC 工厂(连同它的
 *    `__tests__/files.test.ts`)+ `apps/electron/src/main/ipc/files.ts` 那层壳适配
 *    (`IPC_CHANNELS` 上那十四条 `files:*` / `file:*` / `dirs:*` invoke 通道);
 *  - `preload/bridge.ts` 的十四条包装(其中八条是位置参数的)与 `platform/web.ts`
 *    的十四条 REST 镜像;
 *  - `server/http.ts` 的十四条 REST 路由与 `server/runtime.ts` 的 `files` facade
 *    adapter 的**数据面十四条**。
 *
 * 留下的只有一条:`FILE_WATCH_EVENT` 推送(router 没有推送面)与它在 server 那
 * 一侧的 SSE 源 `GET /api/files/watch/events` —— facade 上因此只剩
 * `subscribeWorkspaceFileChanged` 一格。
 *
 * ## #19 的安全面:逐方法的 http 夹紧
 *
 * 这是全仓第一个把「沙箱护栏」逐方法写进域处理者的域。规矩(`../sandbox.ts`
 * 的三条不变量):`transport:'ipc'` 不夹 —— 桌面是用户自己的机器,与迁移前
 * `@main` handler 逐字同义;`transport:'http'` 夹进 `context.sandboxRoot`,
 * 越界回结构化失败,**文案逐字沿用旧 server 路由的原话**。
 *
 * 逐条对照旧 `server/runtime.ts` 的 `files` adapter,一条不多一条不少:
 *
 * | 方法            | http 夹哪些路径              | 越界文案(逐字沿用)                                              |
 * | --------------- | ---------------------------- | ----------------------------------------------------------------- |
 * | `list`          | `cwd`(缺席=沙箱根)+ 每个搜索根 | "File search must stay inside the workspace sandbox root."         |
 * | `listDirs`      | `basePath`(空=沙箱根)+ 逐次 stat/readdir | "Directory completion must stay inside the workspace sandbox root." |
 * | `readContent`   | `path`                        | "File path must stay inside the workspace sandbox root."           |
 * | `saveContent`   | `path`                        | "File path must stay inside the workspace sandbox root."           |
 * | `rollback`      | `auditPath` / `filePath`(各自可缺席) | "Audit path …" / "Rollback file path must stay inside …"      |
 * | `listDirectory` | `path`                        | "Directory path must stay inside the workspace sandbox root."      |
 * | `stat`          | `path`                        | "Path must stay inside the workspace sandbox root."                |
 * | `create`        | `path`                        | "File path must stay inside the workspace sandbox root."           |
 * | `createDirectory` | `path`                      | "Directory path must stay inside the workspace sandbox root."      |
 * | `rename`        | `oldPath` **与** `newPath`(任一越界即拒) | "Rename paths must stay inside the workspace sandbox root."  |
 * | `delete`        | `path`                        | "Path must stay inside the workspace sandbox root."                |
 * | `reveal`        | `path`(夹了,但夹过之后照样做不到,见下) | "Path must stay inside the workspace sandbox root."      |
 * | `watchStart`    | `root`                        | "Workspace watch root must stay inside the workspace sandbox root." |
 * | `watchStop`     | `root`                        | "Workspace watch root must stay inside the workspace sandbox root." |
 *
 * **没有一条是「旧 server 本来不夹、这里新夹上」的** —— 旧 adapter 对这十四条
 * 全都调了 `resolveServerWorkspaceFilePath`。
 *
 * ## 三处 http 分叉(不是夹紧,是能力差)
 *
 * 1. **`list` 的搜索根**。桌面给的是 `os.homedir()` + 下载目录 + 笔记根 +
 *    **按会话解析的接入目录**(批 B2),文件枚举走 ripgrep;http 给的是沙箱根
 *    (`homeDir` 也是沙箱根)、无下载目录、无笔记根、**无接入目录**,文件枚举走
 *    `wiring/files/workspace-walk.ts` 那个走查器 —— 逐字对齐旧 adapter 的 `listServerToolFiles`
 *    无 glob 分支(跳过 `.git`,产出 posix 相对路径)。不改成 ripgrep,是因为
 *    「联网宿主上有没有 rg 二进制」不是这一批该赌的事。
 *
 * 2. **`reveal` 要宿主外壳**。「在文件管理器里定位」只有 Electron 桌面做得到,
 *    走 `@onething/runtime/shell` 的 `configureShellHost`(P4c 第二批立的端口,
 *    那个文件头写着 files 留给后批 —— 就是这一批)。未注入即结构化降级,
 *    与旧 server 那句写死的 "Revealing local files is not available in the web
 *    server runtime." 同义,区别是不再需要第二份实现。**注意先夹后降级**:
 *    路径越界的答案仍然是越界文案,而不是「宿主没有外壳能力」。
 *
 * 3. **`watchStart` / `watchStop` 的真假**。桌面这两条从来是**投影桩**
 *    (`startOnethingFileWatchForIpc`:校验 root 之后回 `{success:true}`)——
 *    全仓没有任何地方往 `FILE_WATCH_EVENT` 发过消息,桌面从来没有真的监视过。
 *    http 那侧是真的:开 `fs.watch`,喂 `/api/files/watch/events` 的 SSE。
 *    这里**逐字保留这个差别**:给桌面装上真监视器会是一次未经拍板的行为变化
 *    (而且是一个没有消费者的 watcher 泄漏)。登记簿搬到了
 *    `../../wiring/files/workspace-watch.ts`,按沙箱根分表,server 的 SSE 从
 *    同一张表订阅。
 */
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  createOnethingDirectory,
  createOnethingFile,
  deleteOnethingPath,
  listOnethingDirectoriesForCompletionForIpc,
  listOnethingDirectory,
  listOnethingFileSearchEntriesForIpc,
  readOnethingFileContent,
  renameOnethingPath,
  revealOnethingPath,
  rollbackOnethingFile,
  saveOnethingFileContent,
  startOnethingFileWatchForIpc,
  statOnethingPath,
  stopOnethingFileWatchForIpc,
} from '@onething/runtime/files'
import { getShellHost, SHELL_HOST_UNAVAILABLE } from '@onething/runtime/shell/host-ports'
import { applyFileMutationUndo } from '@onething/runtime/tools'
import { getVariablesStore } from '@onething/runtime/variables/store-bound'
import { filesRouter, type FilesRoutes } from '@shared/ipc/files.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import { listFiles as ripgrepListFiles } from '../../utils/ripgrep.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { getDownloadsDirectory } from '../../wiring/tools/core/sandbox.js'
import {
  startWorkspaceWatch,
  stopWorkspaceWatch,
} from '../../wiring/files/workspace-watch.js'
import { walkWorkspaceFiles } from '../../wiring/files/workspace-walk.js'
import {
  resolveInsideSandbox,
  resolveRpcSandbox,
  type RpcSandbox,
} from '../sandbox.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

const log = getLogger('rpc.files')
/** 投影层收的是鸭子 logger;从前 `@main` 那层递的是裸 `console`。 */
const consoleLog = consolePort(log)

/** 夹不住时的答案 —— 文案由调用点逐条给(旧 server 路由每条各有原话)。 */
function pathError(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** `list` 夹不住时的答案 —— 它的失败形状带空表(旧 `emptyWorkspaceFileList`)。 */
function emptyFileList(error: string): {
  success: false
  files: []
  entries: []
  error: string
} {
  return { success: false, files: [], entries: [], error }
}

/**
 * 沙箱根 —— `watchStart` / `watchStop` 的登记簿键,以及 `list` / `listDirs` 在
 * http 上的默认根与 `homeDir`。未夹紧(桌面)时用 `os.homedir()`,与迁移前
 * `@main/ipc/files.ts` 递的那一个逐字相同。
 */
function homeOf(sandbox: RpcSandbox): string {
  return sandbox.confined ? sandbox.root : homedir()
}

export const filesRpcHandlers: RpcRouteHandlers<FilesRoutes> = {
  async list(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const homeDir = homeOf(sandbox)

    // 桌面:cwd 原样递下去(缺席由投影自己兜底);http:缺席 = 沙箱根,给了就夹。
    let cwd = request?.cwd
    if (sandbox.confined) {
      const clamped = resolveInsideSandbox(sandbox, request?.cwd ?? sandbox.root)
      if (!clamped) {
        return emptyFileList('File search must stay inside the workspace sandbox root.')
      }
      cwd = clamped
    }

    return listOnethingFileSearchEntriesForIpc({
      cwd,
      query: request?.query,
      limit: request?.limit,
      homeDir,
      downloadsDir: sandbox.confined ? null : getDownloadsDirectory(),
      getNoteRoots: sandbox.confined
        ? () => ({})
        : () => {
            const variablesStore = getVariablesStore()
            return {
              userNoteDir: variablesStore.getUserNoteDir(),
              workNoteDir: variablesStore.getWorkNoteDir(),
            }
          },
      // per-space:按请求携带的**会话归属**取(批 B2 / 设计盲点 1)。
      // 联网宿主没有这一层(旧 server adapter 也没有)。
      ...(sandbox.confined
        ? {}
        : { getConnectedDirs: () => getConnectedDirectoriesForSession(request?.sessionId) }),
      listFiles: root => {
        if (!sandbox.confined) {
          return ripgrepListFiles({ cwd: root.path, hidden: false, noIgnore: true })
        }
        const rootPath = resolveInsideSandbox(sandbox, root.path)
        return rootPath ? walkWorkspaceFiles(rootPath) : []
      },
      logger: consoleLog,
    })
  },

  async rollback(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)

    let auditPath = request?.auditPath
    let filePath = request?.filePath
    if (sandbox.confined) {
      if (request?.auditPath) {
        const clamped = resolveInsideSandbox(sandbox, request.auditPath)
        if (!clamped) {
          return pathError('Audit path must stay inside the workspace sandbox root.')
        }
        auditPath = clamped
      }
      if (request?.filePath) {
        const clamped = resolveInsideSandbox(sandbox, request.filePath)
        if (!clamped) {
          return pathError('Rollback file path must stay inside the workspace sandbox root.')
        }
        filePath = clamped
      }
    }

    return rollbackOnethingFile({
      auditPath,
      filePath,
      originalContent: request?.originalContent,
      isNew: request?.isNew,
      applyAuditUndo: applyFileMutationUndo,
      // 桌面用 `unlink`(与迁移前逐字一致);联网宿主用 `rm --force`
      // (旧 adapter 的写法 —— 沙箱里回滚一个已经不在的文件不该炸)。
      deleteFile: target => (sandbox.confined
        ? fs.rm(target, { force: true })
        : fs.unlink(target)),
      writeFile: (target, content) => fs.writeFile(target, content, 'utf-8'),
    })
  },

  async listDirs(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const homeDir = homeOf(sandbox)

    let basePath = request?.basePath
    if (sandbox.confined) {
      const clamped = resolveInsideSandbox(sandbox, request?.basePath || sandbox.root)
      if (!clamped) {
        return {
          success: false,
          dirs: [],
          basePath: '',
          error: 'Directory completion must stay inside the workspace sandbox root.',
        }
      }
      basePath = clamped
    }

    return listOnethingDirectoriesForCompletionForIpc({
      basePath,
      query: request?.query,
      limit: request?.limit,
      homeDir,
      stat: async target => {
        const resolved = sandbox.confined ? resolveInsideSandbox(sandbox, target) : target
        return resolved ? await fs.stat(resolved).catch(() => null) : null
      },
      readDir: async target => {
        const resolved = sandbox.confined ? resolveInsideSandbox(sandbox, target) : target
        return resolved ? await fs.readdir(resolved, { withFileTypes: true }) : []
      },
      logger: consoleLog,
    })
  },

  async readContent(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('File path must stay inside the workspace sandbox root.')
    }
    return readOnethingFileContent({
      path,
      maxSize: request?.maxSize,
      stat: filePath => fs.stat(filePath),
      async readBytes(filePath, byteLength) {
        const fileHandle = await fs.open(filePath, 'r')
        try {
          const buf = Buffer.alloc(byteLength)
          const { bytesRead } = await fileHandle.read(buf, 0, buf.length, 0)
          return buf.subarray(0, bytesRead)
        } finally {
          await fileHandle.close()
        }
      },
    })
  },

  async saveContent(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('File path must stay inside the workspace sandbox root.')
    }
    return saveOnethingFileContent({
      path,
      content: request?.content ?? '',
      expectedMtimeMs: request?.expectedMtimeMs,
      stat: filePath => fs.stat(filePath),
      writeFile: (filePath, content) => fs.writeFile(filePath, content, 'utf-8'),
    })
  },

  async listDirectory(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('Directory path must stay inside the workspace sandbox root.')
    }
    return listOnethingDirectory({
      path,
      readDir: dirPath => fs.readdir(dirPath, { withFileTypes: true }),
      stat: entryPath => fs.stat(entryPath).catch(() => null),
    })
  },

  async stat(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const path = clampWith(sandbox, request?.path)
    if (path === null) {
      return pathError('Path must stay inside the workspace sandbox root.')
    }
    return statOnethingPath({
      path,
      homeDir: homeOf(sandbox),
      stat: target => fs.stat(target),
    })
  },

  async create(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('File path must stay inside the workspace sandbox root.')
    }
    return createOnethingFile({
      path,
      content: request?.content,
      createFile: (filePath, content) => fs.writeFile(filePath, content, { flag: 'wx' }),
    })
  },

  async createDirectory(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('Directory path must stay inside the workspace sandbox root.')
    }
    return createOnethingDirectory({
      path,
      createDirectory: dirPath => fs.mkdir(dirPath, { recursive: false }).then(() => undefined),
    })
  },

  async rename(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const oldPath = clampWith(sandbox, request?.oldPath)
    const newPath = clampWith(sandbox, request?.newPath)
    if (oldPath === null || newPath === null) {
      return pathError('Rename paths must stay inside the workspace sandbox root.')
    }
    return renameOnethingPath({ oldPath, newPath, renamePath: fs.rename })
  },

  async delete(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('Path must stay inside the workspace sandbox root.')
    }
    return deleteOnethingPath({
      path,
      deletePath: target => fs.rm(target, { recursive: true, force: false }),
    })
  },

  async reveal(request, context = DESKTOP_RPC_CONTEXT) {
    // 先夹后降级:越界的答案是越界文案,不是「宿主没有外壳能力」。
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('Path must stay inside the workspace sandbox root.')
    }
    return revealOnethingPath({
      path,
      stat: target => fs.stat(target),
      // 未注入宿主 = 抛;投影自己 catch 成 `{ success:false, error }`,
      // 于是「宿主没有外壳能力」与「路径不存在」走的是同一条失败路。
      revealPath: async target => {
        const outcome = await getShellHost().revealPath(target)
        if (!outcome.success) throw new Error(outcome.error ?? SHELL_HOST_UNAVAILABLE)
      },
    })
  },

  async watchStart(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    // 桌面:投影桩,与迁移前逐字一致(全仓没有 FILE_WATCH_EVENT 的发送方)。
    if (!sandbox.confined) return startOnethingFileWatchForIpc({ root: request?.root })
    const root = resolveInsideSandbox(sandbox, request?.root ?? '')
    if (!root) {
      return pathError('Workspace watch root must stay inside the workspace sandbox root.')
    }
    return startWorkspaceWatch(sandbox.root, root)
  },

  async watchStop(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    if (!sandbox.confined) return stopOnethingFileWatchForIpc({ root: request?.root })
    const root = resolveInsideSandbox(sandbox, request?.root ?? '')
    if (!root) {
      return pathError('Workspace watch root must stay inside the workspace sandbox root.')
    }
    return stopWorkspaceWatch(sandbox.root, root)
  },
}

/**
 * 单路径夹紧的两个写法 —— 一个从 context 起,一个复用已解析的 sandbox。
 *
 * **未夹紧时原样返回**(连空串也原样),因为桌面语义就是「渲染层说哪就是哪」:
 * 迁移前 `@main/ipc/files.ts` 把 `request.path` 直接递给投影,空串由投影自己
 * 答 "File path is required"。这里若改走 `resolveInsideSandbox`,空串会变成
 * null、答案会变成沙箱文案 —— 那是桌面上一次没人要的行为变化。
 */
function clamp(context: RpcDispatchContext, path: string | undefined): string | null {
  return clampWith(resolveRpcSandbox(context), path)
}

function clampWith(sandbox: RpcSandbox, path: string | undefined): string | null {
  if (!sandbox.confined) return path ?? ''
  return resolveInsideSandbox(sandbox, path ?? '')
}

export function registerFilesRpcDomain(): () => void {
  return registerRouterHandlers(filesRouter, filesRpcHandlers)
}
