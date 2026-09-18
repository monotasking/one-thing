/**
 * 音乐域的**操作面** —— 结构债 P4c 第九批从 `apps/electron/src/main/ipc/music.ts`
 * 整块搬过来的三件真逻辑(那个文件里唯一不是「转调」的部分):
 *
 *  - `readPlayerVolume()` —— 音量读数从哪来是 provider 的事(ncm 把它存在自己的
 *    prefs 文件里,因为 `state` 报的是 null);
 *  - `runMusicCommand()` —— 播放条的传输控制,含电台在场时的五处特判;
 *  - `setMusicProvider()` —— 换 CLI 是一次带手续的重新调台。
 *
 * 三件都是**纯 node**(child_process 走 runtime 的 `process-runner`,fs 只读一个
 * prefs 文件),没有一行认识 Electron —— 它们从前住在主进程里只是因为 IPC 处理者
 * 住在那儿。搬到装配层之后,桌面 IPC 与 `POST /api/rpc` 吃的是同一份。
 *
 * 逐字保留:三个函数的函数体、注释与文案与迁移前一字不差。
 */
import type {
  MusicCommand,
  MusicCommandRequest,
  MusicCommandResponse,
  MusicRadioState,
} from '@shared/ipc/music.js'
import { recentSpins } from './recent-spins.js'
import type { MusicServiceScope } from './service.js'
import type { RadioScope } from './radio.js'

import { MusicWorkOwner } from './lifetime.js'
import { readProviderVolume, volumeArgs } from './player-volume.js'
import { getCurrentBackend } from '../../current.js'
import { listMusicProviderDescriptors } from '@onething/runtime/music'
import { getSettings } from '../../stores/settings.js'

