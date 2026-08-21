import type { CoreCompactFileOperations, CoreCompactMessage } from '@onething/core/engine'

/**
 * C5-1(2026-08-14):确定性文件清单。
 *
 * 摘要里的文件路径从前靠模型「回忆」—— 而这份事实在 toolCalls 的参数里躺着,
 * 是可以直接读出来的。这里就是那张**工具名 → 路径参数**的分类表。
 *
 * 它必须留在 app 层:core 不识产品工具名(架构边界测试锁死)。core 那边只有
 * `formatCompactFileOperations` 一类通用字符串格式化。
 *
 * 工具 id 以 `app/tools/builtin/index.ts` 实际注册的为准(实测会话里
 * `toolCall.toolId === toolCall.toolName === 'read' | 'write' | 'edit' | …`)。
 */

/** 读过的文件。 */
const READ_TOOL_IDS = new Set(['read'])

/** 改过的文件。 */
const MODIFIED_TOOL_IDS = new Set(['write', 'edit'])

/**
 * 明确跳过的工具。`bash` 在这里是**刻意**的:它的路径藏在 shell 命令文本里,
 * 解析命令内容既不可靠(管道、变量、引号、别名)又会把一张分类表变成一个
 * 迷你 shell parser。清单宁可少一条,不能编一条。
 */
const SKIPPED_TOOL_IDS = new Set(['bash'])

/**
 * 路径参数的字段名。`path` 是现行工具的参数名;`file_path` / `filePath` 是历史
 * 会话里真实出现过的旧名(压缩读的是历史,历史里就有它们)。
 */
const PATH_FIELDS = ['path', 'file_path', 'filePath'] as const

function readPathArgument(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  for (const field of PATH_FIELDS) {
    const value = args[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * 从待压缩的消息里确定性地提取两张清单。同一条路径只出现一次(保序);一条既被
 * 读又被改的路径两张清单都上 —— 它确实两件事都发生了。
 */
export function collectCompactFileOperations(
  messages: Array<Pick<CoreCompactMessage, 'toolCalls'>>,
): CoreCompactFileOperations {
  const read: string[] = []
  const modified: string[] = []
  const seenRead = new Set<string>()
  const seenModified = new Set<string>()

  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      const toolId = toolCall.toolId || toolCall.toolName
      if (!toolId || SKIPPED_TOOL_IDS.has(toolId)) continue

      const isRead = READ_TOOL_IDS.has(toolId)
      const isModified = MODIFIED_TOOL_IDS.has(toolId)
      if (!isRead && !isModified) continue

      const path = readPathArgument(toolCall.arguments as Record<string, unknown> | undefined)
      if (!path) continue

      if (isRead && !seenRead.has(path)) {
        seenRead.add(path)
        read.push(path)
      }
      if (isModified && !seenModified.has(path)) {
        seenModified.add(path)
        modified.push(path)
      }
    }
  }

  return { read, modified }
}
