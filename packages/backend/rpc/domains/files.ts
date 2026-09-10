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
 * 2026-08-30 用户拍板加了一条豁免:**本机可信宿主的 HTTP 面与 IPC 同权**
 * (`resolveFilesSandbox` 与 `server/host-trust.ts`)。下面那张夹紧表因此读作
 * 「http 且未声明本机可信」这一支;声明了可信的那一支走的是 `ipc` 那一列,一格
 * 不多一格不少。独立部署(非回环)的 server 不声明,表原样生效。
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
 *    http 那侧等待原生监听就绪,喂 `/api/files/watch/events` 的 SSE。
 *    这里**逐字保留这个差别**:给桌面装上真监视器会是一次未经拍板的行为变化
 *    (而且是一个没有消费者的 watcher 泄漏)。每个 server surface 拥有独立的
 *    `../../wiring/files/workspace-watch.ts` 实例；鉴权后的请求 context 只绑定
 *    当前实例的两个监听端口，SSE 从同一实例订阅，退出等待真实关闭。
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
import type { FilesRoutes } from '@shared/ipc/files.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import { listFiles as ripgrepListFiles } from '../../utils/ripgrep.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { getDownloadsDirectory } from '../../wiring/tools/core/sandbox.js'
import { walkWorkspaceFiles } from '../../wiring/files/workspace-walk.js'
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import {
  resolveInsideSandbox,
  resolveRpcSandbox,
  type RpcSandbox,
} from '../sandbox.js'
import type { RpcDispatchPorts, RpcRouteHandlersWithPorts } from '../registry.js'
import { sessionAccess } from '../../session/access.js'
import type { ListOnethingFileSearchEntriesForIpcOptions, OnethingFilesIpcLogger } from '@onething/runtime/files/file-search'
import type { RollbackOnethingFileOptions } from '@onething/runtime/files/file-rollback'
import type { ReadOnethingFileContentOptions, SaveOnethingFileContentOptions, ListOnethingDirectoryOptions, RevealOnethingPathOptions } from '@onething/runtime/files/file-operations'
import type { ListOnethingDirectoriesForCompletionOptions } from '@onething/runtime/files/directory-listing'
import type { OnethingDirectoryIpcLogger } from '@onething/runtime/files/directory-listing'
import type { ConsoleLikePort } from '@onething/runtime/logging'

const log = getLogger('rpc.files')
/** 投影层收的是鸭子 logger;从前 `@main` 那层递的是裸 `console`。 */
const consoleLog: ConsoleLikePort & OnethingDirectoryIpcLogger & OnethingFilesIpcLogger = consolePort(log)

/**
 * 本域的沙箱判据 —— 通用判据 + 一条**本机宿主豁免**(2026-08-30 用户拍板)。
 *
 * 通用的 `resolveRpcSandbox` 只问 transport:`'http'` 就夹。那条判据默认「联网
 * 宿主 = 别人的机器」,把本机自己那只 HTTP 面(桌面内嵌面 / 回环上的
 * `server:start`)也一起夹进了 `<workspaceRoot>/<uid>/<wid>` 那棵空子树 ——
 * 文件树 / 检索 / reveal 对仓内任何真实路径全被拒。
 *
 * 拍板:**本机可信宿主的 HTTP 面与 IPC 同权**(桌面 parity 既有裁定的延伸)。
 * 可信与否由装配处声明(`server/host-trust.ts`),请求信封一个字都没变 ——
 * 「身份由宿主 mint」的原则不动。豁免时走的就是桌面那条路,`resolveInsideSandbox`
 * 的未夹紧分支照样 `resolve()`,**没有引入任何新的放宽**。
 *
 * 独立部署(非回环绑定)的 server 一律不声明,`resolveRpcSandbox` 的三条不变量
 * 原样生效 —— 含「http 却没有 sandboxRoot = 接线 bug,直接抛」的 fail-closed。
 *
 * `project-dirs` / `markdown` 等域仍然直问 `resolveRpcSandbox`,那是另外的拍板。
 *
 * ## B2(2026-09-03,`docs/design/backend-transport-forks-2026-09.md` §2.2)
 *
 * 判据里的 `transport === 'http' &&` 去掉了:可信是**面级事实**,不是传输属性。
 * 声明过可信的进程里,`ipc` 与 `http` 得到的是同一个不夹紧的沙箱(桌面本来就
 * 走 `resolveRpcSandbox` 的 ipc 分支 → `{confined:false}`,逐字同);没声明的
 * 进程 `http` 照夹、`ipc` 照旧不夹。两种传输的答案因此仍然是今天那两个。
 */
function resolveFilesSandbox(context: RpcDispatchContext): RpcSandbox {
  if (isHostLocallyTrusted()) return { confined: false }
  return resolveRpcSandbox(context)
}

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

