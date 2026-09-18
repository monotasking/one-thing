/**
 * 目录驱动:`settings.notes.folders[]` 里每一条一个库。
 *
 * 它排在 Obsidian 驱动**之后**注册,所以「一个目录既在 folders 里、又是某个
 * Obsidian 库的根」时 Obsidian 那个赢(先认领先得,`NoteSystemRegistry.refresh`)。
 * 这是对的:同一个目录,能问 app 的答案比自己算的准。
 */

import { isNoteSystemEnabled, type NotesConfig, type NoteSystemDriver, type NoteVault } from '../types.js'
import { FOLDER_SYSTEM_ID, FolderVault } from './vault.js'

export class FolderDriver implements NoteSystemDriver {
  readonly id = FOLDER_SYSTEM_ID

  async discover(config: NotesConfig): Promise<NoteVault[]> {
    // 与 Obsidian 驱动逐字相同的一句:读自己那一行,不认识别人的名字。
    if (!isNoteSystemEnabled(config, this.id)) return []
    return config.folders.map(root => new FolderVault({
      root,
      dailyFormat: config.dailyFormat,
      attachmentDirectory: config.attachmentDirectory,
    }))
  }
}
