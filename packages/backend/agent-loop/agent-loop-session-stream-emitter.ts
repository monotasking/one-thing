/**
 * `CoreIPCEmitter` 钉成会话流的具体形状:同目录 `agent-loop-ipc-emitter.ts` 出泛型,这里把七个类型参数钉成
 * `@shared/ipc` / `@shared/events` 里会话流的那几样(`Step` / `ToolCall` / 流结束与出错的数据)。
 * (这只文件从前叫 `ipc-emitter.wiring.ts`;2026-10-03 去掉后缀时与泛型那一半撞名,按内容改叫现在的名字。)它是一处而不是四处,所以不删门面:
 * 删了就得让每个消费者各写一遍七参数应用,那才是真的复制。
 */
import type { Step, ToolCall, ToolPartialResult, ToolResult, ContentPart } from '@shared/ipc.js'
import type { StreamCompleteData, StreamErrorData } from '@shared/events/session-events.js'
import type {
  CoreAgentLoopContentPartEmitter,
} from './agent-loop-executor-turn-state.js'
import type {
  CoreAgentLoopToolExecutionEmitter,
} from './agent-loop-executor-tool-steps.js'
import type { CoreIPCEmitter } from './agent-loop-ipc-emitter.js'

// S2(I4-缝收口):interface 而不是 type alias —— tsserver 的 Go to Implementation
// 不跟随类型别名,而 core 的两道 agent-loop 发射口(内容片/工具执行)在全仓的唯一
// 生产供体就是这一个实例化。两条 `extends` 是事实陈述,成员一个字节没加。
export interface IPCEmitter
  extends CoreIPCEmitter<
      Step,
      ToolCall,
      ToolPartialResult,
      ToolResult,
      ContentPart,
      StreamCompleteData,
      StreamErrorData
    >,
    CoreAgentLoopContentPartEmitter<ContentPart>,
    CoreAgentLoopToolExecutionEmitter<ToolCall, Partial<Step>, ToolPartialResult, ToolResult> {}
