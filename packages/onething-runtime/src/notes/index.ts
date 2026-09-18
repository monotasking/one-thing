/**
 * 笔记领域的桶(`docs/design/notes-obsidian-cli-2026-09.md` §3)。
 *
 * 消费方只该从这里拿 `NoteSystemRegistry` / `NoteVault` —— 驱动的具体类型是给
 * **装配层**注册用的,不是给消费方 `instanceof` 用的。
 */

export * from './types.js'
export { NoteSystemRegistry, type NoteSystemRegistryLogger } from './registry.js'
export { expandHome, isInsideRoot, normalizeVaultRoot } from './paths.js'
export { formatDailyDate } from './daily-format.js'
export { BasenameIndex, type BasenameIndexOptions } from './basename-index.js'
export {
  buildLinkText,
  resolveAttachmentFolder,
  toLinkPathStyle,
  uniqueAttachmentName,
  type LinkTextOptions,
  type NoteLinkPathStyle,
} from './link-format.js'
export {
  createNodeProcessRunner,
  createSocketLivenessProbe,
  NoteProcessTimeout,
} from './process-runner.js'

// ── 驱动 ──────────────────────────────────────────────
export { ObsidianDriver, type ObsidianDriverOptions } from './obsidian/driver.js'
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
} from './obsidian/cli.js'
export {
  ObsidianRegistry,
  obsidianConfigPathCandidates,
  vaultNameFromPath,
  type ObsidianRegistrySnapshot,
  type ObsidianVaultRecord,
} from './obsidian/registry.js'
export {
  FileSnapshotStore,
  MemorySnapshotStore,
  type ObsidianVaultSnapshot,
  type SnapshotStore,
} from './obsidian/snapshot.js'
export { judgeObsidianState, resolveObsidianState } from './obsidian/state.js'
export { ObsidianVault, OBSIDIAN_SYSTEM_ID, type ObsidianVaultOptions } from './obsidian/vault.js'
export { FolderDriver } from './folder/driver.js'
export { FolderVault, FOLDER_SYSTEM_ID, type FolderVaultOptions } from './folder/vault.js'
