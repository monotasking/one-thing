/**
 * voice(语音)域的渲染侧客户端 —— 结构债 P4c 第十一批。
 *
 * 十一条数据面走通用 `rpc:invoke` / `POST /api/rpc`。**两条推送不在这里** ——
 * `onVoiceEvent` / `onVoiceRuntimeCommand` 仍是 `platformApi` 上的订阅
 * (桌面 `ipcRenderer.on`、web `/api/voice/events` 与 `/api/voice/runtime-commands`
 * 两条 SSE),router 今天没有推送面。
 *
 * 这里保留旧的调用形状,调用点(`stores/voice.ts` / `VoiceSettingsTab.vue` /
 * `VoiceRuntimeWindow.vue` 一共 ~50 处)只换名字不换参数:
 *  - 无参的两条(`getState` / `runtimeReady`)按本仓惯例递 `{}`;
 *  - `start` / `stop` 从前是 `request?`,壳上补 `|| {}`,这里补 `?? {}`,形状不变;
 *  - `getTTSModels` 同上;
 *  - **`audioChunk` 不走 router**:它是运行时窗往主进程灌的高频 PCM 上行,
 *    从来就是 `ipcRenderer.send` 的单向通道、不带回执。router 只有请求/响应面,
 *    搬过去等于给每块音频加一条空回执 —— 那是性能面的变化。按拍板 #10 它归
 *    **流式单向残留集**,这里原样转调 `platformApi.voiceAudioChunk`
 *    (桌面 = `ipcRenderer.send`;web = 空实现,server 本就没有那条路由)。
 *
 * server 上没有语音运行时,十一条在 http 上一律拿到与迁移前逐字相同的那批答案
 * (闸在**域处理者**的 `transport === 'http'` 分支上,不在这里 —— 桌面自己也挂着
 * 同一份 HTTP 面,闸必须落在知道 transport 的那一层)。
 */
import type {
  VoiceAudioChunkPayload,
  VoiceRuntimeEvent,
  VoiceStartRequest,
  VoiceStopRequest,
  VoiceSubmitTranscriptRequest,
  VoiceSubmitUtteranceRequest,
  VoiceSynthesizeRequest,
  VoiceTestASRRequest,
  VoiceTestTTSRequest,
} from '@shared/ipc/voice.js'
import { voiceRouter } from '@shared/ipc/voice.js'
import { platformApi } from './index'
import { clientApi } from './client'

const voice = clientApi(voiceRouter)

export const voiceApi = {
  getState: () => voice.getState({}),
  start: (request?: VoiceStartRequest) => voice.start(request ?? {}),
  stop: (request?: VoiceStopRequest) => voice.stop(request ?? {}),
  submitUtterance: (request: VoiceSubmitUtteranceRequest) => voice.submitUtterance(request),
  submitTranscript: (request: VoiceSubmitTranscriptRequest) => voice.submitTranscript(request),
  synthesize: (request: VoiceSynthesizeRequest) => voice.synthesize(request),
  testASR: (request: VoiceTestASRRequest) => voice.testASR(request),
  testTTS: (request: VoiceTestTTSRequest) => voice.testTTS(request),
  getTTSModels: (request?: { force?: boolean }) => voice.getTTSModels(request ?? {}),
  runtimeReady: () => voice.runtimeReady({}),
  runtimeEvent: (event: VoiceRuntimeEvent) => voice.runtimeEvent(event),
  /** 单向上行,不过 router —— 见文件头。 */
  audioChunk: (payload: VoiceAudioChunkPayload): void => {
    platformApi.voiceAudioChunk(payload)
  },
}
