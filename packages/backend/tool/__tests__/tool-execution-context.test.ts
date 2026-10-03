import { describe, expect, it, vi } from 'vitest'
import {
  executeOnethingToolWithSessionContextForIpc,
  executeOnethingToolWithSessionContext,
  type ExecuteOnethingToolWithSessionContextOptions,
  type OnethingToolExecutionSessionLike,
} from '../tool-execution-context.js'

interface TestArgs {
  path: string
}

interface TestResult {
  text: string
}

type TestOptions = ExecuteOnethingToolWithSessionContextOptions<
  TestArgs,
  TestResult,
  OnethingToolExecutionSessionLike
>

function executeTestTool(options: TestOptions) {
  return executeOnethingToolWithSessionContext<
    TestArgs,
    TestResult,
    OnethingToolExecutionSessionLike
  >(options)
}

describe('executeOnethingToolWithSessionContext', () => {
  it('passes session working directory context into the tool executor', async () => {
    const executeTool = vi.fn(() => ({
      success: true,
      data: { text: 'ok' },
    }))

    await expect(executeTestTool({
      toolId: 'read',
      args: { path: 'README.md' },
      sessionId: 'session-1',
      messageId: 'message-1',
      getSession: () => ({
        workingDirectory: '/repo',
        workingDirectoryRoots: ['/repo', '/tmp/project'],
      }),
      executeTool,
    })).resolves.toEqual({
      success: true,
      result: { text: 'ok' },
      error: undefined,
    })

    expect(executeTool).toHaveBeenCalledWith('read', { path: 'README.md' }, {
      sessionId: 'session-1',
      messageId: 'message-1',
      workingDirectory: '/repo',
      workingDirectoryRoots: ['/repo', '/tmp/project'],
    })
  })

  it('keeps execution available when the session cannot be found', async () => {
    const executeTool = vi.fn(() => ({
      success: false,
      error: 'denied',
    }))

    await expect(executeTestTool({
      toolId: 'bash',
      args: { path: 'README.md' },
      sessionId: 'missing-session',
      messageId: 'message-1',
      getSession: () => undefined,
      executeTool,
    })).resolves.toEqual({
      success: false,
      result: undefined,
      error: 'denied',
    })

    expect(executeTool).toHaveBeenCalledWith('bash', { path: 'README.md' }, {
      sessionId: 'missing-session',
      messageId: 'message-1',
      workingDirectory: undefined,
      workingDirectoryRoots: undefined,
    })
  })

  it('normalizes tool executor failures for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(executeOnethingToolWithSessionContextForIpc({
      toolId: 'read',
      args: { path: 'README.md' },
      sessionId: 'session-1',
      messageId: 'message-1',
      getSession: () => undefined,
      executeTool: () => {
        throw new Error('execute failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'execute failed',
    })

    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
