import type { ContextVariable, VariableProvider } from '../types.js'

const NAME = 'music'

export interface MusicRadioSnapshot {
  status: 'playing' | 'paused' | 'stopped'
  title?: string
}

/**
 * Host adapters. All reads must be cache-backed (the now-playing watcher, the
 * radio store) — a variable provider runs on every turn and must never cost a
 * subprocess.
 */
export interface MusicRadioGateway {
  getNowPlaying(): MusicRadioSnapshot | null
  getRadio(): { active: boolean; intent: string; lastError?: string }
  getProgrammeLength(): number
}

/**
 * What is playing and how the radio is doing, as one line the model sees each
 * turn — so "这歌不错" needs no `ncm-cli state` round-trip to make sense of.
 *
 * The value deliberately carries no position and no durations: those change
 * every tick, and the turn-channel dedupe would inject a new block every turn
 * (the background-jobs lesson). Title, status, intent and programme count only
 * change when something actually happens.
 */
export class MusicRadioProvider implements VariableProvider {
  readonly id = 'music-radio'
  readonly priority = 23

  constructor(private readonly gateway: MusicRadioGateway) {}

  list(): ContextVariable[] {
    const nowPlaying = this.gateway.getNowPlaying()
    const radio = this.gateway.getRadio()
    const playingSomething = nowPlaying !== null && nowPlaying.status !== 'stopped'
    if (!playingSomething && !radio.active) return []

    const parts: string[] = []
    if (nowPlaying?.status === 'playing') parts.push(`播放中「${nowPlaying.title ?? '未知曲目'}」`)
    else if (nowPlaying?.status === 'paused') parts.push(`已暂停「${nowPlaying.title ?? '未知曲目'}」`)
    else parts.push('没有在放歌')

    if (radio.active) {
      parts.push(`电台:${radio.intent || '(无描述)'}(节目单剩 ${this.gateway.getProgrammeLength()} 首)`)
    }
    if (radio.lastError) parts.push(`⚠ ${radio.lastError}`)

    return [{
      name: NAME,
      value: parts.join(' · '),
      readonly: true,
      state: true,
      description:
        'Music playback and radio status. Songs are driven via ncm-cli through bash (see the netease-music-cli skill); the radio programme lives in the radio-dj session.',
    }]
  }

  claims(name: string): boolean {
    return name === NAME
  }
}
