import type {
  StreamEngineClockAdapter,
  StreamEngineCompactionAdapter,
  StreamEngineHistoryAdapter,
  StreamEngineIdAdapter,
  StreamEngineMediaAdapter,
  StreamEngineModelRegistryAdapter,
  StreamEnginePermissionAdapter,
  StreamEnginePromptAdapter,
  StreamEngineProviderAdapter,
  StreamEngineSkillsAdapter,
  StreamEngineStreamsAdapter,
  StreamEngineStoreAdapter,
} from '@onething/core/engine'
import {
  createOnethingStreamProviderAdapter,
  type OnethingStreamProviderAdapterOptions,
} from './providers/index.js'
import type {
  CoreAppSettingsWithAI,
  CoreProviderAuthLike,
  CoreProviderConfigLike,
  CoreSessionProviderSelection,
} from './providers/provider-config.js'
import {
  createOnethingStreamEngineRuntime,
} from './stream-runtime.js'

export interface OnethingProductStreamRuntime<
  TSettings extends CoreAppSettingsWithAI<TProviderConfig> = CoreAppSettingsWithAI<any>,
  TMessage = unknown,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
  TProviderConfig extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuthContext extends CoreProviderAuthLike = CoreProviderAuthLike,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult = unknown,
  TCompactResult = unknown,
> {
  store: StreamEngineStoreAdapter<TSettings, TSession, TMessage>
  ids: StreamEngineIdAdapter
  clock: StreamEngineClockAdapter
  permission: StreamEnginePermissionAdapter
  skills: StreamEngineSkillsAdapter<TSkill>
  prompts: StreamEnginePromptAdapter<TSkill, TContentPart>
  media: StreamEngineMediaAdapter<TAttachment>
  provider: StreamEngineProviderAdapter<TSettings, TProviderConfig | undefined, TAuthContext>
  models: StreamEngineModelRegistryAdapter
  history: StreamEngineHistoryAdapter<TSession, TMessage, THistoryMessage>
  streams: StreamEngineStreamsAdapter<THistoryMessage, TStreamResult>
  compaction: StreamEngineCompactionAdapter<unknown, TCompactResult>
}

export interface OnethingProductStreamRuntimeOptions<
  TSettings extends CoreAppSettingsWithAI<TProviderConfig> = CoreAppSettingsWithAI<any>,
  TMessage = unknown,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
  TProviderConfig extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuthContext extends CoreProviderAuthLike = CoreProviderAuthLike,
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
  provider: OnethingStreamProviderAdapterOptions<TProviderConfig, TSettings, TAuthContext, TSession>
  models: StreamEngineModelRegistryAdapter
  history: StreamEngineHistoryAdapter<TSession, TMessage, THistoryMessage>
  streams: {
    executeMessageStream(options: Record<string, unknown>): Promise<void>
    executeAgentLoopStreamGeneration(
      context: unknown,
      historyMessages: THistoryMessage[],
      sessionName?: string,
      options?: unknown
    ): Promise<TStreamResult>
  }
  compaction: StreamEngineCompactionAdapter<unknown, TCompactResult>
}

export interface OnethingProductStreamRuntimeHostAdapters<
  TSettings extends CoreAppSettingsWithAI<TProviderConfig> = CoreAppSettingsWithAI<any>,
  TMessage = unknown,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
  TProviderConfig extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuthContext extends CoreProviderAuthLike = CoreProviderAuthLike,
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
  clearPermissionSession: StreamEnginePermissionAdapter['clearSession']
  getSkillsForSession: StreamEngineSkillsAdapter<TSkill>['getForSession']
  resolvePromptReferences: StreamEnginePromptAdapter<TSkill, TContentPart>['resolveReferences']
  ingestMessageAttachments: StreamEngineMediaAdapter<TAttachment>['ingestMessageAttachments']
  provider: OnethingStreamProviderAdapterOptions<TProviderConfig, TSettings, TAuthContext, TSession>
  models: StreamEngineModelRegistryAdapter
  buildHistoryMessages: StreamEngineHistoryAdapter<TSession, TMessage, THistoryMessage>['buildMessages']
  buildResumeHistoryAfterToolConfirmation: StreamEngineHistoryAdapter<TSession, TMessage, THistoryMessage>['buildResumeAfterToolConfirmation']
  executeMessageStream: StreamEngineStreamsAdapter<THistoryMessage, TStreamResult>['executeMessageStream']
  executeAgentLoopStreamGeneration: StreamEngineStreamsAdapter<THistoryMessage, TStreamResult>['executeAgentLoopStreamGeneration']
  compactSessionContext: StreamEngineCompactionAdapter<unknown, TCompactResult>['compactSessionContext']
  getContextCompactReason: StreamEngineCompactionAdapter<unknown, TCompactResult>['getContextCompactReason']
  shouldSkipAutoCompactForProviderUsageMismatch: StreamEngineCompactionAdapter<unknown, TCompactResult>['shouldSkipAutoCompactForProviderUsageMismatch']
}

