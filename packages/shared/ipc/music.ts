/**
 * Music radio IPC types (ncm-cli backed AI radio)
 *
 * Wire types between renderer and main. Mirrors the runtime-level
 * OnethingMusic* types in packages/onething-runtime/src/music/ — keep the
 * two in structural sync (same duplication convention as voice.ts).
 */

import type { ToolCallModelSettings } from './tools.js'

export type MusicRadioSource = 'fm' | 'daily'

/** mpv = ncm-cli's own player; orpheus = the local 网易云音乐 App (macOS only). */
export type MusicPlayerBackend = 'mpv' | 'orpheus'

export type MusicSetupStage = 'env' | 'credentials' | 'login' | 'ready'

/**
 * Mirrors OnethingMusicLoginStatus. Deliberately no "scanned, waiting for the
 * phone to confirm": `login --check` only answers yes or no, so that middle
 * step is not a fact this machine can observe.
 */
export type MusicLoginStatus = 'idle' | 'starting' | 'waiting' | 'ok' | 'failed' | 'quota'

export interface MusicLoginState {
	status: MusicLoginStatus
	/** The login address (`qrCodeUrl`, else `clickableUrl`). Present while `waiting`. */
	url?: string
	/** The backend's own words on failure / quota. */
	message?: string
}

export interface MusicToolStatus {
	installed: boolean
	version?: string
}

export interface MusicEnvStatus {
	/** Keyed by the provider descriptor's tool ids (ncm: 'ncm-cli', 'mpv'). */
	tools: Record<string, MusicToolStatus>
	npmAvailable: boolean
	brewAvailable: boolean
}

/**
 * What the composer's music bar shows. Mirrors OnethingMusicNowPlaying.
 *
 * `title` is ncm-cli's display string (`可惜没如果 - 林俊杰`), not an id — there
 * is no lyric lookup from this. `status` is already disambiguated: ncm-cli has
 * no `paused` and reports a paused player as `stopped` with a frozen position.
 */
export interface MusicNowPlaying {
	status: 'playing' | 'paused' | 'stopped'
	title?: string
	/** Seconds. */
	position: number
	/** Seconds. */
	duration?: number
	/** ncm-cli's own formatting, e.g. `4:01 / 4:58`. */
	progress?: string
	queueLength: number
	/** Where in the queue we are; `queueLength - currentIndex - 1` songs remain. */
	currentIndex: number
}

/**
 * Bar controls. Deliberately no `stop`: it tears the play session down, and the
 * next start has to cold-start the daemon — which is unreliable. A pause button
 * that calls `stop` would be a pause button that sometimes loses the music.
 *
 * `radio-resume` restarts a silent-but-active radio from its programme, through
 * the keepalive flow — the one measured-viable cold-start path.
 *
 * `seek` and `volume` carry their argument in `value` (seconds / 0-100).
 *
 * `like` hearts the current song (id known via the radio's onDeck). The AI is
 * forbidden from touching红心; the bar's button is the legitimate path — a
 * click IS the explicit user intent the rule asks for.
 */
export type MusicCommand =
	| 'pause'
	| 'resume'
	| 'next'
	| 'prev'
	| 'seek'
	| 'volume'
	| 'like'
	| 'radio-resume'
	/**
	 * Full stop from the bar: cut the patter, stop the music, close the
	 * station (active=false) — the conductor goes dormant, no more advances or
	 * DJ wakes. The programme is kept for a later re-open.
	 */
	| 'radio-stop'

export interface MusicCommandRequest {
	command: MusicCommand
	/** seek: target seconds; volume: 0-100. Ignored by the other commands. */
	value?: number
}

/** One timed LRC line. */
export interface MusicLyricLine {
	/** Seconds from song start. */
	at: number
	text: string
}

/** The current song's lyrics, pushed once per song start. */
export interface MusicLyrics {
	/** Matches MusicNowPlaying.title — the renderer checks before showing. */
	title: string
	lines: MusicLyricLine[]
	/**
	 * The lookup itself failed (network, or the song could not be identified) —
	 * as opposed to `lines: []` with no flag, which means the song has no lyrics.
	 * The panel says two different sentences for the two.
	 */
	failed?: boolean
}

