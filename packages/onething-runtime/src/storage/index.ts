export * from './app-state.js'
export * from './paths.js'
export * from './store-lock.js'
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
} from '@onething/core/storage'
