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
 * ## 闸:这台宿主有没有语音(B1,不再问 transport)
 *
 * 语音要的是**宿主机器上**的麦克风与那扇隐藏的运行时窗;浏览器点一下只会让服务器
 * 那台机器录音。从前这条闸写成 `transport === 'http'` —— 那是**用传输回答外设**:
 * 桌面自己也挂着同一份 HTTP 面(A 期的内嵌 server),于是同一台有麦克风的机器,
 * 从 IPC 问是真的、从自己的 HTTP 面问就成了假态。
 *
 * B1(方案 `docs/design/backend-transport-forks-2026-09.md` §2.2)改成问
 * `hasVoiceHost()` —— 也就是这台宿主的 `OnethingHostPorts.voice` 那一格注没注入。
 * 十一个答案逐字不变(同一句 `SERVER_VOICE_UNAVAILABLE_ERROR`、同一份「停用」状态、
 * 同一份空模型表、`stop` 恒 `{success:true}`);变的只是**谁在回答**:
 * server / daemon / React 壳三家 `voice: null`,答案与从前的 http 支一字不差;
 * Vue 桌面注入了那一格,于是它的内嵌 HTTP 面从此与 IPC 同权。
 *
 * 注意这不是「能力位」那一类闸(music / interaction / evals 的闸在渲染侧客户端),
 * 这是**服务端**的闸 —— 拿到 Bearer 的浏览器不能绕过它。
 */
import {
  acknowledgeOnethingVoiceRuntimeReadyForIpc,
  getOnethingVoiceStateForIpc,
  handleOnethingVoiceRuntimeEventForIpc,
  listOnethingVoiceTTSModelsForIpc,
  testOnethingVoiceASRForIpc,
  testOnethingVoiceTTSForIpc,
} from '@onething/runtime/voice'
import { getVoiceHostPorts, hasVoiceHost } from '@onething/runtime/voice/host-ports.wiring'
import type { VoiceRuntimeState } from '@shared/ipc/voice.js'
import type { VoiceRoutes } from '@shared/ipc/voice.js'
import { getSettings } from '../../stores/settings.js'
import { getOpenRouterTTSModels, transcribeUtterance } from '../../wiring/voice/providers.js'
import { getVoiceService } from '../../wiring/voice/service.js'
import type { RpcRouteHandlers } from '../registry.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { isHistoricalLocalOperator, sessionAccess, SessionAccessError } from '../../session/access.js'
import { getCurrentSessionId } from '../../stores/app-state.js'

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

type VoiceRuntimeSender = Parameters<ReturnType<typeof getVoiceService>['handleRuntimeReady']>[0]

/** One desktop microphone/playback service belongs to the historical local operator. */
function assertVoiceOperator(context: RpcDispatchContext): void {
  if (!isHistoricalLocalOperator(context)) throw new SessionAccessError()
}

/**
 * 操作员闸 + **这次调用要写的那条会话**的写权限。
 *
 * 工单 4 A5 已经把「麦克风当前绑在哪条会话上」判成**设备状态**,并让 `getState` /
 * `stop` 绕开这里。工单 5 §7 把同一条道理落到函数本身:校验的对象只有 `target`
 * —— 这次调用真要写的那一条 —— 而不再连带那条 `current` 绑定。
 *
 * 从前连带 `current` 的后果是同一种病换了四张脸:`synthesize` / `testTTS` /
 * `runtimeReady` / 不指名会话的 `runtimeEvent` 这四口**一个字都不写会话**(合成一段
 * 音、试一次 TTS、认一下运行时窗、收一条设备事件),却会因为麦克风还绑在一条**已删**
 * 的会话上而抛 —— 于是一次删会话就能把语音的半边功能锁死,而"能不能用这台设备"
 * 那个真正的判据(`assertVoiceOperator`)明明已经答过了。
 *
 * 现在:有 `target` 就判那一条,没有就只判操作员。**没有按方法名分叉的分支** ——
 * 谁写会话,谁自然就带得出 target。
 */
function authorizeVoice(context: RpcDispatchContext, requested?: string, fallback: 'current' | 'voice' | 'none' = 'none'): string | undefined {
  assertVoiceOperator(context)
  const target = requested || (fallback === 'current' ? getCurrentSessionId()
    : fallback === 'voice' ? getVoiceService().getState().currentSessionId || getCurrentSessionId() : undefined) || undefined
  if (target) sessionAccess.resolve(context, target, 'write')
  return target
}

export const voiceRpcHandlers: RpcRouteHandlers<VoiceRoutes> = {
  async getState(_input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: true, state: createServerVoiceState() }
    assertVoiceOperator(context)
    return getOnethingVoiceStateForIpc({
      getState: () => getVoiceService().getState(),
    })
  },
  async start(input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) {
      return {
        success: false,
        error: SERVER_VOICE_UNAVAILABLE_ERROR,
        state: createServerVoiceState(SERVER_VOICE_UNAVAILABLE_ERROR),
      }
    }
    const sessionId = authorizeVoice(context, input?.sessionId, 'current')
    return getVoiceService().start({ ...input, ...(sessionId ? { sessionId } : {}) })
  },
  async stop(input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: true }
    assertVoiceOperator(context)
    return getVoiceService().stop(input)
  },
  async submitUtterance(input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    const sessionId = authorizeVoice(context, input?.sessionId, 'voice')
    return getVoiceService().submitUtterance({ ...input, ...(sessionId ? { sessionId } : {}) })
  },
  async submitTranscript(input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    const sessionId = authorizeVoice(context, input?.sessionId, 'voice')
    return getVoiceService().submitTranscript({ ...input, ...(sessionId ? { sessionId } : {}) })
  },
  async synthesize(input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    authorizeVoice(context)
    return getVoiceService().synthesize(input)
  },
  async testASR(input) {
    if (!hasVoiceHost()) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    return testOnethingVoiceASRForIpc({
      request: input,
      getVoiceSettings: () => getSettings().voice!,
      transcribeUtterance,
    })
  },
  async testTTS(input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    authorizeVoice(context)
    return testOnethingVoiceTTSForIpc({
      request: input,
      synthesize: nextRequest => getVoiceService().synthesize(nextRequest),
    })
  },
  async getTTSModels(input) {
    if (!hasVoiceHost()) return { success: true, models: [], fetchedAt: Date.now() }
    return listOnethingVoiceTTSModelsForIpc({
      request: input,
      getTTSModels: force => getOpenRouterTTSModels(force),
    })
  },
  async runtimeReady(_input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    authorizeVoice(context)
    return acknowledgeOnethingVoiceRuntimeReadyForIpc({
      // 宿主认得那扇窗;未注入 = 不抑制回声(headless 上根本没有运行时窗)。
      sender: (getVoiceHostPorts().runtimeWindow?.getWebContents?.() ?? undefined) as VoiceRuntimeSender,
      handleRuntimeReady: runtimeSender => getVoiceService().handleRuntimeReady(runtimeSender),
    })
  },
  async runtimeEvent(input, context = DESKTOP_RPC_CONTEXT) {
    if (!hasVoiceHost()) return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR }
    authorizeVoice(context, 'sessionId' in input ? input.sessionId : input.type === 'latency-milestone' ? input.milestone.sessionId : undefined,
      input.type === 'wake-detected' ? 'current' : 'none')
    return handleOnethingVoiceRuntimeEventForIpc({
      event: input,
      handleRuntimeEvent: event => getVoiceService().handleRuntimeEvent(event),
    })
  },
}
