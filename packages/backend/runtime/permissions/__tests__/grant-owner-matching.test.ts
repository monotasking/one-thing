import { afterEach, describe, expect, it } from 'vitest'
import { addGrant, matchGrant, resetPermissionGrantsForTests } from '../permission-grants.js'

const createdFrom = { messageId: 'm1', title: 'test' }

describe('grant owner matching', () => {
  afterEach(() => {
    resetPermissionGrantsForTests()
  })

  it('an ownerless SESSION grant binds the session, not a person', () => {
    // The radio incident (2026-07-17): the DJ's music-dir pre-grants are
    // minted in identity-less wake turns; once the user chatted in the
    // session, permission enrichment stamped their identity onto every ask
    // and the ownerless grants stopped matching — inbox writes auto-denied.
    addGrant({
      scope: 'session',
      type: 'file_write',
      pattern: '/music/*',
      sessionId: 's1',
      createdFrom,
    })

    // Identity-less drive turn: matches (as before).
    expect(
      matchGrant({ type: 'file_write', pattern: '/music/inbox.json', sessionId: 's1' }),
    ).toBeDefined()
    // A human talked in the session — asks now carry their identity: still matches.
    expect(
      matchGrant({
        type: 'file_write',
        pattern: '/music/inbox.json',
        sessionId: 's1',
        userId: 'local-owner',
      }),
    ).toBeDefined()
    // Other sessions stay out of reach.
    expect(
      matchGrant({ type: 'file_write', pattern: '/music/inbox.json', sessionId: 's2' }),
    ).toBeUndefined()
  })

  it('an OWNED session grant keeps strict two-way matching', () => {
    addGrant({
      scope: 'session',
      type: 'file_write',
      pattern: '/work/*',
      sessionId: 's1',
      userId: 'alice',
      createdFrom,
    })

    expect(
      matchGrant({ type: 'file_write', pattern: '/work/a.txt', sessionId: 's1', userId: 'alice' }),
    ).toBeDefined()
    expect(
      matchGrant({ type: 'file_write', pattern: '/work/a.txt', sessionId: 's1', userId: 'bob' }),
    ).toBeUndefined()
    expect(
      matchGrant({ type: 'file_write', pattern: '/work/a.txt', sessionId: 's1' }),
    ).toBeUndefined()
  })

  it('an ownerless WORKSPACE grant still refuses owned asks (gateway isolation)', () => {
    addGrant({
      scope: 'workspace',
      type: 'file_write',
      pattern: '/repo/*',
      workspaceRoot: '/repo',
      createdFrom,
    })

    expect(
      matchGrant({ type: 'file_write', pattern: '/repo/a.txt', workspaceRoot: '/repo' }),
    ).toBeDefined()
    expect(
      matchGrant({
        type: 'file_write',
        pattern: '/repo/a.txt',
        workspaceRoot: '/repo',
        userId: 'alice',
      }),
    ).toBeUndefined()
  })
})
