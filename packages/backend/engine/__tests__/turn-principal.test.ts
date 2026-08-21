import { afterEach, describe, expect, it } from 'vitest'
import type { MessageOrigin } from '@shared/ipc.js'
import { principalId } from '@onething/core/permission'
import { configureCollabDriveGuard } from '../../collab/drive-guard.js'
import { mintTurnPrincipal } from '../turn-principal.js'

const TOKEN = 'test-drive-token'

afterEach(() => configureCollabDriveGuard(null))

function gatewayOrigin(userId: string, workspaceId?: string): MessageOrigin {
  return {
    transport: 'gateway',
    source: 'gateway',
    resolvedIdentity: { kind: 'channel-user', userId },
    ...(workspaceId ? { conversation: { workspaceId } } : {}),
  } as unknown as MessageOrigin
}

describe('mintTurnPrincipal', () => {
  describe('a claim on the command is not a credential', () => {
    it('discards a forged user principal from an ordinary command', () => {
      // apps/server forwards commands whole, so this field is reachable from
      // the network. Honouring it would hand any caller a chosen identity.
      const minted = mintTurnPrincipal({
        source: 'ipc',
        principal: { kind: 'user', userId: 'owner' },
      })
      expect(principalId(minted)).toBe('user:local')
    })

    it('discards a forged agent principal from an ordinary command', () => {
      const minted = mintTurnPrincipal({
        principal: { kind: 'agent', agentId: 'privileged-agent' },
      })
      expect(principalId(minted)).toBe('user:local')
    })

    it('discards a claim carrying a WRONG drive token', () => {
      configureCollabDriveGuard(TOKEN)
      const minted = mintTurnPrincipal({
        source: 'collab',
        collabDriveToken: 'not-the-token',
        principal: { kind: 'agent', agentId: 'privileged-agent' },
      })
      expect(principalId(minted)).not.toBe('agent:privileged-agent')
    })

    it('discards a claim replayed when no coordinator is running', () => {
      // driveToken === null ⇒ nothing is trusted. A transcript replay carries a
      // token from a process that no longer exists.
      const minted = mintTurnPrincipal({
        source: 'collab',
        collabDriveToken: TOKEN,
        principal: { kind: 'agent', agentId: 'privileged-agent' },
      })
      expect(principalId(minted)).not.toBe('agent:privileged-agent')
    })
  })

  describe('a proven claim is honoured', () => {
    it('takes the agent the live coordinator names', () => {
      configureCollabDriveGuard(TOKEN)
      const minted = mintTurnPrincipal({
        source: 'collab',
        collabDriveToken: TOKEN,
        principal: { kind: 'agent', agentId: 'skill-reviewer' },
      })
      expect(minted).toEqual({ kind: 'agent', agentId: 'skill-reviewer' })
    })

    it('falls back to system, NOT an agent, when the claim is unusable', () => {
      configureCollabDriveGuard(TOKEN)
      const minted = mintTurnPrincipal({
        source: 'collab',
        collabDriveToken: TOKEN,
        principal: { kind: 'agent' },      // no agentId
      })
      expect(principalId(minted)).toBe('system:collab')
    })
  })

  describe('unprovable actors land on least privilege', () => {
    it('system-internal sources mint a system principal', () => {
      expect(principalId(mintTurnPrincipal({ source: 'goal' }))).toBe('system:goal')
    })

    it('the scheduler is a machine, not the desktop owner', () => {
      // It drives turns with `channel: 'scheduler'` and NO source, so the
      // routing-oriented system-internal set never sees it. Before this rule it
      // minted user:local and inherited everything the owner may do.
      expect(principalId(mintTurnPrincipal({ channel: 'scheduler' }))).toBe('system:scheduler')
    })

    it('voice and the CLI are the local person arriving by another door', () => {
      expect(principalId(mintTurnPrincipal({ source: 'voice' }))).toBe('user:local')
      expect(principalId(mintTurnPrincipal({ source: 'text' }))).toBe('user:local')
    })

    it('never falls back to the default agent', () => {
      // session.agentId is stamped on EVERY session, so a lookup always answers
      // and always plausibly. No branch here may return an agent it did not
      // have proof for.
      const cases = [{}, { source: 'goal' }, { channel: 'scheduler' }, { source: 'collab' }]
      for (const command of cases) {
        expect(mintTurnPrincipal(command).kind).not.toBe('agent')
      }
    })
  })

  describe('channel identity becomes the actor', () => {
    it('uses the resolved gateway user', () => {
      const minted = mintTurnPrincipal({}, gatewayOrigin('u-42'))
      expect(minted).toEqual({ kind: 'user', userId: 'u-42' })
    })

    it('carries the workspace when the conversation has one', () => {
      const minted = mintTurnPrincipal({}, gatewayOrigin('u-42', 'ws-7'))
      expect(minted).toEqual({ kind: 'user', userId: 'u-42', workspaceId: 'ws-7' })
    })

    it('desktop turns with no channel identity are the local owner', () => {
      expect(principalId(mintTurnPrincipal({}))).toBe('user:local')
    })
  })
})
