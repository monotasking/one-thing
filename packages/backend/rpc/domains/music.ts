/**
 * music(音乐电台)域 —— **十二条已经退成资源投影**(音乐收尾,`docs/design/
 * atom-2026-09.md` §4「RPC 域」那一行:「24 个手写域逐个退成投影」;口径照 K2c-1
 * 的 `sessions` 域,判据照 §6「换一个 principal 说不说得通」)。
 *
 * 每一条处理器现在只剩三件事:**拼参数 → `backend.resources.read / do` → 把结局
 * 折回这个域一直在答的那个信封**。规则书、端口、事件、那些只有音乐自己知道的分档
 * (电台开着时 `next` 走节目单而不是播放器队列、`like` 按 onDeck 走服务端、
 * 配置改完之后那台保活播放器该不该活着)全部搬进了
 * `wiring/resource/music-provider.ts` —— 于是界面点音乐条上那个按钮,与模型调
 * `music` 工具,走的是**同一台 `ToolRunner`**:同一份授权、同一条审计、同一个取消
 * 源(§2 不变量 2:「没有第二条路,界面点按钮也走它」)。
 *
 * **对外契约一个字没变**:十四条方法的入参、回执、发不发推送、失败文案逐字照旧。
 * `__tests__/music-domain.test.ts` 那几例是这句话的门(断言一字未改,只换了 mock);
 * `__tests__/music-projection.test.ts` 证的是另一半 —— 域这一路与直调资源面产出
 * 同一个结果、同一条 `tool/audit`,也就是它真的退成了投影而不是双写。
 *
 * ## 两条没退,各自的理由
 *
 * · **`djSpeakDone`** —— 它不是一条做法,是一条**推送的回执**。主进程把 DJ 的串词
 *   合成好、经 `MUSIC_DJ_SPEAK` 推给界面去放,界面放完了拿那次推送的 `id` 回来说
 *   一声「播完了」,于是主进程接着放音乐。它没有地址(那个 `id` 是一次推送的相关
 *   号,不是任何东西的坐标)、不改这台机器上任何一格事实、也不该出现在任何账本上
 *   ——给它投一条做法,等于把「一次 await 的 resolve」说成一件资源上发生的事。
 *
 * · **`getNowPlaying`** —— 两条路对**同一个事实**答的形状今天不同,而统一它是一次
 *   用户可感知的行为裁定,不是这一单能顺手拍的:这条 RPC 的契约是
 *   `MusicNowPlaying | null`(没有播放器在跑 = `null`),而资源面那条 `nowPlaying`
 *   读法**刻意**把 `null` 折成一份「停着」的读数(理由写在自述那一格上:对读它的人
 *   来说「守护进程没起」与「停着」是同一件事)。走投影就会让这条方法从此不再答
 *   `null`,并且多一格 `playing` —— 那是改契约。所以它照旧直接读 watcher 的缓存,
 *   **留账**:要么给 RPC 那一侧一次折叠,要么让读法诚实报「没在跑」,两条都要人拍。
 *
 * ## 三处「一件事两个出口两句话」,以及它们为什么前置在这里
 *
 * `search` / `requestSong` / `programmeAction` / `setProvider` 那四条参数前置判据
 * (`query is required` / `action is required` / `providerId is required`)与
 * `openRadio` 的总开关判据**留在域里**,不是漏搬:
 *
 *   · 资源面对同一件事有**自己的**措辞,而且那句措辞是写给模型的行为指引(「用一句
 *     话概括听众想要的氛围」「用户点名想听的歌,尽量带歌手」);这一侧的
 *     `query is required` 是写给一个调用方看的。同一次拒绝,两个出口两句话,
 *     两句都对(判据一模一样 —— 两条路都在同一个地方说不,谁都到不了端口)。
 *   · 总开关那一条更直白:`radioToolOpen` 自己也判 `settings.music.enabled`,判据
 *     **逐字相同**,只是那句话多四个字(「完成配置并打开总开关」)。域这一句先说,
 *     所以退成投影之后文案一个字没变;两道判据同时在,是双保险不是双口径。
 *
 * ## 四条推送留在原地
 *
 * `MUSIC_EVENT` / `MUSIC_NOW_PLAYING` / `MUSIC_LYRICS` / `MUSIC_DJ_SPEAK` 走
 * `broadcastVoiceHostMessage` 这个注入端口,由 `wiring/music/{service,radio,dj-voice}`
 * 直接发 —— 与本域的请求面不在同一条路上。router 今天没有推送面,所以四条常量与
 * 订阅侧原样保留(同 practice / scratchpad / oauth 判例)。**留账**给壳那一半:资源
 * 面上音乐已经会发 `radioOpened` / `radioClosed` / `nowPlayingChanged` /
 * `providerChanged` 四条事件,它们经 `resource:event` 就能出 SSE;要不要让这四条
 * `MUSIC_*` 推送退成同一条路,是壳有了音乐面板之后的一次拍板。
 *
 * ## 迁后 web 行为:能力位关着 = 零变化
 *
 * 电台驱动的是**宿主机器上**的 ncm-cli / mpv,浏览器点一下只会让服务器那台机器
 * 出声。渲染侧有一颗能力位 `music`(`platform/types.ts`),web 上默认 `false`,
 * `platform/music-client.ts` 在它为 false 时**根本不发请求**。
 */
