import { ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerElectronMusicIpcHandlers } from '@onething/electron-host/music/ipc'
import { createElectronMusicProcessRunner } from '@onething/runtime/music/process-runner'
import {
  getOnethingMusicStateForIpc,
  listMusicProviderDescriptors,
  runOnethingMusicSetupForIpc,
  type OnethingMusicSetupRequest,
} from '@onething/runtime/music'
import { DEFAULT_MUSIC_SETTINGS } from '@shared/defaults/settings.js'
import { getSettings, saveSettings } from '@onething/backend/stores/settings.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type {
  MusicCommand,
  MusicCommandRequest,
  MusicCommandResponse,
  MusicRadioState,
} from '@shared/ipc/music.js'
import {
  getActiveMusicProvider,
  getMusicNowPlaying,
  getMusicService,
  refreshMusicNowPlaying,
  resetMusicServiceForProviderSwitch,
  stopMusicPlayerKeepalive,
} from '@onething/backend/wiring/music/service.js'
import {
  applyProgrammeAction,
  disposeRadioConductor,
  getMusicLyrics,
  getProgrammeSnapshot,
  getRadioStartingTitle,
  getRadioStore,
  isRadioActive,
  likeCurrentSong,
  openRadioStation,
  radioToolClose,
  markRadioGesture,
  recordRadioSkip,
  replayCurrentRadioSong,
  requestSong,
  resumeRadioPlayback,
  skipToNextRadioSong,
  startRadioConductor,
} from '@onething/backend/wiring/music/radio.js'
import { resolveDjSpeakDone } from '@onething/backend/wiring/music/dj-voice.js'

/**
 * Music IPC serves the settings tab and the composer's music bar. Choosing what
 * to play is the model's job — it runs ncm-cli through bash, guided by the
 * `netease-music-cli` skill — so nothing here picks songs. The bar only steers
 * the song already playing.
 *
 * Two conductors, one player: the user's pause and the model's next `queue add`
 * both reach the same daemon. That is fine as long as the bar never touches the
 * queue — whatever the model does next simply wins.
 */

/**
 * Where the bar's volume number comes from is the provider's business: ncm
 * persists it in a prefs file because `state` reports volume as null. Foreign
 * format — read defensively, absence just means the knob shows nothing.
 */
