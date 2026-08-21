import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@onething/runtime/storage', () => {
  let data: any = { grants: [] }
  return {
    getOnethingPermissionsDir: () => '/tmp/onething-permissions-test',
    getOnethingSettingsPath: () => '/tmp/onething-permissions-test/settings.json',
    getOnethingFileMutationsDir: () => '/tmp/onething-permissions-test/file-mutations',
    getOnethingToolOutputsDir: () => '/tmp/onething-permissions-test/tool-outputs',
    getOnethingMCPToolsCatalogPath: () => '/tmp/onething-permissions-test/mcp-tools.json',
    ensureDir: () => undefined,
    readJsonFile: (_path: string, defaultValue: any) => _path.endsWith('workspace-grants.json') ? data : defaultValue,
    writeJsonFile: (_path: string, next: any) => { if (_path.endsWith('workspace-grants.json')) data = next },
  }
})

describe('permission grants', () => {
  beforeEach(async () => {
    const { resetPermissionGrantsForTests } = await import('../permission-grants')
    resetPermissionGrantsForTests()
  })

  it('builds workspace grant file storage from onething runtime adapter rules', async () => {
    const {
      createPermissionGrantFileStorage,
      getPermissionWorkspaceGrantsPath,
    } = await import('../permission-grants')
    let stored: unknown = { grants: [] }
    const touchedPaths: string[] = []
    const storage = createPermissionGrantFileStorage({
      getPermissionsDir: () => '/tmp/onething-permissions-test',
      readJsonFile: (filePath, defaultValue) => {
        touchedPaths.push(filePath)
        return stored as typeof defaultValue
      },
      writeJsonFile: (filePath, next) => {
        touchedPaths.push(filePath)
        stored = next
      },
    })

    expect(getPermissionWorkspaceGrantsPath(() => '/tmp/onething-permissions-test'))
      .toBe('/tmp/onething-permissions-test/workspace-grants.json')

    storage.saveWorkspaceGrants([{
      id: 'g1',
      scope: 'workspace',
      type: 'bash',
      pattern: 'git *',
      workspaceRoot: '/repo',
      createdAt: 1,
      updatedAt: 1,
      createdFrom: { messageId: 'm1', title: 'git' },
    }])

    expect(storage.loadWorkspaceGrants()).toHaveLength(1)
    expect(touchedPaths).toEqual([
      '/tmp/onething-permissions-test/workspace-grants.json',
      '/tmp/onething-permissions-test/workspace-grants.json',
    ])
  })

  it('matches session grants only within the same session', async () => {
    const { addGrant, matchGrant } = await import('../permission-grants')
    const grant = addGrant({
      scope: 'session',
      type: 'bash',
      pattern: 'git status *',
      sessionId: 's1',
      createdFrom: { messageId: 'm1', title: 'git status' },
    })

    expect(matchGrant({ type: 'bash', pattern: 'git status --short', sessionId: 's1' })?.id).toBe(grant.id)
    expect(matchGrant({ type: 'bash', pattern: 'git status --short', sessionId: 's2' })).toBeUndefined()
  })

  it('matches workspace grants only within the same workspace', async () => {
    const { addGrant, matchGrant } = await import('../permission-grants')
    const grant = addGrant({
      scope: 'workspace',
      type: 'file_write',
      pattern: '/repo/*',
      workspaceRoot: '/repo',
      createdFrom: { messageId: 'm1', title: 'write' },
    })

    expect(matchGrant({ type: 'file_write', pattern: '/repo/a.ts', workspaceRoot: '/repo' })?.id).toBe(grant.id)
    expect(matchGrant({ type: 'file_write', pattern: '/repo/a.ts', workspaceRoot: '/other' })).toBeUndefined()
  })

  it('isolates owner-scoped workspace grants by user and workspace id', async () => {
    const { addGrant, clearWorkspaceGrants, listWorkspaceGrants, matchGrant } = await import('../permission-grants')
    const aliceGrant = addGrant({
      scope: 'workspace',
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-a',
      createdFrom: { messageId: 'm1', title: 'test' },
    })
    const bobGrant = addGrant({
      scope: 'workspace',
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
      userId: 'bob',
      workspaceId: 'workspace-a',
      createdFrom: { messageId: 'm2', title: 'test' },
    })

    expect(matchGrant({
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-a',
    })?.id).toBe(aliceGrant.id)
    expect(matchGrant({
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
      userId: 'bob',
      workspaceId: 'workspace-a',
    })?.id).toBe(bobGrant.id)
    expect(matchGrant({
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-b',
    })).toBeUndefined()
    expect(matchGrant({
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
    })).toBeUndefined()

    expect(listWorkspaceGrants('/repo', {
      userId: 'alice',
      workspaceId: 'workspace-a',
    }).map(grant => grant.id)).toEqual([aliceGrant.id])

    clearWorkspaceGrants('/repo', {
      userId: 'alice',
      workspaceId: 'workspace-a',
    })

    expect(matchGrant({
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-a',
    })).toBeUndefined()
    expect(matchGrant({
      type: 'bash',
      pattern: 'npm test',
      workspaceRoot: '/repo',
      userId: 'bob',
      workspaceId: 'workspace-a',
    })?.id).toBe(bobGrant.id)
  })

  it('supports revoke and clear session grants', async () => {
    const { addGrant, clearSessionGrants, listSessionGrants, matchGrant, revokeGrant } = await import('../permission-grants')
    const grant = addGrant({
      scope: 'session',
      type: 'mcp',
      pattern: 'mcp:foo',
      sessionId: 's1',
      createdFrom: { messageId: 'm1', title: 'mcp' },
    })

    expect(matchGrant({ type: 'mcp', pattern: 'mcp:foo', sessionId: 's1' })).toBeTruthy()
    expect(revokeGrant(grant.id)).toBe(true)
    expect(matchGrant({ type: 'mcp', pattern: 'mcp:foo', sessionId: 's1' })).toBeUndefined()

    addGrant({
      scope: 'session',
      type: 'mcp',
      pattern: 'mcp:bar',
      sessionId: 's1',
      createdFrom: { messageId: 'm2', title: 'mcp' },
    })
    expect(listSessionGrants('s1')).toHaveLength(2)
    clearSessionGrants('s1')
    expect(listSessionGrants('s1')).toHaveLength(0)
  })
})
