/**
 * music(音乐电台)域的渲染侧客户端 —— 结构债 P4c 第九批。
 *
 * 形状照 `themes-client.ts` / `gateway-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动。**四条推送不在这里** —— `MUSIC_EVENT` /
 * `MUSIC_NOW_PLAYING` / `MUSIC_LYRICS` / `MUSIC_DJ_SPEAK` 仍是 `platformApi` 上的
 * 四条订阅(router 没有推送面)。
 *
 * ## 能力位 `music`(#13,默认关)
 *
 * 电台驱动的是**宿主机器上**的 ncm-cli / mpv,浏览器点一下只会让服务器那台机器
 * 出声 —— 迁到通用通道之后这条路技术上通了,按「续做口径」必须由一颗能力位挡着。
 * `platformApi.capabilities.music` 在 electron 上为 `true`、web 上为 `false`;
 * 为 false 时下面十四条**根本不发请求**,而是就地返回与迁移前 `platform/web.ts`
 * 那十四条硬桩**逐字相同**的答案(`{success:false, error:'音乐电台仅在桌面端可用'}`
 * / `null` / 空电台简报 / `undefined`)。`stores/music.ts` 因此一行判断都不用加,
 * 可感知结果与今天逐字一致。
 *
 * **放开 = 一行**:`platform/web.ts` 的 `music: false` 改成 `true`
 * (或让它跟着 `/api/capabilities` 走)。
 */
import { musicRouter } from '@shared/ipc/music.js'
import type {
  MusicBaseResponse,
  MusicCommandRequest,
  MusicCommandResponse,
  MusicGetProgrammeResponse,
  MusicGetStateResponse,
  MusicListProvidersResponse,
  MusicLyrics,
  MusicNowPlaying,
  MusicOpenRadioRequest,
  MusicProgrammeActionRequest,
  MusicRadioState,
  MusicRequestSongRequest,
  MusicRequestSongResponse,
  MusicSearchRequest,
  MusicSearchResponse,
  MusicSetProviderRequest,
  MusicSetupRequest,
  MusicSetupResponse,
} from '@shared/ipc/music.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

const music = createRouterClient(musicRouter, request => platformApi.rpcInvoke(request))

/** 与迁移前 `platform/web.ts` 那十四条硬桩逐字相同的那句话。 */
const MUSIC_UNSUPPORTED = '音乐电台仅在桌面端可用'

/** 迁移前 `musicGetRadio` 桩返回的那份空简报,逐字相同。 */
const EMPTY_RADIO: MusicRadioState = {
  active: false,
  intent: '',
  programmeLength: 0,
  canResume: false,
}

function enabled(): boolean {
  return platformApi.capabilities.music !== false
}

function unsupported(): MusicBaseResponse {
  return { success: false, error: MUSIC_UNSUPPORTED }
}

export const musicApi = {
  getState: (): Promise<MusicGetStateResponse> =>
    enabled() ? music.getState({}) : Promise.resolve(unsupported()),
  setup: (request: MusicSetupRequest): Promise<MusicSetupResponse> =>
    enabled() ? music.setup(request) : Promise.resolve(unsupported()),
  command: (request: MusicCommandRequest): Promise<MusicCommandResponse> =>
    enabled() ? music.command(request) : Promise.resolve(unsupported()),
  getNowPlaying: (): Promise<MusicNowPlaying | null> =>
    enabled() ? music.getNowPlaying({}) : Promise.resolve(null),
  getRadio: (): Promise<MusicRadioState> =>
    enabled() ? music.getRadio({}) : Promise.resolve({ ...EMPTY_RADIO }),
  getLyrics: (): Promise<MusicLyrics | null> =>
    enabled() ? music.getLyrics({}) : Promise.resolve(null),
  djSpeakDone: (id: string): Promise<void> =>
    enabled() ? music.djSpeakDone({ id }) : Promise.resolve(),
  openRadio: (request: MusicOpenRadioRequest): Promise<MusicBaseResponse> =>
    enabled() ? music.openRadio(request) : Promise.resolve(unsupported()),
  search: (request: MusicSearchRequest): Promise<MusicSearchResponse> =>
    enabled() ? music.search(request) : Promise.resolve(unsupported()),
  requestSong: (request: MusicRequestSongRequest): Promise<MusicRequestSongResponse> =>
    enabled() ? music.requestSong(request) : Promise.resolve(unsupported()),
  getProgramme: (): Promise<MusicGetProgrammeResponse> =>
    enabled() ? music.getProgramme({}) : Promise.resolve(unsupported()),
  programmeAction: (request: MusicProgrammeActionRequest): Promise<MusicBaseResponse> =>
    enabled() ? music.programmeAction(request) : Promise.resolve(unsupported()),
  listProviders: (): Promise<MusicListProvidersResponse> =>
    enabled() ? music.listProviders({}) : Promise.resolve(unsupported()),
  setProvider: (request: MusicSetProviderRequest): Promise<MusicBaseResponse> =>
    enabled() ? music.setProvider(request) : Promise.resolve(unsupported()),
}
