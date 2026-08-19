import {
  ensureDir,
  readJsonFile,
  writeJsonFile,
} from '../storage/index.js'
import path from 'path'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.plugins')

import {
  PLUGIN_KV_FILE_NAME,
  assertNotInNodeModules,
  getCorePluginDataDir,
  getCorePluginHomeDir,
  getCorePluginKvPath,
} from './storage.js'

export interface PluginStoreOptions {
  /**
   * 旧数据根(plugin-data)。**只在没有 homeRoot 时**是 KV 的落点 —— 桌面宿主
   * 一律给 homeRoot,这条参数留给不做家目录布局的调用方。
   */
  dataDir?: string
  /** 家目录根(P1)。给了它,KV 落在 `plugins/<id>/kv.json`。 */
  homeRoot?: string
  /**
   * 是否正在跑 onDispose 回调。
   *
   * 这段窗口里写面放行 —— 插件在 onDispose 里存盘是最自然的收尾写法。
   * 与 `api.storage` 的 `state.disposing` 同构:两个写面必须同时开窗,
   * 否则插件用哪一半就在哪一半丢数据。
   */
  isDisposing?(): boolean
}

/**
 * 插件 KV。
 *
 * R4 起落在 `<root>/<pluginId>/kv.json` 而不是 `<root>/<pluginId>.json`;
 * P1 之后 root 就是家目录 `plugins/` —— 这样"插件的全部落盘足迹"就是一个目录,
 * 卸载与归档只需要搬一次。**没有惰性迁移**:`plugin-data/` 的读路径随 legacy
 * 目录插件一起退役(2026-08-09),那里剩下的东西由孤儿收尸归档。
 */
export class CorePluginStore {
  private data: Record<string, unknown> = {}
  private readonly dataRoot?: string
  private loaded = false

  private disposed = false

  constructor(
    private readonly pluginId: string,
    private readonly options: PluginStoreOptions,
  ) {
    this.dataRoot = options.dataDir
    // 家目录布局下 KV 目录由 save() 现建;旧布局才需要先把数据根摆好。
    if (!options.homeRoot && this.dataRoot) ensureDir(this.dataRoot)
  }

  /**
   * 拆除闩。
   *
   * 没有它的话:一个被 abort 的异步回调事后调 store.set,save() 里的 ensureDir
   * 会把刚刚归档掉的数据目录**复活成一个鬼目录** —— 下一轮孤儿扫描又把它搬走,
   * 如此往复。
   */
  dispose(): void {
    this.disposed = true
  }

  private rejectIfDisposed(what: string): boolean {
    // **onDispose 期间放行**,与 api.storage 同构:插件最自然的收尾写法就是在
    // onDispose 里存盘,而 KV 是它最可能用的那一半。上一版只有 storage 那侧开了
    // 窗口,`api.store.set` 仍撞在已关的 store 上 —— 而这里只 console.error、
    // 不抛不落,正是要根除的那种静默丢数据。
    if (this.options.isDisposing?.()) return false
    if (!this.disposed) return false
    log.error('ignoring store call after dispose', { pluginId: this.pluginId, call: what })
    return true
  }

  private get filePath(): string {
    const homeRoot = this.options.homeRoot
    if (homeRoot) return path.join(getCorePluginHomeDir(homeRoot, this.pluginId), PLUGIN_KV_FILE_NAME)
    return getCorePluginKvPath(this.requireDataRoot(), this.pluginId)
  }

  private get kvDir(): string {
    const homeRoot = this.options.homeRoot
    if (homeRoot) return getCorePluginHomeDir(homeRoot, this.pluginId)
    return getCorePluginDataDir(this.requireDataRoot(), this.pluginId)
  }

  private requireDataRoot(): string {
    if (!this.dataRoot) {
      throw new Error(`[PluginStore:${this.pluginId}] No store root configured (needs homeRoot or dataDir)`)
    }
    return this.dataRoot
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      this.data = readJsonFile<Record<string, unknown>>(this.filePath, {})
    } catch (error) {
      log.error('plugin store load failed', { pluginId: this.pluginId }, error)
      this.data = {}
    }
  }

  private save(): void {
    try {
      const homeRoot = this.options.homeRoot
      if (homeRoot) assertNotInNodeModules(homeRoot, this.filePath)
      ensureDir(this.kvDir)
      writeJsonFile(this.filePath, this.data)
    } catch (error) {
      log.error('plugin store save failed', { pluginId: this.pluginId }, error)
    }
  }

  get<T = unknown>(key: string): T | undefined {
    this.ensureLoaded()
    return this.data[key] as T | undefined
  }

  set<T = unknown>(key: string, value: T): void {
    if (this.rejectIfDisposed('set')) return
    this.ensureLoaded()
    this.data[key] = value
    this.save()
  }

  delete(key: string): void {
    if (this.rejectIfDisposed('delete')) return
    this.ensureLoaded()
    delete this.data[key]
    this.save()
  }

  keys(): string[] {
    this.ensureLoaded()
    return Object.keys(this.data)
  }
}