/** Radio brief snapshot for the bar: is the station on, and is it healthy. */
export interface MusicRadioState {
	/**
	 * Title of the song a start is currently in flight for — held from "we
	 * decided to play this" (patter synthesis included) until the start is
	 * verified or given up. This is what lets the bar say 换歌中 instead of
	 * mistaking a deliberate transition gap for "the radio stalled".
	 */
	starting?: string
	active: boolean
	intent: string
	lastError?: string
	/** Songs still curated and waiting. */
	programmeLength: number
	/**
	 * Whether radio-resume has anything to play: a programme entry, or the
	 * persisted last-played song (fed songs die with the daemon's memory).
	 */
	canResume: boolean
	/**
	 * What plays after the current song, when that is actually knowable: the
	 * player's own queue is opaque, so this is the programme's first entry and
	 * only meaningful while the player holds no fed-ahead track.
	 */
	upNext?: string
	/** ncm-cli's persisted volume (user-prefs.json); `state` reports null. */
	volume?: number
	/** When this station run started (ISO). The panel counts record sides from here. */
	startedAt?: string
	/**
	 * Songs the station started this run, **newest first**, at most
	 * `RADIO_RECENT_LIMIT`. A song is recorded when it starts, so while
	 * something is playing the head of this list is that song.
	 */
	recent?: MusicRadioSpinDTO[]
	/**
	 * Where playback last was (09-19): the song and the second it stopped at,
	 * remembered across a player-daemon exit. The panel shows it when nothing
	 * is playing; ⏯ (`radioResume`) continues from there when it was the
	 * radio's last song and it had not finished.
	 */
	lastPlayed?: { title: string; position: number; durationS?: number }
}

/** How many recent spins the brief carries. */
export const RADIO_RECENT_LIMIT = 12

/** One song the station played. */
export interface MusicRadioSpinDTO {
	title: string
	/** ISO time it started. */
	at: string
	encryptedId?: string
	/** Seconds, when known. */
	durationS?: number
	/** What the listener did while it played: hearted it, or skipped it. */
	verdict?: 'love' | 'skip'
}

/** The DJ's patter to play in the gap before a song (main -> renderer). */
export interface MusicDjSpeak {
	/** Correlates the play with its MUSIC_DJ_SPEAK_DONE ack. */
	id: string
	audioBase64: string
	mimeType: string
	/** The spoken text, for captions/debugging. */
	text: string
	title: string
}

export interface MusicCommandResponse extends MusicBaseResponse {
	nowPlaying?: MusicNowPlaying | null
	/**
	 * The command was accepted but cannot happen yet — today only ⏭ with the
	 * station on and nothing queued: the DJ is refilling the programme, the
	 * current song keeps playing. Success, not failure: nothing went wrong.
	 */
	deferred?: 'refilling'
}

/** Structural mirror of the runtime's OnethingMusicRuntimeState — setup only.
 * Playback/radio state travels on its own channels (now-playing, getRadio);
 * this shape once carried phantom player/programme fields the main process
 * never populated, and the renderer silently rendered stale defaults. */
export interface MusicRuntimeState {
	setupStage: MusicSetupStage
	env?: MusicEnvStatus
	configured: boolean
	loggedIn: boolean
	playerBackend: MusicPlayerBackend
	source: MusicRadioSource
	/** Where the login step stands, login address included (2026-09-18). */
	login: MusicLoginState
	lastError?: string
}

// ============================================================================
// Requests / responses
// ============================================================================

export interface MusicBaseResponse {
	success: boolean
	error?: string
}

export interface MusicGetStateResponse extends MusicBaseResponse {
	state?: MusicRuntimeState
}

export type MusicSetupRequest =
	| { action: 'check-env' }
	| { action: 'install-tool'; tool: string }
	| { action: 'set-credentials'; appId: string; privateKey: string }
	| { action: 'set-player'; player: MusicPlayerBackend }
	| { action: 'login-start' }
	| { action: 'login-cancel' }
	| { action: 'login-check' }
	| { action: 'logout' }

export interface MusicSetupResponse extends MusicBaseResponse {
	/** Every setup step returns the whole runtime state, wizard stage included. */
	state?: MusicRuntimeState
}

// ============================================================================
// Events (main -> renderer, MUSIC_EVENT channel)
// ============================================================================

