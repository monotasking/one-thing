/**
 * scratchpad —— 草稿纸:每个会话一张 markdown 草稿,用户写、AI 每回合静默读到改动。
 *
 * 对外交出三类东西:
 * - 草稿纸运行时:宿主注入口、读 / 改 / 删 / 认领一张草稿、起停文件监视、给引擎的回合钩子;
 * - 仓库类 `OnethingScratchpadStore` 与草稿、改动载荷的形状;
 * - 文件监视器类 `OnethingScratchpadWatcher`。
 * 依赖 storage、logging。
 */
export {
  OnethingScratchpadStore,
  type ScratchpadChangedPayload,
  type ScratchpadDocument,
} from './scratchpad-store.js'
export {
  OnethingScratchpadWatcher,
} from './scratchpad-watcher.js'

// 草稿纸运行时。
export {
  adoptScratchpad,
  configureScratchpadHost,
  getScratchpadHostPorts,
  readScratchpad,
  removeScratchpad,
  resetScratchpadHost,
  scratchpadRuntimeHooks,
  startScratchpadWatcher,
  stopScratchpadWatcher,
  updateScratchpad,
} from './scratchpad-service-bound.js'
export type { ScratchpadHostPorts } from './scratchpad-service-bound.js'
