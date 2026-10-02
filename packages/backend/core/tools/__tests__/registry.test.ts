/**
 * R4b —— `core/tools/registry.ts` 删剩下的那三格。
 *
 * 旧那一大批(`*WithAdapters` 族、`HeadlessToolRegistry`、
 * `filterCore*` / `planCoreToolAutoExecute` / `canCoreToolAutoExecute` /
 * `createCoreToolCall` / provider schema 那几个)随旧工具树删除:它们全部只服务
 * 旧注册表。留下来的是**新树在用**的三个纯投影,外加 `AgentEngine` 自己那台最小
 * 注册表 —— 每一个都在这里各钉一条。
 */
import { describe, expect, it } from 'vitest'
import {
  coreToolContextFromHost,
  coreToolDefinitionFromJsonSchema,
  coreToolValidationFailureMessage,
  extractCoreErrorMessage,
  normalizeCoreToolParameterType,
  ToolRegistry,
} from '../index.js'

describe('core tool projections', () => {
  it('maps JSON schemas into host-facing tool definitions', () => {
    const jsonSchema = {
      properties: {
        path: { type: 'string', description: 'File path' },
        mode: { type: 'mystery', description: 'Mode', enum: ['fast', 1, 'safe'] },
      },
      required: ['path'],
    }

    expect(normalizeCoreToolParameterType('mystery')).toBe('string')
    expect(coreToolDefinitionFromJsonSchema({
      id: 'read',
      name: 'read',
      description: 'Read files',
      jsonSchema,
      enabled: true,
      autoExecute: false,
      permissionGuard: 'safe',
      category: 'builtin',
    })).toMatchObject({
      id: 'read',
      name: 'read',
      parameterSchema: jsonSchema,
      parameters: [
        { name: 'path', type: 'string', description: 'File path', required: true },
        { name: 'mode', type: 'string', description: 'Mode', required: false, enum: ['fast', 'safe'] },
      ],
    })

    expect(extractCoreErrorMessage({ message: 'boom' }, 'fallback')).toBe('boom')
    expect(extractCoreErrorMessage({}, 'fallback')).toBe('fallback')
  })

  it('maps the host execution context, callbacks included', () => {
    const metadataUpdates: unknown[] = []
    const partialUpdates: unknown[] = []
    const runtimeContext = coreToolContextFromHost({
      sessionId: 'session-1',
      messageId: 'message-1',
      toolCallId: 'call-1',
      workingDirectory: '/repo',
      workingDirectoryRoots: ['/repo', '/tmp'],
      abortSignal: { aborted: false },
      approvedAnalysis: { effects: ['read'] },
      onMetadata: update => metadataUpdates.push(update),
      onPartialResult: update => partialUpdates.push(update),
    })

    runtimeContext.metadata({ title: 'Reading', metadata: { path: 'README.md' } })
    runtimeContext.updateResult?.({ content: [{ type: 'text', text: 'partial' }] })

    expect(runtimeContext).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-1',
      toolCallId: 'call-1',
      workingDirectory: '/repo',
      workingDirectoryRoots: ['/repo', '/tmp'],
      abortSignal: { aborted: false },
      approvedAnalysis: { effects: ['read'] },
    })
    expect(metadataUpdates).toEqual([{ title: 'Reading', metadata: { path: 'README.md' } }])
    expect(partialUpdates).toEqual([{ content: [{ type: 'text', text: 'partial' }] }])
  })

  it('formats a validation failure with the tool wording when it has one', () => {
    expect(coreToolValidationFailureMessage(new Error('bad args')))
      .toBe('Invalid arguments: bad args')
    expect(coreToolValidationFailureMessage(
      new Error('bad args'),
      () => 'Invalid read parameters: path is required',
    )).toBe('Invalid read parameters: path is required')
  })
})

describe('AgentEngine 自己那台最小注册表', () => {
  it('registers, lists and unregisters by name', () => {
    const registry = new ToolRegistry()
    const tool = {
      name: 'echo',
      description: 'echo',
      async execute() {
        return { content: 'hi' }
      },
    }
    registry.register(tool)
    expect(registry.get('echo')).toBe(tool)
    expect(registry.list().map(item => item.name)).toEqual(['echo'])
    registry.unregister('echo')
    expect(registry.get('echo')).toBeUndefined()
  })
})