export type MusicEvent =
	| { type: 'state'; state: MusicRuntimeState }
	/** Raw stdout of `ncm-cli login` (contains the ASCII QR code). */
	| { type: 'login-output'; chunk: string }
	| { type: 'install-output'; tool: string; chunk: string }
	| { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }

// ============================================================================
// Programme (the panel's visible, editable queue)
// ============================================================================

export interface MusicProgrammeEntryDTO {
	encryptedId: string
	title: string
	/** The DJ's patter preview. */
	say?: string
	/** e.g. '点歌' for user-requested entries. */
	note?: string
	/** false = rights-restricted; the conductor will skip it. */
	playFlag?: boolean
	/** Track length in seconds, when the catalogue said. */
	durationS?: number
}

export interface MusicGetProgrammeResponse extends MusicBaseResponse {
	entries?: MusicProgrammeEntryDTO[]
	/** Title of the song currently on deck (started last by the radio). */
	onDeck?: string
}

/**
 * Panel edits to the queue. `remove` doubles as the strongest taste signal —
 * it records the song into the brief's skipped history, so the DJ's next
 * batch steers away from it.
 */
export type MusicProgrammeAction =
	| { kind: 'remove'; encryptedId: string }
	| { kind: 'promote'; encryptedId: string }
	| { kind: 'move'; encryptedId: string; toIndex: number }

export interface MusicProgrammeActionRequest {
	action: MusicProgrammeAction
}

// ============================================================================
// Song requests (panel search box; chat goes through the radio tool)
// ============================================================================

export interface MusicOpenRadioRequest {
	/** The listener's one-line direction; empty = let the DJ pick by time/history. */
	intent: string
	/** true = 新电台 (retune: old programme discarded); false = plain open. */
	clearProgramme: boolean
}

export interface MusicSearchRequest {
	query: string
}

export interface MusicSearchRecordDTO {
	title: string
	artist?: string
	/** false = rights-restricted; shown greyed, not clickable. */
	playFlag?: boolean
}

export interface MusicSearchResponse extends MusicBaseResponse {
	records?: MusicSearchRecordDTO[]
}

export interface MusicRequestSongRequest {
	/** 「歌名 歌手」-ish free text; main searches and picks a playable version. */
	query: string
}

export interface MusicRequestSongResponse extends MusicBaseResponse {
	/** The full chosen title (player format) when queued. */
	title?: string
}

// ============================================================================
// Provider descriptors (settings selector + generic wizard)
// ============================================================================

/** Serializable mirror of the runtime MusicProviderDescriptor. */
export interface MusicProviderDescriptorDTO {
	id: string
	label: string
	binary: string
	tools: Array<{
		id: string
		label: string
		install: { npm?: string[]; brew?: string[] }
		requiredWhenPlayerBackend?: string
	}>
	setupStages: MusicSetupStage[]
	credentialFields: Array<{
		key: string
		label: string
		secret: boolean
		placeholder?: string
		helpUrl?: string
	}>
	loginKind: 'qr-stdout' | 'oauth-url' | 'token-paste' | 'none'
	playerBackends?: Array<{ id: string; label: string }>
}

export interface MusicListProvidersResponse extends MusicBaseResponse {
	providers?: MusicProviderDescriptorDTO[]
	activeId?: string
}

export interface MusicSetProviderRequest {
	providerId: string
}

// ============================================================================
// Settings
// ============================================================================

/**
 * 上一次「这台电脑上有什么」的答案(2026-09-18,用户报障:「每次打开都会 check 状态,
 * 上一次都 check 过了」)。
 *
 * 探一次不只是看文件在不在:它还要跑 `login --check`,必要时再跑 `config list`
 * (实测 ~10s),**这两条都吃网易云的每日额度**。所以答案要过夜 —— 记在设置里,
 * 进程重起、面板重开都不再白探一遍。人要重探有一颗钮(向导第 ① 步)。
 *
 * 它是**缓存不是真相**:装了 / 登了 / 退了这些改变它的动作,自己会把它刷新。
 */
export interface MusicProbeCache {
	/** 探完的时刻(epoch ms)。 */
	at: number
	env: MusicEnvStatus
	loggedIn: boolean
	playerBackend: MusicPlayerBackend
}

