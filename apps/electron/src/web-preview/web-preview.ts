import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import { getLogger } from '@onething/app/logging/index.js'

const log = getLogger('web-preview')

/**
 * 测试用:从 Electron 里启停浏览器端(apps/web)的本地开发服务。
 * 仅开发态可用(需要仓库工具链与 apps/web 源码),生产打包后不暴露。
 * 复用 apps/web 的 vite 配置——其 /api 代理指向 127.0.0.1:8787,仅监听本机。
 */

export const WEB_PREVIEW_URL = 'http://127.0.0.1:5174'

let child: ChildProcess | null = null
let quitHookRegistered = false

function ensureQuitCleanup(): void {
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => stopWebPreview())
}

function resolveRepoRoot(): string | null {
  const candidates = [process.cwd(), app.getAppPath?.() ?? '']
  for (const root of candidates) {
    if (root && fs.existsSync(path.join(root, 'apps/web/vite.config.ts'))) {
      return root
    }
  }
  return null
}

/** 仅在开发态、且能定位到 apps/web 源码时可用 */
export function isWebPreviewAvailable(): boolean {
  return !app.isPackaged && resolveRepoRoot() !== null
}

export function isWebPreviewRunning(): boolean {
  return child !== null && child.exitCode === null && !child.killed
}

export function startWebPreview(): { ok: boolean; error?: string } {
  if (isWebPreviewRunning()) return { ok: true }
  const root = resolveRepoRoot()
  if (!root) return { ok: false, error: 'apps/web 源码未找到(仅开发态可用)' }

  ensureQuitCleanup()
  try {
    // detached + shell:true:通过登录 shell 的 PATH 解析 bun/vite,并让 vite 进入独立进程组便于整组回收。
    const proc = spawn('bun run web:dev', {
      cwd: root,
      env: process.env,
      shell: true,
      detached: true,
      stdio: 'ignore',
    })
    proc.on('exit', () => {
      if (child === proc) child = null
    })
    proc.on('error', error => {
      log.error('web preview failed to start', undefined, error)
      if (child === proc) child = null
    })
    child = proc
    return { ok: true }
  } catch (error) {
    child = null
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function stopWebPreview(): void {
  const proc = child
  child = null
  if (!proc || proc.pid === undefined) return
  try {
    // 杀整个进程组(负 pid),连带结束 shell 拉起的 vite。
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    try {
      proc.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
}

export function toggleWebPreview(): { ok: boolean; error?: string } {
  if (isWebPreviewRunning()) {
    stopWebPreview()
    return { ok: true }
  }
  return startWebPreview()
}

export function openWebPreview(): void {
  void shell.openExternal(WEB_PREVIEW_URL)
}
