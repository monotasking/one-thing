import { describe, it, expect } from 'vitest'
import {
  getToolUiCategory,
  getToolDisplayLabel,
  getToolIcon,
  getToolStatusBadgeText,
} from '../helpers/tool-ui-registry'

describe('tool-ui-registry', () => {
  it('maps file tool aliases to categories', () => {
    expect(getToolUiCategory('edit')).toBe('edit')
    expect(getToolUiCategory('replace_file_content')).toBe('edit')
    expect(getToolUiCategory('write_to_file')).toBe('write')
    expect(getToolUiCategory('view_file')).toBe('read')
    expect(getToolUiCategory('web_search')).toBe('search')
    expect(getToolUiCategory('web-open')).toBe('search')
    expect(getToolUiCategory('bash')).toBe('console')
    expect(getToolUiCategory('whatever')).toBe('tool')
  })

  it('labels tools with their display name, aliases included', () => {
    expect(getToolDisplayLabel('edit')).toBe('Edit')
    expect(getToolDisplayLabel('replace_file_content')).toBe('Edit')
    expect(getToolDisplayLabel('bash')).toBe('Bash')
    expect(getToolDisplayLabel('mcp:brave.search')).toBe('brave.search')
    expect(getToolDisplayLabel('whatever_tool')).toBe('whatever_tool')
  })

  it('provides a distinct icon per tool with a category fallback', () => {
    expect(getToolIcon('bash')).toBeTruthy()
    expect(getToolIcon('bash')).not.toBe(getToolIcon('read'))
    expect(getToolIcon('edit')).not.toBe(getToolIcon('write'))
    // MCP tools share the plug icon; unknown tools fall back to the wrench.
    expect(getToolIcon('mcp:brave.search')).toBe(getToolIcon('mcp_search'))
    expect(getToolIcon('totally_unknown')).toBeTruthy()
  })

  // 这些字面量是 StepsPanel 行徽标的现网输出,逐字节钉死(含中文的 '失败')。
  it('badges only the statuses the reader must act on or mourn', () => {
    expect(getToolStatusBadgeText('awaiting-confirmation')).toBe('Needs approval')
    expect(getToolStatusBadgeText('awaiting-confirmation', { permissionQueued: true }))
      .toBe('Waiting for approval')
    expect(getToolStatusBadgeText('cancelled')).toBe('Cancelled')
    expect(getToolStatusBadgeText('rejected')).toBe('Rejected')
    expect(getToolStatusBadgeText('failed')).toBe('失败')
  })

  it('renders no badge for the states the row already shows by icon and duration', () => {
    for (const status of ['queued', 'pending', 'streaming-input', 'received', 'executing', 'completed'] as const) {
      expect(getToolStatusBadgeText(status)).toBe('')
      expect(getToolStatusBadgeText(status, { permissionQueued: true })).toBe('')
    }
  })

})
