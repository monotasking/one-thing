import {
  buildBaseInfo,
  DEFAULT_ILINK_BASE_URL,
  makeHeaders,
  readIlinkJson,
  type WechatAuthState,
} from './auth.js'
import { splitMarkdownText, WECHAT_MAX_TEXT_LENGTH } from '../../../core/markdown-safe-outbound-buffer.js'
import { gatewayLogger } from '../../../core/logging.js'

const RATE_LIMIT_RET = -2
const ILINK_SEND_MIN_INTERVAL_MS = 1_000
const ILINK_RATE_LIMIT_RETRY_BASE_MS = 3_000
const ILINK_RATE_LIMIT_MAX_ATTEMPTS = 4

export interface SendTextOptions {
  minSendIntervalMs?: number
  rateLimitRetryBaseMs?: number
  maxRateLimitAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

let lastSendStartedAt = 0
let sendSlotChain = Promise.resolve()

export async function sendText(
  auth: WechatAuthState,
  toUserId: string,
  contextToken: string,
  text: string,
  options: SendTextOptions = {},
): Promise<void> {
  const segments = splitMarkdownText(text, WECHAT_MAX_TEXT_LENGTH)
  for (let index = 0; index < segments.length; index += 1) {
    await sendTextSegment(auth, toUserId, contextToken, segments[index], {
      index,
      total: segments.length,
      options,
    })
  }
}

export function resetWechatSenderRateLimitForTests(): void {
  lastSendStartedAt = 0
  sendSlotChain = Promise.resolve()
}

async function sendTextSegment(
  auth: WechatAuthState,
  toUserId: string,
  contextToken: string,
  segment: string,
  context: { index: number; total: number; options: SendTextOptions },
): Promise<void> {
  const maxAttempts = Math.max(1, context.options.maxRateLimitAttempts ?? ILINK_RATE_LIMIT_MAX_ATTEMPTS)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await postSendMessage(auth, toUserId, contextToken, segment, context.options)
    let data: unknown
    try {
      data = await readIlinkJson(response, 'sendmessage')
    } catch (error) {
      throw new Error(
        `sendmessage failed ${formatSegmentRequestContext(response.status, segment, context)}: ${formatError(error)}`,
      )
    }

    if (!isRecord(data) || typeof data.ret !== 'number' || data.ret === 0) {
      return
    }

    if (data.ret === RATE_LIMIT_RET && attempt < maxAttempts) {
      const delayMs = rateLimitRetryDelayMs(attempt, context.options)
      gatewayLogger('wechat.sender').warn('sendmessage rate limited, retrying', {
        delayMs,
        attempt,
        maxAttempts,
        context: formatSegmentContext(response.status, segment, context, data),
      })
      await sleep(delayMs, context.options)
      continue
    }

    throw new Error(formatSendMessageError(data, response.status, segment, context))
  }
}

async function postSendMessage(
  auth: WechatAuthState,
  toUserId: string,
  contextToken: string,
  segment: string,
  options: SendTextOptions,
): Promise<Response> {
  await waitForSendSlot(options)
  try {
    return await fetch(`${auth.baseUrl || DEFAULT_ILINK_BASE_URL}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: makeHeaders(auth.botToken),
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: createClientId(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: segment } }],
        },
        base_info: buildBaseInfo(),
      }),
    })
  } catch (error) {
    lastSendStartedAt = Date.now()
    throw error
  }
}

export async function sendTyping(
  auth: WechatAuthState,
  toUserId: string,
  contextToken?: string,
  status: 1 | 2 = 1,
): Promise<void> {
  try {
    const baseUrl = auth.baseUrl || DEFAULT_ILINK_BASE_URL
    const ilinkUserId = toUserId
    const configResponse = await fetch(`${baseUrl}/ilink/bot/getconfig`, {
      method: 'POST',
      headers: makeHeaders(auth.botToken),
      body: JSON.stringify({
        ilink_user_id: ilinkUserId,
        context_token: contextToken,
        base_info: buildBaseInfo(),
      }),
    })
    const config = await readIlinkJson(configResponse, 'getconfig')

    if (!isRecord(config) || typeof config.typing_ticket !== 'string') {
      gatewayLogger('wechat.sender').error('unexpected getconfig response', { response: config })
      return
    }

    const typingResponse = await fetch(`${baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: makeHeaders(auth.botToken),
      body: JSON.stringify({
        ilink_user_id: ilinkUserId,
        typing_ticket: config.typing_ticket,
        status,
        base_info: buildBaseInfo(),
      }),
    })
    await readIlinkJson(typingResponse, 'sendtyping')
  } catch (error) {
    gatewayLogger('wechat.sender').warn('send typing failed', {}, error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

async function waitForSendSlot(options: SendTextOptions): Promise<void> {
  const minIntervalMs = options.minSendIntervalMs ?? ILINK_SEND_MIN_INTERVAL_MS
  if (minIntervalMs <= 0) return

  const waitForSlot = sendSlotChain.then(async () => {
    const elapsedMs = Date.now() - lastSendStartedAt
    const waitMs = lastSendStartedAt === 0 ? 0 : minIntervalMs - elapsedMs
    if (waitMs > 0) {
      await sleep(waitMs, options)
    }
    lastSendStartedAt = Date.now()
  })
  sendSlotChain = waitForSlot.catch(() => {})
  await waitForSlot
}

function rateLimitRetryDelayMs(attempt: number, options: SendTextOptions): number {
  const baseMs = options.rateLimitRetryBaseMs ?? ILINK_RATE_LIMIT_RETRY_BASE_MS
  return baseMs * attempt
}

async function sleep(ms: number, options: SendTextOptions): Promise<void> {
  const delay = options.sleep ?? defaultSleep
  await delay(Math.max(0, ms))
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatSendMessageError(
  data: Record<string, unknown>,
  httpStatus: number,
  segment: string,
  context: { index: number; total: number },
): string {
  const ret = typeof data.ret === 'number' ? data.ret : ''
  const errmsg = typeof data.errmsg === 'string' ? data.errmsg : ''
  return `sendmessage ret=${ret} errmsg=${errmsg} ${formatSegmentContext(httpStatus, segment, context, data)}`
}

function formatSegmentContext(
  httpStatus: number,
  segment: string,
  context: { index: number; total: number },
  data: Record<string, unknown>,
): string {
  return [
    `http=${httpStatus}`,
    `segment=${context.index + 1}/${context.total}`,
    `chars=${segment.length}`,
    `response=${safeJson(data)}`,
  ].join(' ')
}

function formatSegmentRequestContext(
  httpStatus: number,
  segment: string,
  context: { index: number; total: number },
): string {
  return [
    `http=${httpStatus}`,
    `segment=${context.index + 1}/${context.total}`,
    `chars=${segment.length}`,
  ].join(' ')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createClientId(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `onething-gateway-${id}`
}
