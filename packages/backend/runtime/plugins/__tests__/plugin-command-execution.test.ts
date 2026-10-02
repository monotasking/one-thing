import { describe, expect, it, vi } from 'vitest'
import type { CorePluginCommandContext } from '@onething/backend/core/plugins'
import {
  executeOnethingPluginCommand,
  normalizeOnethingPluginCommandName,
} from '../plugin-command-execution.js'

describe('executeOnethingPluginCommand', () => {
  it('normalizes command names before lookup', () => {
    expect(normalizeOnethingPluginCommandName('demo')).toBe('/demo')
    expect(normalizeOnethingPluginCommandName('/demo')).toBe('/demo')
  })

  it('executes a plugin command with an onething command context', async () => {
    const sessionEvents: unknown[] = []
    const globalEvents: unknown[] = []
    const exec = vi.fn(async () => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }))
    const handler = vi.fn(async (_args, ctx) => {
      ctx.steer('steer me')
      ctx.followUp('next')
      ctx.notify('done', 'warn')
      await ctx.exec('echo', ['hello'])
    })

    await expect(executeOnethingPluginCommand({
      commandName: 'demo',
      args: '--fast',
      sessionId: 's1',
      getCommandHandler: vi.fn(() => ({ name: '/demo', handler })),
      getSession: vi.fn(() => ({ workingDirectory: '/repo' })),
      emitSessionCommand: vi.fn((_sessionId, event) => {
        sessionEvents.push(event)
      }),
      emitGlobalEvent: vi.fn(event => {
        globalEvents.push(event)
      }),
      exec,
    })).resolves.toEqual({
      success: true,
      message: 'done',
    })

    expect(handler).toHaveBeenCalledWith('--fast', expect.objectContaining({
      sessionId: 's1',
      cwd: '/repo',
    }))
    expect(sessionEvents).toEqual([
      {
        type: 'command:inject-steering',
        content: 'steer me',
        source: 'plugin-command:/demo',
      },
      {
        type: 'command:inject-followup',
        content: 'next',
        source: 'plugin-command:/demo',
      },
    ])
    expect(globalEvents).toEqual([{
      type: 'plugin:notification',
      pluginId: 'command',
      message: 'done',
      level: 'warn',
    }])
    expect(exec).toHaveBeenCalledWith('echo', ['hello'], { cwd: '/repo' })
  })

  it('returns an unknown-command result before touching session adapters', async () => {
    const getSession = vi.fn()

    await expect(executeOnethingPluginCommand({
      commandName: 'missing',
      sessionId: 's1',
      getCommandHandler: vi.fn(() => undefined),
      getSession,
      emitSessionCommand: vi.fn(),
      emitGlobalEvent: vi.fn(),
      exec: vi.fn(),
    })).resolves.toEqual({
      success: false,
      error: 'Unknown plugin command: /missing',
    })

    expect(getSession).not.toHaveBeenCalled()
  })

  it('reports async emit failures without failing command execution', async () => {
    const onEmitError = vi.fn()

    await expect(executeOnethingPluginCommand({
      commandName: '/demo',
      sessionId: 's1',
      getCommandHandler: vi.fn(() => ({
        name: '/demo',
        async handler(_args: string, ctx: CorePluginCommandContext) {
          ctx.steer('hello')
        },
      })),
      getSession: vi.fn(() => undefined),
      emitSessionCommand: vi.fn(async () => {
        throw new Error('emit failed')
      }),
      emitGlobalEvent: vi.fn(),
      exec: vi.fn(),
      onEmitError,
    })).resolves.toEqual({
      success: true,
      message: '/demo completed',
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onEmitError).toHaveBeenCalledWith('steer', expect.any(Error))
  })
})
