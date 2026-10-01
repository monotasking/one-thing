import type { JsonObject, JsonValue } from '@shared/json.js'

export interface ToolCall {
  id: string
  name: string
  args: JsonObject
}

export interface ToolExecutionContext {
  sessionId: string
  toolCallId: string
  signal?: AbortSignal
}

export interface ToolResult {
  toolCallId?: string
  toolName?: string
  content: string
  isError?: boolean
  data?: JsonValue
}

export interface ToolDefinition<TArgs extends JsonObject = JsonObject> {
  name: string
  description?: string
  parameters?: JsonObject
  execute(args: TArgs, context: ToolExecutionContext): ToolResult | Promise<ToolResult>
}
