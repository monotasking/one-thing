/**
 * Obsidian 的库名册 = `obsidian.json`。
 *
 * **不再向上找 `.obsidian`**(那是 v1 的做法):名册是 Obsidian 自己维护的、
 * 离线可读的一份表,里面还带着「这个库现在开着没有」这一格 —— 后者正是「能不能
 * 对它发命令」的判据。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { normalizeVaultRoot } from '../paths.js'

export interface ObsidianVaultRecord {
  /** `obsidian.json` 里的键。命令行永远显式传它,不传名字。 */
  id: string
  /** 绝对路径,已归一。 */
  path: string
  /** 名册里没有这一格就是 false —— 「没写」不等于「开着」。 */
  open: boolean
}

export interface ObsidianRegistryLogger {
  warn(message: string, fields?: Record<string, unknown>, error?: unknown): void
}

/**
 * 三平台的 `obsidian.json` 落点。linux 上 flatpak 装法把整个 config 根挪了位,
 * 所以那一路给两条候选。
 */
export function obsidianConfigPathCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')]
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [path.join(appData, 'obsidian', 'obsidian.json')]
  }
  return [
    path.join(home, '.config', 'obsidian', 'obsidian.json'),
    path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
  ]
}

interface ObsidianConfigFile {
  vaults?: Record<string, { path?: unknown; ts?: unknown; open?: unknown } | undefined>
  cli?: unknown
}

export interface ObsidianRegistrySnapshot {
  vaults: ObsidianVaultRecord[]
  /** 名册自己说「CLI 已注册」。名册缺席时是 `false`。 */
  cliRegistered: boolean
  /** 真正读到的那个文件;一个都没读到时 `null`。 */
  sourcePath: string | null
}

const EMPTY: ObsidianRegistrySnapshot = { vaults: [], cliRegistered: false, sourcePath: null }

/**
 * 读名册。
 *
 * **文件缺席 / 坏 JSON = 空表 + warn,不抛**:没装 Obsidian 是一种完全正常的
 * 机器状态,不该让装配失败。
 */
export class ObsidianRegistry {
  constructor(
    private readonly options: {
      /** 覆盖候选路径(测试注入)。 */
      configPaths?: string[]
      logger?: ObsidianRegistryLogger
    } = {},
  ) {}

  async read(): Promise<ObsidianRegistrySnapshot> {
    const candidates = this.options.configPaths ?? obsidianConfigPathCandidates()
    for (const candidate of candidates) {
      let raw: string
      try {
        raw = await fs.readFile(candidate, 'utf-8')
      } catch {
        continue // 这一路没有,试下一条。
      }
      let parsed: ObsidianConfigFile
      try {
        parsed = JSON.parse(raw) as ObsidianConfigFile
      } catch (error) {
        this.options.logger?.warn('obsidian.json is not valid JSON; treating it as no vaults', { path: candidate }, error)
        return { ...EMPTY, sourcePath: candidate }
      }
      return {
        vaults: parseVaults(parsed),
        cliRegistered: parsed.cli === true,
        sourcePath: candidate,
      }
    }
    return EMPTY
  }
}

function parseVaults(config: ObsidianConfigFile): ObsidianVaultRecord[] {
  const vaults = config.vaults
  if (!vaults || typeof vaults !== 'object') return []
  const records: ObsidianVaultRecord[] = []
  for (const [id, entry] of Object.entries(vaults)) {
    const vaultPath = entry?.path
    if (typeof vaultPath !== 'string' || vaultPath.trim() === '') continue
    records.push({ id, path: normalizeVaultRoot(vaultPath), open: entry?.open === true })
  }
  return records
}

/** 库根的最后一段 = Obsidian 界面上显示的库名。 */
export function vaultNameFromPath(vaultPath: string): string {
  return path.basename(normalizeVaultRoot(vaultPath)) || vaultPath
}
