/**
 * 提示音的**裁决点**(M1)——「响不响」只在这里判一次。
 *
 * core 只把插件传来的值归一成枚举成员;真正决定出不出声的三件事都要读宿主状态,
 * 所以全落在装配层:
 *
 * 1. **用户主权**(`settings.plugins`)—— 全局总开关 + 每插件静音名单。
 * 2. **限频** —— 每插件 `PLUGIN_NOTIFY_SOUND_THROTTLE_MS` 内最多一声。
 * 3. **枚举** —— core 已经做过,这里再挡一次兜底(宿主别的调用点不经过 core)。
 *
 * 判在这里而不是 renderer,有一条硬理由:插件通知是 `sendToAllWindows` 广播的,
 * 主窗与设置窗各收一份。renderer 自己判就是判两遍、响两声。主进程判完把结果写进
 * 事件,renderer 只负责播 —— 口径唯一,窗口再多也只有一份裁决。
 * (谁来播那一份,由 renderer 侧的主窗门决定,见 `services/plugin-notify-sound.ts`。)
 *
 * 静音时**只掐声音**:横幅照常发出去。通知与提示音是解耦的两件事,静音的语义是
 * "别吵我",不是"别告诉我"。
 */
import {
  PLUGIN_NOTIFY_SOUND_THROTTLE_MS,
  isPluginNotifySound,
  type PluginNotifySound,
} from '@onething/core/plugins'
import { getSettings } from '../stores/settings.js'

/** 每插件最后一次**真的出声**的时刻。被静音/被限频的那些不记账。 */
const lastSoundAt = new Map<string, number>()

export interface ResolvePluginNotifySoundOptions {
  /** 注入时钟,测试用。 */
  now?: () => number
}

/**
 * 把插件请求的音效收敛成"这一条实际要播什么"。
 *
 * 返回 `'none'` 有四种原因,对调用方而言无差别 —— 它们都只意味着不出声:
 * 没点名 / 名字非法 / 被静音(全局或单插件) / 撞上限频窗口。
 */
export function resolvePluginNotifySound(
  pluginId: string,
  requested: PluginNotifySound | undefined,
  options: ResolvePluginNotifySoundOptions = {},
): PluginNotifySound {
  if (!requested || requested === 'none') return 'none'
  // 兜底:宿主内部的调用点(熔断告警等)不经过 core 的归一。
  if (!isPluginNotifySound(requested)) return 'none'

  if (!isPluginNotifySoundAllowed(pluginId)) return 'none'

  const now = options.now ?? Date.now
  const at = now()
  const previous = lastSoundAt.get(pluginId)
  if (previous !== undefined && at - previous < PLUGIN_NOTIFY_SOUND_THROTTLE_MS) return 'none'

  lastSoundAt.set(pluginId, at)
  return requested
}

/** 用户是否允许这个插件出声(总开关 ∧ 不在静音名单里)。读设置失败一律按允许。 */
export function isPluginNotifySoundAllowed(pluginId: string): boolean {
  try {
    const preferences = getSettings().plugins
    if (!preferences) return true
    if (preferences.notifySoundsEnabled === false) return false
    return !preferences.notifySoundMutedPluginIds?.includes(pluginId)
  } catch {
    // 设置还没加载(装配早期)不该把声音永久掐掉 —— 缺省是"能响"。
    return true
  }
}

/** 卸载/禁用插件时清账,免得一个 id 的限频窗口跨越它的生命周期。 */
export function forgetPluginNotifySoundThrottle(pluginId: string): void {
  lastSoundAt.delete(pluginId)
}

/** 测试钩子:清空全部限频账。 */
export function resetPluginNotifySoundThrottle(): void {
  lastSoundAt.clear()
}
