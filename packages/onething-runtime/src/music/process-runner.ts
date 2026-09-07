/**
 * Node-side process runner for the music domain.
 *
 * The runtime driver stays host-free by taking this capability through
 * injection; this file is the only place that touches child_process.
 */

import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  OnethingMusicProcessHandle,
  OnethingMusicProcessResult,
  OnethingMusicProcessRunner,
  OnethingMusicProcessStreamOptions,
} from './index.js'

/**
 * GUI apps inherit a login shell's PATH only when launched from a terminal, so
 * globally installed CLIs (npm -g, Homebrew) are commonly invisible to a
 * double-clicked Electron app. Add the usual install prefixes.
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

export function createElectronMusicProcessRunner(options: {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
} = {}): OnethingMusicProcessRunner & { quiesce(): void; drain(): Promise<void> } {
  const environment = { ...process.env, ...options.env }
  const active = new Set<OnethingMusicProcessHandle>()
  let closed = false
  const quiesce = () => {
    closed = true
    for (const handle of active) handle.kill()
  }
  if (options.signal?.aborted) quiesce()
  else options.signal?.addEventListener('abort', quiesce, { once: true })

  function spawnProcess(options: OnethingMusicProcessStreamOptions): OnethingMusicProcessHandle {
    if (closed) throw new Error('Music process runner is shutting down')
    const processGroup = process.platform !== 'win32'
    const child = spawn(options.command, options.args, {
      env: { ...environment, ...options.env, PATH: resolvePath(environment) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own only this invocation's descendants; never signal the host's group.
      detached: processGroup,
    })

    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let spawnError: Error | undefined
    let settled = false

    const signal = (value: NodeJS.Signals) => {
      if (settled) return
      if (processGroup && child.pid) {
        try { process.kill(-child.pid, value) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(value)
        }
      } else child.kill(value)
    }

    const kill = () => {
      if (settled) return
      signal('SIGTERM')
      killTimer ??= setTimeout(() => signal('SIGKILL'), 1000)
    }

    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      options.onStdout?.(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      options.onStderr?.(chunk)
    })

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin)
    } else {
      // Close stdin so a CLI waiting on input cannot hang the poll loop.
      child.stdin?.end()
    }

    const done = new Promise<OnethingMusicProcessResult>((resolve, reject) => {
      if (options.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true
          kill()
        }, options.timeoutMs)
      }

      child.on('error', error => {
        spawnError = error
      })

      child.on('close', code => {
        settled = true
        if (timer) clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        if (spawnError) { reject(spawnError); return }
        if (timedOut) {
          reject(new Error(`${options.command} 执行超时（${options.timeoutMs}ms）`))
          return
        }
        resolve({ code, stdout, stderr })
      })
    })

    const handle = {
      done,
      kill: () => {
        if (timer) clearTimeout(timer)
        kill()
      },
    }
    active.add(handle)
    void done.then(() => active.delete(handle), () => active.delete(handle))
    return handle
  }

  return {
    run: options => spawnProcess(options).done,
    spawn: spawnProcess,
    quiesce,
    async drain() {
      quiesce()
      while (active.size) await Promise.allSettled([...active].map(handle => handle.done))
      options.signal?.removeEventListener('abort', quiesce)
    },
  }
}

/**
 * Writes a secret to a private temp file. ncm-cli accepts a file path for
 * privateKey, which keeps it out of argv where `ps` would expose it.
 */
export async function writeElectronMusicSecretFile(
  content: string,
): Promise<{ path: string; dispose(): Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'onething-music-'))
  const filePath = path.join(dir, 'private-key.pem')
  await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 })
  await chmod(filePath, 0o600)
  return {
    path: filePath,
    dispose: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
