/**
 * 时间条带的档位记忆(主线 E2)。
 *
 * 单独一个文件,是为了让 `trajectory-projection.ts` 保持**纯**:那边一行 IO 都
 * 没有,加一句 localStorage 就得给每个投影用例配一个存储桩。这边只有存取。
 *
 * 手法照 `ui-anchor-registry.ts` 的抽屉档:
 *  · `safeStorage()` 卡的是**方法在不在**,不是"全局有没有" —— Node 22 起
 *    globalThis 上有一个没开 `--localstorage-file` 的空壳 localStorage
 *    (属性齐、方法全 undefined),只看 typeof 会把它当成能用的存储;
 *  · 存不下不是错误,只是不持久;坏记录当它不存在,不让一条脏字符串把面板拦住。
 */
import {
  TRAJECTORY_TIMELINE_MODES,
  type TrajectoryTimelineMode,
} from './trajectory-projection'

/** 档位默认 `sequence`:先看结构,想看快慢再切。 */
export const TRAJECTORY_TIMELINE_DEFAULT_MODE: TrajectoryTimelineMode = 'sequence'

/** 键名跟随主线 E 的命名(面板级偏好,多窗口各记各的,v1 不同步)。 */
export const TRAJECTORY_TIMELINE_MODE_STORAGE_KEY = 'onething.trajectory.timelineMode'

function safeStorage(): Storage | null {
  try {
    const storage = typeof localStorage === 'undefined' ? null : localStorage
    return typeof storage?.getItem === 'function' ? storage : null
  } catch {
    return null
  }
}

function isTimelineMode(value: unknown): value is TrajectoryTimelineMode {
  return TRAJECTORY_TIMELINE_MODES.includes(value as TrajectoryTimelineMode)
}

export function loadTrajectoryTimelineMode(): TrajectoryTimelineMode {
  const raw = safeStorage()?.getItem(TRAJECTORY_TIMELINE_MODE_STORAGE_KEY)
  return isTimelineMode(raw) ? raw : TRAJECTORY_TIMELINE_DEFAULT_MODE
}

export function saveTrajectoryTimelineMode(mode: TrajectoryTimelineMode): void {
  try {
    safeStorage()?.setItem(TRAJECTORY_TIMELINE_MODE_STORAGE_KEY, mode)
  } catch {
    // 配额满 / 隐私模式:存不下就不存,档位这一次仍然生效。
  }
}
