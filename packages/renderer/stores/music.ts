import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  MusicCommand,
  MusicEvent,
  MusicLyrics,
  MusicNowPlaying,
  MusicPlayerBackend,
  MusicProgrammeActionRequest,
  MusicProgrammeEntryDTO,
  MusicProviderDescriptorDTO,
  MusicRadioState,
  MusicRuntimeState,
  MusicSetupRequest,
} from '@/types'
import { platformApi } from '@/platform'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.music')

let initialized = false

function createEmptyState(): MusicRuntimeState {
  return {
    setupStage: 'env',
    configured: false,
    loggedIn: false,
    playerBackend: 'mpv',
    source: 'fm',
  }
}

export const useMusicStore = defineStore('music', () => {
  const state = ref<MusicRuntimeState>(createEmptyState())
  const lastError = ref('')
  const busy = ref(false)
  /** Raw `ncm-cli login` stdout; the ASCII QR code lives in here. */
  const loginOutput = ref('')
  const installOutput = ref('')
  const toast = ref<{ level: 'info' | 'warn' | 'error'; message: string } | null>(null)

  const setupStage = computed(() => state.value.setupStage)
  const isReady = computed(() => state.value.setupStage === 'ready')
  const playerBackend = computed(() => state.value.playerBackend)

  // --- now playing (composer's music bar) ---

  const nowPlaying = ref<MusicNowPlaying | null>(null)
  /*
   * `barHeight` / `barPinned` 已随 E 期(composer-bands)退役:播放器面板改由
   * StatusChip 的浮层承载,teleport 出输入区,谁都不必再为它预留高度。
   */
  /** The DJ patter currently being spoken, '' when silent — for an optional caption. */
  const djPatter = ref('')
  /**
   * Radio brief snapshot. Refreshed on every now-playing push — radio state
   * only changes meaningfully alongside playback transitions, so that cadence
   * is exactly right and costs no polling.
   */
  const radio = ref<MusicRadioState>({ active: false, intent: '', programmeLength: 0, canResume: false })

  async function refreshRadio() {
    try {
      radio.value = await platformApi.musicGetRadio()
    } catch {
      // Keep the last answer; a failed read is not "the radio turned off".
    }
  }

  /** The visible queue for the panel; refreshed on every now-playing push. */
  const programme = ref<MusicProgrammeEntryDTO[]>([])
  const programmeOnDeck = ref<string | undefined>(undefined)

  async function refreshProgramme() {
    try {
      const response = await platformApi.musicGetProgramme()
      if (response.success) {
        programme.value = response.entries ?? []
        programmeOnDeck.value = response.onDeck
      }
    } catch {
      // Keep the last answer.
    }
  }

  async function programmeAction(action: MusicProgrammeActionRequest['action']) {
    const response = await platformApi.musicProgrammeAction({ action })
    await refreshProgramme()
    return response
  }

  /** The bar's 开电台/新电台: empty intent = let the DJ pick by time/history. */
  async function openRadio(intent: string, clearProgramme: boolean) {
    const response = await platformApi.musicOpenRadio({ intent, clearProgramme })
    await refreshRadio()
    await refreshProgramme()
    return response
  }

  async function searchSongs(query: string) {
    return platformApi.musicSearch({ query })
  }

  /** Cut a named song in as the next track (same channel the radio tool uses). */
  async function requestSongNext(query: string) {
    const response = await platformApi.musicRequestSong({ query })
    await refreshProgramme()
    return response
  }
  /** When `nowPlaying.position` was true, for interpolating between polls. */
  const positionAnchoredAt = ref(0)
  /** Ticks the interpolated clock; only runs while the bar is on screen. */
  const clock = ref(0)
  let clockTimer: ReturnType<typeof setInterval> | null = null

  function setNowPlaying(next: MusicNowPlaying | null) {
    nowPlaying.value = next
    positionAnchoredAt.value = Date.now()
    void refreshRadio()
    void refreshProgramme()
  }

  /**
   * Main polls every few seconds and only announces changes, so the seconds in
   * between are ours to fill. Anything else means an IPC message a second for a
   * number that advances at exactly one second per second.
   */
  const livePosition = computed(() => {
    const playing = nowPlaying.value
    if (!playing) return 0
    void clock.value // re-evaluate on tick
    if (playing.status !== 'playing') return playing.position
    const drift = (Date.now() - positionAnchoredAt.value) / 1000
    const position = playing.position + drift
    return playing.duration ? Math.min(position, playing.duration) : position
  })

  const progressRatio = computed(() => {
    const duration = nowPlaying.value?.duration
    if (!duration) return 0
    return Math.max(0, Math.min(1, livePosition.value / duration))
  })

  // --- lyrics (the composer's placeholder) ---

  const lyrics = ref<MusicLyrics | null>(null)

  /**
   * The lyric line the clock points at, '' when unknowable. Guarded by title:
   * a push for the previous song must not caption the next one.
   */
  /**
   * The lyric clock runs slightly AHEAD of the interpolated position: the
   * position we anchor on was sampled by a subprocess (~0.3s spawn) and rode
   * IPC before the anchor timestamp was taken, so the raw clock trails the
   * actual audio and lines landed late (field feedback). Half a second of
   * lead re-centers it; a line arriving a hair early reads far better than
   * one arriving after the singer.
   */
  const LYRIC_CLOCK_LEAD_S = 0.5

  const currentLyricLine = computed(() => {
    const current = nowPlaying.value
    const sheet = lyrics.value
    if (!current || current.status !== 'playing') return ''
    if (!sheet || sheet.lines.length === 0 || sheet.title !== current.title) return ''
    const position = livePosition.value + LYRIC_CLOCK_LEAD_S
    let line = ''
    for (const item of sheet.lines) {
      if (item.at > position) break
      line = item.text
    }
    return line
  })

  /** Starts the interpolation tick. Reference-counted: the bar may mount twice. */
  let clockUsers = 0
  function useClock(): () => void {
    clockUsers += 1
    if (!clockTimer) clockTimer = setInterval(() => (clock.value = Date.now()), 250)
    return () => {
      clockUsers -= 1
      if (clockUsers <= 0 && clockTimer) {
        clearInterval(clockTimer)
        clockTimer = null
        clockUsers = 0
      }
    }
  }

  async function sendCommand(command: MusicCommand, value?: number) {
    try {
      const response = await platformApi.musicCommand({ command, value })
      if (response.success) setNowPlaying(response.nowPlaying ?? null)
      else if (response.error) lastError.value = response.error
      return response
    } catch (error: any) {
      lastError.value = error?.message || '播放命令失败'
      return { success: false, error: lastError.value }
    }
  }

  function handleEvent(event: MusicEvent) {
    switch (event.type) {
      case 'state':
        state.value = event.state
        if (event.state.lastError) lastError.value = event.state.lastError
        break
      case 'login-output':
        loginOutput.value += event.chunk
        break
      case 'install-output':
        installOutput.value += event.chunk
        break
      case 'toast':
        toast.value = { level: event.level, message: event.message }
        break
    }
  }

  // The DJ's spoken patter plays here, on its own <audio>, not through mpv —
  // music and voice are separate tracks. The voice may overlap the song's
  // opening (main starts the load under the patter and lets both play); we
  // only need to play the clip and report back when it ends (or fails).
  let djAudio: HTMLAudioElement | null = null
  let djCurrentSpeakId: string | null = null

  /**
   * Cut the patter mid-sentence and ACK it — the ack is what unblocks main's
   * awaiting start flow, so an interrupted host never leaves the radio hung.
   * Used by the bar's 跳过口播 (song starts sooner) and by 停止电台 (the
   * station is closed first, so the unblocked flow aborts instead of playing).
   */
  function stopDjPatter() {
    if (djAudio) {
      djAudio.onended = null
      djAudio.onerror = null
      djAudio.pause()
      djAudio = null
    }
    djPatter.value = ''
    const id = djCurrentSpeakId
    djCurrentSpeakId = null
    if (id) void platformApi.musicDjSpeakDone(id)
  }

  function playDjPatter(speak: { id: string; audioBase64: string; mimeType: string; text: string }) {
    const receivedAt = Date.now()
    djPatter.value = speak.text
    // A newer line supersedes one still playing (should be rare — main serializes).
    if (djAudio) {
      djAudio.onended = null
      djAudio.onerror = null
      djAudio.pause()
    }
    djCurrentSpeakId = speak.id
    const ackOnce = () => {
      djPatter.value = ''
      djAudio = null
      djCurrentSpeakId = null
      void platformApi.musicDjSpeakDone(speak.id)
    }
    try {
      const audio = new Audio(`data:${speak.mimeType};base64,${speak.audioBase64}`)
      // Follow the music volume (persisted 0-100), slightly lifted — the voice
      // has to sit above the memory of the music — instead of blasting at full
      // device volume over a quiet station.
      const musicVolume = radio.value.volume
      if (musicVolume !== undefined) {
        audio.volume = Math.max(0.2, Math.min(1, (musicVolume / 100) * 1.4))
      }
      djAudio = audio
      audio.addEventListener(
        'playing',
        () => {
          log.debug('dj patter audible', { receivedToAudibleMs: Date.now() - receivedAt })
        },
        { once: true },
      )
      audio.onended = ackOnce
      // A play failure (autoplay policy, decode error) must still ack, or main
      // holds the music paused until its timeout.
      audio.onerror = ackOnce
      audio.play().catch(ackOnce)
    } catch {
      ackOnce()
    }
  }

  async function initialize() {
    if (initialized) return
    initialized = true

    platformApi.onMusicEvent(handleEvent)
    platformApi.onMusicNowPlaying(setNowPlaying)
    platformApi.onMusicDjSpeak(playDjPatter)
    platformApi.onMusicLyrics(sheet => (lyrics.value = sheet))
    platformApi
      .musicGetLyrics()
      .then(sheet => {
        if (lyrics.value === null) lyrics.value = sheet
      })
      .catch(() => {})
    // Pushes only fire on change, so a renderer arriving mid-song (reload,
    // second window, app launched while the daemon plays on) would otherwise
    // stare at nothing until the next track. Subscribe first, then pull once;
    // if a push races the pull, the push is newer — keep it.
    platformApi
      .musicGetNowPlaying()
      .then(current => {
        if (nowPlaying.value === null) setNowPlaying(current)
      })
      .catch(() => {})
    void refreshRadio()
    void refreshProviders()
    try {
      const response = await platformApi.musicGetState()
      if (response.success && response.state) state.value = response.state
      else if (response.error) lastError.value = response.error
    } catch (error: any) {
      lastError.value = error?.message || '加载电台状态失败'
    }
  }

  async function runSetup(request: MusicSetupRequest, options: { silent?: boolean } = {}) {
    // silent: background polls (login --check every 3s) must not flip `busy` —
    // the settings tab keys hints and button-disabling off it, and a poll that
    // strobes it makes the login step flash "正在生成二维码…" forever.
    if (!options.silent) {
      busy.value = true
      lastError.value = ''
    }
    try {
      const response = await platformApi.musicSetup(request)
      if (response.success && response.state) state.value = response.state
      else if (response.error) lastError.value = response.error
      return response
    } catch (error: any) {
      lastError.value = error?.message || '操作失败'
      return { success: false, error: lastError.value }
    } finally {
      if (!options.silent) busy.value = false
    }
  }

  // --------------------------------------------------------------------------
  // Provider selection (settings): which music CLI drives everything.
  // --------------------------------------------------------------------------
  const providers = ref<MusicProviderDescriptorDTO[]>([])
  const activeProviderId = ref('ncm-cli')
  const activeProvider = computed(
    () => providers.value.find(p => p.id === activeProviderId.value),
  )

  async function refreshProviders() {
    try {
      const response = await platformApi.musicListProviders()
      if (response.success) {
        providers.value = response.providers ?? []
        activeProviderId.value = response.activeId ?? 'ncm-cli'
      }
    } catch {
      // Selector simply stays hidden; the wizard falls back to its copy.
    }
  }

  /** Switching is a retune: programme cleared, wizard restarts on the new CLI. */
  async function setProvider(providerId: string) {
    busy.value = true
    try {
      const response = await platformApi.musicSetProvider({ providerId })
      if (!response.success && response.error) lastError.value = response.error
      await refreshProviders()
      await refreshRadio()
      const stateResponse = await platformApi.musicGetState()
      if (stateResponse.success && stateResponse.state) state.value = stateResponse.state
      return response
    } finally {
      busy.value = false
    }
  }

  const checkEnv = () => runSetup({ action: 'check-env' })
  const installTool = (tool: string) => {
    installOutput.value = ''
    return runSetup({ action: 'install-tool', tool })
  }
  const setCredentials = (appId: string, privateKey: string) =>
    runSetup({ action: 'set-credentials', appId, privateKey })
  /** True only while `login-start` is generating a QR — the hint's one signal. */
  const loginStarting = ref(false)
  const startLogin = async () => {
    loginOutput.value = ''
    loginStarting.value = true
    try {
      return await runSetup({ action: 'login-start' })
    } finally {
      loginStarting.value = false
    }
  }
  const cancelLogin = () => runSetup({ action: 'login-cancel' })
  /** Silent: callers poll this on a timer; it must not strobe `busy`. */
  const checkLogin = () => runSetup({ action: 'login-check' }, { silent: true })
  const logout = () => runSetup({ action: 'logout' })
  const setPlayer = (player: MusicPlayerBackend) => runSetup({ action: 'set-player', player })

  return {
    state,
    lastError,
    busy,
    loginStarting,
    loginOutput,
    installOutput,
    toast,
    setupStage,
    isReady,
    playerBackend,
    nowPlaying,
    djPatter,
    stopDjPatter,
    radio,
    refreshRadio,
    programme,
    programmeOnDeck,
    refreshProgramme,
    programmeAction,
    openRadio,
    searchSongs,
    requestSongNext,
    lyrics,
    currentLyricLine,
    livePosition,
    progressRatio,
    useClock,
    sendCommand,
    initialize,
    providers,
    activeProviderId,
    activeProvider,
    refreshProviders,
    setProvider,
    checkEnv,
    installTool,
    setCredentials,
    startLogin,
    cancelLogin,
    checkLogin,
    logout,
    setPlayer,
  }
})
