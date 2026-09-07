import path from 'node:path'
import type {
  ChannelReplyDeliveryRecord,
  ChannelUserProfile,
  ChannelUserLink,
} from '@shared/ipc.js'
import {
  getOnethingStorePath,
  readJsonFile,
  writeJsonFile,
} from '@onething/runtime/storage'
import { LOCAL_CLIENT_USER_ID } from './origin.js'

interface ChannelIdentityStoreData {
  profiles: ChannelUserProfile[]
  links: ChannelUserLink[]
  deliveries: ChannelReplyDeliveryRecord[]
}

const DEFAULT_DATA: ChannelIdentityStoreData = {
  profiles: [],
  links: [],
  deliveries: [],
}

function storePath(): string {
  return path.join(getOnethingStorePath(), 'channel-identity.json')
}

function normalizeWorkspaceId(workspaceId?: string): string | undefined {
  const trimmed = workspaceId?.trim()
  return trimmed || undefined
}

function sanitizeProfileId(value: string, fallback = 'user'): string {
  return (value || fallback).trim().replace(/[^a-zA-Z0-9_.@-]+/g, '-').replace(/-+/g, '-') || fallback
}

function defaultProfile(now = Date.now()): ChannelUserProfile {
  return {
    id: LOCAL_CLIENT_USER_ID,
    name: 'Local user',
    isMain: true,
    source: 'local',
    createdAt: now,
    updatedAt: now,
  }
}

// Older stores stamped profiles with a memoryScopeId ("channel:<connector>:<ws>:<user>"
// or "client:<id>"); the scope never fed any path and is deprecated. Channel
// coordinates are now explicit fields, migrated lazily from the legacy value.
interface LegacyScopedProfile extends ChannelUserProfile {
  memoryScopeId?: string
}

function migrateLegacyProfile(profile: LegacyScopedProfile): ChannelUserProfile {
  const scope = profile.memoryScopeId
  if (scope?.startsWith('channel:') && !profile.connector) {
    const [connector, workspaceId, ...rest] = scope.slice('channel:'.length).split(':')
    if (connector && rest.length) {
      profile.connector = connector
      profile.workspaceId = workspaceId || 'default'
      profile.externalUserId = rest.join(':')
    }
  }
  delete profile.memoryScopeId
  return profile
}

function channelProfileId(input: {
  connector: string
  workspaceId?: string
  externalUserId: string
}): string {
  const workspaceId = normalizeWorkspaceId(input.workspaceId) || 'default'
  return sanitizeProfileId(`channel-${input.connector}-${workspaceId}-${input.externalUserId}`, 'channel-user')
}

function readStore(filePath = storePath()): ChannelIdentityStoreData {
  const data = readJsonFile<ChannelIdentityStoreData>(filePath, DEFAULT_DATA)
  const now = Date.now()
  const profiles = Array.isArray(data.profiles) ? [...data.profiles] : []
  if (!profiles.some(profile => profile.id === LOCAL_CLIENT_USER_ID)) {
    profiles.unshift(defaultProfile(now))
  }
  return {
    profiles: profiles.map(profile => migrateLegacyProfile(profile)),
    links: Array.isArray(data.links) ? [...data.links] : [],
    deliveries: Array.isArray(data.deliveries) ? [...data.deliveries] : [],
  }
}

function writeStore(data: ChannelIdentityStoreData, filePath = storePath()): void {
  writeJsonFile(filePath, data)
}

/** A send owns its delivery receipt path even if the process later changes store. */
export function createChannelReplyDeliveryStore(storeRoot: string) {
  const filePath = path.join(storeRoot, 'channel-identity.json')
  return {
    getDelivery(assistantMessageId: string): ChannelReplyDeliveryRecord | undefined {
      return readStore(filePath).deliveries.find(record => record.assistantMessageId === assistantMessageId)
    },
    upsertDelivery(record: ChannelReplyDeliveryRecord): void {
      const data = readStore(filePath)
      const index = data.deliveries.findIndex(item => item.assistantMessageId === record.assistantMessageId)
      if (index >= 0) data.deliveries[index] = record
      else data.deliveries.push(record)
      writeStore(data, filePath)
    },
  }
}

export class ChannelIdentityStore {
  listProfiles(): ChannelUserProfile[] {
    return [...readStore().profiles].sort((left, right) => {
      if (left.isMain && !right.isMain) return -1
      if (!left.isMain && right.isMain) return 1
      return (right.lastSentAt || right.updatedAt) - (left.lastSentAt || left.updatedAt)
    })
  }

  getProfile(id: string): ChannelUserProfile | undefined {
    return readStore().profiles.find(profile => profile.id === id)
  }

  getMainProfile(): ChannelUserProfile {
    const data = readStore()
    const profile = data.profiles.find(item => item.isMain) || data.profiles.find(item => item.id === LOCAL_CLIENT_USER_ID)
    return profile || defaultProfile()
  }

