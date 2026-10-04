type MaybePromise<T> = T | Promise<T>

export interface OnethingVoiceTestASRRequest {
  audioBase64?: string
  mimeType?: string
}

export interface OnethingVoiceTestTTSRequest {
  text?: string
}

export interface OnethingVoiceTTSModelsRequest {
  force?: boolean
}

export interface OnethingVoiceTranscriptResult {
  text: string
  transcriptId?: string
}

export interface OnethingVoiceTTSModelsResult<TModel = unknown> {
  models: TModel[]
  fetchedAt?: number
}

export type OnethingVoiceIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export function getOnethingVoiceStateForIpc<TState>(
  options: {
    getState(): TState
  },
): OnethingVoiceIpcResult<{ state: TState }> {
  try {
    return { success: true, state: options.getState() }
  } catch (error) {
    return voiceIpcError(error, 'Failed to get voice state.')
  }
}

export async function testOnethingVoiceASRForIpc<TSettings>(
  options: {
    request: OnethingVoiceTestASRRequest
    getVoiceSettings(): TSettings
    transcribeUtterance(
      utterance: { audioBase64: string; mimeType: string },
      settings: TSettings,
    ): MaybePromise<OnethingVoiceTranscriptResult>
  },
): Promise<OnethingVoiceIpcResult<{ transcript: string; transcriptId?: string }>> {
  try {
    if (!options.request.audioBase64 || !options.request.mimeType) {
      return { success: false, error: 'Attach or record audio before testing ASR.' }
    }
    const transcript = await options.transcribeUtterance({
      audioBase64: options.request.audioBase64,
      mimeType: options.request.mimeType,
    }, options.getVoiceSettings())
    return {
      success: true,
      transcript: transcript.text,
      transcriptId: transcript.transcriptId,
    }
  } catch (error) {
    return voiceIpcError(error, 'ASR test failed.')
  }
}

export async function testOnethingVoiceTTSForIpc<TResponse extends { success: boolean; error?: string }>(
  options: {
    request: OnethingVoiceTestTTSRequest
    synthesize(request: { text: string }): MaybePromise<TResponse>
  },
): Promise<TResponse | { success: false; error: string }> {
  try {
    return await options.synthesize({ text: options.request.text || 'Voice test succeeded.' })
  } catch (error) {
    return voiceIpcError(error, 'TTS test failed.')
  }
}

export async function listOnethingVoiceTTSModelsForIpc<TModel = unknown>(
  options: {
    request?: OnethingVoiceTTSModelsRequest
    getTTSModels(force: boolean): MaybePromise<OnethingVoiceTTSModelsResult<TModel>>
  },
): Promise<OnethingVoiceIpcResult<{ models: TModel[]; fetchedAt?: number }>> {
  try {
    const result = await options.getTTSModels(Boolean(options.request?.force))
    return { success: true, models: result.models, fetchedAt: result.fetchedAt }
  } catch (error) {
    return voiceIpcError(error, 'Failed to load TTS models.')
  }
}

export function acknowledgeOnethingVoiceRuntimeReadyForIpc<TWebContents>(
  options: {
    sender: TWebContents
    handleRuntimeReady(sender: TWebContents): unknown
  },
): OnethingVoiceIpcResult {
  try {
    options.handleRuntimeReady(options.sender)
    return { success: true }
  } catch (error) {
    return voiceIpcError(error, 'Failed to mark voice runtime ready.')
  }
}

export function handleOnethingVoiceRuntimeEventForIpc<TRuntimeEvent>(
  options: {
    event: TRuntimeEvent
    handleRuntimeEvent(event: TRuntimeEvent): unknown
  },
): OnethingVoiceIpcResult {
  try {
    options.handleRuntimeEvent(options.event)
    return { success: true }
  } catch (error) {
    return voiceIpcError(error, 'Failed to handle voice runtime event.')
  }
}

function voiceIpcError(error: unknown, fallback: string): { success: false; error: string } {
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
