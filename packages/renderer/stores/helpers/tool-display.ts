import type { ToolCall } from '@/types'
import { shortenPath } from './tool-preview'
import { getFileToolCategory } from './tool-ui-registry'

/**
 * Verb sets survive ONLY for permission-dialog titles, where natural
 * language reads better ("Run npm install?"). The activity rows use
 * `getToolDisplayLabel` from tool-ui-registry — tool name, no verbs.
 */
interface ToolVerbSet {
  wait: string
  run: string
  done: string
}

const DEFAULT_VERBS: ToolVerbSet = { wait: 'Call', run: 'Calling', done: 'Called' }

const VARIABLE_VERBS: Record<string, ToolVerbSet> = {
  list: { wait: 'List', run: 'Listing', done: 'Listed' },
  set: { wait: 'Set', run: 'Setting', done: 'Set' },
  append: { wait: 'Add', run: 'Adding', done: 'Added' },
  remove: { wait: 'Remove', run: 'Removing', done: 'Removed' },
  delete: { wait: 'Delete', run: 'Deleting', done: 'Deleted' },
}

const TODO_PLAN_VERBS: Record<string, ToolVerbSet> = {
  list: { wait: 'List', run: 'Listing', done: 'Listed' },
  create: { wait: 'Create', run: 'Creating', done: 'Created' },
  update: { wait: 'Update', run: 'Updating', done: 'Updated' },
  rename: { wait: 'Rename', run: 'Renaming', done: 'Renamed' },
  delete: { wait: 'Delete', run: 'Deleting', done: 'Deleted' },
}

const TIME_VERBS: Record<string, ToolVerbSet> = {
  now: { wait: 'Get time', run: 'Getting time', done: 'Got time' },
  convert: { wait: 'Convert', run: 'Converting', done: 'Converted' },
  diff: { wait: 'Compare', run: 'Comparing', done: 'Compared' },
  add: { wait: 'Calculate', run: 'Calculating', done: 'Calculated' },
}

const PROJECT_DIRS_VERBS: Record<string, ToolVerbSet> = {
  list: { wait: 'List', run: 'Listing', done: 'Listed' },
  get: { wait: 'Inspect', run: 'Inspecting', done: 'Inspected' },
  add: { wait: 'Add', run: 'Adding', done: 'Added' },
  update: { wait: 'Update', run: 'Updating', done: 'Updated' },
  remove: { wait: 'Remove', run: 'Removing', done: 'Removed' },
}

const MCP_SEARCH_VERBS: Record<string, ToolVerbSet> = {
  list: { wait: 'List', run: 'Listing', done: 'Listed' },
  search: { wait: 'Search', run: 'Searching', done: 'Searched' },
  find: { wait: 'Find', run: 'Finding', done: 'Found' },
  describe: { wait: 'Inspect', run: 'Inspecting', done: 'Inspected' },
  call: { wait: 'Call', run: 'Calling', done: 'Called' },
}

function normalizeToolName(toolName: string | undefined): string {
  return String(toolName || '').trim().toLowerCase()
}

function getArgs(toolCall?: ToolCall): Record<string, unknown> {
  return (toolCall?.arguments || {}) as Record<string, unknown>
}

function actionOf(toolCall?: ToolCall): string {
  return String(getArgs(toolCall).action || '').toLowerCase()
}

function valueOf(toolCall: ToolCall | undefined, key: string): string {
  const value = getArgs(toolCall)[key]
  return value === undefined || value === null ? '' : String(value)
}

function truncate(value: string, max: number): string {
  if (!value || value.length <= max) return value
  return value.slice(0, max - 3) + '...'
}

function quote(value: string, max: number): string {
  const text = truncate(value, max)
  return text ? `"${text}"` : ''
}

function isLegacyMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp:') || toolName.startsWith('mcp_')
}

function isMcpSearchTool(toolName: string): boolean {
  return toolName === 'mcp_search' || toolName === 'tool_function'
}

