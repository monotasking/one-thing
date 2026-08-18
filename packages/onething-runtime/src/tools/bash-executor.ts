import { constants, createWriteStream, existsSync } from 'node:fs'
import { access as fsAccess, writeFile as fsWriteFile } from 'node:fs/promises'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createToolAbortError } from '@onething/core/tools'
import {
  cleanupBackgroundJobLogs,
  createBackgroundLogPath,
  getProcessGroupPids,
  registerBackgroundJob,
  type BackgroundJob,
} from './background-jobs.js'

export interface ShellConfig {
  shell: string
  args: string[]
}

export interface BashSpawnContext {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext

export interface BashBackgroundLaunch {
  jobId: string
  pid: number
  logPath: string
}

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void
      signal?: AbortSignal
      timeout?: number
      env?: NodeJS.ProcessEnv
    },
  ) => Promise<{ exitCode: number | null; backgroundJobIds?: string[] }>
  /**
   * Launch a command as a managed background job. Returns immediately;
   * stdout/stderr stream into the job's log file for the process lifetime
   * (readable incrementally via readBackgroundJobOutput).
   */
  execBackground?: (
    command: string,
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ) => Promise<BashBackgroundLaunch>
}

const EXIT_STDIO_GRACE_MS = 100
const MAX_BACKGROUND_STARTUP_LOG_BYTES = 1024 * 1024
const trackedDetachedChildPids = new Set<number>()

function findBashOnPath(): string | null {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const target = process.platform === 'win32' ? 'bash.exe' : 'bash'
  try {
    const result = spawnSync(lookup, [target], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.trim().split(/\r?\n/)[0]
      return first || null
    }
  } catch {
    // Ignore lookup failures.
  }
  return null
}