export interface MusicSettings {
	/**
	 * **已退役(2026-09-18)**,留着只为读得懂旧设置文件。用户原话:「音乐不要开关了,
	 * 默认开,控制交给 apps 上面的开关」—— 开不开是壳里「应用」面那颗开关的事,
	 * 后端一处都不再读它。不许再加读者。
	 */
	enabled?: boolean
	/**
	 * Which music CLI provider drives everything (binary, parsers, setup
	 * wizard, bash policy). Unknown/absent ids resolve to 'ncm-cli' — the
	 * registry lives in @onething/runtime/music/providers.
	 */
	provider: string
	source: MusicRadioSource
	/**
	 * Credentials were written into ncm-cli's own encrypted config.
	 * The app never persists appId/privateKey itself.
	 */
	configured: boolean
	/** 上一次探测的答案(见 `MusicProbeCache`)。没有 = 从没探过。 */
	probe?: MusicProbeCache
	/**
	 * The DJ curation turns' dedicated model, same shape as
	 * tools.toolCallModel: a curation turn is background work in a session
	 * nobody is looking at, so it gets its own provider/model/think switch
	 * instead of inheriting whatever the radio session last used. Empty
	 * providerId = follow the session default (today's behavior).
	 */
	radioDj?: ToolCallModelSettings
}

// ============================================================================
// Router
// ============================================================================

/**
 * music(音乐电台)域 —— 结构债 P4c 第九批,十四条数据面整只从手写 IPC 通道迁到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 十四条逐条对应从前 `IPC_CHANNELS` 上那十四条 `music:*` invoke 通道:八条是主进程
 * 里的裸 `ipcMain.handle`,六条经 `apps/electron/src/music/ipc.ts` 那只透传工厂。
 * 请求/响应形状一字未改;变的只是通道。
 *
 * **四条推送留在原地**(`MUSIC_EVENT` / `MUSIC_NOW_PLAYING` / `MUSIC_LYRICS` /
 * `MUSIC_DJ_SPEAK`)—— router 今天没有推送面,而它们早就走
 * `broadcastVoiceHostMessage` 这个注入端口,由 `backend/wiring/music/*` 直接发。
 * 常量与渲染侧订阅因此原样保留。
 *
 * 无参的六条(`getState` / `getNowPlaying` / `getRadio` / `getLyrics` /
 * `getProgramme` / `listProviders`)按本仓惯例递 `{}`;`djSpeakDone` 从前递
 * `{ id }`,形状不变。
 */
import { defineRouter } from './router.js'

export interface MusicDjSpeakDoneRequest {
    /** 与 `MusicDjSpeak.id` 对应的那次播报。 */
    id: string
}

export type MusicRoutes = {
    getState: { input: Record<string, never>; output: MusicGetStateResponse }
    setup: { input: MusicSetupRequest; output: MusicSetupResponse }
    command: { input: MusicCommandRequest; output: MusicCommandResponse }
    getNowPlaying: { input: Record<string, never>; output: MusicNowPlaying | null }
    getRadio: { input: Record<string, never>; output: MusicRadioState }
    getLyrics: { input: Record<string, never>; output: MusicLyrics | null }
    djSpeakDone: { input: MusicDjSpeakDoneRequest; output: void }
    openRadio: { input: MusicOpenRadioRequest; output: MusicBaseResponse }
    search: { input: MusicSearchRequest; output: MusicSearchResponse }
    requestSong: { input: MusicRequestSongRequest; output: MusicRequestSongResponse }
    getProgramme: { input: Record<string, never>; output: MusicGetProgrammeResponse }
    programmeAction: { input: MusicProgrammeActionRequest; output: MusicBaseResponse }
    listProviders: { input: Record<string, never>; output: MusicListProvidersResponse }
    setProvider: { input: MusicSetProviderRequest; output: MusicBaseResponse }
}

export const musicRouter = defineRouter<MusicRoutes>('music', [
    'getState',
    'setup',
    'command',
    'getNowPlaying',
    'getRadio',
    'getLyrics',
    'djSpeakDone',
    'openRadio',
    'search',
    'requestSong',
    'getProgramme',
    'programmeAction',
    'listProviders',
    'setProvider',
])
