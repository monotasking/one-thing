import type {
  FilesActionResponse,
  FilesListDirectoryResponse,
  FilesListRequest,
  FilesListResponse,
  FilesReadContentResponse,
  FilesStatResponse,
} from '@shared/ipc/files'

/**
 * 文件面取数与 `@renderer/platform` 之间的那一层**端口** —— 与
 * `data/sessions-port.ts` / `theme/theme-port.ts` 同一形状、同一理由:
 * files-source 的全部判据(根怎么定、懒展开、每目录一次、预览三态)都是纯逻辑,
 * 不该为了测它去起一台 core。真实现是下面那一个,测试用 `configureFilesPort`
 * 换成假的。
 *
 * 形状是**平台调用面的子集**,不是新契约:六个方法逐条对应
 * `@shared/ipc/files.ts` 那个 router 十四条里的六条,一个字段都没有多。
 * 那八条(saveContent / create / createDirectory / rename / delete / rollback /
 * watchStart / watchStop)本批一条都不开:文件面这一批**只读**,
 * 而 watch 的实情写在下面。
 *
 * ── 签名口径:位置参数进来,信封出去 ─────────────────────────────────────
 * router 一律收对象(`filesApi.readContent({ path, maxSize })`)。端口这一层
 * 用位置参数,与 sessions-port 的 `getMessagesPage(sessionId, limit)` 同体例 ——
 * 端口是给**判据层**用的窄面,不是给网线用的信封;真实现负责那一次包装。
 * 唯一的例外是 `list`:它的四格全是可选的(cwd / query / limit / sessionId),
 * 摊成四个位置参数会立刻长出一串 undefined,所以它原样收那个请求对象。
 *
 * ── 留账:watch 本批不做 ──────────────────────────────────────────────────
 * `watchStart` / `watchStop` 与 `platformApi.onWorkspaceFileChanged` 都没有出现在
 * 这个端口上。理由不是忘了:桌面那两条**从来是投影桩**(校验 root 之后回
 * `{success:true}`,全仓没有任何地方往 `FILE_WATCH_EVENT` 发过消息,见
 * `packages/backend/rpc/domains/files.ts` 文件头第 3 条),http 那侧才是真的。
 * 也就是说「接上 watch」在两个宿主上是两种不同的东西,那是一次要拍板的取舍,
 * 不是顺手件。本批的刷新是**显式的**:面板头上那颗「重新读取」。
 */
export interface FilesPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /**
   * 列一个目录。**不展开 `~`** —— 后端这一条直接把字符串交给 `fs.readdir`
   * (`listOnethingDirectory`),所以调用方必须先自己把根解析成绝对路径。
   * 那正是 `stat` 在这个端口上的唯一用处。
   */
  listDirectory(path: string): Promise<FilesListDirectoryResponse>
  /** 认一条路径。**它展开 `~`**,并在 `path` 上回真正 stat 到的绝对路径。 */
  stat(path: string): Promise<FilesStatResponse>
  /**
   * 读一个文件的前 `maxSize` 字节。回执里的 `size` 是**文件真实字节数**,
   * 不是读回来的那一段的长度 —— 「有没有被截断」只能靠这两个数字比出来。
   */
  readContent(path: string, maxSize: number): Promise<FilesReadContentResponse>
  /** 在文件管理器里定位。只有 Electron 桌面做得到,别处结构化降级。 */
  reveal(path: string): Promise<FilesActionResponse>
  /** 按名字找文件(**不是按内容**,见 search/data.ts 顶部)。 */
  list(request: FilesListRequest): Promise<FilesListResponse>
}

let port: FilesPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureFilesPort(next: FilesPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:`@renderer/platform`
 * 在模块顶层就会去摸 `window`,而端口被换掉的测试根本不该把它拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<FilesPort> {
  const [{ filesApi }, { whenConnected }] = await Promise.all([
    import('@renderer/platform/files-client'),
    import('../platform/connection'),
  ])
  return {
    ready: () => whenConnected(),
    listDirectory: (path) => filesApi.listDirectory({ path }),
    stat: (path) => filesApi.stat({ path }),
    readContent: (path, maxSize) => filesApi.readContent({ path, maxSize }),
    reveal: (path) => filesApi.reveal({ path }),
    list: (request) => filesApi.list(request),
  }
}

let pending: Promise<FilesPort> | undefined

export function filesPort(): Promise<FilesPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