export function createMusicOperationsScope(options: { service: MusicServiceScope; radio: RadioScope; assertOwned?: () => void }) {
  const owner = new MusicWorkOwner(options.assertOwned)
  const { getActiveMusicProvider, getMusicNowPlaying, refreshMusicNowPlaying } = options.service
  const { getRadioStartingTitle, getRadioStore, isRadioActive, likeCurrentSong, markRadioGesture,
    radioToolClose, recordRadioSkip, replayCurrentRadioSong, resumeRadioPlayback, skipToNextRadioSong } = options.radio
/**
 * Where the bar's volume number comes from is the provider's business: ncm
 * persists it in a prefs file because `state` reports volume as null. Foreign
 * format — read defensively, absence just means the knob shows nothing.
 */
function readPlayerVolume(): number | undefined {
  // 读法搬去了 `player-volume.ts`(宠物 P3:电台口播压低音乐也要读它,同一把尺子)。
  return readProviderVolume(getActiveMusicProvider())
}

/** 播放条要的那份电台简报。组合逻辑逐字沿用迁移前的 `getRadio` handler。 */
function readRadioBrief(): MusicRadioState {
  const store = getRadioStore()
  const brief = store.readBrief()
  const programme = store.readProgramme()
  return {
    active: brief.active,
    intent: brief.intent,
    lastError: brief.lastError,
    starting: getRadioStartingTitle(),
    programmeLength: programme.entries.length,
    canResume: programme.entries.length > 0 || brief.onDeck !== undefined,
    upNext: programme.entries[0]?.title,
    volume: readPlayerVolume(),
    startedAt: brief.active ? brief.startedAt : undefined,
    recent: recentSpins(brief),
    ...(brief.lastPlayback
      ? {
          lastPlayed: {
            title: brief.lastPlayback.title,
            position: brief.lastPlayback.position,
            ...(brief.lastPlayback.duration ? { durationS: brief.lastPlayback.duration } : {}),
          },
        }
      : {}),
  }
}


/**
 * Deliberately no `stop`. It tears down the play session, after which the next
 * start has to cold-start the daemon — which is unreliable. A pause button that
 * sometimes loses the music is worse than no pause button.
 */
const COMMAND_ARGS: Partial<Record<MusicCommand, string[]>> = {
  pause: ['pause'],
  resume: ['resume'],
  next: ['next'],
  prev: ['prev'],
}

/** seek/volume carry a number; build their argv or explain why not. */
function argsWithValue(request: MusicCommandRequest): string[] | { error: string } {
  const value = request.value
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${request.command} 需要一个数值参数` }
  }
  if (request.command === 'seek') {
    return ['seek', String(Math.max(0, Math.round(value)))]
  }
  // volume: ncm-cli takes absolute 0-100 (argv shared with the patter duck).
  return volumeArgs(value)
}

async function runMusicCommand(
  request: MusicCommandRequest,
): Promise<MusicCommandResponse> {
  if (request.command === 'radio-resume') {
    // Not an ncm-cli transport command: the daemon is down (that is why the
    // button exists), so this goes through the keepalive restart flow instead.
    markRadioGesture('▶ 续播')
    const resumed = await resumeRadioPlayback()
    await refreshMusicNowPlaying()
    return resumed
      ? { success: true, nowPlaying: getMusicNowPlaying() }
      : { success: false, error: '暂时没歌可放,已叫 DJ 补节目单——到货会自动开播' }
  }

  if (request.command === 'radio-stop') {
    // The bar's full stop: same close the radio tool performs — inactive
    // FIRST (so an in-flight start aborts at its next active check and the
    // conductor goes dormant), then stop the player.
    await radioToolClose()
    await refreshMusicNowPlaying()
    return { success: true, nowPlaying: getMusicNowPlaying() }
  }

  // Hearting is a server call keyed off onDeck, not a transport command — it
  // must dispatch BEFORE the argv table guard below ('like' has no argv, and
  // the guard once swallowed it as 未知的播放命令).
  if (request.command === 'like') {
    const liked = await likeCurrentSong()
    return liked.success
      ? { success: true, nowPlaying: getMusicNowPlaying() }
      : { success: false, error: liked.error }
  }

  let args: string[] | undefined
  if (request.command === 'seek' || request.command === 'volume') {
    const built = argsWithValue(request)
    if ('error' in built) return { success: false, error: built.error }
    args = built
  } else {
    args = COMMAND_ARGS[request.command]
  }
  if (!args) return { success: false, error: `未知的播放命令:${request.command}` }

  // A skip is the strongest taste signal the DJ gets; record it against the
  // song that is on right now, before the next one replaces it. With the
  // radio on there is no player queue to advance (the conductor is the
  // queue), so "next" means: start the next programme entry ourselves.
  if (request.command === 'next') {
    recordRadioSkip()
    if (isRadioActive()) {
      markRadioGesture('⏭ 下一首')
      // Nothing queued: the DJ is refilling (the conductor wakes him on an empty
      // shelf). That is a state, not an error — the song keeps playing and the
      // skip above still counts as a taste signal (09-18 user: 「没有下一首了,
      // dj 正在补歌单,这个状态交给 pet」).
      if (getRadioStore().readProgramme().entries.length === 0) {
        return { success: true, nowPlaying: getMusicNowPlaying(), deferred: 'refilling' }
      }
      const skipped = await skipToNextRadioSong()
      await refreshMusicNowPlaying()
      return skipped
        ? { success: true, nowPlaying: getMusicNowPlaying() }
        : { success: false, error: '没有下一首可放了——DJ 正在补节目单' }
    }
  }

  // ⏮ with the radio on: no player queue to step back through — replay the
  // current song from the top, like a physical player's back button.
  if (request.command === 'prev' && isRadioActive()) {
    markRadioGesture('⏮ 重播')
    const replayed = await replayCurrentRadioSong()
    await refreshMusicNowPlaying()
    return replayed
      ? { success: true, nowPlaying: getMusicNowPlaying() }
      : { success: false, error: '没有可重播的歌' }
  }

  try {
    const result = await options.service.runner.run({
      command: getActiveMusicProvider().descriptor.binary,
      args,
      timeoutMs: 10_000,
    })

    // A zero exit is not success: the CLI can refuse in a JSON envelope and
    // still exit 0 (ncm: "当前无播放进程，请先使用 play 命令开始播放").
    const envelope = getActiveMusicProvider().cli.parse.envelope(result.stdout)
    if (!envelope.ok) {
      return { success: false, error: envelope.message || `${args.join(' ')} 失败` }
    }
    if (result.code !== 0) {
      return { success: false, error: result.stderr.trim() || `${args.join(' ')} 失败` }
    }

    // Read back rather than assume: `next` picks the song, and pause/resume can
    // be refused by a daemon that quietly went away.
    await refreshMusicNowPlaying()
    return { success: true, nowPlaying: getMusicNowPlaying() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '播放命令失败' }
  }
}

/** 面板的搜索框:一次搜索,只取可展示的三格。 */
async function searchMusicSongs(
  query: string,
): Promise<{ success: boolean; records?: Array<{ title: string; artist?: string; playFlag?: boolean }>; error?: string }> {
  try {
    const provider = getActiveMusicProvider()
    const runner = options.service.runner
    const result = await runner.run({
      command: provider.descriptor.binary,
      args: provider.cli.build.search(query, 10),
      timeoutMs: 20_000,
    })
    const records = provider.cli.parse.searchRecords(result.stdout).map(record => ({
      title: record.title,
      artist: record.artist,
      playFlag: record.playFlag,
    }))
    return { success: true, records }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '搜索失败' }
  }
}


  return { quiesce: () => owner.quiesce(), drain: () => owner.drain(),
    readPlayerVolume: owner.wrap(readPlayerVolume),
    readRadioBrief: owner.wrap(readRadioBrief),
    runMusicCommand: owner.wrap(runMusicCommand),
    searchMusicSongs: owner.wrap(searchMusicSongs),
  }
}
export type MusicOperationsScope = ReturnType<typeof createMusicOperationsScope>
export const readPlayerVolume: MusicOperationsScope['readPlayerVolume'] = (...args) => getCurrentBackend('music').music.operations.readPlayerVolume(...args)
export const readRadioBrief: MusicOperationsScope['readRadioBrief'] = (...args) => getCurrentBackend('music').music.operations.readRadioBrief(...args)
export const runMusicCommand: MusicOperationsScope['runMusicCommand'] = (...args) => getCurrentBackend('music').music.operations.runMusicCommand(...args)
export const searchMusicSongs: MusicOperationsScope['searchMusicSongs'] = (...args) => getCurrentBackend('music').music.operations.searchMusicSongs(...args)
export async function setMusicProvider(providerId: string): Promise<{ success: boolean; error?: string }> {
  if (!listMusicProviderDescriptors().some(provider => provider.id === providerId)) return { success: false, error: `未知的音乐 CLI:${providerId}` }
  if (getSettings().music?.provider === providerId) return { success: true }
  return getCurrentBackend('music').music.switchProvider(providerId)
}
