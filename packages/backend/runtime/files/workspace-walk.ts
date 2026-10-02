/**
 * 联网宿主上的工作区文件枚举 —— 结构债 P4c 第八批。
 *
 * `files` 域的 `list` 在 `transport:'http'` 这一支要一个文件枚举器。桌面那一支
 * 用的是 ripgrep(`backend/utils/ripgrep.ts`,`hidden:false, noIgnore:true`);
 * 联网宿主上换成这份手写走查器,逐字对齐被替换掉的
 * `server/runtime.ts` 里 `listServerToolFiles` 的**无 glob 分支**:跳过 `.git`,
 * 产出相对 `root` 的 posix 路径。
 *
 * 为什么不让 http 也走 ripgrep:那要一个 rg 二进制,而「联网宿主上有没有它」
 * 不是这一批该赌的事 —— 迁移的等价性优先于少一份实现。
 *
 * 为什么住在 wiring 而不是域文件里:checker 的
 * `MAIN_FILES_IPC_FILE_OPERATIONS_FORBIDDEN_PATTERNS` 守的是「传输层不许重抄一份
 * 目录遍历」,而这份遍历确实是**机制**不是传输 —— 放在机制的住处,那条断言才
 * 继续说真话。
 */
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export async function* walkWorkspaceFiles(root: string): AsyncGenerator<string> {
  const base = resolve(root)
  const rootStat = await stat(base)
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${base}`)

  async function* walk(directory: string): AsyncGenerator<string> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        yield* walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      yield relative(base, fullPath).split(sep).join('/')
    }
  }

  yield* walk(base)
}
