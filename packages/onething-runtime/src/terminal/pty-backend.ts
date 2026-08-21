/**
 * PTY backend seam.
 *
 * The real implementation loads node-pty lazily via createRequire at first
 * spawn (sherpa-onnx precedent in app/voice/kws.ts): a top-level import would
 * make every host — including the CLI daemon and a readonly server — dlopen
 * pty.node at boot and take the whole process down if the native load fails.
 * Tests inject a fake backend and never touch the native module.
 */

import { createRequire } from 'node:module'

export interface PtySpawnRequest {
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface PtyExitEvent {
  exitCode: number
  signal?: number
}

export interface PtyHandle {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  /**
   * Signal the shell's whole process group (the pty child is a session
   * leader), so SIGHUP-ignoring grandchildren get collected too.
   */
  kill(signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL'): void
  onData(callback: (data: string) => void): void
  onExit(callback: (event: PtyExitEvent) => void): void
}

export interface PtyBackend {
  spawn(request: PtySpawnRequest): PtyHandle
}

const require = createRequire(import.meta.url)

export function createNodePtyBackend(): PtyBackend {
  let nodePty: typeof import('node-pty') | null = null

  return {
    spawn(request: PtySpawnRequest): PtyHandle {
      nodePty ??= require('node-pty') as typeof import('node-pty')
      const pty = nodePty.spawn(request.shell, request.args, {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: request.env,
      })

      return {
        pid: pty.pid,
        write: data => pty.write(data),
        resize: (cols, rows) => pty.resize(cols, rows),
        pause: () => pty.pause(),
        resume: () => pty.resume(),
        kill: signal => {
          try {
            process.kill(-pty.pid, signal)
          } catch {
            try {
              pty.kill(signal)
            } catch {
              // Already gone.
            }
          }
        },
        onData: callback => {
          pty.onData(callback)
        },
        onExit: callback => {
          pty.onExit(event => callback({ exitCode: event.exitCode, signal: event.signal }))
        },
      }
    },
  }
}
