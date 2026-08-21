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
} from '@onething/runtime/music'

/**
 * GUI apps inherit a login shell's PATH only when launched from a terminal, so
 * globally installed CLIs (npm -g, Homebrew) are commonly invisible to a
 * double-clicked Electron app. Add the usual install prefixes.
 */
function resolvePath(): string {
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const current = process.env.PATH?.split(path.delimiter) ?? []
  const merged = [...current]
  for (const entry of extras) {
    if (!merged.includes(entry)) merged.push(entry)
  }
  return merged.join(path.delimiter)
}

function buildEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides, PATH: resolvePath() }
}

export function createElectronMusicProcessRunner(): OnethingMusicProcessRunner {
  function spawnProcess(options: OnethingMusicProcessStreamOptions): OnethingMusicProcessHandle {
    const child = spawn(options.command, options.args, {
      env: buildEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let timedOut = false

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
          child.kill('SIGTERM')
        }, options.timeoutMs)
      }

      child.on('error', error => {
        if (timer) clearTimeout(timer)
        reject(error)
      })

      child.on('close', code => {
        if (timer) clearTimeout(timer)
        if (timedOut) {
          reject(new Error(`${options.command} 执行超时（${options.timeoutMs}ms）`))
          return
        }
        resolve({ code, stdout, stderr })
      })
    })

    return {
      done,
      kill: () => {
        if (timer) clearTimeout(timer)
        child.kill('SIGTERM')
      },
    }
  }

  return {
    run: options => spawnProcess(options).done,
    spawn: spawnProcess,
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
