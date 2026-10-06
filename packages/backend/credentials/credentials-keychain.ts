/**
 * macOS 钥匙串的命令行门面:用系统自带的 `security` 命令读、写凭证主密钥那一条(第④步批 0,
 * 决策 D2(a),`docs/design/two-process-2026-10.md` §2.1)。
 *
 * 这只文件只管「起一个 `security` 子进程、限时、读它的回答」这一件事,不认识主密钥的格式,
 * 也不认识 store。三条硬规矩都写在这里,因为挂死只会发生在这一层:
 *
 *  1. **带硬超时**(缺省 3 秒):钥匙串要弹授权框而没人点时,`security` 会一直等下去
 *     (根 CLAUDE.md §1 记的那种挂死)。到点就 `SIGKILL`,答 `timeout`。
 *  2. **stdin 不继承**:子进程的标准输入是 `ignore`,它永远不会去读终端,也就不会停在一个
 *     看不见的提示符上。
 *  3. **永不抛**:起不来、被杀、输出缺失或读不懂,一律折成一个原因码交回去。上层据此进入
 *     「已锁定」状态,而不是让一次装配因为钥匙串炸掉。
 *
 * 写入时密钥经命令行参数 `-w` 交给 `security`:macOS 上别的用户读不到本用户进程的参数,
 * 而同一个用户本来就能用同一条命令读出这一条(D2 写明的强度上限),所以参数里出现一瞬间
 * 不多暴露什么。
 *
 * 测试与门不碰真钥匙串:它们要么不走这一档(`ONETHING_CREDENTIALS_KEYRING=file|none`),要么经
 * `command` 换成一只假的慢命令(`gate:credentials` ⑦)。
 */
import { spawn } from 'node:child_process'

/** 一次钥匙串操作的结局。`value` 只在读成功时有。 */
export type KeychainOutcome =
  | { kind: 'ok'; value?: string }
  | { kind: 'not-found' }
  | { kind: 'timeout' }
  | { kind: 'denied'; exitCode: number | null }
  | { kind: 'failed'; detail: string }

export interface KeychainRunOptions {
  /** 硬超时(毫秒)。缺省 3000。 */
  timeoutMs?: number
  /** 要起的命令。缺省 `/usr/bin/security`;测试与门用它换成假的。 */
  command?: string
}

export const KEYCHAIN_DEFAULT_TIMEOUT_MS = 3000
const SECURITY_COMMAND = '/usr/bin/security'

/** `security` 在找不到条目时的退出码(errSecItemNotFound)。 */
const EXIT_ITEM_NOT_FOUND = 44
/**
 * 这几种退出码都是「钥匙串在,但不让读」:用户在授权框上点了拒绝(128 = 用户取消)、
 * 不允许交互(36)、认证失败(51)。别的非零退出码归 `failed`,原因说不准就不猜。
 */
const DENIED_EXIT_CODES = new Set([36, 51, 128])

function runSecurity(args: string[], options: KeychainRunOptions): Promise<KeychainOutcome> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_DEFAULT_TIMEOUT_MS
  // 第二道闸:vitest 进程里永远不起真的 `security`(第一道是全局 setup 强制 `none` 档)。
  // 测试要测钥匙串那一档,一律经 `command` 换成假的。
  if (process.env.VITEST && !options.command) {
    return Promise.resolve({ kind: 'failed', detail: 'the real keychain is off limits inside vitest' })
  }
  return new Promise<KeychainOutcome>(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (outcome: KeychainOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(options.command ?? SECURITY_COMMAND, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      // 到点就杀,不等它自己退:挂着的 `security` 正是我们要躲开的那件事。
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经退了也算杀掉了。
      }
      finish({ kind: 'timeout' })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', error => finish({ kind: 'failed', detail: error.message }))
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish({ kind: 'ok', value: stdout.trim() })
        return
      }
      if (code === EXIT_ITEM_NOT_FOUND) {
        finish({ kind: 'not-found' })
        return
      }
      if (code !== null && DENIED_EXIT_CODES.has(code)) {
        finish({ kind: 'denied', exitCode: code })
        return
      }
      finish({ kind: 'failed', detail: `exit ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}: ${stderr.trim().slice(0, 200)}` })
    })
  })
}

/** 读一条通用密码。成功时 `value` 是 `security -w` 打出来的那一行。 */
export function readKeychainSecret(
  service: string,
  account: string,
  options: KeychainRunOptions = {},
): Promise<KeychainOutcome> {
  return runSecurity(['find-generic-password', '-s', service, '-a', account, '-w'], options)
}

/** 写(或覆盖,`-U`)一条通用密码。 */
export function writeKeychainSecret(
  service: string,
  account: string,
  secret: string,
  options: KeychainRunOptions = {},
): Promise<KeychainOutcome> {
  return runSecurity(['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret], options)
}