function readPlayerVolume(): number | undefined {
  const provider = getActiveMusicProvider()
  if (provider.reliability.volumeSource !== 'prefs-file') return undefined
  const prefsPath = provider.reliability.probePaths?.volumePrefs
  if (!prefsPath) return undefined
  try {
    const expanded = prefsPath.startsWith('~')
      ? path.join(os.homedir(), prefsPath.slice(1))
      : prefsPath
    const raw = readFileSync(expanded, 'utf8')
    const volume = (JSON.parse(raw) as { volume?: unknown }).volume
    return typeof volume === 'number' && Number.isFinite(volume)
      ? Math.max(0, Math.min(100, Math.round(volume)))
      : undefined
  } catch {
    return undefined
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
  // volume: ncm-cli takes absolute 0-100.
  return ['volume', String(Math.max(0, Math.min(100, Math.round(value))))]
}

async function runMusicCommand(request: MusicCommandRequest): Promise<MusicCommandResponse> {
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
    const result = await createElectronMusicProcessRunner().run({
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

/**
 * Switching CLIs is a retune with paperwork: stop the OLD provider's
 * playback, discard the programme (its ids belong to the old service; the
 * brief's taste history is titles and survives), persist the choice with
 * configured=false so the new wizard runs, and rebuild every provider-bound
 * singleton. Unreachable from the UI while only one provider is registered.
 */
async function setMusicProvider(providerId: string): Promise<{ success: boolean; error?: string }> {
  const known = listMusicProviderDescriptors().some(descriptor => descriptor.id === providerId)
  if (!known) return { success: false, error: `未知的音乐 CLI:${providerId}` }

  const settings = getSettings()
  const music = settings.music ?? { ...DEFAULT_MUSIC_SETTINGS }
  if (music.provider === providerId) return { success: true }

  // Old provider's stop, before the registry answer changes underneath it.
  stopMusicPlayerKeepalive()

  const store = getRadioStore()
  store.writeProgramme({ entries: [] })
  const brief = store.readBrief()
  store.writeBrief({ ...brief, active: false, onDeck: undefined })

  saveSettings({
    ...settings,
    music: { ...music, provider: providerId, configured: false },
  })

  disposeRadioConductor()
  resetMusicServiceForProviderSwitch()
  startRadioConductor()
  return { success: true }
}

export function registerMusicHandlers(): void {
  // Renderer acks a DJ patter finished playing → main resumes the music.
  ipcMain.handle(IPC_CHANNELS.MUSIC_DJ_SPEAK_DONE, (_event, request: { id?: string }) => {
    if (request?.id) resolveDjSpeakDone(request.id)
  })

  ipcMain.handle(
    IPC_CHANNELS.MUSIC_OPEN_RADIO,
    (_event, request: { intent?: string; clearProgramme?: boolean }) => {
      const settings = getSettings()
      if (settings.music?.enabled !== true) {
        return { success: false, error: '音乐电台未启用:请在 设置 → 音乐 打开总开关' }
      }
      openRadioStation(request?.intent?.trim() ?? '', {
        clearProgramme: request?.clearProgramme === true,
      })
      return { success: true }
    },
  )

  ipcMain.handle(IPC_CHANNELS.MUSIC_SEARCH, async (_event, request: { query?: string }) => {
    const query = request?.query?.trim()
    if (!query) return { success: false, error: 'query is required' }
    try {
      const provider = getActiveMusicProvider()
      const runner = createElectronMusicProcessRunner()
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
  })

  ipcMain.handle(IPC_CHANNELS.MUSIC_REQUEST_SONG, (_event, request: { query?: string }) =>
    request?.query?.trim()
      ? requestSong(request.query.trim())
      : { success: false, error: 'query is required' },
  )

  ipcMain.handle(IPC_CHANNELS.MUSIC_GET_PROGRAMME, () => ({
    success: true,
    ...getProgrammeSnapshot(),
  }))

  ipcMain.handle(
    IPC_CHANNELS.MUSIC_PROGRAMME_ACTION,
    (_event, request: { action?: Parameters<typeof applyProgrammeAction>[0] }) =>
      request?.action
        ? applyProgrammeAction(request.action)
        : { success: false, error: 'action is required' },
  )

  ipcMain.handle(IPC_CHANNELS.MUSIC_LIST_PROVIDERS, () => ({
    success: true,
    providers: listMusicProviderDescriptors(),
    activeId: getActiveMusicProvider().descriptor.id,
  }))

  ipcMain.handle(IPC_CHANNELS.MUSIC_SET_PROVIDER, (_event, request: { providerId?: string }) =>
    request?.providerId
      ? setMusicProvider(request.providerId)
      : { success: false, error: 'providerId is required' },
  )

  registerElectronMusicIpcHandlers({
    channels: {
      getState: IPC_CHANNELS.MUSIC_GET_STATE,
      setup: IPC_CHANNELS.MUSIC_SETUP,
      command: IPC_CHANNELS.MUSIC_COMMAND,
      getNowPlaying: IPC_CHANNELS.MUSIC_GET_NOW_PLAYING,
      getRadio: IPC_CHANNELS.MUSIC_GET_RADIO,
      getLyrics: IPC_CHANNELS.MUSIC_GET_LYRICS,
    },
    getState: () => getOnethingMusicStateForIpc({ getState: () => getMusicService().getState() }),
    command: request => runMusicCommand(request as MusicCommandRequest),
    // The watcher's cache, not a fresh poll: answering a window reload must not
    // cost a subprocess. Position is at most one poll interval stale, and the
    // renderer interpolates anyway.
    getNowPlaying: () => getMusicNowPlaying(),
    getRadio: (): MusicRadioState => {
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
      }
    },
    getLyrics: () => getMusicLyrics(),
    setup: async request => {
      const result = await runOnethingMusicSetupForIpc({
        request: request as OnethingMusicSetupRequest,
        service: getMusicService(),
      })

      // Only ever stop the keepalive here, never start it. Starting launches the
      // TUI, and the TUI plays 每日推荐 at whoever is nearby — nobody switching a
      // radio button asked to hear music. The first playback command starts it
      // (see the bash tool); switching to orpheus, or breaking the setup, makes
      // the offscreen TUI dead weight.
      if (result.success && !(result.state.setupStage === 'ready' && result.state.playerBackend === 'mpv')) {
        stopMusicPlayerKeepalive()
      }
      return result
    },
  })
}
