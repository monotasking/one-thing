import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dir: '',
  /** Scripted replies keyed by the first meaningful arg word. */
  runs: [] as Array<{ args: string[]; env?: Record<string, string | undefined> }>,
  stateReplies: [] as string[],
  playerBackend: 'mpv' as string,
  /** `login --check`: true = logged in; false = the 未登录 refusal envelope. */
  loginOk: true,
  /** `search song` reply records (the silent-start post-mortem reads playFlag). */
  searchRecords: [] as unknown[],
  /** Live settings snapshot; tests flip music.enabled through this. */
  settings: { music: {} } as { music: Record<string, unknown> },
  /** `song lyric` 的 LRC 文本;缺席 = 没歌词(口播在静音里说)。 */
  lyric: undefined as string | undefined,
  /** 播放器此刻的音量读数;`undefined` = 读不到。P4 起电台不再读它(压音量归 `speech:activity`)。 */
  volume: undefined as number | undefined,
  /** 播放器此刻的读数(跳过那一段要「真在放」才记)。 */
  nowPlaying: null as null | { status: string; title?: string; position: number; queueLength: number; currentIndex: number },
}))

vi.mock('@onething/runtime/music/process-runner', () => ({
  createElectronMusicProcessRunner: () => ({
    run: async (options: { args: string[]; env?: Record<string, string | undefined> }) => {
      mocks.runs.push({ args: options.args, env: options.env })
      if (options.args[0] === 'state') {
        const reply = mocks.stateReplies.shift() ?? mocks.stateReplies[0] ?? 'stopped'
        const state =
          reply === 'playing'
            ? { status: 'playing', title: 'song X', position: 3, duration: 200, queueLength: 1, currentIndex: 0 }
            : { status: 'stopped', position: 0, queueLength: 0, currentIndex: 0 }
        return { code: 0, stdout: JSON.stringify({ success: true, state }), stderr: '' }
      }
      if (options.args[0] === 'search') {
        return {
          code: 0,
          stdout: JSON.stringify({ code: 200, data: { records: mocks.searchRecords } }),
          stderr: '',
        }
      }
      if (options.args[0] === 'song' && options.args[1] === 'lyric') {
        return { code: 0, stdout: JSON.stringify({ code: 200, data: { lyric: mocks.lyric ?? '' } }), stderr: '' }
      }
      if (options.args[0] === 'login') {
        // Real ncm-cli refuses with exit 0 + a success:false envelope.
        const body = mocks.loginOk
          ? { success: true }
          : { success: false, message: '未登录，请执行 ncm-cli login 完成登录' }
        return { code: 0, stdout: JSON.stringify(body), stderr: '' }
      }
      return { code: 0, stdout: '{"success": true}', stderr: '' }
    },
    spawn: () => ({ done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill: () => {} }),
  }),
}))

// 音量读数本来读 `~/.config/ncm-cli/user-prefs.json` —— 测试里换成脚本值,绝不碰真文件。
vi.mock('../player-volume.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../player-volume.js')>()),
  readProviderVolume: () => mocks.volume,
}))

vi.mock('@onething/runtime/voice/host-ports.wiring', () => ({
  broadcastVoiceHostMessage: vi.fn(),
  configureVoiceHost: vi.fn(),
  getVoiceHostPorts: () => ({}),
}))

vi.mock('../service.js', async () => {
  const { ncmMusicProvider } = await import('@onething/runtime/music/index')
  return {
    // The real active-provider resolution (settings → registry) collapses to
    // ncm here: these tests exercise the founding provider's behavior.
    getActiveMusicProvider: () => ncmMusicProvider,
    getMusicNowPlaying: () => mocks.nowPlaying,
    getMusicService: () => ({
      getState: () => ({ playerBackend: mocks.playerBackend }),
      checkLogin: vi.fn().mockResolvedValue(false),
    }),
    nudgeMusicClients: vi.fn(),
    refreshMusicNowPlaying: vi.fn().mockResolvedValue(undefined),
    setMusicSampleListener: vi.fn(),
  }
})