export function createOnethingProductStreamRuntime<
  TSettings extends CoreAppSettingsWithAI<TProviderConfig> = CoreAppSettingsWithAI<any>,
  TMessage = unknown,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
  TProviderConfig extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuthContext extends CoreProviderAuthLike = CoreProviderAuthLike,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult = unknown,
  TCompactResult = unknown,
>(
  options: OnethingProductStreamRuntimeOptions<
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
): OnethingProductStreamRuntime<
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
> {
  return createOnethingStreamEngineRuntime<
    TSettings,
    TMessage,
    TSession,
    TProviderConfig | undefined,
    TAuthContext,
    TSkill,
    TContentPart,
    TAttachment,
    THistoryMessage,
    TStreamResult,
    TCompactResult
  >({
    store: options.store,
    ids: options.ids,
    clock: options.clock,
    permission: options.permission,
    skills: options.skills,
    prompts: options.prompts,
    media: options.media,
    provider: createOnethingStreamProviderAdapter<
      TProviderConfig,
      TSettings,
      TAuthContext,
      TSession
    >(options.provider),
    models: options.models,
    history: options.history,
    streams: options.streams,
    compaction: options.compaction,
  }) as unknown as OnethingProductStreamRuntime<
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
  >
}

export function createOnethingProductStreamRuntimeFromHostAdapters<
  TSettings extends CoreAppSettingsWithAI<TProviderConfig> = CoreAppSettingsWithAI<any>,
  TMessage = unknown,
  TSession extends CoreSessionProviderSelection = CoreSessionProviderSelection,
  TProviderConfig extends CoreProviderConfigLike = CoreProviderConfigLike,
  TAuthContext extends CoreProviderAuthLike = CoreProviderAuthLike,
  TSkill = unknown,
  TContentPart = unknown,
  TAttachment = unknown,
  THistoryMessage = unknown,
  TStreamResult = unknown,
  TCompactResult = unknown,
>(
  adapters: OnethingProductStreamRuntimeHostAdapters<
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
): OnethingProductStreamRuntime<
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
> {
  return createOnethingProductStreamRuntime<
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
  >({
    store: adapters.store,
    ids: adapters.ids,
    clock: adapters.clock,
    permission: {
      clearSession: adapters.clearPermissionSession,
    },
    skills: {
      getForSession: adapters.getSkillsForSession,
    },
    prompts: {
      resolveReferences: adapters.resolvePromptReferences,
    },
    media: {
      ingestMessageAttachments: adapters.ingestMessageAttachments,
    },
    provider: adapters.provider,
    models: adapters.models,
    history: {
      buildMessages: adapters.buildHistoryMessages,
      buildResumeAfterToolConfirmation: adapters.buildResumeHistoryAfterToolConfirmation,
    },
    streams: {
      executeMessageStream: adapters.executeMessageStream,
      executeAgentLoopStreamGeneration: adapters.executeAgentLoopStreamGeneration,
    },
    compaction: {
      compactSessionContext: adapters.compactSessionContext,
      getContextCompactReason: adapters.getContextCompactReason,
      shouldSkipAutoCompactForProviderUsageMismatch: adapters.shouldSkipAutoCompactForProviderUsageMismatch,
    },
  })
}
