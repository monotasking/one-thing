import type { MessageKey } from '../../i18n'

/**
 * **四枚心情块**(样例 v7 的开台邀请;音乐面 v9 起两处共用 —— 唱机关着时的邀请,与「电台」那一格)。
 *
 * 块上印两个字,按下去发出去的是**整句意图**(`intent` 那一句)—— 与「跟黑豆说」开台是同一条路,
 * 只是替人把第一句话说了。加一种心情 = 这张表一行 + i18n 两句(+ `tokens.css` 一格色,电台那一格用)。
 */
export interface MusicMood {
  id: string
  label: MessageKey
  intent: MessageKey
}

export const MUSIC_MOODS: readonly MusicMood[] = [
  { id: 'rain', label: 'music.mood.rain', intent: 'music.preset.rain' },
  { id: 'focus', label: 'music.mood.focus', intent: 'music.preset.focus' },
  { id: 'friday', label: 'music.mood.friday', intent: 'music.preset.friday' },
  { id: 'drive', label: 'music.mood.drive', intent: 'music.preset.drive' },
]
