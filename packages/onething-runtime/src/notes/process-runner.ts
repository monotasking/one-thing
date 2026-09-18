/**
 * 笔记领域**唯一**碰 `child_process` / `net` 的文件。
 *
 * 派工单原话把这两件缺省实现放在 `obsidian/cli.ts` 里,理由是「让 cli.ts 成为
 * 唯一碰 child_process 的文件」。这里落在 `notes/process-runner.ts`,同一条纪律
 * 的更强形式:**下一个驱动(Logseq)也要起子进程**,而它不该 import
 * `notes/obsidian/` 里的任何东西 —— 那样「加一种笔记系统」就变成了「先读懂
 * Obsidian 那一坨」。领域级的端口住领域级的文件。
 *
 * 做法照 `music/process-runner.ts`:PATH 补上 GUI 进程看不见的安装前缀、进程组
 * 独立、SIGTERM → 1s → SIGKILL。两条 Obsidian 特有的纪律由 `obsidian/cli.ts`
 * 自己守(读完 stdout 再返回、首行判错)。
 */

import { spawn } from 'node:child_process'
import * as net from 'node:net'
import * as path from 'node:path'
import type {
  NoteLivenessProbe,
  NoteProcessHandle,
  NoteProcessResult,
  NoteProcessRunOptions,
  NoteProcessRunner,
} from './types.js'

/**
 * GUI 进程只在从终端启动时才继承登录 shell 的 PATH,所以双击起来的 Electron
 * 看不见 Homebrew / npm -g 装的命令。把常见前缀补上。
 */
function resolvePath(environment: NodeJS.ProcessEnv): string {
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const current = environment.PATH?.split(path.delimiter) ?? []
  const merged = [...current]
  for (const entry of extras) {
    if (!merged.includes(entry)) merged.push(entry)
  }
  return merged.join(path.delimiter)
}

export function createNodeProcessRunner(options: { env?: NodeJS.ProcessEnv } = {}): NoteProcessRunner {
  const environment = { ...process.env, ...options.env }

  function spawnProcess(runOptions: NoteProcessRunOptions): NoteProcessHandle {
    const processGroup = process.platform !== 'win32'
    const child = spawn(runOptions.command, runOptions.args, {
      env: { ...environment, ...runOptions.env, PATH: resolvePath(environment) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // 只拥有这一次调用的后代,永远不对宿主自己的进程组发信号。
      detached: processGroup,
    })

    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let spawnError: Error | undefined
    let settled = false

    const signal = (value: NodeJS.Signals): void => {
      if (settled) return
      if (processGroup && child.pid) {
        try {
          process.kill(-child.pid, value)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(value)
        }
      } else child.kill(value)
    }

    const kill = (): void => {
      if (settled) return
      signal('SIGTERM')
      killTimer ??= setTimeout(() => signal('SIGKILL'), 1000)
    }

    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    // 只累加、**不提前关** stdout:Obsidian CLI 的读方一关 stdout 就挂死到 20s
    // alarm(§1 实测)。这里从头读到 close 为止。
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    // 关掉 stdin,免得等输入的 CLI 把调用方吊住。
    child.stdin?.end()

    const done = new Promise<NoteProcessResult>((resolve, reject) => {
      if (runOptions.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true
          kill()
        }, runOptions.timeoutMs)
      }
      child.on('error', error => { spawnError = error })
      child.on('close', code => {
        settled = true
        if (timer) clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        if (spawnError) { reject(spawnError); return }
        if (timedOut) {
          reject(new NoteProcessTimeout(runOptions.command, runOptions.timeoutMs ?? 0))
          return
        }
        resolve({ code, stdout, stderr })
      })
    })

    return {
      done,
      kill: () => {
        if (timer) clearTimeout(timer)
        kill()
      },
    }
  }

  return {
    run: runOptions => spawnProcess(runOptions).done,
    spawn: spawnProcess,
  }
}

export class NoteProcessTimeout extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`[notes] "${command}" did not finish within ${timeoutMs}ms; the child was killed`)
    this.name = 'NoteProcessTimeout'
  }
}

/**
 * 「能连上这条 unix socket 吗」= 那个 app 活着且它的 CLI 已注册。
 *
 * 为什么不是 `pgrep`:进程在、但 CLI 没注册(旧版本、用户关了)时 `pgrep` 说
 * 「活着」,于是我们发一条命令过去 —— 而那条命令会把 app 拉起来一次。socket
 * 同时回答了两个问题,`pgrep` 只回答一个。
 *
 * Windows 上 Obsidian 的对应物(named pipe)**没有查到公开读数**,所以这个工厂
 * 在 win32 上返回一个答 `null` 的探针(「不确定」),而不是猜一个 `\\.\pipe\…`
 * 写死 —— 猜错的代价是后台路径把 Obsidian 拉起来,正是本领域第一条纪律禁止的
 * 那件事。见 §7 留账。
 */
export function createSocketLivenessProbe(socketPath: string | null): NoteLivenessProbe {
  if (socketPath === null) {
    return { isAlive: async () => null }
  }
  return {
    isAlive: () => new Promise<boolean>(resolve => {
      let done = false
      const settle = (alive: boolean): void => {
        if (done) return
        done = true
        try { socket.destroy() } catch { /* 已经没了 */ }
        resolve(alive)
      }
      const socket = net.connect(socketPath)
      socket.setTimeout(1000)
      socket.once('connect', () => settle(true))
      socket.once('error', () => settle(false))
      socket.once('timeout', () => settle(false))
    }),
  }
}
