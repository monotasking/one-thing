/**
 * voice(语音)域 —— 结构债 P4c 第十一批,十一条数据面整只从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/voice/ipc.ts` 那只裸 `ipcMain.handle` 工厂(这一域没有
 *    `apps/electron/src/ipc/*` 那层可移植工厂)与 `@main/ipc/voice.ts` 的壳适配;
 *  - `preload/bridge.ts` 的十一条包装与 `platform/web.ts` 的十一条 REST 镜像;
 *  - `server/http.ts` 的十一条 REST 路由,以及 `server/runtime.ts` 的 `voice`
 *    adapter 上那十一个「server 上没有语音」的桩。
 *
 * ## 两条推送不在这里,而且一行都没改
 *
 * `VOICE_EVENT` 与 `VOICE_RUNTIME_COMMAND` 早就是端口形状 ——
 * `configureVoiceHost` 的 `broadcastMessage` / `runtimeWindow.sendCommand`
 * (`runtime/src/voice/host-ports.wiring.ts`),事件源是装配层那台 VoiceService。
 * 所以本批不需要像 oauth / evals 那样新立广播端口;server 那侧的
 * `/api/voice/events` 与 `/api/voice/runtime-commands` 两条 SSE 也原样保留。
 *
 * ## `runtimeReady` 的发起窗改由宿主回答
 *
 * 它从前从 `event.sender` 取发起窗,用来抑制 `runtime-ready` 事件的回声。信封里
 * 没有那一格,于是改问 `runtimeWindow.getWebContents()` —— 语音运行时窗是唯一会
 * 调这条的窗口,抑制口径逐字不变。
 *
 * ## `VOICE_AUDIO_CHUNK` 不在这个域里
 *
 * 高频 PCM 上行从来就是 `ipcRenderer.send` 的单向通道,不带回执;router 只有
 * 请求/响应面,搬过去等于给每块音频加一条空回执 —— 那是性能面的变化。它按拍板
 * #10 归**流式单向残留集**,常量 / preload 的 `send` 包装 / 主进程那条
 * `ipcMain.on` 原样留在 `apps/electron/src/main/ipc/voice.ts` 的终态小文件里。
 * web 侧同样保持旧行为:server 从来没有 `/api/voice/audio-chunk` 这条路由,
 * 旧 `platform/web.ts` 发出去再 `.catch()` 吞掉 —— 现在干脆不发。
 *
 * ## http 分叉:逐字保留「server 上没有语音运行时」
 *
 * 语音要的是**宿主机器上**的麦克风与那扇隐藏的运行时窗;浏览器点一下只会让服务器
 * 那台机器录音。所以 `transport === 'http'` 这一支逐字沿用旧 server adapter 的
 * 十一个答案(同一句 `SERVER_VOICE_UNAVAILABLE_ERROR`、同一份「停用」状态、
 * 同一份空模型表、`stop` 恒 `{success:true}`)。桌面这一支与迁移前逐字同义。
 *
 * 注意这不是「能力位」那一类闸(music / interaction / evals 的闸在渲染侧客户端),
 * 这是**服务端**的分叉 —— 因为桌面自己也挂着同一份 HTTP 面(A 期的内嵌 server),
 * 闸必须落在知道 transport 的那一层。
 */
import {
  acknowledgeOnethingVoiceRuntimeReadyForIpc,
  getOnethingVoiceStateForIpc,
  handleOnethingVoiceRuntimeEventForIpc,
  listOnethingVoiceTTSModelsForIpc,
  testOnethingVoiceASRForIpc,
  testOnethingVoiceTTSForIpc,
} from '@onething/runtime/voice'
import { getVoiceHostPorts } from '@onething/runtime/voice/host-ports.wiring'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { VoiceRuntimeState } from '@shared/ipc/voice.js'
import type { VoiceRoutes } from '@shared/ipc/voice.js'
import { getSettings } from '../../stores/settings.js'
import { getOpenRouterTTSModels, transcribeUtterance } from '../../wiring/voice/providers.js'
import { getVoiceService } from '../../wiring/voice/service.js'
import type { RpcRouteHandlers } from '../registry.js'

/** 逐字沿用被删掉的 server `voice` adapter 的那句话。 */
const SERVER_VOICE_UNAVAILABLE_ERROR =
  'Voice runtime is not available in the web server runtime.'

/** 逐字沿用被删掉的 `createServerVoiceState`。 */
function createServerVoiceState(lastError?: string): VoiceRuntimeState {
  return {
    status: lastError ? 'error' : 'disabled',
    enabled: false,
    runtimeReady: false,
    lastError,
    updatedAt: Date.now(),
  }
}

/** 语音只在宿主机器上成立 —— 网络那一侧永远拿旧 server 那批答案。 */
function isRemoteCaller(context: RpcDispatchContext): boolean {
  return context.transport === 'http'
}

type VoiceRuntimeSender = Parameters<ReturnType<typeof getVoiceService>['handleRuntimeReady']>[0]

export const voiceRpcHandlers: RpcRouteHandlers<VoiceRoutes> = {
  async getState(_input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: true, state: createServerVoiceState() }
    return getOnethingVoiceStateForIpc({
      getState: () => getVoiceService().getState(),
    })
  },
  async start(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return {
        success: false,
        error: SERVER_VOICE_UNAVAILABLE_ERROR,
        state: createServerVoiceState(SERVER_VOICE_UNAVAILABLE_ERROR),
      }
    }
    return getVoiceService().start(input)
  },
  async stop(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: true }
    return getVoiceService().stop(input)
  },
  async submitUtterance(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return getVoiceService().submitUtterance(input)
  },
  async submitTranscript(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return getVoiceService().submitTranscript(input)
  },
  async synthesize(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return getVoiceService().synthesize(input)
  },
  async testASR(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return testOnethingVoiceASRForIpc({
      request: input,
      getVoiceSettings: () => getSettings().voice!,
      transcribeUtterance,
    })
  },
  async testTTS(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return testOnethingVoiceTTSForIpc({
      request: input,
      synthesize: nextRequest => getVoiceService().synthesize(nextRequest),
    })
  },
  async getTTSModels(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: true, models: [], fetchedAt: Date.now() }
    return listOnethingVoiceTTSModelsForIpc({
      request: input,
      getTTSModels: force => getOpenRouterTTSModels(force),
    })
  },
  async runtimeReady(_input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return acknowledgeOnethingVoiceRuntimeReadyForIpc({
      // 宿主认得那扇窗;未注入 = 不抑制回声(headless 上根本没有运行时窗)。
      sender: (getVoiceHostPorts().runtimeWindow?.getWebContents?.() ?? undefined) as VoiceRuntimeSender,
      handleRuntimeReady: runtimeSender => getVoiceService().handleRuntimeReady(runtimeSender),
    })
  },
  async runtimeEvent(input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return handleOnethingVoiceRuntimeEventForIpc({
      event: input,
      handleRuntimeEvent: event => getVoiceService().handleRuntimeEvent(event),
    })
  },
}

