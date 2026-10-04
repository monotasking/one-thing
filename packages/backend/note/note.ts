/**
 * 笔记领域的桶(`docs/design/notes-obsidian-cli-2026-09.md` §3)。
 *
 * 消费方只该从这里拿 `NoteSystemRegistry` / `NoteVault` —— 驱动的具体类型是给
 * **装配层**注册用的,不是给消费方 `instanceof` 用的。
 */

export * from './note-types.js'
export { NoteSystemRegistry, type NoteSystemRegistryLogger } from './note-registry.js'
export { expandHome, isInsideRoot, normalizeVaultRoot } from './note-paths.js'
export { formatDailyDate } from './note-daily-format.js'
export { BasenameIndex, type BasenameIndexOptions } from './note-basename-index.js'
export {
  buildLinkText,
  resolveAttachmentFolder,
  toLinkPathStyle,
  uniqueAttachmentName,
  type LinkTextOptions,
  type NoteLinkPathStyle,
} from './note-link-format.js'
export {
  createNodeProcessRunner,
  createSocketLivenessProbe,
  NoteProcessAborted,
  NoteProcessTimeout,
} from './note-process-runner.js'

// ── 驱动 ──────────────────────────────────────────────
export { ObsidianDriver, type ObsidianDriverOptions } from './obsidian/note-obsidian-driver.js'
export {
  ObsidianCli,
  ObsidianCliError,
  OBSIDIAN_CLI_BUDGET_MS,
  parseEvalJson,
  parseEvalText,
  resolveObsidianExecutable,
  type ObsidianCliOptions,
  type ObsidianCliResult,
  type ObsidianCliRunOptions,
} from './obsidian/note-obsidian-cli.js'
export {
  ObsidianRegistry,
  obsidianConfigPathCandidates,
  vaultNameFromPath,
  type ObsidianRegistrySnapshot,
  type ObsidianVaultRecord,
} from './obsidian/note-obsidian-registry.js'
export {
  FileSnapshotStore,
  MemorySnapshotStore,
  type ObsidianVaultSnapshot,
  type SnapshotStore,
} from './obsidian/note-obsidian-snapshot.js'
export { judgeObsidianState, resolveObsidianState } from './obsidian/note-obsidian-state.js'
export { ObsidianVault, OBSIDIAN_SYSTEM_ID, type ObsidianVaultOptions } from './obsidian/note-obsidian-vault.js'
export { FolderDriver } from './folder/note-folder-driver.js'
export { FolderVault, FOLDER_SYSTEM_ID, type FolderVaultOptions } from './folder/note-folder-vault.js'
