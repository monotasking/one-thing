import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOnethingLogDir, getOnethingRunDir, getOnethingStorePath } from '@onething/runtime/storage'

export interface CliRuntimePaths {
  storePath: string
  runDir: string
  socketPath: string
  pidPath: string
  logPath: string
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
  return {
    storePath,
    runDir,
    socketPath: path.join(runDir, 'daemon.sock'),
    pidPath: path.join(runDir, 'daemon.pid'),
    logPath: path.join(getOnethingLogDir({ storePath }), 'daemon.log'),
    lockPath: path.join(runDir, 'backend.lock'),
  }
}

export function ensureRuntimeDirs(paths: CliRuntimePaths): void {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(paths.logPath), { recursive: true })
}

export function defaultStorePath(): string {
  return process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
}
