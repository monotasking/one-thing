/**
 * music(音乐电台)域 —— 结构债 P4c 第九批,十四条数据面整只从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/music/ipc.ts` 的手写 IPC 工厂(六条透传)+
 *    `apps/electron/src/main/ipc/music.ts` 那层壳适配(另外八条是裸
 *    `ipcMain.handle`)—— 两个文件**整只删掉**;
 *  - `preload/bridge.ts` 的十四条包装;
 *  - `platform/web.ts` 的十四条 `MUSIC_UNSUPPORTED` 硬桩。
 *
 * server 侧本来就**一条路由都没有**(web 是硬桩),所以 `server/http.ts` 与
 * `server/runtime.ts` 零改动 —— 域挂上 router 就经 `POST /api/rpc` 自动可达。
 *
 * ## 四条推送留在原地
 *
 * `MUSIC_EVENT` / `MUSIC_NOW_PLAYING` / `MUSIC_LYRICS` / `MUSIC_DJ_SPEAK` 早就走
 * `broadcastVoiceHostMessage` 这个注入端口,由 `wiring/music/{service,radio,dj-voice}`
 * 直接发 —— 与本域的请求面不在同一条路上。router 今天没有推送面,所以四条常量与
 * 渲染侧的四条订阅原样保留(同 practice / scratchpad / oauth 判例)。
 *
 * ## 三件真逻辑搬进 wiring,不留在传输层
 *
 * 迁移前主进程那个文件里唯一不是「转调」的部分(音量读数 / 播放命令的电台特判 /
 * 换 provider 的手续)搬到了 `../../wiring/music/operations.ts`,逐字保留。
 * 本文件因此只剩参数校验与转调 —— 传输层不该有产品逻辑。
 *
 * ## 迁后 web 行为:能力位关着 = 零变化
 *
 * 电台驱动的是**宿主机器上**的 ncm-cli / mpv,浏览器点一下只会让服务器那台机器
 * 出声。所以迁走通道之后渲染侧新立了一颗能力位 `music`(`platform/types.ts`),
 * web 上默认 `false`,`platform/music-client.ts` 在它为 false 时**根本不发请求**,
 * 逐条返回与今天的硬桩逐字相同的答案(`{success:false, error:'音乐电台仅在桌面端
 * 可用'}` / `null` / 空电台简报)。放开 = `platform/web.ts` 里 `music: false` 改成
 * `true` 那一行。
 */
import {
  getOnethingMusicStateForIpc,
  listMusicProviderDescriptors,
  runOnethingMusicSetupForIpc,
  type OnethingMusicSetupRequest,
} from '@onething/runtime/music'
import type { MusicRoutes } from '@shared/ipc/music.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { assertMusicOperator } from '../../wiring/music/access.js'
import { getSettings } from '../../stores/settings.js'
import { resolveDjSpeakDone } from '../../wiring/music/dj-voice.js'
import {
  readRadioBrief,
  runMusicCommand,
  searchMusicSongs,
  setMusicProvider,
} from '../../wiring/music/operations.js'
import {
  applyProgrammeAction,
  getMusicLyrics,
  getProgrammeSnapshot,
  openRadioStation,
  requestSong,
} from '../../wiring/music/radio.js'
import {
  getActiveMusicProvider,
  getMusicNowPlaying,
  getMusicService,
  stopMusicPlayerKeepalive,
} from '../../wiring/music/service.js'
import type { RpcRouteHandlers } from '../registry.js'

export const musicRpcHandlers: RpcRouteHandlers<MusicRoutes> = {
  async getState(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return getOnethingMusicStateForIpc({ getState: () => getMusicService().getState() })
  },

  async setup(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    const result = await runOnethingMusicSetupForIpc({
      request: request as OnethingMusicSetupRequest,
      service: getMusicService(),
    })

    // Only ever stop the keepalive here, never start it. Starting launches the
    // TUI, and the TUI plays 每日推荐 at whoever is nearby — nobody switching a
    // radio button asked to hear music. The first playback command starts it
    // (see the bash tool); switching to orpheus, or breaking the setup, makes
    // the offscreen TUI dead weight.
    if (
      result.success
      && !(result.state.setupStage === 'ready' && result.state.playerBackend === 'mpv')
    ) {
      stopMusicPlayerKeepalive()
    }
    return result
  },

  async command(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return runMusicCommand(request)
  },

  // The watcher's cache, not a fresh poll: answering a window reload must not
  // cost a subprocess. Position is at most one poll interval stale, and the
  // renderer interpolates anyway.
  async getNowPlaying(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return getMusicNowPlaying()
  },

  async getRadio(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return readRadioBrief()
  },

  async getLyrics(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return getMusicLyrics()
  },

  /** Renderer acks a DJ patter finished playing → main resumes the music. */
  async djSpeakDone(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    if (request?.id) resolveDjSpeakDone(request.id)
  },

  async openRadio(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    const settings = getSettings()
    if (settings.music?.enabled !== true) {
      return { success: false, error: '音乐电台未启用:请在 设置 → 音乐 打开总开关' }
    }
    openRadioStation(request?.intent?.trim() ?? '', {
      clearProgramme: request?.clearProgramme === true,
    })
    return { success: true }
  },

  async search(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    const query = request?.query?.trim()
    if (!query) return { success: false, error: 'query is required' }
    return searchMusicSongs(query)
  },

  async requestSong(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    const query = request?.query?.trim()
    return query ? requestSong(query) : { success: false, error: 'query is required' }
  },

  async getProgramme(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return { success: true, ...getProgrammeSnapshot() }
  },

  async programmeAction(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return request?.action
      ? applyProgrammeAction(request.action as Parameters<typeof applyProgrammeAction>[0])
      : { success: false, error: 'action is required' }
  },

  async listProviders(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return {
      success: true,
      providers: listMusicProviderDescriptors(),
      activeId: getActiveMusicProvider().descriptor.id,
    }
  },

  async setProvider(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return request?.providerId
      ? setMusicProvider(request.providerId)
      : { success: false, error: 'providerId is required' }
  },
}
