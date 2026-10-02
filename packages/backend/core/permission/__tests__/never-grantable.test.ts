import { afterEach, describe, expect, it } from 'vitest'
import { addGrant, isGrantableType, matchGrant, resetPermissionGrantsForTests } from '../permission-grants.js'

const createdFrom = { messageId: 'm1', title: 'test' }

describe('never-grantable permission types', () => {
  afterEach(() => {
    resetPermissionGrantsForTests()
  })

  it('classifies capability_change as never grantable', () => {
    expect(isGrantableType('capability_change')).toBe(false)
    expect(isGrantableType('file_write')).toBe(true)
    expect(isGrantableType('bash')).toBe(true)
  })

  // A standing grant here would let the assistant repoint a capability once and
  // then keep repointing it without ever being asked again.
  it('refuses to create a workspace grant for a capability change', () => {
    expect(() => addGrant({
      scope: 'workspace',
      type: 'capability_change',
      pattern: '/anywhere',
      workspaceRoot: '/repo',
      createdFrom,
    })).toThrow(/never grantable/)

    expect(matchGrant({
      type: 'capability_change',
      pattern: '/anywhere',
      workspaceRoot: '/repo',
    })).toBeUndefined()
  })

  it('refuses a session grant for a capability change too', () => {
    expect(() => addGrant({
      scope: 'session',
      type: 'capability_change',
      pattern: '/anywhere',
      sessionId: 'session-a',
      createdFrom,
    })).toThrow(/never grantable/)
  })

  it('still grants ordinary file writes', () => {
    const grant = addGrant({
      scope: 'workspace',
      type: 'file_write',
      pattern: '/repo/src/*',
      workspaceRoot: '/repo',
      createdFrom,
    })

    expect(grant.id).toBeTruthy()
    expect(matchGrant({
      type: 'file_write',
      pattern: '/repo/src/a.ts',
      workspaceRoot: '/repo',
    })).toBeTruthy()
  })
})
