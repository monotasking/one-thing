import { CoreFileStorageProvider } from '@onething/backend/storage/storage-primitives'
import {
  ensureOnethingStoreDirs,
} from './paths.js'
export class FileStorageProvider extends CoreFileStorageProvider {
  async initialize(): Promise<void> {
    ensureOnethingStoreDirs()
    await super.initialize()
  }
}
