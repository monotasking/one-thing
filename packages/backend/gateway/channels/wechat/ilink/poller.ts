import {
  buildBaseInfo,
  DEFAULT_ILINK_BASE_URL,
  loadGetUpdatesBuf,
  makeHeaders,
  readIlinkJson,
  saveGetUpdatesBuf,
} from './auth.js'
import { gatewayLogger } from '../../../core/logging.js'
import type { GetUpdatesResponse, WeixinMessage } from './types.js'

const POLL_TIMEOUT_MS = 40_000
const ERROR_RETRY_MS = 3_000
const STALE_TOKEN_ERRCODE = -14

export class ILinkPoller {
  private readonly log = gatewayLogger('wechat.poller')
  private running = false
  private getUpdatesBuf: string
  private abortController: AbortController | null = null
  private loopPromise: Promise<void> | null = null
  private timeoutMs = POLL_TIMEOUT_MS

  constructor(
    private readonly botToken: string,
    private readonly onMessage: (msg: WeixinMessage) => Promise<void>,
    private readonly baseUrl = DEFAULT_ILINK_BASE_URL,
    private readonly accountId?: string,
  ) {
    this.getUpdatesBuf = loadGetUpdatesBuf(accountId)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.abortController?.abort()
    await this.loopPromise
    this.loopPromise = null
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.pollOnce()
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          this.timeoutMs = response.longpolling_timeout_ms + 5_000
        }

        if (isApiError(response)) {
          if (isStaleToken(response)) {
            this.log.error('WeChat token expired — delete the stored token and restart to relogin', {
              accountId: this.accountId,
              tokenFile: '<store>/gateway/wechat-token.json',
            })
            this.running = false
            return
          }
          throw new Error(`getupdates ret=${response.ret ?? ''} errcode=${response.errcode ?? ''} errmsg=${response.errmsg ?? ''}`)
        }

        if (response.get_updates_buf) {
          this.getUpdatesBuf = response.get_updates_buf
          saveGetUpdatesBuf(this.getUpdatesBuf, this.accountId)
        }

        for (const msg of response.msgs ?? []) {
          try {
            await this.onMessage(msg)
          } catch (error) {
            this.log.error('message handler failed', { accountId: this.accountId }, error)
          }
        }
      } catch (error) {
        if (!this.running) return
        if (isAbortError(error)) continue

        this.log.error('poll failed', { accountId: this.accountId }, error)
        await delay(ERROR_RETRY_MS)
      }
    }
  }

  private async pollOnce(): Promise<GetUpdatesResponse> {
    let timedOut = false
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    this.abortController = controller

    try {
      const response = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: makeHeaders(this.botToken),
        body: JSON.stringify({
          get_updates_buf: this.getUpdatesBuf,
          base_info: buildBaseInfo(),
        }),
        signal: controller.signal,
      })
      const data = await readIlinkJson(response, 'getupdates')

      if (!isGetUpdatesResponse(data)) {
        this.log.error('unexpected getupdates response', { accountId: this.accountId, response: data })
        return recoverUnexpectedGetUpdatesResponse(data)
      }

      return data
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        throw new DOMException('getupdates timeout', 'AbortError')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      if (this.abortController === controller) {
        this.abortController = null
      }
    }
  }
}

function isGetUpdatesResponse(value: unknown): value is GetUpdatesResponse {
  if (!isRecord(value)) return false
  return (value.ret === undefined || typeof value.ret === 'number')
    && (value.errcode === undefined || typeof value.errcode === 'number')
    && (value.errmsg === undefined || typeof value.errmsg === 'string')
    && (value.msgs === undefined || Array.isArray(value.msgs))
    && (value.get_updates_buf === undefined || typeof value.get_updates_buf === 'string')
    && (value.sync_buf === undefined || typeof value.sync_buf === 'string')
    && (value.longpolling_timeout_ms === undefined || typeof value.longpolling_timeout_ms === 'number')
}

function recoverUnexpectedGetUpdatesResponse(value: unknown): GetUpdatesResponse {
  if (!isRecord(value)) return { msgs: [] }

  return {
    ret: typeof value.ret === 'number' ? value.ret : undefined,
    errcode: typeof value.errcode === 'number' ? value.errcode : undefined,
    errmsg: typeof value.errmsg === 'string' ? value.errmsg : undefined,
    msgs: Array.isArray(value.msgs) ? value.msgs as WeixinMessage[] : [],
    sync_buf: typeof value.sync_buf === 'string' ? value.sync_buf : undefined,
    get_updates_buf: typeof value.get_updates_buf === 'string' ? value.get_updates_buf : undefined,
    longpolling_timeout_ms: typeof value.longpolling_timeout_ms === 'number'
      ? value.longpolling_timeout_ms
      : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isApiError(response: GetUpdatesResponse): boolean {
  return (response.ret !== undefined && response.ret !== 0)
    || (response.errcode !== undefined && response.errcode !== 0)
}

function isStaleToken(response: GetUpdatesResponse): boolean {
  return response.ret === STALE_TOKEN_ERRCODE || response.errcode === STALE_TOKEN_ERRCODE
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