export const filesRpcHandlers: RpcRouteHandlersWithPorts<FilesRoutes> = {
  async list(request, context = DESKTOP_RPC_CONTEXT) {
    if (request?.sessionId) sessionAccess.resolve(context, request.sessionId, 'read')
    const sandbox = resolveFilesSandbox(context)
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

    const listOnethingFileSearchEntriesForIpcOptions: ListOnethingFileSearchEntriesForIpcOptions = {
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
    };
    return listOnethingFileSearchEntriesForIpc(listOnethingFileSearchEntriesForIpcOptions)
  },

  async rollback(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveFilesSandbox(context)

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

    const rollbackOnethingFileOptions: RollbackOnethingFileOptions = {
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
    };
    return rollbackOnethingFile(rollbackOnethingFileOptions)
  },

  async listDirs(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveFilesSandbox(context)
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

    const listOnethingDirectoriesForCompletionOptions: ListOnethingDirectoriesForCompletionOptions & { logger?: OnethingDirectoryIpcLogger } = {
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
    };
    return listOnethingDirectoriesForCompletionForIpc(listOnethingDirectoriesForCompletionOptions)
  },

  async readContent(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('File path must stay inside the workspace sandbox root.')
    }
    const readOnethingFileContentOptions: ReadOnethingFileContentOptions = {
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
    };
    return readOnethingFileContent(readOnethingFileContentOptions)
  },

  async saveContent(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('File path must stay inside the workspace sandbox root.')
    }
    const saveOnethingFileContentOptions: SaveOnethingFileContentOptions = {
      path,
      content: request?.content ?? '',
      expectedMtimeMs: request?.expectedMtimeMs,
      stat: filePath => fs.stat(filePath),
      writeFile: (filePath, content) => fs.writeFile(filePath, content, 'utf-8'),
    };
    return saveOnethingFileContent(saveOnethingFileContentOptions)
  },

  async listDirectory(request, context = DESKTOP_RPC_CONTEXT) {
    const path = clamp(context, request?.path)
    if (path === null) {
      return pathError('Directory path must stay inside the workspace sandbox root.')
    }
    const listOnethingDirectoryOptions: ListOnethingDirectoryOptions = {
      path,
      readDir: dirPath => fs.readdir(dirPath, { withFileTypes: true }),
      stat: entryPath => fs.stat(entryPath).catch(() => null),
    };
    return listOnethingDirectory(listOnethingDirectoryOptions)
  },

  async stat(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveFilesSandbox(context)
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

  /*
   * K3-c' —— 资源面有同一件事的另一条出口:`dir` 的 `createDirectory` 做法
   * (`wiring/resource/dir-provider.ts`)。**这一条不退成它的投影**,理由与
   * `updateWorkingDirectory` 同一笔:它对非本机可信的调用方有 per-caller 的
   * `context.sandboxRoot` 夹持,而资源那条路的 `Invocation` 里今天没有这一格。
   * 两条路调的是同一只纯函数,分叉只在夹持这一层。
   */
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

  /*
   * K3-c' —— 资源面的对应做法是 `dir` 的 `rename`。同上,本单不退投影
   * (per-caller 夹持这一格未到位)。两条路调的都是 `renameOnethingPath`。
   */
  async rename(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveFilesSandbox(context)
    const oldPath = clampWith(sandbox, request?.oldPath)
    const newPath = clampWith(sandbox, request?.newPath)
    if (oldPath === null || newPath === null) {
      return pathError('Rename paths must stay inside the workspace sandbox root.')
    }
    return renameOnethingPath({ oldPath, newPath, renamePath: fs.rename })
  },

  /*
   * K3-c' —— 资源面的对应做法是 `dir` 的 `delete`,同上不退投影。
   *
   * **这两条的行为有一格有意的差别,不是漏改**:这里是 `recursive: true`(界面上
   * 一个人看着文件树按下删除,他知道自己删的是一棵树),资源面是 `false`(那条路上
   * 的调用方可能是模型 / 插件 / 脚本,而误删一个空目录可恢复,误删一棵树不可)。
   * 理由的正本写在 `@onething/runtime/files/resource-spec` 的 `delete` 上。
   */
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
    const revealOnethingPathOptions: RevealOnethingPathOptions = {
      path,
      stat: target => fs.stat(target),
      // 未注入宿主 = 抛;投影自己 catch 成 `{ success:false, error }`,
      // 于是「宿主没有外壳能力」与「路径不存在」走的是同一条失败路。
      revealPath: async target => {
        const outcome = await getShellHost().revealPath(target)
        if (!outcome.success) throw new Error(outcome.error ?? SHELL_HOST_UNAVAILABLE)
      },
    };
    return revealOnethingPath(revealOnethingPathOptions)
  },

  async watchStart(request, context = DESKTOP_RPC_CONTEXT, ports?: RpcDispatchPorts) {
    const sandbox = resolveFilesSandbox(context)
    // 桌面:投影桩,与迁移前逐字一致(全仓没有 FILE_WATCH_EVENT 的发送方)。
    if (!sandbox.confined) return startOnethingFileWatchForIpc({ root: request?.root })
    const root = resolveInsideSandbox(sandbox, request?.root ?? '')
    if (!root) {
      return pathError('Workspace watch root must stay inside the workspace sandbox root.')
    }
    // 端口是**这次派发显式递进来的**(工单 4 C3),不是从 context 上摸出来的。
    const start = ports?.workspaceWatch?.startWorkspaceWatch
    if (!start) return pathError('Workspace file watching is not available in this runtime.')
    return start(sandbox.root, root)
  },

  async watchStop(request, context = DESKTOP_RPC_CONTEXT, ports?: RpcDispatchPorts) {
    const sandbox = resolveFilesSandbox(context)
    if (!sandbox.confined) return stopOnethingFileWatchForIpc({ root: request?.root })
    const root = resolveInsideSandbox(sandbox, request?.root ?? '')
    if (!root) {
      return pathError('Workspace watch root must stay inside the workspace sandbox root.')
    }
    const stop = ports?.workspaceWatch?.stopWorkspaceWatch
    if (!stop) return pathError('Workspace file watching is not available in this runtime.')
    return stop(sandbox.root, root)
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
  return clampWith(resolveFilesSandbox(context), path)
}

function clampWith(sandbox: RpcSandbox, path: string | undefined): string | null {
  if (!sandbox.confined) return path ?? ''
  return resolveInsideSandbox(sandbox, path ?? '')
}
