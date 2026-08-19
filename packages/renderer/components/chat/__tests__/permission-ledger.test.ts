import { describe, expect, it } from 'vitest'
import {
  buildScopeOptions,
  canAllowWorkspace,
  countQueuedBehind,
  findPendingPermission,
  findRespondableToolCall,
  permissionDetailKey,
  permissionPreview,
  permissionTarget,
  permissionTool,
} from '../permission/permission-ledger'
import type { ToolCall } from '@/types'

/**
 * 权限账页栏位的纯逻辑(§8 铁律 1)。
 *
 * 这一组是"字段没变"的可执行证据:栏位读什么、scope 给几档、哪些工具不许给
 * workspace 档 —— 全部照旧壳(原 `ChatPanel.vue`)逐条钉住。
 */
function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    toolName: 'bash',
    toolId: 'bash',
    status: 'pending',
    arguments: { command: 'bun run test' },
    ...overrides,
  } as ToolCall
}

describe('栏位字段', () => {
  it('tool 是小写工具名', () => {
    expect(permissionTool(toolCall({ toolName: 'Bash' }))).toBe('bash')
  })

  it('target 优先取 path / file_path / command,并把换行压成空格', () => {
    expect(permissionTarget(toolCall({ arguments: { command: 'a\n  b' } }))).toBe('a b')
    expect(permissionTarget(toolCall({ arguments: { path: '/repo/a.ts' } }))).toBe('/repo/a.ts')
  })

  it('有 diff 就报增删,detail 键名跟着换', () => {
    const withChanges = toolCall({ changes: { filePath: '/a.ts', additions: 3, deletions: 1 } as any })
    expect(permissionDetailKey(withChanges)).toBe('diff')
    expect(permissionPreview(withChanges)).toBe('+3 -1')
    // bash 的命令已经占了 target 行,不许再印一次。
    expect(permissionPreview(toolCall())).toBe('')
    expect(permissionDetailKey(toolCall())).toBe('detail')
  })
})

describe('scope 档位', () => {
  it('普通会话:once / session / workspace', () => {
    expect(buildScopeOptions(toolCall()).map(option => option.value)).toEqual(['once', 'session', 'workdir'])
  })

  it('collab 会话(room/work)只给 once', () => {
    expect(buildScopeOptions(toolCall(), { collabScopeOnly: true }).map(o => o.value)).toEqual(['once'])
  })

  it('敏感读 / 能力改指向不给 workspace 档', () => {
    expect(canAllowWorkspace(toolCall({ permissionType: 'sensitive_file_read' } as any))).toBe(false)
    expect(canAllowWorkspace(toolCall({ permissionType: 'capability_change' } as any))).toBe(false)
    expect(canAllowWorkspace(toolCall({
      toolName: 'read',
      toolId: 'read',
      arguments: { path: '/repo/.env' },
    }))).toBe(false)
    expect(canAllowWorkspace(toolCall())).toBe(true)
  })
})

describe('待审批的挑选与排队计数', () => {
  const pending = toolCall({ id: 'p1', requiresConfirmation: true, canRespond: true })

  it('requiresConfirmation 与 canRespond 必须同时为真', () => {
    expect(findPendingPermission([{ toolCalls: [toolCall({ requiresConfirmation: true })] }])).toBeNull()
    expect(findPendingPermission([{ toolCalls: [toolCall({ canRespond: true })] }])).toBeNull()
    expect(findPendingPermission([{ toolCalls: [pending] }])?.id).toBe('p1')
  })

  // MessageList 的审批卡与这里共用同一个谓词 —— 它是单条消息级的那一半。
  it('单条消息级谓词与整段挑选同口径', () => {
    expect(findRespondableToolCall({ toolCalls: [toolCall({ requiresConfirmation: true })] })).toBeNull()
    expect(findRespondableToolCall({ toolCalls: [toolCall({ canRespond: true })] })).toBeNull()
    expect(findRespondableToolCall({})).toBeNull()
    expect(findRespondableToolCall({ toolCalls: [toolCall(), pending] })?.id).toBe('p1')
  })

  it('只数排在它后面的 queued 调用', () => {
    const messages = [{
      toolCalls: [
        toolCall({ id: 'before', status: 'queued' }),
        pending,
        toolCall({ id: 'after-1', status: 'queued' }),
        toolCall({ id: 'after-2', status: 'completed' }),
        toolCall({ id: 'after-3', status: 'queued' }),
      ],
    }]
    expect(countQueuedBehind(messages, pending)).toBe(2)
    expect(countQueuedBehind(messages, null)).toBe(0)
  })
})
