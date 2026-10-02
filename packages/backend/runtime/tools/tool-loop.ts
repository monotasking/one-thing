import type { ToolCall, ToolExecutionContext, ToolResult } from './types.js'
import type { ToolExecutor } from './executor.js'

export async function executeToolCalls(
  calls: ToolCall[],
  executor: ToolExecutor,
  context: Omit<ToolExecutionContext, 'toolCallId'>
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const call of calls) {
    results.push(await executor.execute(call, {
      ...context,
      toolCallId: call.id,
    }))
  }
  return results
}
