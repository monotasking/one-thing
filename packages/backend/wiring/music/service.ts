import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MusicSetupService,
  createNowPlayingWatcher,
  getMusicProvider,
  type MusicProvider,
  type OnethingMusicEvent,
  type OnethingMusicNowPlaying,
  type OnethingMusicRadioSource,
  type NowPlayingWatcher,
} from '@onething/runtime/music/index'
import {
  createElectronMusicProcessRunner,
  writeElectronMusicSecretFile,
} from '@onething/runtime/music/process-runner'
import { broadcastVoiceHostMessage } from '@onething/runtime/voice/host-ports.wiring'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { DEFAULT_MUSIC_SETTINGS } from '@shared/defaults/settings.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { consolePort, getLogger } from '../logging/index.js'
import type { MusicSetupServiceOptions } from '@onething/runtime/music/setup-service'
import type { NowPlayingWatcherOptions } from '@onething/runtime/music/now-playing'

const log = getLogger('music')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


let service: MusicSetupService | null = null
let nowPlayingWatcher: NowPlayingWatcher | null = null
/**
 * The radio conductor's tap on the watcher (see ../music/radio.ts). A settable
 * hook instead of an import so the dependency stays one-way: radio.ts needs the
 * keepalive from this module, so this module must not need radio.ts back.
 */
let sampleListener: ((nowPlaying: OnethingMusicNowPlaying | null) => void) | null = null

export function setMusicSampleListener(
  listener: ((nowPlaying: OnethingMusicNowPlaying | null) => void) | null,
): void {
  sampleListener = listener
}

/**
 * The active music CLI provider (settings.music.provider; unknown → ncm).
 * Every per-CLI fact this module needs — binary name, probe paths, wire
 * parsers, the setup backend — comes off this object.
 */
export function getActiveMusicProvider(): MusicProvider {
  return getMusicProvider(getSettings().music?.provider)
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

/**
 * The player daemon binds a socket and unlinks it on the way out, so its
 * presence is a free "is anything playing?" check — a file stat instead of
 * the subprocess `state` would cost. Path is the provider's own convention;
 * if it ever moves, the bar goes quiet rather than wrong. Providers without a
 * socket probe report "running" and pay the state poll instead.
 */
function playerSocketPath(): string | undefined {
  const socket = getActiveMusicProvider().reliability.probePaths?.playerSocket
  return socket ? expandHome(socket) : undefined
}

function getMusicSettings() {
  return getSettings().music ?? DEFAULT_MUSIC_SETTINGS
}

function persistMusicSettings(patch: Partial<typeof DEFAULT_MUSIC_SETTINGS>): void {
  const settings = getSettings()
  saveSettings({
    ...settings,
    music: { ...DEFAULT_MUSIC_SETTINGS, ...settings.music, ...patch },
  })
}

function emitMusicEvent(event: OnethingMusicEvent): void {
  broadcastVoiceHostMessage({
    channel: IPC_CHANNELS.MUSIC_EVENT,
    payload: event,
  })

  // Mirror the durable bits into settings so a restart lands on the right
  // wizard step instead of re-asking for credentials.
  if (event.type === 'state') {
    const current = getMusicSettings()
    const { configured, source } = event.state
    if (current.configured !== configured || current.source !== source) {
      persistMusicSettings({ configured, source })
    }
  }
}

export function getMusicService(): MusicSetupService {
  if (service) return service

  const provider = getActiveMusicProvider()
  const musicSetupServiceOptions: MusicSetupServiceOptions = {
    backend: provider.createBackend({
      runner: createElectronMusicProcessRunner(),
      writeSecretFile: writeElectronMusicSecretFile,
      logger: consoleLog,
    }),
    emit: emitMusicEvent,
    getSource: (): OnethingMusicRadioSource => getMusicSettings().source,
    tools: provider.descriptor.tools,
    logger: consoleLog,
  };
  service = new MusicSetupService(musicSetupServiceOptions)
  return service
}

/**
 * Stop whatever is playing — e.g. after switching to orpheus, where the
 * 网易云音乐 App takes over and a lingering mpv session would double up.
 */
export function stopMusicPlayerKeepalive(): void {
  const socket = playerSocketPath()
  if (socket && !existsSync(socket)) return
  const provider = getActiveMusicProvider()
  try {
    spawn(provider.descriptor.binary, provider.cli.build.stop(), {
      detached: true,
      stdio: 'ignore',
    }).unref()
  } catch (error) {
    log.warn('stop playback failed', {}, error)
  }
}

// ----------------------------------------------------------------------------
// Now playing (the composer's music bar)
// ----------------------------------------------------------------------------

function getNowPlayingWatcher(): NowPlayingWatcher {
  const provider = getActiveMusicProvider()
  const nowPlayingWatcherOptions: NowPlayingWatcherOptions = {
    runner: createElectronMusicProcessRunner(),
    cli: {
      binary: provider.descriptor.binary,
      parseNowPlaying: provider.cli.parse.nowPlaying,
    },
    isPlayerRunning: () => {
      const socket = playerSocketPath()
      return socket ? existsSync(socket) : true
    },
    emit: nowPlaying => {
      broadcastVoiceHostMessage({
        channel: IPC_CHANNELS.MUSIC_NOW_PLAYING,
        payload: nowPlaying,
      })
    },
    onSample: nowPlaying => sampleListener?.(nowPlaying),
    logger: consoleLog,
  };
  nowPlayingWatcher ??= createNowPlayingWatcher(nowPlayingWatcherOptions)
  return nowPlayingWatcher
}

/**
 * Safe to call at startup: with no daemon this is a file stat on a timer, and
 * `ncm-cli state` cannot start a player even if it did run (measured — it logs
 * nothing and spawns nothing). Unlike the keepalive, watching cannot make sound.
 */
export function startMusicNowPlayingWatch(): void {
  getNowPlayingWatcher().start()
}

export function getMusicNowPlaying(): OnethingMusicNowPlaying | null {
  return nowPlayingWatcher?.current() ?? null
}

/** Poll immediately — used right after a bar command, so the UI does not lag a tick. */
export async function refreshMusicNowPlaying(): Promise<void> {
  await getNowPlayingWatcher().refresh()
}

/**
 * Re-broadcast the current snapshot even though nothing about IT changed.
 * The renderer re-pulls the radio state on every now-playing push, and some
 * radio-side facts (a start going in flight) change while the player is
 * silent — the watcher, which only announces changes, would never carry the
 * news. Costs one IPC message, no subprocess.
 */
export function nudgeMusicClients(): void {
  broadcastVoiceHostMessage({
    channel: IPC_CHANNELS.MUSIC_NOW_PLAYING,
    payload: nowPlayingWatcher?.current() ?? null,
  })
}

/**
 * Rebuild the provider-bound singletons after settings.music.provider
 * changed: the setup service holds the OLD backend and the watcher the OLD
 * binary/parser. The sample listener (conductor tap) survives — the watcher
 * restart re-subscribes nothing; radio.ts re-wires itself separately.
 */
export function resetMusicServiceForProviderSwitch(): void {
  service?.dispose()
  service = null
  nowPlayingWatcher?.stop()
  nowPlayingWatcher = null
  startMusicNowPlayingWatch()
}

export function disposeMusicService(): void {
  service?.dispose()
  service = null
  nowPlayingWatcher?.stop()
  nowPlayingWatcher = null
  // Legacy playback (NCM_LEGACY_PLAY) runs as detached processes that outlive
  // us, and once the window is gone there is no bar left to stop them — quit
  // must take the music with it (fire-and-forget inside).
  stopMusicPlayerKeepalive()
}
