type MaybePromise<T> = T | Promise<T>

export interface UpdateOnethingSessionWorkingDirectoryOptions {
  sessionId: string
  workingDirectory: string | null
  /**
   * 「这条字符串指的是哪条真路径」—— `~` 展开 + `resolve`,由宿主给。
   *
   * **必填,而且不给默认值**(09-21 立):这本规则书从前直接把调用方递来的
   * 原样字符串交给 `isDirectory`,于是用户在「绑定…」那一行 / `/cd` 里敲
   * `~/Documents/...`,`fs.stat` 拿到的就是字面量 `~/Documents/...` ——
   * ENOENT,屏幕上一句「目录不存在」,而目录明明在。同一个问题变量域的
   * `workdir` 早就答过(`variables/providers/core.ts` 的
   * `resolveExistingDirectory`:`normalizePath(expandPath(...))`),这条路
   * 只是从来没接上。给默认值就是在这一层猜宿主的家目录,所以宁可必填。
   *
   * 落盘的也是它的产物:工作目录这条串同时是**项目分组的键**
   * (`expose/projection.ts` 的 projectId、`workdirGateway.write` 自动登记进
   * 名册),一条 `~/x` 和一条 `/Users/me/x` 会分裂成两个项目 —— 名册里那两条
   * `~/data/code/...` 化石就是这么来的。
   */
  resolvePath(path: string): string
  isDirectory(path: string): MaybePromise<boolean>
  writeWorkingDirectory(sessionId: string, workingDirectory: string): MaybePromise<unknown>
}

export interface UpdateOnethingSessionWorkingDirectoryResult {
  success: boolean
  error?: string
  /** 真正落盘的那条路径(清空时是空串)。失败时缺席。 */
  path?: string
}

export async function updateOnethingSessionWorkingDirectory(
  options: UpdateOnethingSessionWorkingDirectoryOptions,
): Promise<UpdateOnethingSessionWorkingDirectoryResult> {
  const requested = options.workingDirectory

  // 清空:`null` / 空串 / 只有空白 —— 三者都是「你没给我路径」的同一句话,
  // 而清空工作目录是一条随时可以重设的指针,不是数据。
  if (requested === null || requested.trim() === '') {
    await options.writeWorkingDirectory(options.sessionId, '')
    return { success: true, path: '' }
  }

  const workingDirectory = options.resolvePath(requested.trim())

  let existsAndIsDirectory = false
  try {
    existsAndIsDirectory = await options.isDirectory(workingDirectory)
  } catch (error) {
    // 「不存在」与「碰不到」是两个排障方向:macOS 的 TCC 对 `~/Documents`
    // 这类受保护目录回的是 EPERM,把它说成「不存在」会把人指向找路径,
    // 而真正要做的是给这个 app 授权。判据是 errno,不是消息串。
    const code = (error as { code?: unknown } | undefined)?.code
    if (typeof code === 'string' && code !== 'ENOENT') {
      return { success: false, error: `Cannot access directory: ${workingDirectory} (${code})` }
    }
    return { success: false, error: `Directory does not exist: ${workingDirectory}` }
  }

  if (!existsAndIsDirectory) {
    return { success: false, error: `Not a directory: ${workingDirectory}` }
  }

  await options.writeWorkingDirectory(options.sessionId, workingDirectory)
  return { success: true, path: workingDirectory }
}
