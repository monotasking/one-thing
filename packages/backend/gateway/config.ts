import type { AllowlistConfig } from './core/index.js'

export type GatewayChannelId = 'wechat' | 'telegram'
export type GatewayPermissionMode = 'remote-approval' | 'auto-accept-edits' | 'dangerously-allow-all'

export interface GatewayPermissionConfig {
  mode: GatewayPermissionMode
  timeoutMs: number
}

const DEFAULT_GATEWAY_PERMISSION_TIMEOUT_MS = 300_000

export function isGatewayEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.ONETHING_GATEWAY ?? env.GATEWAY_ENABLED
  if (explicit !== undefined) {
    return isTruthyGatewayValue(explicit)
  }

  const configured = env.GATEWAY_CHANNELS
    ?.split(',')
    .map(channel => channel.trim().toLowerCase())
    .filter(Boolean)

  if (configured?.some(isSupportedGatewayChannelId)) return true
  return Boolean(readTelegramBotToken(env, false))
}

export function readGatewayChannelIdsFromEnv(env: NodeJS.ProcessEnv): GatewayChannelId[] {
  const configured = env.GATEWAY_CHANNELS
    ?.split(',')
    .map(channel => channel.trim().toLowerCase())
    .filter(Boolean)

  const channels = configured?.length
    ? configured
    : readDefaultGatewayChannelIdsFromEnv(env)

  const seen = new Set<GatewayChannelId>()
  return channels.map(channel => {
    if (!isSupportedGatewayChannelId(channel)) {
      throw new Error(`Unsupported gateway channel "${channel}". Supported channels: wechat, telegram.`)
    }
    return channel
  }).filter(channel => {
    if (seen.has(channel)) return false
    seen.add(channel)
    return true
  })
}

export function readAllowlistConfigFromEnv(env: NodeJS.ProcessEnv): AllowlistConfig {
  const ids = env.GATEWAY_ALLOWLIST
    ?.split(',')
    .map(id => id.trim())
    .filter(Boolean)

  if (ids?.length) {
    return { mode: 'strict', ids }
  }

  return { mode: 'open' }
}

export function readGatewayPermissionConfigFromEnv(env: NodeJS.ProcessEnv): GatewayPermissionConfig {
  return {
    mode: readGatewayPermissionMode(env.GATEWAY_PERMISSION_MODE),
    timeoutMs: readPositiveInteger(env.GATEWAY_PERMISSION_TIMEOUT_MS, DEFAULT_GATEWAY_PERMISSION_TIMEOUT_MS),
  }
}

export function readTelegramBotToken(env: NodeJS.ProcessEnv, required = true): string {
  const token = env.GATEWAY_TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN ?? ''
  if (required && !token.trim()) {
    throw new Error('Telegram gateway channel requires TELEGRAM_BOT_TOKEN or GATEWAY_TELEGRAM_BOT_TOKEN')
  }
  return token
}

export function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readDefaultGatewayChannelIdsFromEnv(env: NodeJS.ProcessEnv): GatewayChannelId[] {
  if (readTelegramBotToken(env, false)) return ['telegram']
  return ['wechat']
}

function isSupportedGatewayChannelId(channel: string): channel is GatewayChannelId {
  return channel === 'wechat' || channel === 'telegram'
}

function readGatewayPermissionMode(value: string | undefined): GatewayPermissionMode {
  const mode = value?.trim().toLowerCase() || 'remote-approval'
  if (isGatewayPermissionMode(mode)) return mode
  throw new Error('Unsupported GATEWAY_PERMISSION_MODE "' + value + '". Supported modes: remote-approval, auto-accept-edits, dangerously-allow-all.')
}

function isGatewayPermissionMode(value: string): value is GatewayPermissionMode {
  return value === 'remote-approval'
    || value === 'auto-accept-edits'
    || value === 'dangerously-allow-all'
}

function isTruthyGatewayValue(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'on'
    || normalized === 'wechat'
    || normalized === 'telegram'
}
