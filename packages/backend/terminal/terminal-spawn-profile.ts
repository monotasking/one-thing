/**
 * Spawn-parameter construction for user terminals, collected in one function
 * so the P5 shell-integration phase can hook in here (ZDOTDIR wrapping with
 * four shims — .zshenv/.zprofile/.zshrc/.zlogin) without touching the service.
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalCreateRequest } from '@shared/ipc.js'
import type { PtySpawnRequest } from './terminal-pty-backend.js'

export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24

/**
 * GUI-launched Electron lacks the login shell's PATH (same fix as
 * app/music/process-runner.ts). Mostly belt-and-braces here — the `-l` login
 * shell rebuilds PATH from the user's profile anyway — but it keeps pre-rc
 * spawns and exotic setups working.
 */
function augmentedPath(): string {
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const current = process.env.PATH?.split(path.delimiter) ?? []
  const merged = [...current]
  for (const entry of extras) {
    if (!merged.includes(entry)) merged.push(entry)
  }
  return merged.join(path.delimiter)
}

export function buildSpawnProfile(request: TerminalCreateRequest): PtySpawnRequest {
  const requestedCwd = request.cwd?.trim()
  const cwd = requestedCwd && existsSync(requestedCwd) ? requestedCwd : os.homedir()

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.PATH = augmentedPath()
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // 请求自带的变量叠在最上面(A3-b:ACP agent 递来的 env + 应用代理);PATH 若在其中也由它说了算。
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (typeof value === 'string') env[key] = value
  }

  const cols = request.cols && request.cols > 0 ? Math.floor(request.cols) : DEFAULT_TERMINAL_COLS
  const rows = request.rows && request.rows > 0 ? Math.floor(request.rows) : DEFAULT_TERMINAL_ROWS

  // 给了命令就直接起它(不经 shell 转一道:参数原样到 argv,没有引号与注入的问题)。
  const command = request.command?.trim()
  if (command) {
    return { shell: command, args: [...(request.args ?? [])], cwd, env, cols, rows }
  }

  const shell =
    request.shell?.trim() ||
    process.env.SHELL ||
    (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { shell, args: ['-l'], cwd, env, cols, rows }
}