function isTodoTool(toolName: string): boolean {
  return toolName === 'todo' || toolName === 'todo_plan'
}

export { getFileToolCategory }

/** Hard cap for the primary argument shown in a row title (CSS clamps to 2 lines). */
const PRIMARY_ARG_MAX = 400

export function buildToolPrimaryArg(toolNameInput: string | undefined, toolCall?: ToolCall): string {
  const toolName = normalizeToolName(toolNameInput || toolCall?.toolName || toolCall?.toolId)
  if (toolName === 'bash') {
    const command = valueOf(toolCall, 'command') || valueOf(toolCall, 'CommandLine')
    return truncate(command.replace(/\s*\n\s*/g, ' '), PRIMARY_ARG_MAX)
  }
  if (toolName === 'grep') {
    const pattern = quote(valueOf(toolCall, 'pattern'), 60)
    const scope = valueOf(toolCall, 'glob') || valueOf(toolCall, 'path')
    return [pattern, scope ? shortenPath(scope, 36) : ''].filter(Boolean).join(', ')
  }
  if (toolName === 'glob') return valueOf(toolCall, 'pattern')
  return buildToolActivityTarget(toolName, toolCall)
}

export function buildToolActivityTarget(toolNameInput: string | undefined, toolCall?: ToolCall): string {
  const toolName = normalizeToolName(toolNameInput || toolCall?.toolName || toolCall?.toolId)
  const action = actionOf(toolCall)
  const args = getArgs(toolCall)

  if (toolName === 'variable') return buildVariableTarget(toolCall)
  if (isTodoTool(toolName)) return String(args.title || args.id || args.scope || 'todos')
  if (toolName === 'time') return String(args.timezone || args.fromTimezone || args.toTimezone || action || 'time')
  if (toolName === 'project_dirs') {
    const path = valueOf(toolCall, 'path')
    return path ? shortenPath(path, 42) : 'projects'
  }
  if (isMcpSearchTool(toolName)) {
    if (action === 'list' || action === 'search' || action === 'find') {
      return valueOf(toolCall, 'query') ? quote(valueOf(toolCall, 'query'), 42) : 'MCP tools'
    }
    return valueOf(toolCall, 'tool') || valueOf(toolCall, 'function') || 'MCP tool'
  }
  if (toolName === 'web_search' || toolName === 'websearch' || toolName === 'web-search') {
    return valueOf(toolCall, 'query') ? quote(valueOf(toolCall, 'query'), 60) : 'web'
  }
  if (toolName === 'web_open' || toolName === 'webopen' || toolName === 'web-open') {
    return valueOf(toolCall, 'title') || hostFor(valueOf(toolCall, 'url')) || 'page'
  }
  if (toolName === 'web_find' || toolName === 'webfind' || toolName === 'web-find') {
    const pattern = quote(valueOf(toolCall, 'pattern'), 36)
    const host = hostFor(valueOf(toolCall, 'url'))
    return [pattern, host].filter(Boolean).join(' in ') || 'page'
  }
  if (toolName === 'calculator') return valueOf(toolCall, 'expression') || 'expression'
  if (toolName === 'get_current_time') return valueOf(toolCall, 'timezone') || 'current time'
  if (isLegacyMcpTool(toolName)) return toolCall?.toolName || toolCall?.toolId || 'MCP tool'
  return ''
}

