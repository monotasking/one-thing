import { listMusicProviderDescriptors, type OnethingMusicNowPlaying } from '@onething/runtime/music'
import { DEFAULT_MUSIC_SETTINGS } from '@shared/defaults/settings.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { createMusicServiceScope } from './service.js'
import { createRadioScope } from './radio.js'
import { createDjVoiceScope } from './dj-voice.js'
import { createMusicOperationsScope } from './operations.js'
import { MusicWorkOwner } from './lifetime.js'
import { createHostVoiceKit, type HostVoice, type HostVoiceFactory, type HostVoiceKit, type SpeechActivityAnnouncer } from './host-voice.js'
import { MusicMoments, type MusicMomentEvent } from './moments.js'
import { readProviderVolume, setProviderVolume, SpeechActivityDuck } from './player-volume.js'
import type { EventBus } from '../../events/event-bus.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('music')

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
  /**
   * 接管主持人声音的那一方(宠物 P3,§10.2「宠物接管」)。没绑 = 电台用 dj-voice 缺省实现。
   *
   * 与 `nowPlayingListeners` 同理住在子系统上:换 provider / 重置电台会整代重建作用域,
   * 但「谁来说电台的话」是组合根定的,寿命是 backend 的寿命。电台每说一句现问一次
   * (`hostVoiceFor`),所以绑定可以晚于作用域建好,也不必在换代时重绑。
   */
  private hostVoiceFactory: HostVoiceFactory | undefined
  /**
   * 谁在看「听歌这件事的事实」(宠物 P4,§11.1:`music:player` 的 `trackStarted` / `skipped` / …)。
   * 与 `nowPlayingListeners` 同理住在子系统上。
   */
  private readonly factListeners = new Set<(event: MusicMomentEvent, payload: Record<string, unknown>) => void>()
  /**
   * 连跳计数、暂停计时、间奏检测(§11.1「音乐自己的状态,放在已有的 music 实例上」)。一只,
   * 寿命 = backend:换音乐 CLI 不该让「90 秒内第三次跳过」从零数起。
   */
  readonly moments: MusicMoments
  /** `speech:activity` 的发送口(§11.3)。`attachSpeechActivity` 接上总线之前 = 不报。 */
  private announceSpeech: SpeechActivityAnnouncer | undefined

  constructor(private readonly options: { storePath: string; assertOwned: () => void; clock?: { now(): number } }) {
    this.owner = new MusicWorkOwner(options.assertOwned)
    this.moments = new MusicMoments({
      emit: (event, payload) => {
        for (const listener of [...this.factListeners]) {
          try {
            listener(event, payload)
          } catch (error) {
            log.warn('music fact observer failed', { event }, error)
          }
        }
      },
      ...(options.clock ? { clock: options.clock } : {}),
    })
    this.generation = this.createGeneration()
  }

  /** 订阅「听歌这件事的事实」。返回退订(幂等)。 */
  onPlayerFact(listener: (event: MusicMomentEvent, payload: Record<string, unknown>) => void): () => void {
    this.factListeners.add(listener)
    return () => {
      this.factListeners.delete(listener)
    }
  }

  /**
   * 接上总线(§11.3):① 缺省主持人声音出声前后发 `speech:activity`;② 订同一条事件,播放器正在
   * 放时把音量压到 35%,说完恢复。返回解绑(组合根 `own()` 它)。
   *
   * 订与发都在这里,是因为音乐是「出声的应用」这一侧;发的另一方(宠物)用自己的总线把手发同一条,
   * 两边互不认识。
   */
  attachSpeechActivity(bus: Pick<EventBus, 'emitGlobal' | 'onGlobal'>): () => void {
    const duck = new SpeechActivityDuck({
      isPlaying: () => {
        // 收尾中的作用域会在读数上抛:那一刻不压,而不是把异常抛进总线的投递里。
        try {
          return this.generation.service.getMusicNowPlaying()?.status === 'playing'
        } catch {
          return false
        }
      },
      read: () => readProviderVolume(this.generation.service.getActiveMusicProvider()),
      set: level => {
        const service = this.generation.service
        return setProviderVolume(service.runner, service.getActiveMusicProvider(), level)
      },
      warn: (message, fields) => log.warn(message, fields),
    })
    const announce: SpeechActivityAnnouncer = active => {
      bus.emitGlobal({ type: 'speech:activity', active, at: Date.now() })
    }
    this.announceSpeech = announce
    const unsubscribe = bus.onGlobal('speech:activity', envelope => {
      duck.onActivity(envelope.event.active)
    })
    return () => {
      unsubscribe()
      if (this.announceSpeech === announce) this.announceSpeech = undefined
    }
  }

  /**
   * 此刻的出声工具包:同一份口播缓存、同一条出声路(§11.3「电台认领与宠物自发开口共用」)。
   * 电台以外想出声的一方(宠物自发开口)现问这一只,而不是自己复制一份缓存。
   */
  voiceKit(): HostVoiceKit {
    return this.kitFor(this.djVoice)
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

  /**
   * 让别人来说电台的话。返回解绑函数(只解自己绑的那一个)。音乐域不认识交进来的是谁 ——
   * 它只拿到一个 `HostVoice`。
   */
  bindHostVoice(factory: HostVoiceFactory): () => void {
    this.hostVoiceFactory = factory
    return () => {
      if (this.hostVoiceFactory === factory) this.hostVoiceFactory = undefined
    }
  }

  /** 这一代作用域此刻该用的主持人声音:绑了接管就交接管,没绑就是缺省。 */
  private hostVoiceFor(djVoice: MusicGeneration['djVoice']): HostVoice {
    const kit = this.kitFor(djVoice)
    return this.hostVoiceFactory ? this.hostVoiceFactory(kit) : kit.fallback
  }

  private kitFor(djVoice: MusicGeneration['djVoice']): HostVoiceKit {
    return createHostVoiceKit(djVoice, active => this.announceSpeech?.(active))
  }

  private createGeneration(): MusicGeneration {
    const service = createMusicServiceScope({
      ...this.options,
      onNowPlaying: nowPlaying => {
        // 拷一份再遍历:监听器在回调里退订是正常操作(一次 unmount)。
        // 暂停计时排在订阅者之前:一个抛了的订阅者不该让「暂停了多久」少记一次状态变化。
        this.moments.observeNowPlaying(nowPlaying)
        for (const listener of [...this.nowPlayingListeners]) listener(nowPlaying)
      },
    })
    const djVoice = createDjVoiceScope(this.options.assertOwned)
    const radio = createRadioScope({ ...this.options, service, hostVoice: () => this.hostVoiceFor(djVoice), moments: this.moments })
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
      const radio = createRadioScope({ ...this.options, service: previous.service, hostVoice: () => this.hostVoiceFor(djVoice), moments: this.moments })
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