import type {
  MusicGetProgrammeResponse,
  MusicLyrics,
  MusicNowPlaying,
  MusicProgrammeAction,
  MusicRadioState,
  MusicRoutes,
  MusicRuntimeState,
  MusicSearchResponse,
  MusicListProvidersResponse,
  MusicCommand,
} from '@shared/ipc/music.js'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import type { Outcome } from '@onething/core/toolkit'
import type { ReadOutcome } from '@onething/core/resource'
import {
  MUSIC_PLAYER_PATH,
  MUSIC_PROVIDER_PATH,
  MUSIC_RADIO_PATH,
  MUSIC_RESOURCE_SCHEME,
} from '@onething/runtime/music/resource-spec'
import { assertMusicOperator } from '../../wiring/music/access.js'
import { getSettings } from '../../stores/settings.js'
import { resolveDjSpeakDone } from '../../wiring/music/dj-voice.js'
import { getMusicNowPlaying } from '../../wiring/music/service.js'
import { BackendNotAssembledError, getCurrentBackendInstance } from '../../current.js'
import { principalOf } from '../principal.js'
import {
  foldOutcomeToDetailedEnvelope,
  foldOutcomeToEnvelope,
  foldReadOutcomeToEnvelope,
  unwrapReadOutcome,
} from '../resource-envelope.js'
import type { RpcRouteHandlers } from '../registry.js'

/** 这个进程当前那台资源内核。与 `rpc/domains/sessions.ts` 同一条读法、同一句「还没装配」。 */
function resources() {
  const backend = getCurrentBackendInstance()
  if (!backend) throw new BackendNotAssembledError()
  return backend.resources
}

/**
 * 一次调用的坐标。**不带 `sessionId`**:音乐条上那个按钮与任何一条会话都无关,
 * 拿当前会话顶上去,审计就会读成「那条会话按了暂停」(与 `sessions` 域那一格
 * 逐字同一条理由;无发起坐标由内核的保留坐标接着)。
 */
function callOptions(context: RpcDispatchContext) {
  return {
    principal: principalOf(context),
    ...(context.signal ? { signal: context.signal } : {}),
  }
}

function ref(path: string): string {
  return `${MUSIC_RESOURCE_SCHEME}:${path}`
}

/** 拼参数 → **读那条路** → 结局。读不落审计、不吃预算、`ok` 带的是**值**。 */
function readMusic(
  context: RpcDispatchContext,
  path: string,
  name: string,
  query: Record<string, unknown> = {},
): Promise<ReadOutcome> {
  return resources().read(ref(path), name, query, callOptions(context))
}

/** 拼参数 → 管线 → 结局。与模型调同一只工具走的是同一个 `ToolRunner.run`。 */
function doMusic(
  context: RpcDispatchContext,
  path: string,
  op: string,
  params: Record<string, unknown> = {},
): Promise<Outcome> {
  return resources().do(ref(path), op, params, callOptions(context))
}