export function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (existsSync(customShellPath)) return { shell: customShellPath, args: ['-c'] }
    throw new Error(`Custom shell path not found: ${customShellPath}`)
  }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : '',
      process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe` : '',
      findBashOnPath() ?? '',
    ].filter(Boolean)

    for (const candidate of candidates) {
      try {
        const result = spawnSync(candidate, ['--version'], { encoding: 'utf-8', timeout: 3000, windowsHide: true })
        if (result.status === 0) return { shell: candidate, args: ['-c'] }
      } catch {
        // Try next candidate.
      }
    }

    throw new Error('No bash shell found. Install Git Bash or configure a shell path.')
  }

  return { shell: process.env.SHELL || findBashOnPath() || '/bin/sh', args: ['-c'] }
}

/**
 * Variables a shell needs to be a shell. Always inherited, even under an
 * allowlist — an allowlist that drops PATH does not restrict the model, it just
 * breaks every command and teaches the user to switch the setting back off.
 * The Windows names are inert on POSIX and vice versa.
 */
const SHELL_ENV_BASELINE_KEYS: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'windir',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
]

function envKeyMatches(key: string, pattern: string): boolean {
  return pattern.endsWith('*')
    ? key.startsWith(pattern.slice(0, -1))
    : key === pattern
}

/**
 * The environment handed to bash.
 *
 * With no allowlist this inherits `process.env` wholesale — which on desktop
 * includes everything the user's login shell exported (see login-shell-env.ts),
 * API keys included. That is the historical behaviour and stays the default,
 * because a wrong allowlist breaks toolchains in ways that are hard to
 * diagnose (nvm/pyenv PATH shims, GH_TOKEN for `gh`, proxy vars).
 *
 * Pass an allowlist to opt into the tight version: baseline shell variables
 * plus exactly what is named. Entries may end in `*` to take a family
 * (`LC_*`, `npm_config_*`).
 */
export function getShellEnv(allowlist?: readonly string[] | null): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = allowlist
    ? Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        SHELL_ENV_BASELINE_KEYS.includes(key) ||
        allowlist.some(pattern => envKeyMatches(key, pattern))),
    )
    : { ...process.env }

  return {
    ...inherited,
    LANG: process.env.LANG || 'en_US.UTF-8',
  }
}

export function resolveSpawnContext(
  command: string,
  cwd: string,
  spawnHook?: BashSpawnHook,
  envAllowlist?: readonly string[] | null,
): BashSpawnContext {
  const base: BashSpawnContext = { command, cwd, env: getShellEnv(envAllowlist) }
  return spawnHook ? spawnHook(base) : base
}

export function trackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.add(pid)
}

export function untrackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.delete(pid)
}

export function killTrackedDetachedChildren(): void {
  for (const pid of trackedDetachedChildPids) killProcessTree(pid, 'SIGKILL')
  trackedDetachedChildPids.clear()
}

export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }).unref()
    } catch {
      // Ignore kill failures; process may already be gone.
    }
    return
  }

  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Process already exited.
    }
  }
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let postExitTimer: NodeJS.Timeout | undefined
    let stdoutEnded = child.stdout === null
    let stderrEnded = child.stderr === null

    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('end', onStdoutEnd)
      child.stderr?.removeListener('end', onStderrEnd)
    }

    const finalize = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(code)
    }

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return
      if (stdoutEnded && stderrEnded) finalize(exitCode)
    }

    const onStdoutEnd = () => {
      stdoutEnded = true
      maybeFinalizeAfterExit()
    }
    const onStderrEnd = () => {
      stderrEnded = true
      maybeFinalizeAfterExit()
    }
    const onError = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const onExit = (code: number | null) => {
      exited = true
      exitCode = code
      maybeFinalizeAfterExit()
      if (!settled) postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS)
    }
    const onClose = (code: number | null) => finalize(code)

    child.stdout?.once('end', onStdoutEnd)
    child.stderr?.once('end', onStderrEnd)
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
  })
}

function createDeferredBackgroundLog(maxBytes = MAX_BACKGROUND_STARTUP_LOG_BYTES) {
  const chunks: Buffer[] = []
  let byteLength = 0
  let omittedBytes = 0

  return {
    append(data: Buffer): void {
      if (byteLength >= maxBytes) {
        omittedBytes += data.length
        return
      }

      const remaining = maxBytes - byteLength
      const chunk = data.length > remaining ? data.subarray(0, remaining) : data
      chunks.push(Buffer.from(chunk))
      byteLength += chunk.length
      omittedBytes += data.length - chunk.length
    },

    async flush(): Promise<string | undefined> {
      if (byteLength === 0 && omittedBytes === 0) return undefined

      const logPath = createBackgroundLogPath()
      const parts = [...chunks]
      if (omittedBytes > 0) {
        parts.push(Buffer.from(`\n\n[background log truncated after ${maxBytes} bytes; ${omittedBytes} bytes omitted]\n`))
      }

      try {
        await fsWriteFile(logPath, Buffer.concat(parts))
        return logPath
      } catch {
        return undefined
      }
    },
  }
}

export function createLocalBashOperations(options: {
  shellPath?: string
  spawnHook?: BashSpawnHook
  sessionId?: string
  /** Omit (or null) to inherit process.env wholesale — see getShellEnv. */
  envAllowlist?: readonly string[] | null
} = {}): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      cleanupBackgroundJobLogs()
      try {
        await fsAccess(cwd, constants.F_OK)
      } catch {
        throw new Error(`Work directory does not exist: ${cwd}\nCannot execute bash commands.`)
      }
      if (signal?.aborted) throw createToolAbortError('aborted')

      const { shell, args } = getShellConfig(options.shellPath)
      const spawnContext = resolveSpawnContext(command, cwd, options.spawnHook, options.envAllowlist)
      const child = spawn(shell, [...args, spawnContext.command], {
        cwd: spawnContext.cwd,
        detached: process.platform !== 'win32',
        env: env ?? spawnContext.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

      if (child.pid) trackDetachedChildPid(child.pid)
      let timedOut = false
      let timeoutHandle: NodeJS.Timeout | undefined
      const backgroundLog = createDeferredBackgroundLog()
      const appendOutput = (data: Buffer) => {
        backgroundLog.append(data)
        onData(data)
      }

      const onAbort = () => killProcessTree(child.pid, 'SIGKILL')

      try {
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            killProcessTree(child.pid, 'SIGKILL')
          }, timeout)
        }

        child.stdout?.on('data', appendOutput)
        child.stderr?.on('data', appendOutput)

        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }

        const exitCode = await waitForChildProcess(child)
        if (signal?.aborted) throw createToolAbortError('aborted')
        if (timedOut) throw new Error(`timeout:${timeout}`)
        const backgroundPids = child.pid && process.platform !== 'win32'
          ? getProcessGroupPids(child.pid).filter(pid => pid !== child.pid)
          : []
        const backgroundLogPath = backgroundPids.length > 0
          ? await backgroundLog.flush()
          : undefined
        const backgroundJobIds = child.pid && backgroundPids.length > 0
          ? [registerBackgroundJob({
              command: spawnContext.command,
              cwd: spawnContext.cwd,
              sessionId: options.sessionId,
              shellPid: child.pid,
              pgid: child.pid,
              childPids: backgroundPids,
              logPath: backgroundLogPath,
            }).id]
          : undefined
        return { exitCode, backgroundJobIds }
      } finally {
        child.stdout?.removeListener('data', appendOutput)
        child.stderr?.removeListener('data', appendOutput)
        if (child.pid) untrackDetachedChildPid(child.pid)
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
    },

    execBackground: async (command, cwd, { env } = {}) => {
      cleanupBackgroundJobLogs()
      try {
        await fsAccess(cwd, constants.F_OK)
      } catch {
        throw new Error(`Work directory does not exist: ${cwd}\nCannot execute bash commands.`)
      }

      const { shell, args } = getShellConfig(options.shellPath)
      const spawnContext = resolveSpawnContext(command, cwd, options.spawnHook, options.envAllowlist)
      const logPath = createBackgroundLogPath()
      const logStream = createWriteStream(logPath, { flags: 'a' })

      const child = spawn(shell, [...args, spawnContext.command], {
        cwd: spawnContext.cwd,
        detached: process.platform !== 'win32',
        env: env ?? spawnContext.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

      child.stdout?.pipe(logStream, { end: false })
      child.stderr?.pipe(logStream, { end: false })
      child.once('close', () => logStream.end())
      child.once('error', () => logStream.end())
      child.unref()

      // shellPid 0: the spawned shell IS the job (no wrapper to exclude when
      // scanning the process group for liveness).
      const job: BackgroundJob = registerBackgroundJob({
        command: spawnContext.command,
        cwd: spawnContext.cwd,
        sessionId: options.sessionId,
        shellPid: 0,
        pgid: child.pid ?? 0,
        childPids: child.pid ? [child.pid] : [],
        logPath,
      })

      return { jobId: job.id, pid: child.pid ?? 0, logPath }
    },
  }
}
