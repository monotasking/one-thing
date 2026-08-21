import {
  registerElectronVoiceIpcHandlers,
  type ElectronVoiceTTSModelsRequest,
} from '@onething/electron-host/voice/ipc'
import {
  IPC_CHANNELS,
  type VoiceAudioChunkPayload,
  type VoiceRuntimeEvent,
  type VoiceStartRequest,
  type VoiceStopRequest,
  type VoiceSubmitTranscriptRequest,
  type VoiceSubmitUtteranceRequest,
  type VoiceSynthesizeRequest,
  type VoiceTestASRRequest,
  type VoiceTestTTSRequest,
} from '@shared/ipc.js'
import {
  acknowledgeOnethingVoiceRuntimeReadyForIpc,
  getOnethingVoiceStateForIpc,
  handleOnethingVoiceRuntimeEventForIpc,
  listOnethingVoiceTTSModelsForIpc,
  testOnethingVoiceASRForIpc,
  testOnethingVoiceTTSForIpc,
} from '@onething/runtime/voice'
import { getVoiceService } from '@onething/backend/voice/service.js'
import { getSettings } from '@onething/backend/stores/settings.js'
import { getOpenRouterTTSModels, transcribeUtterance } from '@onething/backend/voice/providers.js'

export function registerVoiceHandlers(): void {
  type VoiceRuntimeSender = Parameters<ReturnType<typeof getVoiceService>['handleRuntimeReady']>[0]

  registerElectronVoiceIpcHandlers({
    channels: {
      getState: IPC_CHANNELS.VOICE_GET_STATE,
      start: IPC_CHANNELS.VOICE_START,
      stop: IPC_CHANNELS.VOICE_STOP,
      submitUtterance: IPC_CHANNELS.VOICE_SUBMIT_UTTERANCE,
      submitTranscript: IPC_CHANNELS.VOICE_SUBMIT_TRANSCRIPT,
      synthesize: IPC_CHANNELS.VOICE_SYNTHESIZE,
      testASR: IPC_CHANNELS.VOICE_TEST_ASR,
      testTTS: IPC_CHANNELS.VOICE_TEST_TTS,
      getTTSModels: IPC_CHANNELS.VOICE_GET_TTS_MODELS,
      runtimeReady: IPC_CHANNELS.VOICE_RUNTIME_READY,
      runtimeEvent: IPC_CHANNELS.VOICE_RUNTIME_EVENT,
      audioChunk: IPC_CHANNELS.VOICE_AUDIO_CHUNK,
    },
    getState: async () => {
      return getOnethingVoiceStateForIpc({
        getState: () => getVoiceService().getState(),
      })
    },
    start: async (request: unknown) => {
      return getVoiceService().start(request as VoiceStartRequest)
    },
    stop: async (request: unknown) => {
      return getVoiceService().stop(request as VoiceStopRequest)
    },
    submitUtterance: async (request: unknown) => {
      return getVoiceService().submitUtterance(request as VoiceSubmitUtteranceRequest)
    },
    submitTranscript: async (request: unknown) => {
      return getVoiceService().submitTranscript(request as VoiceSubmitTranscriptRequest)
    },
    synthesize: async (request: unknown) => {
      return getVoiceService().synthesize(request as VoiceSynthesizeRequest)
    },
    testASR: async (request: unknown) => {
      return testOnethingVoiceASRForIpc({
        request: request as VoiceTestASRRequest,
        getVoiceSettings: () => getSettings().voice!,
        transcribeUtterance,
      })
    },
    testTTS: async (request: unknown) => {
      return testOnethingVoiceTTSForIpc({
        request: request as VoiceTestTTSRequest,
        synthesize: nextRequest => getVoiceService().synthesize(nextRequest),
      })
    },
    getTTSModels: async (request?: ElectronVoiceTTSModelsRequest) => {
      return listOnethingVoiceTTSModelsForIpc({
        request,
        getTTSModels: force => getOpenRouterTTSModels(force),
      })
    },
    runtimeReady: async (sender: unknown) => {
      return acknowledgeOnethingVoiceRuntimeReadyForIpc({
        sender: sender as VoiceRuntimeSender,
        handleRuntimeReady: runtimeSender => getVoiceService().handleRuntimeReady(runtimeSender),
      })
    },
    runtimeEvent: async (runtimeEvent: unknown) => {
      return handleOnethingVoiceRuntimeEventForIpc({
        event: runtimeEvent as VoiceRuntimeEvent,
        handleRuntimeEvent: event => getVoiceService().handleRuntimeEvent(event),
      })
    },
    audioChunk: (payload: unknown) => {
      getVoiceService().handleAudioChunk(payload as VoiceAudioChunkPayload)
    },
  })
}