/**
 * 这个域对失败的兜底措辞。
 *
 * 判据是「**这一句话原来是谁说的**」:`getState` / `setup` 的空消息兜底原来写在
 * `runOnethingMusicSetupForIpc` 那对投影函数里(`musicIpcError` 的 fallback),
 * 所以退成投影之后由域把它补回去 —— 端口自己的那句话优先,它没话说时才用兜底。
 */
function fallbackTo(fallback: string) {
  return (error: Error): string => error.message || fallback
}

/**
 * `MusicCommand` 词表 → 资源面的那条做法(以及它作用在哪个单例上、数值参数叫什么)。
 *
 * 表按 `MusicCommand` **全表**打:词表里加一条而这里忘了配,是一个编译错而不是一次
 * 运行时的「未知的播放命令」。那句兜底只为**契约外**的调用方留着(它的另一个产地
 * 在 `wiring/music/operations.ts` 的 argv 表守卫上,那一条今天从 RPC 这一路已经够
 * 不着了 —— 留账:两处一句话,等下一次真要改文案时收成一处)。
 */
const COMMAND_OPS: Readonly<Record<MusicCommand, { op: string; path: string; valueKey?: string }>> = {
  pause: { op: 'pause', path: MUSIC_PLAYER_PATH },
  resume: { op: 'resume', path: MUSIC_PLAYER_PATH },
  next: { op: 'next', path: MUSIC_PLAYER_PATH },
  prev: { op: 'prev', path: MUSIC_PLAYER_PATH },
  seek: { op: 'seek', path: MUSIC_PLAYER_PATH, valueKey: 'position' },
  volume: { op: 'volume', path: MUSIC_PLAYER_PATH, valueKey: 'level' },
  like: { op: 'like', path: MUSIC_PLAYER_PATH },
  'radio-resume': { op: 'radioResume', path: MUSIC_RADIO_PATH },
  'radio-stop': { op: 'radioStop', path: MUSIC_RADIO_PATH },
}

