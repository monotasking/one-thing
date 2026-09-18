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
  /**
   * 人刚跟主持人说了话,还没等到他回话(§7.3「发送中」那一行)。
   *
   * 它排在**第 2 行**:比「电台关着 = off」「没歌 = idle」都靠前 —— 人正等着他开口,
   * 这一刻他在忙是事实,与此刻有没有歌在放无关。只有第 1 行的 `fault` 赢过它:
   * 后端都报错了,装作在翻唱片是撒谎。
   */
  awaitingHost?: boolean
}

/**
 * **电台开着、节目单空了 = 主持人在补歌单**(09-18 用户:「没有下一首了,dj 正在补歌单,这个状态
 * 交给 pet 啊」)。不管此刻有没有歌在放:放着的是最后一首,他同样在翻 —— 后端的指挥在空架子上
 * 就会叫醒他(`radio-conductor` 的 starving 那一支)。节目单还没读到(`undefined`)不算空。
 */
export function stationRefilling(brief: MusicRadioState | undefined, programme: MusicProgrammeView | undefined): boolean {
  return brief?.active === true && programme !== undefined && programme.entries.length === 0
}

export function musicPetActivity({
  runtime,
  brief,
  nowPlaying,
  nowError,
  programme,
  awaitingHost,
}: MusicPetInputs): PetActivity {
  const playing = nowPlaying?.playing === true
  /* 1 */ if (nowError || runtime?.lastError) return 'fault'
  /* 2 */ if (awaitingHost) return 'busy'
  /* 3 */ if (runtime !== undefined && runtime.setupStage !== 'ready') return 'off'
  /* 4 */ if (brief !== undefined && !brief.active && !playing) return 'off'
  /* 5 */ if (brief?.starting || stationRefilling(brief, programme)) return 'busy'
  /* 6 */ if (playing) return { kind: 'rhythm', bpm: MUSIC_DEFAULT_BPM }
  /* 7 */ if (nowPlaying?.status === 'paused') return 'still'
  /* 8 */ return 'idle'
}
