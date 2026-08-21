/**
 * 角色后缀 `.wiring`(I2,P3'e-A2b):`CoreIPCEmitter` 的**跨进程词汇实例化** ——
 * core 出泛型(`packages/core/engine/ipc-emitter.ts`),这里把七个类型参数钉成
 * `@shared/ipc` / `@shared/events` 的具体形状。它是一处而不是四处,所以不删门面:
 * 删了就得让每个消费者各写一遍七参数应用,那才是真的复制。
 */
import type { Step, ToolCall, ToolPartialResult, ToolResult, ContentPart } from '@shared/ipc.js'
import type { StreamCompleteData, StreamErrorData } from '@shared/events/session-events.js'
import type { CoreIPCEmitter } from '@onething/core/engine'

export type IPCEmitter = CoreIPCEmitter<
  Step,
  ToolCall,
  ToolPartialResult,
  ToolResult,
  ContentPart,
  StreamCompleteData,
  StreamErrorData
>
