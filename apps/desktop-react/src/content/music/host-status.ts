import type { MusicHostDoingKind, MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import type { MusicNowPlayingView } from '../../data/music-source'
import type { MessageKey } from '../../i18n'

/**
 * **黑豆头顶那块状态牌**(主持人抽屉 H2,2026-09-27;正本 `docs/music-panel-2026-09.md` §16.2 第 1 段)。
 *
 * 一句现在时:「睡着」「在挑歌」「在搜「周杰伦」」「在放」「出错了」「醒着」。抽屉的檐上与唱机里黑豆
 * 旁边读的是同一句 —— 这只文件就是那一句话的唯一产地(与 `status.ts` 同一个形:表 + 优先序,纯函数,
 * 不写文案、不画东西)。
 *
 * **后端说得出他在干什么时,那一句是数据不是字典**:`host.doing.label`(「在搜「周杰伦」」)由后端的
 * 动词表算好,原样上屏;壳不认识 ncm-cli(`music-port.ts` 文件头那句判据)。其余几句是固定的,走 i18n。
 *
 * 优先序(先命中先赢):
 *  ① 没接入 / 没登录 —— 睡着(没有主持人可言);
 *  ② 电台关着 —— 睡着;
 *  ③ 他在干活而且后端说得出在干什么 —— 后端那一句(种类取 `doing.kind`);
 *  ④ 他在干活、说不出在干什么 —— 在挑歌(`host.working`,老后端退到 `djWorking`);
 *  ⑤ 在放 —— 在放;
 *  ⑥ 出错(简报的 `lastError`,或抽屉那条记录流没读到)—— 出错了;
 *  ⑦ 其余 —— 醒着。
 *
 * 「在放」排在「出错」前面:简报的 `lastError` 会在下一首起播之后还挂一会儿,歌在放的时候他就是
 * 在放 —— 那句错话归面板的状态条去说(`status.ts`),不归这块牌。
 */
export type HostStatusKind = 'asleep' | 'picking' | 'playing' | 'error' | 'awake' | MusicHostDoingKind

/** 一句固定的(字典)或一句后端给的(数据)。 */
export type HostStatusLabel = { key: MessageKey } | { text: string }

export interface HostStatus {
  kind: HostStatusKind
  label: HostStatusLabel
}

export interface HostStatusInput {
  runtime?: MusicRuntimeState
  brief?: MusicRadioState
  nowPlaying?: MusicNowPlayingView
  /** 抽屉那条记录流没读到(只有抽屉给;唱机里那块牌不管这件事)。 */
  logFailed?: boolean
}

const FIXED: Readonly<Record<'asleep' | 'picking' | 'playing' | 'error' | 'awake', MessageKey>> = {
  asleep: 'music.host.asleep',
  picking: 'music.host.picking',
  playing: 'music.host.playing',
  error: 'music.host.error',
  awake: 'music.host.awake',
}

function fixed(kind: keyof typeof FIXED): HostStatus {
  return { kind, label: { key: FIXED[kind] } }
}

export function deriveHostStatus({ runtime, brief, nowPlaying, logFailed = false }: HostStatusInput): HostStatus {
  if (runtime === undefined || runtime.setupStage !== 'ready') return fixed('asleep')
  if (brief?.active !== true) return fixed('asleep')
  const working = brief.host?.working ?? brief.djWorking === true
  const doing = brief.host?.doing
  if (working && doing) return { kind: doing.kind, label: { text: doing.label } }
  if (working) return fixed('picking')
  if (nowPlaying?.playing === true) return fixed('playing')
  if (brief.lastError || logFailed) return fixed('error')
  return fixed('awake')
}

/** 把那一句念出来(字典那一档过 `t`,数据那一档原样)。 */
export function hostStatusText(status: HostStatus, t: (key: MessageKey) => string): string {
  return 'key' in status.label ? t(status.label.key) : status.label.text
}
