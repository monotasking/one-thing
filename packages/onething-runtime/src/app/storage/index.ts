/**
 * Storage Module Entry Point
 *
 * Simplified after memory system removal.
 */

import type {
  CoreStorageConfig as StorageConfig,
  CoreStorageProvider as IStorageProvider,
  CoreStorageType as StorageType,
} from '@onething/core/storage'
import { FileStorageProvider } from '@onething/runtime/storage/file-storage'
import { HeadlessStorageManager } from '@onething/core/storage'
import { consolePort, getLogger } from '../logging/index.js'

const log = getLogger('storage')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
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
export { FileStorageProvider } from '@onething/runtime/storage/file-storage'
