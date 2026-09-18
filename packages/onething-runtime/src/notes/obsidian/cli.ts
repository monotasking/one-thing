/**
 * Obsidian CLI 的包装。**领域里唯一知道 `obsidian` 这个可执行文件存在的地方。**
 *
 * 四条真机纪律(读数在 `docs/design/notes-obsidian-cli-2026-09.md` §1),每一条
 * 都在下面有一行代码守着:
 *
 *  1. **退出码恒 0**。错 = stdout 首行以 `Error:` 开头,或整段是 `Vault not found.`。
 *     按退出码判成功的写法在这个 CLI 上永远是绿的。
 *  2. **读方提前关 stdout 会让它挂死**(20s alarm 才回)。所以永远读完再返回 ——
 *     这一条守在 `process-runner.ts`(只累加、不 `destroy`)。
 *  3. **`vault=<id>` 必须是 argv[0]**,而且永远传 id 不传名字(名字会重)。
 *  4. **app 没跑时第一条命令会把 app 拉起来**。所以每条命令先探活;探不活且调用方
 *     没说 `mayLaunch` → 一次 `spawn` 都不发生,抛 `NoteVaultUnavailable`。
 */

import {
  NoteVaultUnavailable,
  type NoteLivenessProbe,
  type NoteProcessRunner,
} from '../types.js'

/** 可执行名。`ONETHING_OBSIDIAN_CLI` 覆盖(开发机 / 非常规安装位置)。 */
export function resolveObsidianExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.ONETHING_OBSIDIAN_CLI?.trim()
  if (override) return override
  return platform === 'win32' ? 'obsidian.exe' : 'obsidian'
}

export const OBSIDIAN_CLI_BUDGET_MS = 10_000

export interface ObsidianCliResult {
  /** 去掉尾部换行的整段 stdout。 */
  stdout: string
  /** 非空行的第一行 —— 判错看的就是它。 */
  firstLine: string
}

/** CLI 说了一句错话(退出码仍然是 0)。 */
export class ObsidianCliError extends Error {
  constructor(readonly command: string, readonly detail: string) {
    super(`[notes.obsidian] ${command}: ${detail}`)
    this.name = 'ObsidianCliError'
  }
}

export interface ObsidianCliOptions {
  runner: NoteProcessRunner
  probe: NoteLivenessProbe
  executable?: string
  budgetMs?: number
}

export interface ObsidianCliRunOptions {
  budgetMs?: number
  /**
   * 允许这一次把 app 拉起来 / 对一个没开的库发命令。**缺省 false**,所以后台
   * 路径拿缺省值就是安全的。
   */
  mayLaunch?: boolean
  /**
   * **换词即 kill**(P5)。原样递给 `NoteProcessRunner.run` —— 这一层不解释它,
   * 也不在探活之后自己再看一眼:已经 abort 的信号由 runner 在 `spawn` 之前挡下,
   * 那是同一句话唯一的产地。
   */
  signal?: AbortSignal
}

/** `Vault not found.` 是整段,不带 `Error:` 前缀 —— 所以要单独认。 */
const VAULT_NOT_FOUND = 'Vault not found.'

export class ObsidianCli {
  private readonly executable: string
  private readonly budgetMs: number

  constructor(private readonly options: ObsidianCliOptions) {
    this.executable = options.executable ?? resolveObsidianExecutable()
    this.budgetMs = options.budgetMs ?? OBSIDIAN_CLI_BUDGET_MS
  }

  /** 这台机器上 Obsidian 现在活着吗(`null` = 平台没有探活手段)。 */
  isAlive(): Promise<boolean | null> {
    return this.options.probe.isAlive()
  }

  /**
   * 发一条命令。
   *
   * `params` 是 `key=value` 的原文(值里的空格不用引号 —— 它们走 argv,不经
   * shell);光有键的开关传 `key` 即可。
   */
  async run(
    vaultId: string,
    command: string,
    params: readonly string[] = [],
    options: ObsidianCliRunOptions = {},
  ): Promise<ObsidianCliResult> {
    if (options.mayLaunch !== true) {
      const alive = await this.options.probe.isAlive()
      // `null`(不确定)与 `false` 同样拦下 —— 不确定时后台不发。
      if (alive !== true) {
        throw new NoteVaultUnavailable(
          alive === null ? 'cli-not-registered' : 'system-not-running',
          vaultId,
          alive === null ? 'no liveness probe on this platform' : undefined,
        )
      }
    }

    // 纪律 3:`vault=<id>` 是 argv[0]。
    const args = [`vault=${vaultId}`, command, ...params]
    const result = await this.options.runner.run({
      command: this.executable,
      args,
      timeoutMs: options.budgetMs ?? this.budgetMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    const stdout = result.stdout.replace(/\s+$/, '')
    const firstLine = stdout.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
    // 纪律 1:退出码没用,看首行。
    if (firstLine.startsWith('Error:')) {
      throw new ObsidianCliError(command, firstLine.slice('Error:'.length).trim())
    }
    if (stdout.trim() === VAULT_NOT_FOUND) {
      throw new NoteVaultUnavailable('vault-not-open', vaultId, VAULT_NOT_FOUND)
    }
    return { stdout, firstLine }
  }

  /**
   * `eval code=<js>`,脚本自己 `JSON.stringify` 过 → 这里 `JSON.parse` 回来。
   *
   * 剥掉 `=> ` 之后 parse;**没有那个前缀时也直接 parse 一次** —— 本机只见过
   * 1.13.7 一种格式,这一步容错是留给下一个版本的(§1 ④)。两条都不成就抛,
   * 而不是悄悄返回 `undefined`。
   */
  async eval<T>(vaultId: string, script: string, options: ObsidianCliRunOptions = {}): Promise<T> {
    const { stdout } = await this.run(vaultId, 'eval', [`code=${script}`], options)
    return parseEvalJson<T>(stdout)
  }

  /**
   * `eval code=<js>`,脚本返回的是**裸字符串**(`generateMarkdownLink` 的
   * `[[x]]`、`getFirstLinkpathDest(...)?.path`、`getDailyNote().path`)。
   *
   * 这些不是 JSON,`JSON.parse` 会当场红 —— 所以分成两个方法,而不是一个方法
   * 里 try/catch 兜底:调用方在写代码那一刻就知道自己问的是哪一种。
   */
  async evalText(
    vaultId: string,
    script: string,
    options: ObsidianCliRunOptions = {},
  ): Promise<string | null> {
    const { stdout } = await this.run(vaultId, 'eval', [`code=${script}`], options)
    return parseEvalText(stdout)
  }
}

/** `=> {"a":1}` → `{a:1}`。导出是为了单测能直接钉住这一层容错。 */
export function parseEvalJson<T>(stdout: string): T {
  const body = stripEvalArrow(stdout)
  try {
    return JSON.parse(body) as T
  } catch {
    throw new ObsidianCliError('eval', `cannot parse result as JSON: ${body.slice(0, 200)}`)
  }
}

/** `=> [[x]]` → `[[x]]`;`=> null` / 空 → `null`。 */
export function parseEvalText(stdout: string): string | null {
  const body = stripEvalArrow(stdout)
  if (body === '' || body === 'null' || body === 'undefined') return null
  return body
}

function stripEvalArrow(stdout: string): string {
  const text = stdout.trim()
  return text.startsWith('=>') ? text.slice(2).trim() : text
}
