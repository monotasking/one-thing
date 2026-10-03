import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreProvider, type WorkdirGateway } from '../providers/core.js'
import { GlobalStoreProvider, type GlobalStoreGateway } from '../providers/global-store.js'
import { SessionStoreProvider, type SessionStoreGateway } from '../providers/session-store.js'
import { VariableError, type ContextVariable, type VariableContext } from '../types.js'

const ctx: VariableContext = { sessionId: 'sess-a' }

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-variable-providers-'))
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

function workdirGateway(initial: string = '', roots: string[] = []): WorkdirGateway & {
  writtenRoots: string[][]
} {
  let active = initial
  let extraRoots = roots
  const writtenRoots: string[][] = []
  return {
    writtenRoots,
    read: () => active,
    readRoots: () => extraRoots,
    write: (_sessionId, next) => {
      active = next
    },
    writeRoots: (_sessionId, nextRoots) => {
      extraRoots = nextRoots
      writtenRoots.push(nextRoots)
    },
    expandPath: input => input.startsWith('~') ? input.replace('~', os.homedir()) : input,
  }
}

describe('runtime CoreProvider', () => {
  it('validates workdir roots and delegates permission enforcement through an adapter', async () => {
    const gateway = workdirGateway(tempDir)
    const nextRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-variable-root-'))
    const enforcePermission = vi.fn(async () => undefined)
    const provider = new CoreProvider(gateway, { enforcePermission })

    const result = await provider.append({
      sessionId: 'sess-a',
      messageId: 'message-1',
      toolCallId: 'tool-1',
    }, { name: 'workdir', value: nextRoot })

    expect(result.values).toEqual([tempDir, nextRoot])
    expect(gateway.writtenRoots).toEqual([[nextRoot]])
    expect(enforcePermission).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-a',
      messageId: 'message-1',
      toolCallId: 'tool-1',
      toolName: 'workdir',
      workspaceRoot: tempDir,
      preview: expect.objectContaining({
        title: `Add workdir root: ${nextRoot}`,
      }),
    }))

    await fs.rm(nextRoot, { recursive: true, force: true })
  })

  it('rejects missing workdirs inside the runtime provider', async () => {
    const provider = new CoreProvider(workdirGateway())
    await expect(provider.set(ctx, { name: 'workdir', value: path.join(tempDir, 'missing') }))
      .rejects.toMatchObject({ code: 'WORKDIR_NOT_FOUND' })
  })

  it('set enforces the same external-directory barrier as append', async () => {
    const gateway = workdirGateway(tempDir)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-variable-outside-'))
    const enforcePermission = vi.fn(async () => undefined)
    const provider = new CoreProvider(gateway, { enforcePermission })

    await provider.set({
      sessionId: 'sess-a',
      messageId: 'message-1',
      toolCallId: 'tool-1',
    }, { name: 'workdir', value: outside })

    expect(enforcePermission).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'workdir',
      preview: expect.objectContaining({ title: `Set work directory: ${outside}` }),
    }))

    await fs.rm(outside, { recursive: true, force: true })
  })

  it('set denied by the barrier does not change the workdir', async () => {
    const gateway = workdirGateway(tempDir)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-variable-denied-'))
    const provider = new CoreProvider(gateway, {
      enforcePermission: vi.fn(async () => {
        throw new Error('denied')
      }),
    })

    await expect(provider.set({
      sessionId: 'sess-a',
      messageId: 'message-1',
    }, { name: 'workdir', value: outside })).rejects.toThrow('denied')
    expect(gateway.read('sess-a')).toBe(tempDir)
    expect(gateway.writtenRoots).toEqual([])

    await fs.rm(outside, { recursive: true, force: true })
  })

  it('set skips the barrier for subdirectories of granted roots and preauthorized dirs', async () => {
    const inside = await fs.mkdtemp(path.join(tempDir, 'nested-'))
    const enforcePermission = vi.fn(async () => undefined)
    const provider = new CoreProvider(workdirGateway(tempDir), { enforcePermission })
    await provider.set({ sessionId: 'sess-a', messageId: 'm1' }, { name: 'workdir', value: inside })
    expect(enforcePermission).not.toHaveBeenCalled()

    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-variable-project-'))
    // 批 B4:名册 per-space,判据必须拿到会话语境 —— 宿主靠 ctx.sessionId 把会话
    // 解析成空间。少喂这一个字段,A 空间的名册就会替 B 空间的会话免掉审批。
    const isPreauthorizedDirectory = vi.fn(
      (dir: string, ctx: { sessionId: string }) => dir === project && ctx.sessionId === 'sess-a',
    )
    const preauthorized = new CoreProvider(workdirGateway(tempDir), {
      enforcePermission,
      isPreauthorizedDirectory,
    })
    await preauthorized.set({ sessionId: 'sess-a', messageId: 'm1' }, { name: 'workdir', value: project })
    expect(enforcePermission).not.toHaveBeenCalled()
    expect(isPreauthorizedDirectory).toHaveBeenCalledWith(project, { sessionId: 'sess-a' })

    await fs.rm(project, { recursive: true, force: true })
  })
})

function sessionGateway(initial: Record<string, ContextVariable[]> = {}): SessionStoreGateway & {
  state: Map<string, ContextVariable[]>
} {
  const state = new Map(Object.entries(initial))
  return {
    state,
    read: sessionId => state.get(sessionId) ?? [],
    write: (sessionId, variables) => {
      state.set(sessionId, variables)
    },
  }
}

describe('runtime SessionStoreProvider', () => {
  it('filters reserved legacy entries and enforces per-session limits', async () => {
    const gateway = sessionGateway({
      'sess-a': [
        { name: 'topic', value: 'one' },
        { name: 'workdir', value: '/legacy' },
      ],
    })
    const provider = new SessionStoreProvider(gateway, { maxPerSession: 1 })

    expect(provider.list(ctx)).toEqual([
      expect.objectContaining({ name: 'topic', scope: 'session' }),
    ])
    await expect(provider.set(ctx, { name: 'overflow', value: 'two' }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(provider.delete(ctx, 'workdir')).rejects.toMatchObject({ code: 'RESERVED' })
  })
})

function globalGateway(initial: ContextVariable[] = []): GlobalStoreGateway & {
  state: ContextVariable[]
} {
  return {
    state: initial,
    read() {
      return this.state
    },
    write(variables) {
      this.state = variables
    },
  }
}

describe('runtime GlobalStoreProvider', () => {
  it('stores shared variables and rejects reserved names', async () => {
    const gateway = globalGateway()
    const provider = new GlobalStoreProvider(gateway, 2)

    await provider.set(ctx, { name: 'shared_topic', value: 'alpha' })
    expect(provider.list(ctx)).toEqual([
      expect.objectContaining({ name: 'shared_topic', value: 'alpha', scope: 'global' }),
    ])
    await expect(provider.set(ctx, { name: 'workdir', value: tempDir }))
      .rejects.toBeInstanceOf(VariableError)
  })
})
