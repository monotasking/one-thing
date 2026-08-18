import {
  createCoreId,
  type CoreContextCompactResultLike,
  type CoreProviderConfigWithKeyLike,
  type CoreStreamEngineRuntime,
  type CoreStreamMessage,
  type CoreStreamResultLike,
  type CoreStreamSession,
  type CoreStreamSettings,
  type StreamEngineClockAdapter,
  type StreamEngineCompactionAdapter,
  type StreamEngineHistoryAdapter,
  type StreamEngineIdAdapter,
  type StreamEngineMediaAdapter,
  type StreamEngineModelRegistryAdapter,
  type StreamEnginePermissionAdapter,
  type StreamEnginePromptAdapter,
  type StreamEngineProviderAdapter,
  type StreamEngineSkillsAdapter,
  type StreamEngineStreamsAdapter,
  type StreamEngineStoreAdapter,
} from '@onething/core/engine'

export type OnethingStreamRuntime<
  TSettings extends CoreStreamSettings = CoreStreamSettings,
  TMessage extends CoreStreamMessage = CoreStreamMessage,
  TSession extends CoreStreamSession<TMessage> = CoreStreamSession<TMessage>,
  TProviderConfig = unknown,
  TProviderConfigWithKey extends CoreProviderConfigWithKeyLike = CoreProviderConfigWithKeyLike,
  TAuthContext = unknown,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult extends CoreStreamResultLike = CoreStreamResultLike,
  TCompactResult extends CoreContextCompactResultLike = CoreContextCompactResultLike,
> = CoreStreamEngineRuntime<
  TSettings,
  TMessage,
  TSession,
  TProviderConfig,
  TProviderConfigWithKey,
  TAuthContext,
  TSkill,
  TContentPart,
  TAttachment,
  THistoryMessage,
  TStreamResult,
  TCompactResult
>

export interface OnethingStreamRuntimeOptions<
  TSettings = unknown,
  TMessage = unknown,
  TSession = unknown,
  TProviderConfig = unknown,
  TAuthContext = unknown,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult = unknown,
  TCompactResult = unknown,
> {
  store: StreamEngineStoreAdapter<TSettings, TSession, TMessage>
  ids?: StreamEngineIdAdapter
  clock?: StreamEngineClockAdapter
  permission: StreamEnginePermissionAdapter
  skills: StreamEngineSkillsAdapter<TSkill>
  prompts: StreamEnginePromptAdapter<TSkill, TContentPart>
  media: StreamEngineMediaAdapter<TAttachment>
  provider: StreamEngineProviderAdapter<TSettings, TProviderConfig, TAuthContext>
  models: StreamEngineModelRegistryAdapter
  history: StreamEngineHistoryAdapter<TSession, TMessage, THistoryMessage>
  streams: StreamEngineStreamsAdapter<THistoryMessage, TStreamResult>
  compaction: StreamEngineCompactionAdapter<unknown, TCompactResult>
}

export function createOnethingStreamEngineRuntime<
  TSettings = unknown,
  TMessage = unknown,
  TSession = unknown,
  TProviderConfig = unknown,
  TAuthContext = unknown,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult = unknown,
  TCompactResult = unknown,
>(
  options: OnethingStreamRuntimeOptions<
    TSettings,
    TMessage,
    TSession,
    TProviderConfig,
    TAuthContext,
    TSkill,
    TContentPart,
    TAttachment,
    THistoryMessage,
    TStreamResult,
    TCompactResult
  >,
): CoreStreamEngineRuntime {
  return {
    store: options.store as CoreStreamEngineRuntime['store'],
    ids: options.ids ?? {
      createId: createCoreId,
    },
    clock: options.clock ?? {
      now: () => Date.now(),
    },
    permission: options.permission as CoreStreamEngineRuntime['permission'],
    skills: options.skills as CoreStreamEngineRuntime['skills'],
    prompts: options.prompts as CoreStreamEngineRuntime['prompts'],
    media: options.media as CoreStreamEngineRuntime['media'],
    provider: options.provider as CoreStreamEngineRuntime['provider'],
    models: options.models as CoreStreamEngineRuntime['models'],
    history: options.history as CoreStreamEngineRuntime['history'],
    streams: options.streams as CoreStreamEngineRuntime['streams'],
    compaction: options.compaction as CoreStreamEngineRuntime['compaction'],
  }
}
