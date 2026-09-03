import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOnethingLogDir, getOnethingRunDir, getOnethingStorePath } from '@onething/runtime/storage'

export interface CliRuntimePaths {
  storePath: string
  runDir: string
  socketPath: string
  pidPath: string
  logDir: string
  /** 结构化日志(L2 之后的正主):`log/daemon.jsonl`。 */
  logPath: string
  /** spawn 时 fd 重定向的落点 —— 只接 configure 之前的 stderr。 */
  bootLogPath: string
  lockPath: string
}

export function assertSupportedPlatform(): void {
  if (process.platform === 'win32') {
    const error = new Error('Windows daemon transport is not supported in v1.')
    error.name = 'ERR_UNSUPPORTED_PLATFORM'
    throw error
  }
}

export function getCliRuntimePaths(storePath = getOnethingStorePath()): CliRuntimePaths {
  // run 目录的定义只有一处(@onething/runtime/storage),发现文件 http.json 与
  // daemon.sock / backend.lock 同住这里。
  const runDir = getOnethingRunDir({ storePath })
  const logDir = getOnethingLogDir({ storePath })
  return {
    storePath,
    runDir,
    socketPath: path.join(runDir, 'daemon.sock'),
    pidPath: path.join(runDir, 'daemon.pid'),
    logDir,
    logPath: path.join(logDir, 'daemon.jsonl'),
    bootLogPath: path.join(logDir, 'daemon.log'),
    lockPath: path.join(runDir, 'backend.lock'),
  }
}

export function ensureRuntimeDirs(paths: CliRuntimePaths): void {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(paths.logDir, { recursive: true })
}

export function defaultStorePath(): string {
  return process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}
