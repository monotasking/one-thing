/**
 * 通知提示音的**枚举事实源**(M1,宿主动词翼)。
 *
 * 一句话规矩:**插件只能点名,不能作曲**。这里列出的六个名字是插件唯一能说出口
 * 的声音;频率、波形、时长、音量、音频文件一律不过线。这不是省事,是"防音频轰炸"
 * 的结构保证 —— 只要参数面是一个封闭枚举,再恶意的插件也只能在这六个之间选,
 * 而不能合成刺耳长音或塞进一段 30 秒的 mp3。
 *
 * 与之配套的另外两道闸(都不在 core,因为都要读宿主状态):
 * 1. **限频** —— 每插件 `PLUGIN_NOTIFY_SOUND_THROTTLE_MS` 内最多出一声,连发只响
 *    第一声(横幅本身不限,只限声音)。落在装配层的 `app/plugins/notify-sound.ts`。
 * 2. **用户主权** —— 全局总开关 + 每插件静音,落在 `settings.plugins`。静音时
 *    横幅照常显示,只是不出声:通知与提示音是解耦的两件事。
 *
 * 声音的**实现**(WebAudio 合成配方)在 renderer
 * (`packages/renderer/services/plugin-notify-sound.ts`),与 practice-sound 同规:
 * 零音频资产、跟随系统音量、无版权顾虑。那份配方表按本枚举做 exhaustive Record,
 * 所以这里加一个名字而不给配方,编译期就会红。
 *
 * 没有为出声单开 permission:notify 本来就是插件的基础能力,声音只是它的一个
 * 受限参数,且用户有一键静音兜底 —— 再加一道声明门只是摩擦,换不来安全。
 */

export const PLUGIN_NOTIFY_SOUNDS = [
  /** 不出声(缺省)。老调用、被静音、被限频、名字非法,最终都收敛到这里。 */
  'none',
  /** 中性一声:有事发生,不好不坏。 */
  'info',
  /** 两声上行:成了。 */
  'success',
  /** 两声同高短促:注意一下。 */
  'warning',
  /** 低沉下行:出错了。 */
  'error',
  /** 三声铃状上行:提醒你回来看一眼(比 info 更"叫人")。 */
  'chime',
] as const

export type PluginNotifySound = (typeof PLUGIN_NOTIFY_SOUNDS)[number]

/** 缺省即静默:不传 sound 的老调用与今天的行为逐字节一致。 */
export const DEFAULT_PLUGIN_NOTIFY_SOUND: PluginNotifySound = 'none'

/**
 * 每插件出声的最小间隔(毫秒)。
 *
 * 3 秒是"连发只响第一声"的窗口:插件在一个循环里喊 20 条通知,用户看到 20 条
 * 横幅(那是插件自己的表达自由),但只听到 1 声。可调 —— 调大更安静,调小更吵,
 * 但不要调到 0:那等于把这道闸拆了。
 */
export const PLUGIN_NOTIFY_SOUND_THROTTLE_MS = 3000

export function isPluginNotifySound(value: unknown): value is PluginNotifySound {
  return typeof value === 'string' && (PLUGIN_NOTIFY_SOUNDS as readonly string[]).includes(value)
}

/** 归一化的结果:`unknown` 为真时调用方应当记一条日志(而不是静默吞掉)。 */
export interface NormalizedPluginNotifySound {
  sound: PluginNotifySound
  /** 传了个不在枚举里的名字 —— 已降级为 'none',但这是插件的 bug,值得说一声。 */
  unknown: boolean
}

/**
 * 把插件传来的任意值收敛成枚举成员。
 *
 * `undefined` / `null` = 没打算出声(不是错),`unknown: false`;
 * 传了个枚举外的字符串或非字符串 = 降级 none + `unknown: true`。
 * **降级而不是抛错**:一条通知的声音不该把插件的这次调用整个打掉。
 */
export function normalizePluginNotifySound(value: unknown): NormalizedPluginNotifySound {
  if (value === undefined || value === null) {
    return { sound: DEFAULT_PLUGIN_NOTIFY_SOUND, unknown: false }
  }
  if (isPluginNotifySound(value)) return { sound: value, unknown: false }
  return { sound: DEFAULT_PLUGIN_NOTIFY_SOUND, unknown: true }
}

/** `api.ui.notify` 的 options 形态(第二参的第二种长相,见 api-builder)。 */
export interface PluginNotifyOptions {
  level?: 'info' | 'warn' | 'error'
  sound?: PluginNotifySound
}
