import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import {
  getGatewayDataPath,
  deleteGatewayFile,
  readGatewayJsonFile,
  writeGatewayJsonFile,
} from '../../../core/storage.js'
import { gatewayLogger } from '../../../core/logging.js'

export const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const ILINK_CHANNEL_VERSION = '2.4.6'
const ILINK_BOT_AGENT = 'onething-gateway/0.0.0'
const ILINK_APP_CLIENT_VERSION = buildClientVersion(ILINK_CHANNEL_VERSION)
const WECHAT_TOKEN_PATH = getGatewayDataPath('wechat-token.json')
const WECHAT_SYNC_PATH = getGatewayDataPath('wechat-sync.json')
const DEFAULT_WECHAT_ACCOUNT_ID = 'default'

interface TokenFile {
  bot_token?: string
  baseurl?: string
  ilink_user_id?: string
  ilink_bot_id?: string
}

interface SyncFile {
  get_updates_buf?: string
}

export interface WechatAuthState {
  botToken: string
  baseUrl: string
  ilinkUserId?: string
  ilinkBotId?: string
}

export interface WechatAccountStorage {
  accountId: string
  tokenPath: string
  syncPath: string
  legacyTokenPath?: string
  legacySyncPath?: string
}

interface QRCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

export interface QRCodeStatusResponse {
  status:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect'
    | 'pending'
    | string
  bot_token?: string
  baseurl?: string
  ilink_user_id?: string
  ilink_bot_id?: string
  redirect_host?: string
}

export function buildBaseInfo(): Record<string, string> {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: ILINK_BOT_AGENT,
  }
}

export function makeHeaders(botToken?: string): Record<string, string> {
  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64')
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    ...(botToken ? { Authorization: `Bearer ${botToken}` } : {}),
  }
}

export async function getQRCode(): Promise<QRCodeResponse> {
  const response = await fetch(`${DEFAULT_ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: makeHeaders(),
  })
  const data = await readIlinkJson(response, 'get_bot_qrcode')

  if (isQRCodeResponse(data)) {
    return data
  }

  gatewayLogger('wechat.auth').error('unexpected get_bot_qrcode response', { response: data })
  throw new Error('Unexpected get_bot_qrcode response')
}

export async function pollQRCodeStatus(qrcode: string, baseUrl = DEFAULT_ILINK_BASE_URL): Promise<QRCodeStatusResponse> {
  const url = new URL(`${baseUrl}/ilink/bot/get_qrcode_status`)
  url.searchParams.set('qrcode', qrcode)

  const response = await fetch(url, {
    headers: makeHeaders(),
  })
  const data = await readIlinkJson(response, 'get_qrcode_status')

  if (isQRCodeStatusResponse(data)) {
    return data
  }

  gatewayLogger('wechat.auth').error('unexpected get_qrcode_status response', { response: data })
  throw new Error('Unexpected get_qrcode_status response')
}

export function getWechatAccountStorage(accountId = DEFAULT_WECHAT_ACCOUNT_ID): WechatAccountStorage {
  const normalized = normalizeWechatAccountId(accountId)
  return {
    accountId: normalized,
    tokenPath: getGatewayDataPath('wechat-accounts', normalized, 'token.json'),
    syncPath: getGatewayDataPath('wechat-accounts', normalized, 'sync.json'),
    ...(normalized === DEFAULT_WECHAT_ACCOUNT_ID
      ? {
          legacyTokenPath: WECHAT_TOKEN_PATH,
          legacySyncPath: WECHAT_SYNC_PATH,
        }
      : {}),
  }
}

export function normalizeWechatAccountId(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_WECHAT_ACCOUNT_ID
  return trimmed.replace(/[^a-zA-Z0-9_.@-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_WECHAT_ACCOUNT_ID
}

export async function saveAuthState(state: WechatAuthState, accountId?: string): Promise<void> {
  const storage = getWechatAccountStorage(accountId)
  writeGatewayJsonFile<TokenFile>(storage.tokenPath, {
    bot_token: state.botToken,
    baseurl: state.baseUrl,
    ilink_user_id: state.ilinkUserId,
    ilink_bot_id: state.ilinkBotId,
  })
}

export async function loadAuthState(accountId?: string): Promise<WechatAuthState | null> {
  const storage = getWechatAccountStorage(accountId)
  const saved = readGatewayJsonFile<TokenFile | null>(
    storage.tokenPath,
    storage.legacyTokenPath ? readGatewayJsonFile<TokenFile | null>(storage.legacyTokenPath, null) : null,
  )
  if (typeof saved?.bot_token !== 'string' || !saved.bot_token) {
    return null
  }

  return {
    botToken: saved.bot_token,
    baseUrl: typeof saved.baseurl === 'string' && saved.baseurl ? saved.baseurl : DEFAULT_ILINK_BASE_URL,
    ilinkUserId: saved.ilink_user_id,
    ilinkBotId: saved.ilink_bot_id,
  }
}

export async function clearAuthState(accountId?: string): Promise<void> {
  const storage = getWechatAccountStorage(accountId)
  deleteGatewayFile(storage.tokenPath)
  deleteGatewayFile(storage.syncPath)
  if (storage.legacyTokenPath) deleteGatewayFile(storage.legacyTokenPath)
  if (storage.legacySyncPath) deleteGatewayFile(storage.legacySyncPath)
}

export function saveGetUpdatesBuf(getUpdatesBuf: string, accountId?: string): void {
  writeGatewayJsonFile<SyncFile>(getWechatAccountStorage(accountId).syncPath, { get_updates_buf: getUpdatesBuf })
}

export function loadGetUpdatesBuf(accountId?: string): string {
  const storage = getWechatAccountStorage(accountId)
  const saved = readGatewayJsonFile<SyncFile | null>(
    storage.syncPath,
    storage.legacySyncPath ? readGatewayJsonFile<SyncFile | null>(storage.legacySyncPath, null) : null,
  )
  return typeof saved?.get_updates_buf === 'string' ? saved.get_updates_buf : ''
}

export async function readIlinkJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) {
    gatewayLogger('wechat.ilink').error('iLink request failed', { label, status: response.status, body: text })
    throw new Error(`iLink ${label} failed with HTTP ${response.status}`)
  }

  try {
    return text ? JSON.parse(text) : {}
  } catch (error) {
    gatewayLogger('wechat.ilink').error('iLink returned a non-JSON response', { label, body: text })
    throw error
  }
}

function isQRCodeResponse(value: unknown): value is QRCodeResponse {
  return isRecord(value)
    && typeof value.qrcode === 'string'
    && typeof value.qrcode_img_content === 'string'
}

function isQRCodeStatusResponse(value: unknown): value is QRCodeStatusResponse {
  return isRecord(value) && typeof value.status === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(part => (Number.isFinite(part) ? part : 0))

  return ((major & 0xFF) << 16) | ((minor & 0xFF) << 8) | (patch & 0xFF)
}
