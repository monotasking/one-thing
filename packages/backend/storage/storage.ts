export * from './storage-app-state.js'
export * from './storage-builtin-resources.js'
export * from './storage-paths.js'
export * from './storage-store-lock.js'
export * from './storage-store-backup.js'
// 打包资源目录的宿主注入口 `configureStorePathHost`(包根归位 2,2026-10-03 从包根 `stores/docs-paths.ts` 搬来)。
export { configureStorePathHost, getMacOSAutomationDocsPath, resetStorePathHost } from './storage-docs-paths.js'
export type { StorePathHost } from './storage-docs-paths.js'
/**
 * 文件 IO 原语从 core 借道这里出去 —— P3'a-2 之前它们是 `app/stores/paths.ts`
 * 顺手再导出的一组,调用点(含 43 个 `vi.mock`)一直把「路径」与「读写 JSON」
 * 当同一个模块用。转发层删掉之后保持同一个出口,省得每个调用点各自再引一次 core。
 */
export {
  deleteJsonFile,
  ensureDir,
  generateToolOutputFilename,
  joinPaths,
  readJsonFile,
  writeJsonFile,
  writeJsonFileAsync,
} from '@onething/backend/storage/storage-primitives'