export const musicRpcHandlers: RpcRouteHandlers<MusicRoutes> = {
  async getState(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return foldReadOutcomeToEnvelope(await readMusic(context, MUSIC_PROVIDER_PATH, 'state'), {
      project: value => ({ state: value as MusicRuntimeState }),
      describeError: fallbackTo('获取电台状态失败'),
    })
  },

  async setup(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    // 「配置改完之后要不要把那台保活播放器停掉」搬进了 provider 的 `apply`:它是
    // 产品逻辑(起会拉起 TUI、TUI 会对着旁边的人放歌),与谁在问这件事无关。
    return foldOutcomeToDetailedEnvelope(
      await doMusic(context, MUSIC_PROVIDER_PATH, 'setup', { ...request }),
      {
        project: details => ({ state: details?.state as MusicRuntimeState | undefined }),
        describeError: fallbackTo('配置操作失败'),
      },
    )
  },

  async command(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    const command = request?.command
    const route = command && Object.prototype.hasOwnProperty.call(COMMAND_OPS, command)
      ? COMMAND_OPS[command]
      : undefined
    if (!route) return { success: false, error: `未知的播放命令:${String(command)}` }
    return foldOutcomeToDetailedEnvelope(
      await doMusic(context, route.path, route.op, route.valueKey ? { [route.valueKey]: request?.value } : {}),
      {
        // 交回去的读数是端口在命令之后自己重读的那一份,原样上抬 —— 域不重算,
        // 也不为了填满这一格再去问一次缓存(那会答一份比它更旧的读数)。
        project: details => ({ nowPlaying: details?.nowPlaying as MusicNowPlaying | null | undefined }),
      },
    )
  },

  /**
   * 这一条**没有**退成投影,理由在文件头(两条路对同一个事实答的形状不同,统一它
   * 是一次要人拍的行为变化)。
   *
   * 读的仍是 watcher 的缓存而不是一次新的轮询:答一次窗口重载不该花一个子进程。
   * 位置最多旧一个轮询周期,而界面本来就在自己插值。
   */
  async getNowPlaying(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return getMusicNowPlaying()
  },

  async getRadio(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    // 裸值,不是信封 —— 这条方法的契约上没有 `success` 那一格(见
    // `unwrapReadOutcome` 的文件注释)。
    return unwrapReadOutcome<MusicRadioState>(await readMusic(context, MUSIC_RADIO_PATH, 'brief'))
  },

  async getLyrics(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return unwrapReadOutcome<MusicLyrics | null>(await readMusic(context, MUSIC_PLAYER_PATH, 'lyrics'))
  },

  /**
   * 界面报一次 DJ 串词播完了 → 主进程接着放音乐。**不是一条做法**,理由在文件头:
   * 它是一条推送的回执,那个 `id` 是相关号不是坐标。
   */
  async djSpeakDone(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    if (request?.id) resolveDjSpeakDone(request.id)
  },

  async openRadio(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    // 总开关这一句先说,所以文案一个字没变(端口那一侧判的是同一个设置项,只是
    // 那句话多四个字)。判据相同 = 双保险,不是双口径。
    const settings = getSettings()
    if (settings.music?.enabled !== true) {
      return { success: false, error: '音乐电台未启用:请在 设置 → 音乐 打开总开关' }
    }
    // 「新电台」= 换台(旧节目单作废),否则就是开台 —— 这一格从前是端口的一个
    // 布尔参数,在资源面上它是两条做法(它们在权限卡与命令面板上要各说各的话)。
    const op = request?.clearProgramme === true ? 'retune' : 'open'
    return foldOutcomeToEnvelope(
      await doMusic(context, MUSIC_RADIO_PATH, op, { intent: request?.intent?.trim() ?? '' }),
    )
  },

  async search(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    const query = request?.query?.trim()
    if (!query) return { success: false, error: 'query is required' }
    return foldReadOutcomeToEnvelope(
      await readMusic(context, MUSIC_PROVIDER_PATH, 'search', { query }),
      { project: value => ({ records: (value as MusicSearchResponse).records }) },
    )
  },

  async requestSong(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    const query = request?.query?.trim()
    if (!query) return { success: false, error: 'query is required' }
    /*
     * 点歌**失败也是一次 `Outcome.ok`** —— 那是旧 `radio` 的口径,资源面照旧守着
     * 它(模型读到那句坏消息之后会改口去搜别的版本)。这一路的契约要的是
     * `{success:false,error}`,所以折的是回执的结构化那一份(`details.request`),
     * 而不是结局本身:同一次 apply,两个出口,各按自己的词汇说话。
     */
    const outcome = await doMusic(context, MUSIC_RADIO_PATH, 'request', { song: query })
    if (outcome.kind !== 'ok') return foldOutcomeToEnvelope(outcome) as { success: false; error: string }
    const requested = outcome.result.details?.request as
      | { success?: boolean; title?: string; error?: string }
      | undefined
    return requested?.success
      ? { success: true, ...(requested.title !== undefined ? { title: requested.title } : {}) }
      : { success: false, error: requested?.error ?? '点歌失败' }
  },

  async getProgramme(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return foldReadOutcomeToEnvelope(await readMusic(context, MUSIC_RADIO_PATH, 'programme'), {
      project: value => value as Omit<MusicGetProgrammeResponse, 'success' | 'error'>,
    })
  },

  async programmeAction(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    if (!request?.action) return { success: false, error: 'action is required' }
    return foldOutcomeToEnvelope(
      await doMusic(context, MUSIC_RADIO_PATH, 'programmeAction', {
        action: request.action as MusicProgrammeAction,
      }),
    )
  },

  async listProviders(_input, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    return foldReadOutcomeToEnvelope(await readMusic(context, MUSIC_PROVIDER_PATH, 'providers'), {
      project: value => value as Omit<MusicListProvidersResponse, 'success' | 'error'>,
    })
  },

  async setProvider(request, context = DESKTOP_RPC_CONTEXT) {
    assertMusicOperator(context)
    if (!request?.providerId) return { success: false, error: 'providerId is required' }
    return foldOutcomeToEnvelope(
      await doMusic(context, MUSIC_PROVIDER_PATH, 'setProvider', { providerId: request.providerId }),
    )
  },
}
