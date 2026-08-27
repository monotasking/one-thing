import type { JsonObject } from '../json.js'

export type CoreStepType = 'skill-read' | 'tool-call' | 'thinking' | 'file-read' | 'file-write' | 'command'

export interface CoreToolCallForStep {
  id: string
  toolName: string
  arguments: JsonObject
}

export interface CoreStepForToolCall<TToolCall extends CoreToolCallForStep = CoreToolCallForStep> {
  id: string
  type: CoreStepType
  title: string
  status: 'running'
  timestamp: number
  turnIndex?: number
  toolCallId: string
  toolCall: TToolCall
}

export interface CreateToolStepOptions {
  timestamp: number
  skillName?: string | null
  turnIndex?: number
}

export interface CreateToolStepWithFactoryOptions {
  now: () => number
  skillName?: string | null
  turnIndex?: number
}

/**
 * **step 身份的唯一产地**(F4-b1,§16.16)。
 *
 * 一条 step 的身份就是它那次工具调用的身份 —— 全链路(引擎发射器 → store →
 * IPC/渲染层 → 事件 → 投影物化)只认这一条派生规则,谁都不许再造第二个。
 *
 * 从前引擎在 `tool_input_start` 那一刻现生一个 `createCoreId()` 的 uuid,而投影
 * 物化(`materializeStep`)写死 `step-${callId}`:两套 id 指同一件事,而
 * `patchStep` 是**按 id 认**的(`steps.findIndex(step => step.id === stepId)`),
 * 两侧互换即静默 `findIndex === -1`,并且没有任何一道门会红(canonical G1 明文
 * 丢掉 step `id`)。那是 §16.13 记的硬阻塞①。
 *
 * 选 callId 派生而不是"让事件携带引擎 uuid",理由是那个 uuid **没有任何持久存在**:
 * `messages.jsonl` 自 F4-a 起停写,冷加载无条件走投影(`hydrate.ts`),所以 uuid
 * 只活在进程内的那一个 run 窗口里 —— 让它与它早就有的确定性对应物合一,账本一个
 * 字节不变,老账本因此天然不需要降级路径(它们本来就是从投影折出来的)。
 */
export function coreStepIdForToolCall(toolCallId: string): string {
  return `step-${toolCallId}`
}

/**
 * Detect if a bash command is reading a skill file and extract skill name.
 */
export function detectSkillUsage(toolName: string, args: JsonObject): string | null {
  if (toolName !== 'bash') return null

  const command = typeof args.command === 'string' ? args.command : ''
  if (!command) return null

  const skillPathMatch = command.match(/(?:cat|less|head|tail|more)\s+.*(?:^|\/)([^/\s'"]+)\/SKILL\.md/)
  if (skillPathMatch) {
    return skillPathMatch[1]
  }

  return null
}

/**
 * Determine step type from tool name and arguments.
 */
export function getStepType(toolName: string, args: JsonObject): CoreStepType {
  if (toolName === 'bash') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (command.match(/(?:cat|less|head|tail|more)\s+.*SKILL\.md/)) {
      return 'skill-read'
    }
    if (command.match(/^(cat|less|head|tail|more)\s+/)) {
      return 'file-read'
    }
    if (command.match(/^(echo|printf|tee)\s+.*>/) || command.match(/^(mv|cp|mkdir|touch|rm)\s+/)) {
      return 'file-write'
    }
    return 'command'
  }

  return 'tool-call'
}

/**
 * Generate a human-readable step title from tool name and arguments.
 */
export function generateStepTitle(toolName: string, args: JsonObject, skillName?: string | null): string {
  if (skillName) {
    return `Reading ${skillName} skill documentation`
  }

  if (toolName === 'bash') {
    const command = typeof args.command === 'string' ? args.command : ''
    return `Run: ${command}`
  }

  const lowerName = toolName.toLowerCase()
  const isFile = [
    'read', 'view_file', 'read_file', 'view-file', 'read-file',
    'write', 'write_to_file', 'write_file', 'write-file',
    'edit', 'replace_file_content', 'multi_replace_file_content',
  ].includes(lowerName)

  if (isFile) {
    const rawPath = args.path || args.AbsolutePath || args.TargetFile || args.filePath || ''
    if (rawPath) {
      const normalized = String(rawPath).replace(/\\/g, '/').replace(/\/+$/, '')
      const filename = normalized.split('/').filter(Boolean).pop() || normalized
      if (filename) {
        return `Tool: ${toolName}: ${filename}`
      }
    }
  }

  if (toolName.includes(':')) {
    const parts = toolName.split(':')
    const shortName = parts[parts.length - 1]
    return `Tool: ${shortName}`
  }

  return `Tool: ${toolName}`
}

export function createToolExecutionStep<TToolCall extends CoreToolCallForStep>(
  toolCall: TToolCall,
  options: CreateToolStepOptions,
): CoreStepForToolCall<TToolCall> {
  return {
    id: coreStepIdForToolCall(toolCall.id),
    type: getStepType(toolCall.toolName, toolCall.arguments),
    title: generateStepTitle(toolCall.toolName, toolCall.arguments, options.skillName),
    status: 'running',
    timestamp: options.timestamp,
    turnIndex: options.turnIndex,
    toolCallId: toolCall.id,
    toolCall: { ...toolCall },
  }
}

export function createToolExecutionStepWithFactory<TToolCall extends CoreToolCallForStep>(
  toolCall: TToolCall,
  options: CreateToolStepWithFactoryOptions,
): CoreStepForToolCall<TToolCall> {
  return createToolExecutionStep(toolCall, {
    timestamp: options.now(),
    skillName: options.skillName,
    turnIndex: options.turnIndex,
  })
}
