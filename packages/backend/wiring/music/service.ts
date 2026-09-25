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


import { MusicWorkOwner } from './lifetime.js'
import { getCurrentBackend } from '../../current.js'

export function createMusicServiceScope(options: {
  storePath: string
  assertOwned?: () => void
  /**
   * 一条**扇出**的 now-playing 观察口(K3-b)。
   *
   * 它不是第二个 `setMusicSampleListener`:那一格是单槽、归电台指挥台独占(见下面
   * 那段注释),而且它是**每一次成功轮询**都响 —— 用来看队列水位,不是「变了」。
   * 这一格挂在 `emit` 上,也就是 watcher 自己的**变化检测之后**,语义正好是
   * 「现在放的东西变了」,而这正是 `music:player` 那条 `nowPlayingChanged` 事件的
   * 定义。缺席 = 没人看,与今天逐字一样。
   *
   * 为什么收一个回调而不是在这里自己开一张监听表:这只作用域随音乐 provider 切换
   * 整代重建(`MusicSubsystem.switchProvider`),表放在这里的话,换一次 CLI 订阅就
   * 全丢了。所以表归子系统(它的寿命是 backend 的寿命),这里只负责把事实递上去。
   */
  onNowPlaying?: (nowPlaying: OnethingMusicNowPlaying | null) => void
  /**
   * 接入向导那条扇出口(2026-09-18)。与 `onNowPlaying` 逐字同一个形状、同一个
   * 理由:这只作用域随音乐 provider 切换整代重建,所以监听表归子系统,这里只把
   * 事实递上去。
   *
   * 递的是**整只** `OnethingMusicEvent`,不在这里分拣:谁要哪一种由读表的人说
   * (资源 provider 今天只把 `install-output` 折成一条资源事实)。
   */
  onSetupEvent?: (event: OnethingMusicEvent) => void
}) {
  const owner = new MusicWorkOwner(options.assertOwned)
  const runner = createElectronMusicProcessRunner({ env: { ONETHING_STORE_PATH: options.storePath }, signal: owner.signal })
  const setups = new Set<MusicSetupService>()
  const watchers = new Set<NowPlayingWatcher>()
  let activated = false
let service: MusicSetupService | null = null
let nowPlayingWatcher: NowPlayingWatcher | null = null
/**
 * The radio conductor's tap on the watcher (see ../music/radio.ts). A settable
 * hook instead of an import so the dependency stays one-way: radio.ts needs the
 * keepalive from this module, so this module must not need radio.ts back.
 */
let sampleListener: ((nowPlaying: OnethingMusicNowPlaying | null) => void) | null = null

function setMusicSampleListener(
  listener: ((nowPlaying: OnethingMusicNowPlaying | null) => void) | null,
): void {
  sampleListener = listener
}

/**
 * The active music CLI provider (settings.music.provider; unknown → ncm).
 * Every per-CLI fact this module needs — binary name, probe paths, wire
 * parsers, the setup backend — comes off this object.
 */
function getActiveMusicProvider(): MusicProvider {
  owner.assertActive()
  activated = true
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
  if (owner.signal.aborted) return
  broadcastVoiceHostMessage({
    channel: IPC_CHANNELS.MUSIC_EVENT,
    payload: event,
  })

  // 一个坏掉的观察者不该把这条事实撤销掉(与 `onNowPlaying` 那一处同一句话)。
  try {
    options.onSetupEvent?.(event)
  } catch (error) {
    log.warn('music setup observer failed', { type: event.type }, error)
  }

  // Mirror the durable bits into settings so a restart lands on the right
  // wizard step instead of re-asking for credentials.
  if (event.type === 'state') {
    const current = getMusicSettings()
    const { configured, source, env, loggedIn, playerBackend } = event.state
    const patch: Parameters<typeof persistMusicSettings>[0] = {}
    if (current.configured !== configured || current.source !== source) {
      Object.assign(patch, { configured, source })
    }
    // 探测的答案也记下来(见 seed 那一段):env 在 = 刚探过,把这一份连同登录与出声方式
    // 一起存成缓存,下次起来先按它摆,不再白探一遍。
    if (env) {
      const probe = { at: Date.now(), env, loggedIn, playerBackend }
      const before = current.probe
      const changed =
        !before ||
        before.loggedIn !== loggedIn ||
        before.playerBackend !== playerBackend ||
        JSON.stringify(before.env) !== JSON.stringify(env)
      if (changed) Object.assign(patch, { probe })
    }
    if (Object.keys(patch).length > 0) persistMusicSettings(patch)
  }
}

function getMusicService(): MusicSetupService {
  if (service) return service

  const provider = getActiveMusicProvider()
  const musicSetupServiceOptions: MusicSetupServiceOptions = {
    backend: provider.createBackend({
      runner: runner,
      writeSecretFile: writeElectronMusicSecretFile,
      logger: consoleLog,
    }),
    emit: emitMusicEvent,
    getSource: (): OnethingMusicRadioSource => getMusicSettings().source,
    /*
     * 上次探测的答案(用户 09-18 报障:「每次打开都会 check 状态,上一次都 check 过了」)。
     * 探一次要跑 `login --check`,必要时再跑 `config list`(~10s),两条都吃网易云的每日
     * 额度 —— 所以这件事要过夜。种子只是**上次的答案**,不是真相:装 / 登 / 退这些会改变
     * 它的动作自己会把它刷新,人也可以按「重新检查」。
     */
    seed: (() => {
      const probe = getMusicSettings().probe
      if (!probe) return undefined
      return {
        env: probe.env,
        configured: getMusicSettings().configured,
        loggedIn: probe.loggedIn,
        playerBackend: probe.playerBackend,
      }
    })(),
    tools: provider.descriptor.tools,
    logger: consoleLog,
  };
  const instance = new MusicSetupService(musicSetupServiceOptions)
  setups.add(instance)
  service = new Proxy(instance, {
    get(target, property) {
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? owner.wrap(value.bind(target)) : value
    },
  })
  return service
}

/**
 * Stop whatever is playing — e.g. after switching to orpheus, where the
 * 网易云音乐 App takes over and a lingering mpv session would double up.
 */
function stopMusicPlayerKeepalive(): Promise<void> {
  const provider = getMusicProvider(getSettings().music?.provider)
  const socket = provider.reliability.probePaths?.playerSocket
  if (socket && !existsSync(expandHome(socket))) return Promise.resolve()
  const stopRunner = createElectronMusicProcessRunner({ env: { ONETHING_STORE_PATH: options.storePath } })
  return owner.track(stopRunner.run({ command: provider.descriptor.binary, args: provider.cli.build.stop(), timeoutMs: 3000 })
    .then(() => undefined)
    .catch(error => { log.warn('stop playback failed', {}, error) })
    .finally(() => stopRunner.drain()))
}

// ----------------------------------------------------------------------------
// Now playing (the composer's music bar)
// ----------------------------------------------------------------------------

function getNowPlayingWatcher(): NowPlayingWatcher {
  const provider = getActiveMusicProvider()
  const nowPlayingWatcherOptions: NowPlayingWatcherOptions = {
    runner: runner,
    cli: {
      binary: provider.descriptor.binary,
      parseNowPlaying: provider.cli.parse.nowPlaying,
    },
    isPlayerRunning: () => {
      const socket = playerSocketPath()
      return socket ? existsSync(socket) : true
    },
    emit: nowPlaying => {
      if (owner.signal.aborted) return
      broadcastVoiceHostMessage({
        channel: IPC_CHANNELS.MUSIC_NOW_PLAYING,
        payload: nowPlaying,
      })
      // 一个坏掉的观察者不该把这次推送撤销掉,也不该把 watcher 的这一拍炸掉
      // (与 `now-playing.ts` 对 `onSample` 的处理、`ResourceEventHub.emit` 对监听器
      // 的处理是同一句话)。
      try {
        options.onNowPlaying?.(nowPlaying)
      } catch (error) {
        log.warn('now-playing observer failed', {}, error)
      }
    },
    onSample: nowPlaying => { if (!owner.signal.aborted) sampleListener?.(nowPlaying) },
    logger: consoleLog,
  };
  if (!nowPlayingWatcher) {
    nowPlayingWatcher = createNowPlayingWatcher(nowPlayingWatcherOptions)
    watchers.add(nowPlayingWatcher)
  }
  return nowPlayingWatcher
}

/**
 * Safe to call at startup: with no daemon this is a file stat on a timer, and
 * `ncm-cli state` cannot start a player even if it did run (measured — it logs
 * nothing and spawns nothing). Unlike the keepalive, watching cannot make sound.
 */
function startMusicNowPlayingWatch(): void {
  getNowPlayingWatcher().start()
}

function getMusicNowPlaying(): OnethingMusicNowPlaying | null {
  return nowPlayingWatcher?.current() ?? null
}

/** Poll immediately — used right after a bar command, so the UI does not lag a tick. */
async function refreshMusicNowPlaying(): Promise<void> {
  await getNowPlayingWatcher().refresh()
}

/**
 * A transport command is about to go out: every `state` read already in flight
 * is stale from here on (it would land after the command and announce the old
 * world). See `NowPlayingWatcher.beginCommand`.
 */
function beginMusicCommand(): void {
  nowPlayingWatcher?.beginCommand()
}

/**
 * The command was accepted: announce its effect now instead of after a
 * `state` round trip. Not a sample (the conductor never sees it); the next
 * poll corrects it if the player disagrees. See `NowPlayingWatcher.assume`.
 */
function assumeMusicNowPlaying(
  next: (previous: OnethingMusicNowPlaying | null) => OnethingMusicNowPlaying | null,
): void {
  nowPlayingWatcher?.assume(next)
}

/**
 * Re-broadcast the current snapshot even though nothing about IT changed.
 * The renderer re-pulls the radio state on every now-playing push, and some
 * radio-side facts (a start going in flight) change while the player is
 * silent — the watcher, which only announces changes, would never carry the
 * news. Costs one IPC message, no subprocess.
 */
function nudgeMusicClients(): void {
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
async function resetMusicServiceForProviderSwitch(): Promise<void> {
  const previousService = service
  const previousWatcher = nowPlayingWatcher
  previousService?.dispose()
  previousWatcher?.quiesce()
  await Promise.all([previousService?.drain(), previousWatcher?.drain()])
  owner.assertActive()
  service = null
  nowPlayingWatcher = null
  startMusicNowPlayingWatch()
}

function quiesce(): void {
  if (owner.signal.aborted) return
  sampleListener = null
  for (const watcher of watchers) watcher.quiesce()
  for (const setup of setups) setup.dispose()
  owner.quiesce()
  runner.quiesce()
  if (activated) void stopMusicPlayerKeepalive()
}

async function drain(): Promise<void> {
  quiesce()
  await Promise.all([
    owner.drain(), runner.drain(),
    ...[...watchers].map(watcher => watcher.drain()),
    ...[...setups].map(setup => setup.drain()),
  ])
}

  return {
    quiesce, drain, runner,
    setMusicSampleListener: owner.wrap(setMusicSampleListener),
    getActiveMusicProvider: owner.wrap(getActiveMusicProvider),
    getMusicService: owner.wrap(getMusicService),
    stopMusicPlayerKeepalive: owner.wrap(stopMusicPlayerKeepalive),
    startMusicNowPlayingWatch: owner.wrap(startMusicNowPlayingWatch),
    getMusicNowPlaying: owner.wrap(getMusicNowPlaying),
    refreshMusicNowPlaying: owner.wrap(refreshMusicNowPlaying),
    beginMusicCommand: owner.wrap(beginMusicCommand),
    assumeMusicNowPlaying: owner.wrap(assumeMusicNowPlaying),
    nudgeMusicClients: owner.wrap(nudgeMusicClients),
    resetMusicServiceForProviderSwitch: owner.wrap(resetMusicServiceForProviderSwitch),
  }
}

export type MusicServiceScope = ReturnType<typeof createMusicServiceScope>
export const setMusicSampleListener: MusicServiceScope['setMusicSampleListener'] = (...args) => getCurrentBackend('music').music.service.setMusicSampleListener(...args)
export const getActiveMusicProvider: MusicServiceScope['getActiveMusicProvider'] = (...args) => getCurrentBackend('music').music.service.getActiveMusicProvider(...args)
export const getMusicService: MusicServiceScope['getMusicService'] = (...args) => getCurrentBackend('music').music.service.getMusicService(...args)
export const stopMusicPlayerKeepalive: MusicServiceScope['stopMusicPlayerKeepalive'] = (...args) => getCurrentBackend('music').music.service.stopMusicPlayerKeepalive(...args)
export const startMusicNowPlayingWatch: MusicServiceScope['startMusicNowPlayingWatch'] = (...args) => getCurrentBackend('music').music.service.startMusicNowPlayingWatch(...args)
export const getMusicNowPlaying: MusicServiceScope['getMusicNowPlaying'] = (...args) => getCurrentBackend('music').music.service.getMusicNowPlaying(...args)
export const refreshMusicNowPlaying: MusicServiceScope['refreshMusicNowPlaying'] = (...args) => getCurrentBackend('music').music.service.refreshMusicNowPlaying(...args)
export const beginMusicCommand: MusicServiceScope['beginMusicCommand'] = (...args) => getCurrentBackend('music').music.service.beginMusicCommand(...args)
export const assumeMusicNowPlaying: MusicServiceScope['assumeMusicNowPlaying'] = (...args) => getCurrentBackend('music').music.service.assumeMusicNowPlaying(...args)
export const nudgeMusicClients: MusicServiceScope['nudgeMusicClients'] = (...args) => getCurrentBackend('music').music.service.nudgeMusicClients(...args)
export const resetMusicServiceForProviderSwitch: MusicServiceScope['resetMusicServiceForProviderSwitch'] = (...args) => getCurrentBackend('music').music.service.resetMusicServiceForProviderSwitch(...args)
export function disposeMusicService(): Promise<void> { return getCurrentBackend('music').music.service.drain() }
