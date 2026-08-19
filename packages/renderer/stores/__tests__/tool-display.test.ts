import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/types'
import type { JsonObject } from '@shared/json'
import {
  buildToolActivityTarget,
  buildToolPermissionTitle,
  buildToolPrimaryArg,
} from '../helpers/tool-display'
import { getToolDisplayLabel } from '../helpers/tool-ui-registry'

function tc(toolName: string, args: JsonObject = {}): ToolCall {
  return {
    id: `tc-${toolName}`,
    toolId: toolName,
    toolName,
    arguments: args,
    status: 'pending',
    timestamp: 0,
  }
}

describe('tool display mappings', () => {
  it('labels every known tool with its own name, never a generic verb', () => {
    expect(getToolDisplayLabel('bash')).toBe('Bash')
    expect(getToolDisplayLabel('read')).toBe('Read')
    expect(getToolDisplayLabel('edit_file')).toBe('Edit')
    expect(getToolDisplayLabel('write_to_file')).toBe('Write')
    expect(getToolDisplayLabel('grep')).toBe('Grep')
    expect(getToolDisplayLabel('glob')).toBe('Glob')
    expect(getToolDisplayLabel('web_search')).toBe('WebSearch')
    expect(getToolDisplayLabel('web-open')).toBe('WebOpen')
    expect(getToolDisplayLabel('calculator')).toBe('Calculator')
    expect(getToolDisplayLabel('variable')).toBe('Variable')
    expect(getToolDisplayLabel('todo_plan')).toBe('Todo')
    expect(getToolDisplayLabel('time')).toBe('Time')
    expect(getToolDisplayLabel('project_dirs')).toBe('Projects')
    expect(getToolDisplayLabel('mcp_search')).toBe('MCP')
  })

  it('shows raw names for MCP and unknown tools instead of "Called"', () => {
    expect(getToolDisplayLabel('mcp:brave.web_search')).toBe('brave.web_search')
    expect(getToolDisplayLabel('custom_runtime_tool')).toBe('custom_runtime_tool')
    expect(getToolDisplayLabel('')).toBe('Tool')
  })

  it('builds the full bash command as the primary argument', () => {
    const longCommand = 'cd ~/data/work/lenovo-scripts && echo "=== repo files ===" && ls *.lua'
    expect(buildToolPrimaryArg('bash', tc('bash', { command: longCommand }))).toBe(longCommand)
  })

  it('collapses bash newlines and caps extremely long commands', () => {
    expect(buildToolPrimaryArg('bash', tc('bash', { command: 'echo a \n  && echo b' }))).toBe('echo a && echo b')
    const huge = 'x'.repeat(1000)
    const arg = buildToolPrimaryArg('bash', tc('bash', { command: huge }))
    expect(arg.length).toBeLessThanOrEqual(400)
    expect(arg.endsWith('...')).toBe(true)
  })

  it('builds pattern-and-scope arguments for search tools', () => {
    expect(buildToolPrimaryArg('grep', tc('grep', { pattern: 'needle', glob: 'src/**/*.ts' }))).toBe('"needle", src/**/*.ts')
    expect(buildToolPrimaryArg('grep', tc('grep', { pattern: 'needle' }))).toBe('"needle"')
    expect(buildToolPrimaryArg('glob', tc('glob', { pattern: '**/*.vue' }))).toBe('**/*.vue')
  })

  it('keeps activity targets for query-style tools', () => {
    expect(buildToolActivityTarget('web_search', tc('web_search', { query: 'current weather' }))).toBe('"current weather"')
    expect(buildToolActivityTarget('variable', tc('variable', { action: 'set', name: 'workdir', value: '/tmp/x' }))).toBe('workdir')
    expect(buildToolActivityTarget('todo', tc('todo', { action: 'update', title: 'Ship it' }))).toBe('Ship it')
  })

  it('keeps natural-language permission titles', () => {
    expect(buildToolPermissionTitle(tc('bash', { command: 'echo hi' }))).toBe('Run echo hi')
    expect(buildToolPermissionTitle(tc('edit', { path: 'src/app.ts' }))).toBe('Edit src/app.ts')
    expect(buildToolPermissionTitle(tc('mcp_search', { action: 'call', tool: 'brave_web_search' }))).toBe('Call brave_web_search')
    expect(buildToolPermissionTitle(tc('custom_runtime_tool'))).toBe('Call custom_runtime_tool')
  })
})
