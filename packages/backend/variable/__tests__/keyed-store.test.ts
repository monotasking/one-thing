import { beforeEach, describe, expect, it } from 'vitest'
import { KeyedStoreProvider, type KeyedStoreGateway } from '../providers/keyed-store.js'
import { GlobalStoreProvider } from '../providers/global-store.js'
import { SessionStoreProvider } from '../providers/session-store.js'
import { VariableRegistry } from '../registry.js'
import { VariableError, type ContextVariable, type VariableContext } from '../types.js'

const ctx: VariableContext = { sessionId: 'sess-a' }

function keyedGateway(resolveKey: (sessionId: string) => string | null): KeyedStoreGateway {
  const record = new Map<string, ContextVariable[]>()
  return {
    resolveKey,
    read: key => record.get(key) ?? [],
    write: (key, variables) => {
      record.set(key, variables)
    },
  }
}

function agentProvider(resolveKey: (sessionId: string) => string | null = () => 'agent-1') {
  return new KeyedStoreProvider(keyedGateway(resolveKey), {
    id: 'agent-store',
    scope: 'agent',
    priority: 920,
    unresolvedHint: 'no agent',
  })
}

function projectProvider(resolveKey: (sessionId: string) => string | null) {
  return new KeyedStoreProvider(keyedGateway(resolveKey), {
    id: 'project-store',
    scope: 'project',
    priority: 940,
    unresolvedHint: 'no workdir',
  })
}