// 注意:vi.mock 的相对路径按【本测试文件】解析,不是按被测模块解析。这里在
// music/__tests__/ 下,radio.ts 的 '@onething/runtime/storage/index' 对本文件是 '@onething/runtime/storage/index'。
// 曾因少写一层目录,paths mock 静默失效、getOnethingStorePath 走真实实现,7 个夹具把
// ~/.onething/music/ 的真实电台状态反复清空(2026-07-17 事故),而测试自读自写全绿。
/** 主持人声音(宠物 P3 起电台只认 `hostVoice`):假的,从不合成、从不出声。 */
const hostVoice = { prefetch: vi.fn(), speak: vi.fn().mockResolvedValue(undefined) }
/** 听歌的事实(宠物 P4 §11.1):假的,只记电台在哪几处报了什么。 */
const moments = { trackStarted: vi.fn(), skipped: vi.fn(), liked: vi.fn(), observeSample: vi.fn(), observeNowPlaying: vi.fn() }
vi.mock('@onething/runtime/agents/store-bound.wiring', () => ({
  agentExists: () => true,
  createAgent: vi.fn(),
  findAgent: () => ({ systemPrompt: '' }),
  updateAgent: vi.fn(),
}))
vi.mock('../../../stores/sessions.js', () => ({
  getSession: vi.fn(),
  getSessionsList: vi.fn(() => []),
  createSession: vi.fn(),
  updateSessionAgent: vi.fn(),
}))
vi.mock('@onething/runtime/storage/index', () => ({ getOnethingStorePath: () => mocks.dir }))
vi.mock('../../../stores/settings.js', () => ({ getSettings: () => mocks.settings }))

const HEX = 'D71F6E90EA704F1C44183933E7E0F19'
const entry = (n: number) => ({ encryptedId: HEX + n, originalId: String(n), title: `song ${n}` })

async function loadRadio() {
  const radio = await import('../radio.js')
  activeRadio ??= radio.createRadioScope({
    storePath: mocks.dir,
    service: { ...await import('../service.js'), runner: (await import('@onething/runtime/music/process-runner')).createElectronMusicProcessRunner() },
    hostVoice: () => hostVoice,
    moments,
  } as unknown as Parameters<typeof radio.createRadioScope>[0])
  return { ...radio, ...activeRadio }
}

let activeRadio: ReturnType<typeof import('../radio.js')['createRadioScope']> | undefined

