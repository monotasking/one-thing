export interface CoreStorageProvider {
  initialize(): Promise<void>
  close(): Promise<void>
}

export type CoreStorageType = 'file'

export interface CoreStorageConfig {
  type: CoreStorageType
  dataDir?: string
}

export type CoreStorageProviderFactory<TProvider extends CoreStorageProvider = CoreStorageProvider> = (
  config: CoreStorageConfig
) => TProvider

export interface GetStorageOptions {
  onInitializeError?: (error: unknown) => void
}

export class HeadlessStorageManager<TProvider extends CoreStorageProvider = CoreStorageProvider> {
  private storageInstance: TProvider | null = null
  private currentStorageType: CoreStorageType = 'file'

  constructor(private readonly createStorageProvider: CoreStorageProviderFactory<TProvider>) {}

  get type(): CoreStorageType {
    return this.currentStorageType
  }

  get instance(): TProvider | null {
    return this.storageInstance
  }

  async initializeStorage(type: CoreStorageType = 'file'): Promise<TProvider> {
    if (this.storageInstance && this.currentStorageType === type) {
      return this.storageInstance
    }

    if (this.storageInstance) {
      await this.storageInstance.close()
    }

    const config: CoreStorageConfig = { type }
    this.storageInstance = this.createStorageProvider(config)
    this.currentStorageType = type
    await this.storageInstance.initialize()
    return this.storageInstance
  }

  getStorage(options: GetStorageOptions = {}): TProvider {
    if (!this.storageInstance) {
      this.storageInstance = this.createStorageProvider({ type: 'file' })
      this.currentStorageType = 'file'
      this.storageInstance.initialize().catch(error => {
        options.onInitializeError?.(error)
      })
    }
    return this.storageInstance
  }

  async closeStorage(): Promise<void> {
    if (this.storageInstance) {
      await this.storageInstance.close()
      this.storageInstance = null
    }
  }
}
