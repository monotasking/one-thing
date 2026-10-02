import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gatewayLogger } from './logging.js'

const DEFAULT_STORE_DIR_NAME = '.onething'

export function getGatewayStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ONETHING_STORE_PATH || path.join(os.homedir(), DEFAULT_STORE_DIR_NAME)
}

export function getGatewayDataPath(...segments: string[]): string {
  return path.join(getGatewayStorePath(), 'gateway', ...segments)
}

export function readGatewayJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const content = fs.readFileSync(filePath, 'utf-8').trim()
    return content ? JSON.parse(content) as T : fallback
  } catch {
    gatewayLogger('storage').warn('read failed, using fallback', { file: path.basename(filePath) })
    return fallback
  }
}

export function writeGatewayJsonFile<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

export function deleteGatewayFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    gatewayLogger('storage').warn('delete failed', { file: path.basename(filePath) })
  }
}