describe('main radio playback (legacy starter)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.dir = mkdtempSync(path.join(os.tmpdir(), 'main-radio-'))
    mocks.runs = []
    mocks.stateReplies = []
    mocks.playerBackend = 'mpv'
    mocks.loginOk = true
    mocks.searchRecords = []
    mocks.settings = { music: {} }
    mocks.lyric = undefined
    mocks.volume = undefined
    mocks.nowPlaying = null
    for (const fn of Object.values(moments)) fn.mockReset()
    hostVoice.speak.mockReset()
    hostVoice.speak.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await activeRadio?.drain()
    activeRadio = undefined
    rmSync(mocks.dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('the store is fenced into the test tmp dir, never the real user data dir', async () => {
    // The tripwire for the incident above: if the paths mock ever detaches
    // again (renamed module, moved test file), this fails loudly instead of
    // silently wiping the user's live radio state on every test run.
    const radio = await loadRadio()
    expect(radio.getRadioStore().briefPath.startsWith(mocks.dir)).toBe(true)
  })

  it('resume plays via NCM_LEGACY_PLAY, polls until playing, records onDeck', async () => {
    vi.useFakeTimers()
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1), entry(2)] })
    // Slow night: silent polls before the song audibly starts. The verify
    // loop checks immediately and then every 300ms — four stopped replies keep
    // the start in flight past the 1s 换歌中 assertion below.
    mocks.stateReplies = ['stopped', 'stopped', 'stopped', 'stopped', 'playing']

    const resume = radio.resumeRadioPlayback()
    // Mid-start the bar's 换歌中 signal names the song; it clears when done.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(radio.getRadioStartingTitle()).toBe('song 1')
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(resume).resolves.toBe(true)
    expect(radio.getRadioStartingTitle()).toBeUndefined()

    const play = mocks.runs.find(run => run.args[0] === 'play')
    expect(play?.env?.NCM_LEGACY_PLAY).toBe('1')
    expect(store.readBrief().onDeck?.title).toBe('song 1')
    expect(store.readProgramme().entries.map(item => item.title)).toEqual(['song 2'])
  })

  it('reports failure when the player never starts within the deadline', async () => {
    vi.useFakeTimers()
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })
    mocks.stateReplies = ['stopped'] // stays stopped forever

    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(13_000)
    await expect(resume).resolves.toBe(false)
    expect(store.readBrief().lastError).toContain('起播失败')
  })

  it('resume on a CLOSED station with songs left re-opens it (bar 恢复)', async () => {
    vi.useFakeTimers()
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: false, intent: '', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })
    mocks.stateReplies = ['playing']

    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(resume).resolves.toBe(true)
    // The station is back on the air — conductor re-engages on later ticks.
    expect(store.readBrief().active).toBe(true)
  })

  it('openRadioStation: the bar path shares the tool path (a fresh open wipes the old intent)', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: false, intent: '旧方向', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })

    // 开电台 with empty intent = a fresh station: the previous session's
    // direction must NOT haunt this one. Cleared to '' → the open prompt's
    // intent-line degradation lets the DJ pick by time/history.
    radio.openRadioStation('', { clearProgramme: false })
    let brief = store.readBrief()
    expect(brief.active).toBe(true)
    expect(brief.intent).toBe('') // a fresh open wipes the previous intent
    expect(store.readProgramme().entries).toHaveLength(1)

    // 新电台 = retune: new direction, old programme discarded.
    radio.openRadioStation('深夜爵士', { clearProgramme: true })
    brief = store.readBrief()
    expect(brief.intent).toBe('深夜爵士')
    expect(store.readProgramme().entries).toHaveLength(0)
  })

  it('dj session rotation: oversized transcripts rotate; dead ids reuse the index', async () => {
    const radio = await loadRadio()

    // Heavy transcript → rotate (either axis trips it).
    expect(radio.isDjSessionOversized({ messages: new Array(41), contextSize: 0 })).toBe(true)
    expect(radio.isDjSessionOversized({ messages: [], contextSize: 60_001 })).toBe(true)
    expect(radio.isDjSessionOversized({ messages: new Array(10), contextSize: 30_000 })).toBe(false)
    expect(radio.isDjSessionOversized(null)).toBe(false)

    // Dead-id recovery prefers the newest light radio-dj session; oversized
    // and foreign-agent sessions never qualify.
    expect(
      radio.pickReusableRadioDjSession([
        { id: 'a', agentId: 'radio-dj', updatedAt: 100, messageCount: 2 },
        { id: 'b', agentId: 'radio-dj', updatedAt: 300, messageCount: 99 },
        { id: 'c', agentId: 'radio-dj', updatedAt: 200, messageCount: 4 },
        { id: 'd', agentId: 'default', updatedAt: 400, messageCount: 1 },
      ]),
    ).toBe('c')
    expect(radio.pickReusableRadioDjSession([])).toBeNull()
  })

  it('requestSong: picks the first playable version and cuts in as next', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    mocks.settings = { music: { enabled: true } }
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })
    mocks.searchRecords = [
      { id: entry(8).encryptedId, originalId: 8, name: '晴天', artists: [{ name: 'B-KLl' }], playFlag: false },
      { id: entry(9).encryptedId, originalId: 9, name: '晴天', artists: [{ name: '周杰伦' }], playFlag: true },
    ]

    const result = await radio.requestSong('晴天 周杰伦')
    expect(result).toMatchObject({ success: true, title: '晴天 - 周杰伦' })
    expect(store.readProgramme().entries.map(item => item.title)).toEqual([
      '晴天 - 周杰伦', 'song 1',
    ])
    expect(store.readProgramme().entries[0]?.note).toBe('点歌')

    // Requesting an already-queued song promotes instead of duplicating.
    const again = await radio.requestSong('晴天 周杰伦')
    expect(again.success).toBe(true)
    expect(store.readProgramme().entries.map(item => item.title)).toEqual([
      '晴天 - 周杰伦', 'song 1',
    ])
  })

  it('requestSong refuses honestly: all-grey results, and a closed station', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    mocks.settings = { music: { enabled: true } }
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [] })
    mocks.searchRecords = [
      { id: entry(8).encryptedId, originalId: 8, name: '海浪', artists: [{ name: 'Deca Joins' }], playFlag: false },
    ]
    await expect(radio.requestSong('海浪')).resolves.toMatchObject({ success: false })

    store.writeBrief({ active: false, intent: 'x', played: [], skipped: [], loved: [] })
    await expect(radio.requestSong('晴天')).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('电台未开'),
    })
  })

  it('programme panel actions: remove records a skip, promote/move reorder', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1), entry(2), entry(3)] })

    // ✕ = the strongest taste signal, not just queue management.
    radio.applyProgrammeAction({ kind: 'remove', encryptedId: entry(2).encryptedId })
    expect(store.readProgramme().entries.map(item => item.title)).toEqual(['song 1', 'song 3'])
    expect(store.readBrief().skipped.map(spin => spin.title)).toEqual(['song 2'])

    radio.applyProgrammeAction({ kind: 'promote', encryptedId: entry(3).encryptedId })
    expect(store.readProgramme().entries.map(item => item.title)).toEqual(['song 3', 'song 1'])

    radio.applyProgrammeAction({ kind: 'move', encryptedId: entry(3).encryptedId, toIndex: 1 })
    expect(store.readProgramme().entries.map(item => item.title)).toEqual(['song 1', 'song 3'])

    // Popped-by-conductor race: acting on a vanished entry is a quiet no-op.
    expect(
      radio.applyProgrammeAction({ kind: 'remove', encryptedId: entry(9).encryptedId }),
    ).toEqual({ success: true })
  })

  it('the start flow itself refuses a closed station (mid-flight close guard)', async () => {
    // ▶ on a closed station re-opens it by design — but a start already in
    // flight when 停止电台 lands must abort, and ⏮ replay (no re-open logic)
    // exercises the same in-flow guard directly.
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({
      active: false, intent: 'x', played: [], skipped: [], loved: [],
      onDeck: entry(1),
    })

    await expect(radio.replayCurrentRadioSong()).resolves.toBe(false)
    expect(mocks.runs.filter(run => run.args[0] === 'play')).toHaveLength(0)
  })

  it('resume steps over curation-flagged grey entries — no patter, no play attempt', async () => {
    vi.useFakeTimers()
    const radio = await loadRadio()
    hostVoice.speak.mockClear()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({
      entries: [
        { ...entry(1), say: '为一首放不出的歌写的串词', playFlag: false },
        { ...entry(2), playFlag: true },
      ],
    })
    mocks.stateReplies = ['playing']

    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(resume).resolves.toBe(true)

    // The grey entry cost nothing: its patter never synthesized, its play
    // never issued; song 2 is what actually started.
    expect(hostVoice.speak).not.toHaveBeenCalled()
    const plays = mocks.runs.filter(run => run.args[0] === 'play')
    expect(plays).toHaveLength(1)
    expect(plays[0]?.args).toContain(entry(2).encryptedId)
  })

  it('names rights restriction when a silent start turns out to be a greyed-out song', async () => {
    // `play` on a playFlag:false song exits 0 with no output and no sound
    // (measured 2026-07-17) — the post-mortem re-searches and reads the flag.
    vi.useFakeTimers()
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })
    mocks.stateReplies = ['stopped'] // stays stopped forever
    mocks.searchRecords = [{ id: entry(1).encryptedId, name: 'song 1', playFlag: false }]

    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(13_000)
    await expect(resume).resolves.toBe(false)
    expect(store.readBrief().lastError).toContain('版权受限')
  })

  it('names the true cause when the login expired instead of blaming the song', async () => {
    // Expired login = play exits 0 with no sound for EVERY song (field-hit
    // 2026-07-17). The status line must carry the actionable sentence, not
    // 起播失败(some innocent song).
    vi.useFakeTimers()
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })
    mocks.stateReplies = ['stopped'] // stays stopped forever
    mocks.loginOk = false

    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(13_000)
    await expect(resume).resolves.toBe(false)
    expect(store.readBrief().lastError).toBe(
      '网易云登录过期了,在音乐面里重新登录;登录恢复后电台会自动续播',
    )
  })

  it('serializes starts: a concurrent caller gives up instead of double-sounding', async () => {
    vi.useFakeTimers()
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1), entry(2)] })
    mocks.stateReplies = ['stopped', 'playing', 'playing']

    const first = radio.resumeRadioPlayback()
    const second = radio.skipToNextRadioSong()
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(false) // gave up; error recorded honestly
    expect(mocks.runs.filter(run => run.args[0] === 'play')).toHaveLength(1)
    // The loser's popped entry went BACK to the programme — a double-tap must
    // not silently eat a curated song (it did, once).
    expect(store.readProgramme().entries.map(item => item.title)).toEqual(['song 2'])
  })

  it('there is no master switch: radio opens on settings that never mention a switch', async () => {
    const radio = await loadRadio()
    mocks.settings = { music: {} }
    const status = await radio.radioToolOpen('雨天民谣', { clearProgramme: false })
    expect(status.active).toBe(true)
    expect(status.intent).toBe('雨天民谣')
  })

  it('skip never falls back to replaying the current song', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({
      active: true, intent: 'x', played: [], skipped: [], loved: [],
      onDeck: entry(9),
    })
    store.writeProgramme({ entries: [] })

    await expect(radio.skipToNextRadioSong()).resolves.toBe(false)
    expect(mocks.runs.filter(run => run.args[0] === 'play')).toHaveLength(0)
  })

  it('refuses to start under the orpheus backend, with a pointer to the fix', async () => {
    mocks.playerBackend = 'orpheus'
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })

    await expect(radio.resumeRadioPlayback()).resolves.toBe(false)
    expect(store.readBrief().lastError).toContain('内置播放器')
  })

  it('likeCurrentSong hearts onDeck and records the loved signal', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({
      active: true, intent: 'x', played: [], skipped: [], loved: [],
      onDeck: entry(3),
    })

    await expect(radio.likeCurrentSong()).resolves.toEqual({ success: true })
    const like = mocks.runs.find(run => run.args[0] === 'song')
    expect(like?.args).toEqual(['song', 'like', '--songId', HEX + '3'])
    expect(store.readBrief().loved.map(spin => spin.title)).toEqual(['song 3'])
  })

  it('likeCurrentSong refuses without a known song id', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })

    const result = await radio.likeCurrentSong()
    expect(result.success).toBe(false)
    expect(mocks.runs.filter(run => run.args[0] === 'song')).toHaveLength(0)
  })

  it('宠物 P4:电台不再自己压音量 —— 压着前奏说也好、静音里说也好,都不发 volume 命令', async () => {
    vi.useFakeTimers()
    // 第一句歌词在 30 秒:口播(估计 3 秒)远放得下 → 歌先放、话压着前奏说。
    mocks.lyric = '[00:30.00]第一句歌词'
    mocks.volume = 80
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [{ ...entry(1), say: '下一首是一首老歌。' }] })
    mocks.stateReplies = ['playing']

    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(resume).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(10)

    expect(hostVoice.speak).toHaveBeenCalledTimes(1)
    expect(hostVoice.speak.mock.calls[0]?.[1]).toMatchObject({ overMusic: true })
    expect(hostVoice.speak.mock.calls[0]?.[1]).not.toHaveProperty('onVoiceStart')
    expect(mocks.runs.filter(run => run.args[0] === 'volume')).toHaveLength(0)
  })

  it('宠物 P3:停止电台时正在说的那句被中止', async () => {
    vi.useFakeTimers()
    mocks.lyric = '[00:30.00]第一句歌词'
    let seenSignal: AbortSignal | undefined
    hostVoice.speak.mockImplementation((_text: string, options: { signal?: AbortSignal }) => {
      seenSignal = options.signal
      // 一直说,直到被中止。
      return new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
    })
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [{ ...entry(1), say: '下一首是一首老歌。' }] })
    mocks.stateReplies = ['playing']

    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(resume).resolves.toBe(true)
    expect(seenSignal?.aborted).toBe(false)

    await radio.radioToolClose()
    await vi.advanceTimersByTimeAsync(10)
    expect(seenSignal?.aborted).toBe(true)
  })

  it('宠物 P4:一首歌确认在放 → 报 trackStarted(播放器的标题 + 那首的 id)', async () => {
    vi.useFakeTimers()
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    store.writeProgramme({ entries: [entry(1)] })
    mocks.stateReplies = ['playing']
    const resume = radio.resumeRadioPlayback()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(resume).resolves.toBe(true)
    expect(moments.trackStarted).toHaveBeenCalledTimes(1)
    expect(moments.trackStarted).toHaveBeenCalledWith({ title: 'song X', encryptedId: HEX + '1' })
  })

  it('宠物 P4:跳过只在真记下一次跳过时报;对着静音按 ⏭ 不报', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    radio.recordRadioSkip()
    expect(moments.skipped).not.toHaveBeenCalled()

    mocks.nowPlaying = { status: 'playing', title: '晴天 - 周杰伦', position: 20, queueLength: 1, currentIndex: 0 }
    radio.recordRadioSkip()
    expect(moments.skipped).toHaveBeenCalledWith('晴天 - 周杰伦')

    store.writeBrief({ ...store.readBrief(), active: false })
    radio.recordRadioSkip()
    expect(moments.skipped).toHaveBeenCalledTimes(1)
  })

  it('宠物 P4:♥ 成功才报 liked;不知道 id 的拒绝不报', async () => {
    const radio = await loadRadio()
    const store = radio.getRadioStore()
    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    await radio.likeCurrentSong()
    expect(moments.liked).not.toHaveBeenCalled()

    store.writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [], onDeck: entry(3) })
    await expect(radio.likeCurrentSong()).resolves.toEqual({ success: true })
    expect(moments.liked).toHaveBeenCalledWith('song 3')
  })
})