export function buildToolPermissionTitle(toolCall: ToolCall): string {
  const toolName = normalizeToolName(toolCall.toolName || toolCall.toolId)

  if (toolName === 'bash') return `Run ${truncate(valueOf(toolCall, 'command') || 'command', 96)}`
  if (toolName === 'edit') return `Edit ${valueOf(toolCall, 'path') || toolCall.changes?.filePath || 'file'}`
  if (toolName === 'write') return `Write ${valueOf(toolCall, 'path') || 'file'}`
  if (toolName === 'read') return `Read ${valueOf(toolCall, 'path') || 'file'}`
  if (toolName === 'grep') return `Search ${quote(valueOf(toolCall, 'pattern'), 60) || 'files'}`
  if (toolName === 'glob') return `Match ${valueOf(toolCall, 'pattern') || 'files'}`
  if (toolName === 'find') return `Find ${valueOf(toolCall, 'pattern') || 'files'}`
  if (toolName === 'ls') return `List ${valueOf(toolCall, 'path') || 'directory'}`
  if (toolName === 'web_search' || toolName === 'websearch' || toolName === 'web-search') {
    return valueOf(toolCall, 'query') ? `Search web for ${quote(valueOf(toolCall, 'query'), 60)}` : 'Search web'
  }
  if (toolName === 'web_open' || toolName === 'webopen' || toolName === 'web-open') {
    return `Open ${valueOf(toolCall, 'title') || hostFor(valueOf(toolCall, 'url')) || 'web page'}`
  }
  if (toolName === 'web_find' || toolName === 'webfind' || toolName === 'web-find') {
    return `Find ${quote(valueOf(toolCall, 'pattern'), 60) || 'text'} in ${hostFor(valueOf(toolCall, 'url')) || 'web page'}`
  }
  if (toolName === 'variable') return buildVariablePermissionTitle(toolCall)
  if (isTodoTool(toolName)) return buildActionPermissionTitle(toolCall, TODO_PLAN_VERBS, 'todo')
  if (toolName === 'time') return buildActionPermissionTitle(toolCall, TIME_VERBS, 'time')
  if (toolName === 'project_dirs') return buildActionPermissionTitle(toolCall, PROJECT_DIRS_VERBS, 'project')
  if (isMcpSearchTool(toolName)) return buildMcpSearchPermissionTitle(toolCall)
  if (toolName === 'calculator') return `Calculate ${valueOf(toolCall, 'expression') || 'expression'}`
  if (toolName === 'get_current_time') return 'Get current time'
  if (isLegacyMcpTool(toolName)) return `Call ${toolCall.toolName || toolCall.toolId || 'MCP tool'}`

  return `Call ${toolCall.toolName || toolCall.toolId || 'tool'}`
}

function buildActionPermissionTitle(
  toolCall: ToolCall,
  verbs: Record<string, ToolVerbSet>,
  noun: string,
): string {
  const action = actionOf(toolCall)
  const verb = verbs[action]?.wait || DEFAULT_VERBS.wait
  const target = buildToolActivityTarget(toolCall.toolName || toolCall.toolId, toolCall)
  return `${verb} ${target && target !== action ? target : noun}`
}

function buildMcpSearchPermissionTitle(toolCall: ToolCall): string {
  const action = actionOf(toolCall)
  const target = valueOf(toolCall, 'tool') || valueOf(toolCall, 'function')
  if (action === 'describe') return `Inspect MCP tool ${target || ''}`.trim()
  if (action === 'call') return `Call ${target || 'MCP tool'}`
  return valueOf(toolCall, 'query')
    ? `Search MCP tools for ${quote(valueOf(toolCall, 'query'), 60)}`
    : 'Search MCP tools'
}

function buildVariablePermissionTitle(toolCall: ToolCall): string {
  const action = actionOf(toolCall)
  const name = valueOf(toolCall, 'name') || 'variable'
  const target = buildVariableTarget(toolCall)
  const verb = VARIABLE_VERBS[action]?.wait || 'Change'
  return `${verb} ${target || name}`
}

function buildVariableTarget(toolCall: ToolCall | undefined): string {
  const action = actionOf(toolCall)
  const name = valueOf(toolCall, 'name')
  if (action === 'list') return 'variables'
  if (action === 'append' && name === 'workdir') return 'workdir root'
  if (action === 'remove' && name === 'workdir') return 'workdir root'
  return name || 'variable'
}

function hostFor(value: string): string {
  if (!value) return ''
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return truncate(value, 42)
  }
}
