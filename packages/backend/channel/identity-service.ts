import type {
  MessageOrigin,
  ResolvedIdentity,
} from '@shared/ipc.js'
import { writeAppLog } from '../logging/index.js'
import { getChannelIdentityStore } from './identity-store.js'
import {
  createApiOrigin,
  createDesktopOrigin,
  createLocalClientIdentity,
  createVoiceOrigin,
  originConnector,
  originWorkspaceId,
} from './origin.js'

function sanitizeKeyPart(value: string | undefined, fallback: string): string {
  return (value || fallback).trim().replace(/[^a-zA-Z0-9_.@-]+/g, '_') || fallback
}

function connectorFor(origin: MessageOrigin): string {
  return originConnector(origin) || origin.conversation?.connector || origin.replyTarget?.connector || origin.transport
}

function externalUserIdFor(origin: MessageOrigin): string {
  return origin.actor?.externalUserId
    || origin.resolvedIdentity?.externalUserKey
    || origin.resolvedIdentity?.userId
    || `${origin.transport}-anonymous`
}

export class ChannelIdentityService {
  resolve(origin: MessageOrigin): ResolvedIdentity {
    if (origin.transport === 'desktop' || origin.transport === 'voice') {
      const store = getChannelIdentityStore()
      const profile = origin.resolvedIdentity?.profileId
        ? store.getProfile(origin.resolvedIdentity.profileId) || store.getMainProfile()
        : store.getMainProfile()
      store.touchProfile(profile.id, {
        sentAt: origin.receivedAt,
        transport: origin.transport,
      })
      const identity = origin.resolvedIdentity ?? createLocalClientIdentity(profile.name)
      identity.userId = profile.id
      identity.profileId = profile.id
      identity.displayName = profile.name
      identity.linkedClientUserId = profile.id
      writeAppLog('info', 'channel.identity', 'Resolved local client identity', {
        transport: origin.transport,
        userId: identity.userId,
        profileId: identity.profileId,
      })
      return identity
    }

    if (origin.resolvedIdentity?.kind === 'client-user') {
      const store = getChannelIdentityStore()
      const profile = store.ensureClientProfile(
        origin.resolvedIdentity.profileId || origin.resolvedIdentity.linkedClientUserId || origin.resolvedIdentity.userId,
        origin.resolvedIdentity.displayName || origin.actor?.displayName || origin.actor?.handle,
      )
      store.touchProfile(profile.id, {
        sentAt: origin.receivedAt,
        transport: origin.transport,
        connector: connectorFor(origin),
        displayName: origin.actor?.displayName || origin.actor?.handle,
      })
      const identity: ResolvedIdentity = {
        ...origin.resolvedIdentity,
        userId: profile.id,
        profileId: profile.id,
        displayName: origin.resolvedIdentity.displayName || profile.name,
        linkedClientUserId: profile.id,
      }
      writeAppLog('info', 'channel.identity', 'Preserved trusted client identity', {
        transport: origin.transport,
        userId: identity.userId,
        profileId: identity.profileId,
      })
      return identity
    }

    const connector = connectorFor(origin)
    const workspaceId = originWorkspaceId(origin)
    const externalUserId = externalUserIdFor(origin)
    const store = getChannelIdentityStore()
    const link = store.findLink({
      connector,
      workspaceId,
      externalUserId,
    })

    if (link) {
      const profile = store.ensureClientProfile(link.clientUserId, origin.actor?.displayName || origin.actor?.handle)
      store.touchProfile(profile.id, {
        sentAt: origin.receivedAt,
        transport: origin.transport,
        connector,
        displayName: origin.actor?.displayName || origin.actor?.handle,
      })
      const identity: ResolvedIdentity = {
        kind: 'client-user',
        userId: profile.id,
        profileId: profile.id,
        displayName: origin.actor?.displayName || origin.actor?.handle || profile.name,
        linkedClientUserId: profile.id,
        externalUserKey: `${connector}:${workspaceId || 'default'}:${externalUserId}`,
      }
      writeAppLog('info', 'channel.identity', 'Resolved linked channel user identity', {
        connector,
        workspaceId,
        externalUserId,
        userId: identity.userId,
        profileId: identity.profileId,
      })
      return identity
    }

    const externalUserKey = `${connector}:${workspaceId || 'default'}:${externalUserId}`
    const profile = store.ensureChannelProfile({
      connector,
      workspaceId,
      externalUserId,
      displayName: origin.actor?.displayName || origin.actor?.handle,
    })
    store.touchProfile(profile.id, {
      sentAt: origin.receivedAt,
      transport: origin.transport,
      connector,
      displayName: origin.actor?.displayName || origin.actor?.handle,
    })
    const identity: ResolvedIdentity = {
      kind: 'channel-user',
      userId: profile.id || `channel:${sanitizeKeyPart(externalUserKey, 'external-user')}`,
      profileId: profile.id,
      displayName: origin.actor?.displayName || origin.actor?.handle || profile.name || externalUserId,
      externalUserKey,
    }
    writeAppLog('info', 'channel.identity', 'Resolved unlinked channel user identity', {
      connector,
      workspaceId,
      externalUserId,
      userId: identity.userId,
      profileId: identity.profileId,
    })
    return identity
  }

  resolveOrigin(origin: MessageOrigin): MessageOrigin {
    const normalized = this.normalizeOrigin(origin)
    return {
      ...normalized,
      resolvedIdentity: this.resolve(normalized),
    }
  }

  normalizeOrigin(origin: MessageOrigin | undefined, fallbackTransport: MessageOrigin['transport'] = 'desktop'): MessageOrigin {
    if (!origin) {
      if (fallbackTransport === 'voice') return createVoiceOrigin()
      if (fallbackTransport === 'api') return createApiOrigin()
      return createDesktopOrigin()
    }

    return {
      ...origin,
      source: origin.source || (origin.transport === 'voice' ? 'voice' : origin.transport === 'api' ? 'api' : 'text'),
      receivedAt: typeof origin.receivedAt === 'number' ? origin.receivedAt : Date.now(),
    }
  }
}

let singleton: ChannelIdentityService | null = null

export function getChannelIdentityService(): ChannelIdentityService {
  if (!singleton) singleton = new ChannelIdentityService()
  return singleton
}
