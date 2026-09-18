/**
 * 笔记系统注册表 —— 「加一种笔记系统 = 一个目录 + 一行注册」里的那张表。
 *
 * **这个文件里不出现任何一个驱动的名字。** 注册顺序即优先级(先认领先得),
 * `vaultFor` 是最长前缀匹配 —— 一个库被另一个库包着(用户把 vault 放进另一个
 * vault 的子目录)时,里面那个赢,因为它的根更长。
 */

import { isInsideRoot, normalizeVaultRoot } from './paths.js'
import type { NotesConfig, NoteSystemDriver, NoteVault } from './types.js'

export interface NoteSystemRegistryLogger {
  warn(message: string, fields?: Record<string, unknown>, error?: unknown): void
}

export class NoteSystemRegistry {
  private readonly drivers: NoteSystemDriver[] = []
  /** 最近一次 `refresh` 的产物。注册表自己不缓存单个库的状态。 */
  private discovered: NoteVault[] = []
  private config: NotesConfig | null = null

  constructor(private readonly logger?: NoteSystemRegistryLogger) {}

  /** 注册顺序 = 认领顺序。重复 id 直接抛:两份同 id 的驱动谁赢是说不清的。 */
  register(driver: NoteSystemDriver): void {
    if (this.drivers.some(existing => existing.id === driver.id)) {
      throw new Error(`[notes] a note-system driver with id "${driver.id}" is already registered`)
    }
    this.drivers.push(driver)
  }

  registeredDriverIds(): readonly string[] {
    return this.drivers.map(driver => driver.id)
  }

  /**
   * 按配置重问一遍所有驱动。
   *
   * **先认领先得**:同一个根被两个驱动都认下来时,注册在前的那个赢 —— 判据是
   * 归一后的根路径,不是 id。一个驱动抛了不拖累别人(记一条 warn 跳过它)。
   */
  async refresh(config: NotesConfig): Promise<NoteVault[]> {
    this.config = config
    const claimed = new Map<string, NoteVault>()
    for (const driver of this.drivers) {
      let vaults: NoteVault[]
      try {
        vaults = await driver.discover(config)
      } catch (error) {
        this.logger?.warn('note-system driver discovery failed', { driver: driver.id }, error)
        continue
      }
      for (const vault of vaults) {
        const key = normalizeVaultRoot(vault.root)
        if (claimed.has(key)) continue
        claimed.set(key, vault)
      }
    }
    this.discovered = [...claimed.values()]
    return this.vaults()
  }

  /**
   * 把库表清空(驱动仍然在册)。
   *
   * 给「这台宿主现在不该交出本机笔记库」那一档用:与「问过驱动、它什么都没给」
   * 是同一个可观察状态,所以消费方不需要认识第二种「空」。
   */
  clear(): void {
    this.discovered = []
  }

  vaults(): NoteVault[] {
    return [...this.discovered]
  }

  vault(id: string): NoteVault | null {
    return this.discovered.find(vault => vault.id === id) ?? null
  }

  /**
   * 主库:配置指定的那个(还在表里的话),否则第一个。
   *
   * 「否则第一个」不是随便挑:`refresh` 的顺序是注册顺序 × 驱动自己的顺序,
   * 两者都是确定的,所以这个回落在同一台机器上是稳定的。
   */
  primaryVault(): NoteVault | null {
    const preferred = this.config?.primaryVaultId
    if (preferred) {
      const match = this.vault(preferred)
      if (match) return match
    }
    return this.discovered[0] ?? null
  }

  /** 这个绝对路径落在哪个库里。最长前缀匹配;不在任何库里回 `null`。 */
  vaultFor(absPath: string): NoteVault | null {
    let best: NoteVault | null = null
    let bestLength = -1
    for (const vault of this.discovered) {
      if (!isInsideRoot(absPath, vault.root)) continue
      const length = normalizeVaultRoot(vault.root).length
      if (length > bestLength) {
        best = vault
        bestLength = length
      }
    }
    return best
  }
}
