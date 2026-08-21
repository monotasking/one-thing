import { CoreFileStorageProvider } from '@onething/core/storage'
import {
  ensureOnethingStoreDirs,
} from './paths.js'
export class FileStorageProvider extends CoreFileStorageProvider {
  async initialize(): Promise<void> {
    ensureOnethingStoreDirs()
    await super.initialize()
  }
}
