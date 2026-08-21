import type { Step, ToolCall, ToolPartialResult, ToolResult, ContentPart } from '@shared/ipc.js'
import type { StreamCompleteData, StreamErrorData } from '@shared/events/session-events.js'
import type { CoreIPCEmitter } from '@onething/core/engine'

export type { StreamCompleteData, StreamErrorData } from '@shared/events/session-events.js'

export type IPCEmitter = CoreIPCEmitter<
  Step,
  ToolCall,
  ToolPartialResult,
  ToolResult,
  ContentPart,
  StreamCompleteData,
  StreamErrorData
>
