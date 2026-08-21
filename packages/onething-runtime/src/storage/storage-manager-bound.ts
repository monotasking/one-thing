/**
 * 进程级的 `HeadlessStorageManager` 单例(绑定文件 provider)。
 *
 * P3'a-3 从 `src/app/storage/index.ts` 归位:它除了那一句 `consolePort` 之外没有
 * 任何装配层依赖 —— provider 是 `./file-storage.js`,管理器是 core 的。文件名带
 * `-bound` 表明它是**被绑定的单例**,不是可复用的纯模块(纯的那半在 core)。
 */

import type {
  CoreStorageConfig as StorageConfig,
  CoreStorageProvider as IStorageProvider,
  CoreStorageType as StorageType,
} from '@onething/core/storage'
import { FileStorageProvider } from './file-storage.js'
import { HeadlessStorageManager } from '@onething/core/storage'
import { consolePort, getLogger } from '../logging/index.js'

const log = getLogger('storage')
/** 注入式鸭子 logger 端口的过渡替身(logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


function createStorageProvider(config: StorageConfig): IStorageProvider {
  switch (config.type) {
    case 'file':
    default:
      return new FileStorageProvider()
  }
}

const storageManager = new HeadlessStorageManager(createStorageProvider)

export async function initializeStorage(
  type: StorageType = 'file'
): Promise<IStorageProvider> {
  const alreadyInitialized = Boolean(storageManager.instance) && storageManager.type === type
  const storage = await storageManager.initializeStorage(type)
  if (!alreadyInitialized) {
    log.info('storage initialized', { backend: type })
  }
  return storage
}

export function getStorage(): IStorageProvider {
  return storageManager.getStorage({ onInitializeError: consoleLog.error })
}

export async function closeStorage(): Promise<void> {
  await storageManager.closeStorage()
}

export * from '@onething/core/storage'
export { FileStorageProvider } from './file-storage.js'
