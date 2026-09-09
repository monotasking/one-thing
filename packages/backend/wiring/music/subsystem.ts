import { listMusicProviderDescriptors, type OnethingMusicNowPlaying } from '@onething/runtime/music'
import { DEFAULT_MUSIC_SETTINGS } from '@shared/defaults/settings.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { createMusicServiceScope } from './service.js'
import { createRadioScope } from './radio.js'
import { createDjVoiceScope } from './dj-voice.js'
import { createMusicOperationsScope } from './operations.js'
import { MusicWorkOwner } from './lifetime.js'

type MusicGeneration = {
  service: ReturnType<typeof createMusicServiceScope>
  djVoice: ReturnType<typeof createDjVoiceScope>
  radio: ReturnType<typeof createRadioScope>
  operations: ReturnType<typeof createMusicOperationsScope>
}

/** One Backend owns every provider generation until its real work has ended. */
export class MusicSubsystem {
  private readonly owner: MusicWorkOwner
  private generation: MusicGeneration
  private readonly generations = new Set<MusicGeneration>()
  private changes: Promise<unknown> = Promise.resolve()
  /**
   * 谁在看「现在放的东西变了」(K3-b:`music:player` 的 `nowPlayingChanged`)。
   *
   * 表住在**子系统**而不是那只服务作用域上,因为作用域随 provider 切换整代重建
   * (`switchProvider`)而这张表的寿命是 backend 的寿命 —— 换一次音乐 CLI 不该让
   * 订阅者悄悄失聪。每一代作用域拿到的是同一只扇出闭包。
   */
  private readonly nowPlayingListeners = new Set<(nowPlaying: OnethingMusicNowPlaying | null) => void>()

  constructor(private readonly options: { storePath: string; assertOwned: () => void }) {
    this.owner = new MusicWorkOwner(options.assertOwned)
    this.generation = this.createGeneration()
  }

  /**
   * 订阅「现在放的东西变了」。返回退订(幂等)。
   *
   * 判据是 watcher 自己的变化检测(标题 / 状态 / 时长任一变了),不是每一拍轮询 ——
   * 位置每秒都在动,把它也算成「变了」会让每个订阅者都得自己再去一次抖动。
   */
  onNowPlayingChanged(listener: (nowPlaying: OnethingMusicNowPlaying | null) => void): () => void {
    this.nowPlayingListeners.add(listener)
    return () => {
      this.nowPlayingListeners.delete(listener)
    }
  }

  private createGeneration(): MusicGeneration {
    const service = createMusicServiceScope({
      ...this.options,
      onNowPlaying: nowPlaying => {
        // 拷一份再遍历:监听器在回调里退订是正常操作(一次 unmount)。
        for (const listener of [...this.nowPlayingListeners]) listener(nowPlaying)
      },
    })
    const djVoice = createDjVoiceScope(this.options.assertOwned)
    const radio = createRadioScope({ ...this.options, service, djVoice })
    const operations = createMusicOperationsScope({ ...this.options, service, radio })
    const generation = { service, djVoice, radio, operations }
    this.generations.add(generation)
    return generation
  }

  get service() { this.owner.assertActive(); return this.generation.service }
  get radio() { this.owner.assertActive(); return this.generation.radio }
  get djVoice() { this.owner.assertActive(); return this.generation.djVoice }
  get operations() { this.owner.assertActive(); return this.generation.operations }

  private quiesceGeneration(generation: typeof this.generation): void {
    generation.operations.quiesce()
    generation.radio.quiesce()
    generation.djVoice.quiesce()
    generation.service.quiesce()
  }

  private async drainGeneration(generation: typeof this.generation): Promise<void> {
    this.quiesceGeneration(generation)
    await Promise.all([generation.operations.drain(), generation.radio.drain(), generation.djVoice.drain(), generation.service.drain()])
  }

  switchProvider(providerId: string): Promise<{ success: boolean; error?: string }> {
    this.owner.assertActive()
    const work = this.changes.catch(() => {}).then(async () => {
      this.owner.assertActive()
      if (!listMusicProviderDescriptors().some(provider => provider.id === providerId)) {
        return { success: false, error: `未知的音乐 CLI:${providerId}` }
      }
      const settings = getSettings()
      const music = settings.music ?? { ...DEFAULT_MUSIC_SETTINGS }
      if (music.provider === providerId) return { success: true }
      const previous = this.generation
      await this.drainGeneration(previous)
      this.owner.assertActive()
      this.generations.delete(previous)
      // All old writers are gone before the provider selection changes.
      saveSettings({ ...settings, music: { ...music, provider: providerId, configured: false } })
      this.generation = this.createGeneration()
      const newStore = this.generation.radio.getRadioStore()
      newStore.writeProgramme({ entries: [] })
      newStore.writeBrief({ ...newStore.readBrief(), active: false, onDeck: undefined })
      this.generation.service.startMusicNowPlayingWatch()
      this.generation.radio.startRadioConductor()
      return { success: true }
    })
    this.changes = work
    return this.owner.track(work)
  }

  resetRadio(): Promise<void> {
    this.owner.assertActive()
    const work = this.changes.catch(() => {}).then(async () => {
      this.owner.assertActive()
      const previous = this.generation
      previous.operations.quiesce()
      previous.radio.quiesce()
      previous.djVoice.quiesce()
      await Promise.all([previous.operations.drain(), previous.radio.drain(), previous.djVoice.drain()])
      this.owner.assertActive()
      this.generations.delete(previous)
      const djVoice = createDjVoiceScope(this.options.assertOwned)
      const radio = createRadioScope({ ...this.options, service: previous.service, djVoice })
      const operations = createMusicOperationsScope({ ...this.options, service: previous.service, radio })
      this.generation = { service: previous.service, djVoice, radio, operations }
      this.generations.add(this.generation)
    })
    this.changes = work
    return this.owner.track(work)
  }

  quiesce(): void {
    this.owner.quiesce()
    for (const generation of this.generations) this.quiesceGeneration(generation)
  }

  async drain(): Promise<void> {
    this.quiesce()
    await this.owner.drain()
    await Promise.all([...this.generations].map(generation => this.drainGeneration(generation)))
  }
}