describe('KeyedStoreProvider', () => {
  it('stamps its scope on stored variables and lists per key', async () => {
    const provider = agentProvider()
    await provider.set(ctx, { name: 'deploy_target', value: 'staging' })

    const listed = provider.list(ctx)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'deploy_target', value: 'staging', scope: 'agent' })
  })

  it('isolates variables between keys', async () => {
    const keys = new Map([['sess-a', 'agent-1'], ['sess-b', 'agent-2']])
    const provider = agentProvider(sessionId => keys.get(sessionId) ?? null)
    await provider.set(ctx, { name: 'foo', value: 'a' })

    expect(provider.list({ sessionId: 'sess-b' })).toHaveLength(0)
    expect(provider.list(ctx)).toHaveLength(1)
  })

  it('reads as empty and rejects writes when the key does not resolve', async () => {
    const provider = projectProvider(() => null)
    expect(provider.list(ctx)).toEqual([])
    await expect(provider.set(ctx, { name: 'foo', value: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_VALUE', message: 'no workdir' })
  })

  it('rejects reserved names', async () => {
    const provider = agentProvider()
    await expect(provider.set(ctx, { name: 'workdir', value: '/tmp' }))
      .rejects.toBeInstanceOf(VariableError)
  })

  it('delete removes only existing variables', async () => {
    const provider = agentProvider()
    await provider.set(ctx, { name: 'foo', value: 'x' })
    await provider.delete(ctx, 'foo')
    expect(provider.list(ctx)).toHaveLength(0)
    await expect(provider.delete(ctx, 'foo')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('registry scope routing with agent/project stores', () => {
  let registry: VariableRegistry
  let sessionVars: Map<string, ContextVariable[]>
  let globalVars: ContextVariable[]

  beforeEach(() => {
    registry = new VariableRegistry()
    sessionVars = new Map()
    globalVars = []
    registry.register(new GlobalStoreProvider({
      read: () => globalVars,
      write: variables => {
        globalVars = variables
      },
    }))
    registry.register(agentProvider())
    registry.register(projectProvider(() => 'proj-1'))
    registry.register(new SessionStoreProvider({
      read: sessionId => sessionVars.get(sessionId) ?? [],
      write: (sessionId, variables) => {
        sessionVars.set(sessionId, variables)
      },
    }))
  })

  it('routes explicit scopes to their stores', async () => {
    await registry.set(ctx, { name: 'a_var', value: '1', scope: 'agent' })
    await registry.set(ctx, { name: 'p_var', value: '2', scope: 'project' })
    await registry.set(ctx, { name: 's_var', value: '3' })

    const all = await registry.list(ctx)
    expect(all.find(v => v.name === 'a_var')?.scope).toBe('agent')
    expect(all.find(v => v.name === 'p_var')?.scope).toBe('project')
    expect(all.find(v => v.name === 's_var')?.scope).toBe('session')
  })

  it('unscoped set updates the variable where it already lives', async () => {
    await registry.set(ctx, { name: 'shared', value: 'v1', scope: 'agent' })
    await registry.set(ctx, { name: 'shared', value: 'v2' })

    const all = await registry.list(ctx)
    const matches = all.filter(v => v.name === 'shared')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ scope: 'agent', value: 'v2' })
  })

  it('rejects an explicitly-scoped set that would shadow another store', async () => {
    await registry.set(ctx, { name: 'shared', value: 'v1', scope: 'project' })
    await expect(registry.set(ctx, { name: 'shared', value: 'v2', scope: 'session' }))
      .rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' })
    // list stays consistent — the write was rejected before creating a duplicate.
    await expect(registry.list(ctx)).resolves.toHaveLength(1)
  })

  it('unscoped delete follows the variable to its owning store', async () => {
    await registry.set(ctx, { name: 'shared', value: 'v1', scope: 'agent' })
    await registry.delete(ctx, 'shared')
    await expect(registry.list(ctx)).resolves.toHaveLength(0)
  })

  it('scoped delete misses report NOT_FOUND from the target store', async () => {
    await registry.set(ctx, { name: 'shared', value: 'v1', scope: 'agent' })
    await expect(registry.delete(ctx, 'shared', 'project'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('agent variables are visible only to sessions of that agent', async () => {
    // Visibility is structural: list() resolves the key from the CALLING
    // session's agent binding, so another agent's variables are never even
    // read — including in the broadcast-refresh path, which snapshots each
    // session with its own ctx.
    const agentBySession = new Map([['sess-a', 'agent-1'], ['sess-b', 'agent-2']])
    const record = new Map<string, ContextVariable[]>()
    const bare = new VariableRegistry()
    bare.register(new KeyedStoreProvider({
      resolveKey: sessionId => agentBySession.get(sessionId) ?? null,
      read: key => record.get(key) ?? [],
      write: (key, variables) => {
        record.set(key, variables)
      },
    }, { id: 'agent-store', scope: 'agent', priority: 920, unresolvedHint: 'no agent' }))
    bare.register(new SessionStoreProvider({
      read: () => [],
      write: () => undefined,
    }))

    await bare.set({ sessionId: 'sess-a' }, { name: 'team_style', value: 'terse', scope: 'agent' })

    expect(await bare.get({ sessionId: 'sess-a' }, 'team_style')).toBeDefined()
    expect(await bare.get({ sessionId: 'sess-b' }, 'team_style')).toBeUndefined()

    // Same name from the other agent's session is a fresh, independent
    // variable — no cross-agent conflict, no shared state.
    await bare.set({ sessionId: 'sess-b' }, { name: 'team_style', value: 'verbose', scope: 'agent' })
    expect((await bare.get({ sessionId: 'sess-a' }, 'team_style'))?.value).toBe('terse')
    expect((await bare.get({ sessionId: 'sess-b' }, 'team_style'))?.value).toBe('verbose')
  })

  it('switching the workdir switches the visible project variables; no workdir means an empty project scope', async () => {
    // The gateway resolves the key per call (the app gateway reads the
    // session's live workingDirectory), so a workdir switch needs no
    // invalidation — the next list() sees the other project's variables.
    let workdir: string | null = '/proj/a'
    const record = new Map<string, ContextVariable[]>()
    const bare = new VariableRegistry()
    bare.register(new KeyedStoreProvider({
      resolveKey: () => workdir,
      read: key => record.get(key) ?? [],
      write: (key, variables) => {
        record.set(key, variables)
      },
    }, { id: 'project-store', scope: 'project', priority: 940, unresolvedHint: 'no workdir' }))
    bare.register(new SessionStoreProvider({
      read: () => [],
      write: () => undefined,
    }))

    await bare.set(ctx, { name: 'proj_var', value: 'from-a', scope: 'project' })
    expect((await bare.list(ctx)).map(v => v.name)).toContain('proj_var')

    workdir = '/proj/b'
    expect((await bare.list(ctx)).map(v => v.name)).not.toContain('proj_var')
    await bare.set(ctx, { name: 'proj_var', value: 'from-b', scope: 'project' })

    workdir = '/proj/a'
    expect((await bare.get(ctx, 'proj_var'))?.value).toBe('from-a')

    workdir = null
    expect((await bare.list(ctx)).filter(v => v.scope === 'project')).toEqual([])
  })

  it('project scope without a workdir rejects with the hint', async () => {
    const bare = new VariableRegistry()
    bare.register(projectProvider(() => null))
    bare.register(new SessionStoreProvider({
      read: () => [],
      write: () => undefined,
    }))
    await expect(bare.set(ctx, { name: 'x', value: '1', scope: 'project' }))
      .rejects.toMatchObject({ code: 'INVALID_VALUE', message: 'no workdir' })
  })
})
