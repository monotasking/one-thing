/**
 * note —— 笔记领域(`docs/design/notes-obsidian-cli-2026-09.md` §3):笔记库(`NoteVault`)、
 * 自述的笔记系统驱动(Obsidian、普通目录)与它们的登记表,以及装配好的笔记子系统。
 *
 * 消费方只该拿 `NoteVault` 与子系统给的几个「现在的笔记根 / 笔记库」读法 —— 驱动的具体类型是给
 * 装配与测试用的,不是给消费方 `instanceof` 用的。对外交出三类东西:
 * - 领域形状:`NoteVault` / `NoteSystemDriver` / `NoteSystemState` 与「这个库现在用不了」的错误;
 * - 笔记子系统:装配(`bootstrapNotes`)、安全地取、登记表,以及「笔记根」「笔记库」「技能用的笔记根」
 *   这几个全仓唯一的读法;旧设置的一次性迁移;
 * - 测试与真机门要直接构造的几只驱动零件(普通目录库、Obsidian 的命令行 / 库 / 快照 / 状态判据、`~` 展开)。
 * 依赖 settings、storage、logging,以及包根的当前实例槽与本机信任判据。
 */

// 领域形状。
export { NoteVaultUnavailable } from './note-types.js'
export type {
  NoteLinkKind,
  NoteSystemDriver,
  NoteSystemState,
  NoteVault,
  NoteVaultUnavailableReason,
} from './note-types.js'

// 装配好的笔记子系统与「笔记根」读法。
export {
  bootstrapNotes,
  getNotesSubsystemSafe,
  getNoteSystemRegistry,
  noteRootsNow,
  noteVaultsNow,
  primaryNoteVaultNow,
  skillVaultRootsNow,
} from './note-subsystem.js'
export type { NotesSubsystem } from './note-subsystem.js'
export { migrateNotesSettings } from './note-migration.js'

// 驱动零件(测试与真机门直接构造)。
export { expandHome } from './note-paths.js'
export { FolderVault } from './folder/note-folder-vault.js'
export { ObsidianCli } from './obsidian/note-obsidian-cli.js'
export { MemorySnapshotStore } from './obsidian/note-obsidian-snapshot.js'
export { judgeObsidianState } from './obsidian/note-obsidian-state.js'
export { ObsidianVault } from './obsidian/note-obsidian-vault.js'
