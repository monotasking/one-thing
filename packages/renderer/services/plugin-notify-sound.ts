/**
 * 插件通知提示音的**合成实现**(M1)。
 *
 * 与 `practice-sound.ts` 同规:WebAudio 现场合成,零音频资产 —— 不打包 mp3/wav,
 * 跟随系统音量,没有版权顾虑,也没有"插件自带音频文件"这条音频轰炸的路。
 * 音量比 practice 的节拍器略高一点(那是闭眼练习用的敲点,这是通知),但仍然克制。
 *
 * **要不要响不在这里判**。静音开关、每插件静音、限频三道闸全在主进程
 * (`@onething/backend` 的 `plugins/notify-sound.ts`)。这里只做两件事:按名字查配方、
 * 挡掉副窗重复播。
 */
// 叶子路径,不走桶:桶 re-export 的 loader.ts 带 node:url,一进浏览器包就在求值
// 时炸(platform/__tests__/boundary.test.ts 守着这条)。
import { PLUGIN_NOTIFY_SOUNDS, type PluginNotifySound } from '@onething/core/plugins/notify-sound'

let audioContext: AudioContext | null = null

function getContext(): AudioContext | null {
  try {
    if (!audioContext) audioContext = new AudioContext()
    // 用户还没在本窗口交互过时 context 是 suspended;resume 是异步的,
    // 所以第一声可能被吞 —— 这是浏览器自动播放策略,不是 bug。
    if (audioContext.state === 'suspended') void audioContext.resume()
    return audioContext
  } catch {
    return null
  }
}

interface Tone {
  freq: number
  /** 可选滑音终点。 */
  freqTo?: number
  durationMs: number
  delayMs?: number
  gain?: number
}

/**
 * 枚举 → 配方,**exhaustive Record**。
 *
 * 类型写成 `Record<PluginNotifySound, Tone[]>` 是有意的:core 里新增一个枚举成员
 * 而这里忘了给配方,typecheck 当场红。枚举与它的实现因此不可能漂移。
 */
const RECIPES: Record<PluginNotifySound, Tone[]> = {
  // 不出声。绝大多数 notify 走的是这条。
  none: [],
  // 中性单音:有事发生,不好不坏。
  info: [{ freq: 660, durationMs: 130, gain: 0.11 }],
  // 两声上行:成了。与 practice 的 finished 同一条动机,音更短。
  success: [
    { freq: 587, durationMs: 100, gain: 0.11 },
    { freq: 880, durationMs: 150, delayMs: 110, gain: 0.11 },
  ],
  // 两声同高短促:注意一下。同音重复比升降更"催"。
  warning: [
    { freq: 494, durationMs: 90, gain: 0.12 },
    { freq: 494, durationMs: 90, delayMs: 150, gain: 0.12 },
  ],
  // 低沉下行:出错了。滑音让它听上去像"沉下去"而不是又一记敲击。
  error: [{ freq: 440, freqTo: 262, durationMs: 320, gain: 0.13 }],
  // 三声铃状上行:叫人回来看一眼 —— 比 info 更有存在感,又不像 error 那样不祥。
  chime: [
    { freq: 784, durationMs: 110, gain: 0.09 },
    { freq: 988, durationMs: 110, delayMs: 120, gain: 0.09 },
    { freq: 1319, durationMs: 220, delayMs: 240, gain: 0.09 },
  ],
}

function playTones(tones: Tone[]): void {
  if (!tones.length) return
  const ctx = getContext()
  if (!ctx) return
  for (const tone of tones) {
    const start = ctx.currentTime + (tone.delayMs ?? 0) / 1000
    const end = start + tone.durationMs / 1000
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(tone.freq, start)
    if (tone.freqTo) osc.frequency.linearRampToValueAtTime(tone.freqTo, end)
    const peak = tone.gain ?? 0.1
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0005, end)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(start)
    osc.stop(end + 0.02)
  }
}

/**
 * 只有主窗出声。
 *
 * 插件通知走 `sendToAllWindows` 广播 —— 设置窗、搜索窗、todo 窗都是独立的
 * BrowserWindow,各跑一份 renderer,各收一份同样的 payload。不设这道门,用户开着
 * 设置窗时每条通知都会听到两声。判据是路由 hash:副窗都是 `#/xxx`
 * (`#/settings`、`#/search`、`#/todo-plan`、`#/image-preview`、`#/voice-runtime`,
 * 见 App.vue),主窗不是。
 */
function isPrimaryWindow(): boolean {
  try {
    return !window.location.hash.startsWith('#/')
  } catch {
    return true
  }
}

/**
 * 播一声。传进来的应当是**主进程裁决后**的 sound。
 *
 * 'none'、非枚举名、副窗 —— 一律静默返回,不报错:一条通知的声音坏掉不该变成
 * 用户看得见的故障。
 */
export function playPluginNotifySound(sound: unknown): void {
  if (typeof sound !== 'string') return
  if (!(PLUGIN_NOTIFY_SOUNDS as readonly string[]).includes(sound)) return
  if (sound === 'none') return
  if (!isPrimaryWindow()) return
  playTones(RECIPES[sound as PluginNotifySound])
}

/** 试听:绕过主窗门,给设置页的"试听"按钮用(用户就在设置窗里点的)。 */
export function previewPluginNotifySound(sound: PluginNotifySound): void {
  playTones(RECIPES[sound] ?? [])
}
