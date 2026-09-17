/**
 * **主持人声音端口 `hostVoice`**(宠物 P3,正本 `docs/design/pet-system-2026-09.md` §10.2 第三、四行)。
 *
 * 电台只认这一个接口:预取一句、说一句。谁来说、用什么嗓子、在哪里出声,都不是电台的事。
 *
 * ── 两个实现,一个缺省 ───────────────────────────────────────────────────
 *  · **缺省**(`createDefaultHostVoice`)= 今天的 `dj-voice`:合成(带缓存与预取)→ 出声
 *    (`dj-voice.ts` 的 `playPatter`:有 `speechOutput` 就在进程内放,没有且有语音宿主就推给
 *    渲染进程,两者都没有就立刻算说完)。
 *  · **接管**:组合根在 `pets` 开着时用 `MusicSubsystem.bindHostVoice(factory)` 换一个实现进来
 *    (宠物宿主认领这句话、发气泡事件、再出声)。工厂拿到一份 `HostVoiceKit`:音乐这边**借出**
 *    同一份口播缓存与同一条出声路,以及缺省实现本身作退路 —— 接管方不复制缓存,也不自己去找
 *    扬声器。
 *
 * ── 依赖方向 ─────────────────────────────────────────────────────────────
 * 音乐域**不 import 宠物**。这只文件里没有「宠物」这个词出现在类型上:工厂是一个函数,
 * 谁交进来都一样。反方向(宠物那边 import 这里的类型)是允许的。
 */
import type { VoiceSettings } from '@shared/ipc.js'

/** 一段合成好的口播。 */
export interface PatterSpeech {
  readonly audioBase64: string
  readonly mimeType: string
}

/**
 * 嗓子的**调法**:在当前语音设置上改几个旋钮再去合成。`key` 进缓存键 —— 同一句话用两种
 * 嗓子合成是两段音频。
 */
export interface PatterVoiceStyle {
  readonly key: string
  apply(settings: VoiceSettings): VoiceSettings
}

export interface HostVoiceSpeakOptions {
  /** 这句口播介绍的那首歌(日志用)。 */
  readonly title: string
  /** 压着音乐说(前奏够长,歌先放)。`false` = 在静音里说。 */
  readonly overMusic: boolean
  /**
   * 关台 / 停止电台 / 整代作废。中止 → 正在放的那一段立刻停,`speak` resolve。
   * (§10.2 的形状里没有这一格;§10.6「关台中途 signal 中止」要它,所以加在这里。)
   */
  readonly signal?: AbortSignal
  /**
   * 真要出声的前一刻(合成成功、认领完成、马上放)调一次。电台在这里压低音乐 ——
   * 合成失败 / 没配语音就不会调,于是不会白压一次音量(§10.6「压音量」排在「发出」之后)。
   */
  readonly onVoiceStart?: () => Promise<void>
}

export interface HostVoice {
  /** 后台预热这一句(发完不等,不抛)。 */
  prefetch(text: string, title: string): void
  /** 说这一句,**说完**才 resolve。不抛:电台接下来无论如何都要继续放歌。 */
  speak(text: string, options: HostVoiceSpeakOptions): Promise<void>
}

/**
 * 这句话从哪来(接管方记账用)。只有电台这一个出处,形状照资源事件的 `{ scheme, event }`,
 * 于是账本里它与别的时刻同一种写法。
 */
export const RADIO_PATTER_SOURCE = { scheme: 'music', event: 'radio-patter' } as const

/** 音乐这边借给接管方的东西。 */
export interface HostVoiceKit {
  readonly source: { readonly scheme: string; readonly event: string }
  /** 缺省实现:接管方不认领这句话时照它说。 */
  readonly fallback: HostVoice
  /** 同一份口播缓存。失败 / 超时 / 没配语音答 `null`,不抛。 */
  synthesize(text: string, title: string, style?: PatterVoiceStyle): Promise<PatterSpeech | null>
  /** 预取(进同一份缓存)。 */
  prefetch(text: string, title: string, style?: PatterVoiceStyle): void
  /** 同一条出声路。放完 / 中止 / 失败都 resolve。 */
  play(speech: PatterSpeech, options: { text: string; title: string; signal?: AbortSignal }): Promise<void>
}

export type HostVoiceFactory = (kit: HostVoiceKit) => HostVoice

/** 缺省实现要的那几件(`dj-voice.ts` 的作用域交出来的)。 */
export interface PatterVoiceTools {
  synthesizePatter(text: string, title: string, style?: PatterVoiceStyle): Promise<PatterSpeech | null>
  prefetchDjPatter(text: string, title: string, style?: PatterVoiceStyle): void
  playPatter(speech: PatterSpeech, options: { text: string; title: string; signal?: AbortSignal }): Promise<void>
}

/** 今天的 dj-voice 路:合成 → 出声。 */
export function createDefaultHostVoice(tools: PatterVoiceTools): HostVoice {
  return {
    prefetch: (text, title) => tools.prefetchDjPatter(text, title),
    speak: async (text, { title, signal, onVoiceStart }) => {
      const speech = await tools.synthesizePatter(text, title)
      if (!speech || signal?.aborted) return
      await onVoiceStart?.()
      if (signal?.aborted) return
      await tools.playPatter(speech, { text, title, ...(signal ? { signal } : {}) })
    },
  }
}

/** 装一个工具包:缺省实现 + 借出去的缓存与出声路。 */
export function createHostVoiceKit(tools: PatterVoiceTools): HostVoiceKit {
  return {
    source: RADIO_PATTER_SOURCE,
    fallback: createDefaultHostVoice(tools),
    synthesize: (text, title, style) => tools.synthesizePatter(text, title, style),
    prefetch: (text, title, style) => tools.prefetchDjPatter(text, title, style),
    play: (speech, options) => tools.playPatter(speech, options),
  }
}
