import { runAgentLoop } from './agent-loop-runner.js'
import { agentEventsToProviderStreamChunks, type AgentProviderStreamChunk } from './agent-loop-provider-stream.js'
import { AgentEventQueue } from './agent-loop-stream.js'
import type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentStreamEvent,
} from './agent-loop-types.js'

export async function* streamAgentLoopProviderChunks(
  options: AgentLoopOptions,
): AsyncGenerator<AgentProviderStreamChunk, AgentLoopResult, void> {
  const queue = new AgentEventQueue<AgentStreamEvent>()
  const onEvent = options.onEvent
  let result: AgentLoopResult | undefined

  const run = (async () => {
    try {
      const agentLoopOptions: AgentLoopOptions = {
        ...options,
        onEvent(event) {
          onEvent?.(event)
          queue.push(event)
        },
      };
      result = await runAgentLoop(agentLoopOptions)
      queue.close()
    } catch (error) {
      queue.fail(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  for await (const chunk of agentEventsToProviderStreamChunks(queue)) {
    yield chunk
  }

  await run
  if (!result) {
    throw new Error('Agent loop completed without a result')
  }
  return result
}
