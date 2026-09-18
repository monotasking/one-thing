/**
 * Obsidian 驱动:名册 ∩ 配置 = 今天在册的库。
 *
 * 三个闸,顺序固定:
 *  ① 这个驱动自己那一行总开关(`config.systems[this.id]`,缺席 = 开)——关了整个
 *     系统退场,一条命令都不发,连名册都不读。**读的是自己的 id,不是字面量
 *     `obsidian`**,所以这一句在下一个驱动里逐字一样;
 *  ② `obsidian.json` 的名册 —— 它是唯一的库来源(不向上找 `.obsidian`);
 *  ③ `settings.notes.vaults[id].enabled !== false` —— 缺席算开(R7:迁移把全部
 *     库种成 enabled,新出现的库也该默认在册)。
 *
 * **`open` 不在这三个闸里**:一个没打开的库仍然该出现在列表里(用户看得到、
 * 能在设置里关掉它),只是它的前台动作会被 `ObsidianVault` 拒掉。把它从表里
 * 抹掉等于「用户关掉 Obsidian 窗口,笔记库就消失了」。
 */

import { isNoteSystemEnabled, type NotesConfig, type NoteSystemDriver, type NoteVault } from '../types.js'
import type { ObsidianCli } from './cli.js'
import { ObsidianRegistry, vaultNameFromPath } from './registry.js'
import type { SnapshotStore } from './snapshot.js'
import { ObsidianVault, OBSIDIAN_SYSTEM_ID, type ObsidianVaultLogger } from './vault.js'

export interface ObsidianDriverOptions {
  registry: ObsidianRegistry
  cli: ObsidianCli
  snapshots: SnapshotStore
  logger?: ObsidianVaultLogger
}

export class ObsidianDriver implements NoteSystemDriver {
  readonly id = OBSIDIAN_SYSTEM_ID

  constructor(private readonly options: ObsidianDriverOptions) {}

  async discover(config: NotesConfig): Promise<NoteVault[]> {
    if (!isNoteSystemEnabled(config, this.id)) return []
    const snapshot = await this.options.registry.read()
    return snapshot.vaults
      .filter(record => config.vaults[record.id]?.enabled !== false)
      .map(record => new ObsidianVault({
        record,
        cli: this.options.cli,
        snapshots: this.options.snapshots,
        name: vaultNameFromPath(record.path),
        logger: this.options.logger,
      }))
  }
}
