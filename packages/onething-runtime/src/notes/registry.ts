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
   * 在册的驱动本身(只读快照)。
   *
   * 给「问每个驱动它自己那句自述」的读者用 —— 今天只有一个:设置页要的
   * 「这个系统此刻什么状态」。**这只方法不认识任何一个驱动的名字**,所以加一种
   * 笔记系统仍然是一个目录 + 一行注册。
   */
  registeredDrivers(): readonly NoteSystemDriver[] {
    return [...this.drivers]
  }

  /** 按 id 取一个驱动。不在册 = `null`。 */
  driver(id: string): NoteSystemDriver | null {
    return this.drivers.find(driver => driver.id === id) ?? null
  }

  /**
   * 按配置重问一遍所有驱动。
   *
   * **先认领先得**:同一个根被两个驱动都认下来时,注册在前的那个赢 —— 判据是
   * 归一后的根路径,不是 id。一个驱动抛了不拖累别人(记一条 warn 跳过它)。
   */
  async refresh(config: NotesConfig): Promise<NoteVault[]> {
    this.config = config
    this.discovered = await this.discoverAll(config)
    return this.vaults()
  }

  /**
   * 按一份配置问一遍所有驱动,**不改这张表的状态**。
   *
   * 它是 `refresh` 的身子;单独露出来是因为有一个读者要的是**另一份配置下**的
   * 答案:设置页要画「名册里的全部库」,包括被用户关掉的那些 —— 关掉的库必须
   * 画得出来才关得回来。那一发传的是「把偏好全清空」的同一份配置
   * (`{...config, systems: {}, vaults: {}}`),于是每个驱动自己那两道开关闸
   * 全部放行。
   *
   * **这里没有为那个读者开一格新端口**:驱动的两道闸读的本来就是配置,
   * 「不筛」就是「传一份没有偏好的配置」。加一种笔记系统仍然是一个目录 + 一行
   * 注册 —— 这只方法一个驱动的名字都不认识。
   */
  async discoverAll(config: NotesConfig): Promise<NoteVault[]> {
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
    return [...claimed.values()]
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
