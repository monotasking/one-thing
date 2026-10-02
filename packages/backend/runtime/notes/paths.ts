/**
 * 路径归一。
 *
 * 全仓今天有三份 `~` 展开(沙箱、检索、变量);P3 把它们收成这一份。P1 只立
 * 产地,不动那三处。
 */

import * as os from 'node:os'
import * as path from 'node:path'

/** `~` / `~/x` / `$HOME/x` → 绝对路径。其余原样返回。 */
export function expandHome(input: string): string {
  const value = input.trim()
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  if (value.startsWith('$HOME/') || value.startsWith('$HOME\\')) {
    return path.join(os.homedir(), value.slice(6))
  }
  return value
}

/**
 * 库根的规范形:展开 `~`、`path.resolve`、去尾斜杠。
 *
 * `vaultFor` 的最长前缀匹配全靠这一句 —— 两条同一个目录的不同写法必须归到一个
 * 字符串,否则「这个文件属于哪个库」会按用户当初怎么打字而变。
 */
export function normalizeVaultRoot(input: string): string {
  const resolved = path.resolve(expandHome(input))
  // path.resolve 已经去掉了尾斜杠(根目录 `/` 除外,它本来就该留着)。
  return resolved
}

/**
 * 大小写是**平台事实**,不是偏好:macOS / Windows 的默认文件系统不区分大小写,
 * Linux 区分。比较前按平台折一次,否则 `/Users/me/Vault/a.md` 会被判成不在
 * `/Users/me/vault` 里。
 */
function foldCase(value: string): string {
  return process.platform === 'linux' ? value : value.toLowerCase()
}

/** `child` 是不是 `root` 本身或它下面的东西(两者都先 `normalizeVaultRoot`)。 */
export function isInsideRoot(child: string, root: string): boolean {
  const target = foldCase(normalizeVaultRoot(child))
  const base = foldCase(normalizeVaultRoot(root))
  if (target === base) return true
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}
