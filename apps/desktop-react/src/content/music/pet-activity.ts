import type { MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import type { MusicNowPlayingView, MusicProgrammeView } from '../../data/music-source'
import type { PetActivity } from '../../pets/types'

/**
 * **音乐的在场投影 → 宠物活动**(宠物 P1,正本 `docs/design/pet-system-2026-09.md` §8.1)。
 *
 * 纯函数:唱机场景、实验台与单测吃同一份。表的行号写在每一行旁边 —— 改顺序就是改设计。
 * 输入全是**读数本身**(可能还没读到,是 `undefined`);「还没读到」不等于「关着」,
 * 所以第 3、4 行只在简报真的读到了才成立。
 */

/**
 * 读数里没有拍速(ncm-cli 不交 bpm),rhythm 一律按这个数点头。
 * 放在 TS 而不是 CSS:它是活动的一格参数,形象按 60/bpm 自己换算成节拍时长。
 */
export const MUSIC_DEFAULT_BPM = 90

export interface MusicPetInputs {
  runtime?: MusicRuntimeState
  brief?: MusicRadioState
  nowPlaying?: MusicNowPlayingView
  /** `nowPlaying` 读法的错话(`useQuery(...).error`)。 */
  nowError?: string
  /** 节目单;`undefined` = 还没读到(与「读到了、是空的」不是一回事)。 */
  programme?: MusicProgrammeView
}

export function musicPetActivity({ runtime, brief, nowPlaying, nowError, programme }: MusicPetInputs): PetActivity {
  const playing = nowPlaying?.playing === true
  /* 1 */ if (nowError || runtime?.lastError) return 'fault'
  /* 2 */ if (runtime !== undefined && runtime.setupStage !== 'ready') return 'off'
  /* 3 */ if (brief !== undefined && !brief.active && !playing) return 'off'
  /* 4 */ if (brief?.starting || (brief?.active && programme !== undefined && programme.entries.length === 0 && !playing))
    return 'busy'
  /* 5 */ if (playing) return { kind: 'rhythm', bpm: MUSIC_DEFAULT_BPM }
  /* 6 */ if (nowPlaying?.status === 'paused') return 'still'
  /* 7 */ return 'idle'
}

/**
 * 换歌时主持人要说的那一句(§8.2「换歌时恰好有口播」):节目单里标题与
 * `starting` 相同的那一条的 `say`,找不到取第一条的;都没有就不说。
 */
export function startingSay(starting: string, programme: MusicProgrammeView | undefined): string | undefined {
  const entries = programme?.entries ?? []
  const match = entries.find((entry) => entry.title === starting) ?? entries[0]
  const say = match?.say?.trim()
  return say ? say : undefined
}
