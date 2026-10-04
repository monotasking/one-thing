import { CoreFileStorageProvider } from '@onething/backend/storage/storage-primitives'
import {
  ensureOnethingStoreDirs,
} from './storage-paths.js'
export class FileStorageProvider extends CoreFileStorageProvider {
  async initialize(): Promise<void> {
    ensureOnethingStoreDirs()
    await super.initialize()
  }
}