  createProfile(input: {
    id?: string
    name: string
    isMain?: boolean
    source?: ChannelUserProfile['source']
    channel?: {
      connector: string
      workspaceId?: string
      externalUserId: string
    }
  }): ChannelUserProfile {
    const now = Date.now()
    const data = readStore()
    const id = sanitizeProfileId(input.id || input.name, `user-${now}`)
    const existing = data.profiles.find(profile => profile.id === id)

    if (input.isMain) {
      data.profiles.forEach(profile => {
        profile.isMain = profile.id === id
      })
    }

    if (existing) {
      existing.name = input.name.trim() || existing.name
      if (input.channel) {
        existing.connector = input.channel.connector
        existing.workspaceId = normalizeWorkspaceId(input.channel.workspaceId) || 'default'
        existing.externalUserId = input.channel.externalUserId
      }
      existing.source = input.source || existing.source
      existing.isMain = input.isMain === undefined ? existing.isMain : input.isMain
      existing.updatedAt = now
      writeStore(data)
      return existing
    }

    const profile: ChannelUserProfile = {
      id,
      name: input.name.trim() || id,
      isMain: input.isMain === true,
      source: input.source || 'manual',
      ...(input.channel
        ? {
            connector: input.channel.connector,
            workspaceId: normalizeWorkspaceId(input.channel.workspaceId) || 'default',
            externalUserId: input.channel.externalUserId,
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    }
    data.profiles.push(profile)
    if (profile.isMain) {
      data.profiles.forEach(item => {
        item.isMain = item.id === profile.id
      })
    }
    writeStore(data)
    return profile
  }

  updateProfile(input: {
    id: string
    name?: string
    isMain?: boolean
  }): ChannelUserProfile {
    const data = readStore()
    const profile = data.profiles.find(item => item.id === input.id)
    if (!profile) throw new Error('Channel user profile not found')

    if (input.name !== undefined) profile.name = input.name.trim() || profile.name
    if (input.isMain !== undefined) {
      data.profiles.forEach(item => {
        item.isMain = input.isMain ? item.id === input.id : item.isMain && item.id !== input.id
      })
      profile.isMain = input.isMain
    }
    profile.updatedAt = Date.now()
    writeStore(data)
    return profile
  }

  ensureClientProfile(clientUserId: string, displayName?: string): ChannelUserProfile {
    const existing = this.getProfile(clientUserId)
    if (existing) return existing
    return this.createProfile({
      id: clientUserId,
      name: displayName || clientUserId,
      source: clientUserId === LOCAL_CLIENT_USER_ID ? 'local' : 'manual',
      isMain: clientUserId === LOCAL_CLIENT_USER_ID,
    })
  }

  ensureChannelProfile(input: {
    connector: string
    workspaceId?: string
    externalUserId: string
    displayName?: string
  }): ChannelUserProfile {
    const id = channelProfileId(input)
    const existing = this.getProfile(id)
    if (existing) return existing
    return this.createProfile({
      id,
      name: input.displayName || input.externalUserId,
      source: 'channel',
      channel: input,
    })
  }

  touchProfile(id: string, input: {
    sentAt?: number
    transport?: ChannelUserProfile['lastTransport']
    connector?: string
    displayName?: string
  } = {}): void {
    const data = readStore()
    const profile = data.profiles.find(item => item.id === id)
    if (!profile) return
    const now = Date.now()
    profile.lastSentAt = input.sentAt || now
    profile.lastTransport = input.transport || profile.lastTransport
    profile.lastConnector = input.connector || profile.lastConnector
    if (input.displayName && profile.source === 'channel') profile.name = input.displayName
    profile.updatedAt = now
    writeStore(data)
  }

  listLinks(filter: {
    connector?: string
    workspaceId?: string
    clientUserId?: string
  } = {}): ChannelUserLink[] {
    const workspaceId = normalizeWorkspaceId(filter.workspaceId)
    return readStore().links.filter(link => {
      if (filter.connector && link.connector !== filter.connector) return false
      if (workspaceId !== undefined && normalizeWorkspaceId(link.workspaceId) !== workspaceId) return false
      if (filter.clientUserId && link.clientUserId !== filter.clientUserId) return false
      return true
    })
  }

  findLink(input: {
    connector: string
    workspaceId?: string
    externalUserId: string
  }): ChannelUserLink | undefined {
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    return readStore().links.find(link =>
      link.connector === input.connector
      && normalizeWorkspaceId(link.workspaceId) === workspaceId
      && link.externalUserId === input.externalUserId
    )
  }

  createLink(input: {
    connector: string
    workspaceId?: string
    externalUserId: string
    clientUserId: string
  }): ChannelUserLink {
    this.ensureClientProfile(input.clientUserId)
    const now = Date.now()
    const data = readStore()
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const existing = data.links.find(link =>
      link.connector === input.connector
      && normalizeWorkspaceId(link.workspaceId) === workspaceId
      && link.externalUserId === input.externalUserId
    )

    if (existing) {
      existing.clientUserId = input.clientUserId
      existing.updatedAt = now
      writeStore(data)
      return existing
    }

    const link: ChannelUserLink = {
      id: `link-${now}-${Math.random().toString(36).slice(2, 10)}`,
      connector: input.connector,
      workspaceId,
      externalUserId: input.externalUserId,
      clientUserId: input.clientUserId,
      createdAt: now,
      updatedAt: now,
    }
    data.links.push(link)
    writeStore(data)
    return link
  }

  deleteLink(id: string): boolean {
    const data = readStore()
    const nextLinks = data.links.filter(link => link.id !== id)
    if (nextLinks.length === data.links.length) return false
    writeStore({ ...data, links: nextLinks })
    return true
  }

  listDeliveries(): ChannelReplyDeliveryRecord[] {
    return readStore().deliveries
  }

  getDelivery(assistantMessageId: string): ChannelReplyDeliveryRecord | undefined {
    return createChannelReplyDeliveryStore(getOnethingStorePath()).getDelivery(assistantMessageId)
  }

  upsertDelivery(record: ChannelReplyDeliveryRecord): void {
    createChannelReplyDeliveryStore(getOnethingStorePath()).upsertDelivery(record)
  }
}

let singleton: ChannelIdentityStore | null = null

export function getChannelIdentityStore(): ChannelIdentityStore {
  if (!singleton) singleton = new ChannelIdentityStore()
  return singleton
}
