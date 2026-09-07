import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { RuntimeRequestContext } from '@onething/core'
import { validateTenantScopes } from './tenant-paths.js'

export interface HttpIdentityOptions {
  defaultUserId?: string
  defaultWorkspaceId?: string
  allowedWorkspaceIds?: readonly string[]
  authToken?: string
}

type IdentityResult = { context: RuntimeRequestContext; error?: never } | { error: string; context?: never }

/** Capture the trusted operator and tenant allow-list once per HTTP host. */
export function createHttpRequestIdentity(input: HttpIdentityOptions): (request: IncomingMessage) => IdentityResult {
  const defaultUserId = input.defaultUserId ?? 'local-user'
  const defaultWorkspaceId = input.defaultWorkspaceId ?? 'default'
  const allowedWorkspaceIds = Object.freeze([...(input.allowedWorkspaceIds ?? [defaultWorkspaceId])])
  validateTenantScopes(defaultUserId, defaultWorkspaceId, allowedWorkspaceIds)
  const options = Object.freeze({ ...input, defaultUserId, defaultWorkspaceId, allowedWorkspaceIds })
  return request => {
    const error = request.method === 'OPTIONS' ? undefined : checkRequestAuthorization(request, options)
    return error ? { error } : { context: getRuntimeRequestContext(request, options) }
  }
}

function getRuntimeRequestContext(
  request: IncomingMessage,
  options: HttpIdentityOptions,
): RuntimeRequestContext {
  return {
    userId: options.defaultUserId || 'local-user',
    workspaceId: readHeader(request, 'x-onething-workspace-id')
      || options.defaultWorkspaceId || 'default',
    authToken: readBearerToken(request),
    origin: readHeader(request, 'origin'),
  }
}


function checkRequestAuthorization(
  request: IncomingMessage,
  options: HttpIdentityOptions,
): string | undefined {
  if (options.authToken) {
    // 2026-09-04 起只认 Bearer 头:从前 `GET /api/events` 额外认 `?token=`,是给浏览器 `EventSource`
    // (带不了 header)留的口;@onething/client 用 fetch 流解析 SSE 后全仓无人再构造它,Vue 壳退役时删。
    const bearer = readBearerToken(request)
    if (!bearer || !tokenMatches(bearer, options.authToken)) {
      return 'Unauthorized: this server requires a Bearer token (ONETHING_SERVER_TOKEN).'
    }
  } else if (readHeader(request, 'x-onething-user-id') || readHeader(request, 'x-onething-workspace-id')) {
    return 'Unauthorized: identity headers are rejected unless the server has an auth token configured (ONETHING_SERVER_TOKEN).'
  }
  const userId = readHeader(request, 'x-onething-user-id')
  if (userId !== undefined && userId !== (options.defaultUserId ?? 'local-user')) {
    return 'Unauthorized: the identity header does not match the configured operator.'
  }
  const workspaceId = readHeader(request, 'x-onething-workspace-id')
  if (workspaceId !== undefined && !(options.allowedWorkspaceIds ?? [options.defaultWorkspaceId ?? 'default']).includes(workspaceId)) {
    return 'Unauthorized: this tenant scope is not allowed by the server.'
  }
  return undefined
}

function tokenMatches(provided: string, expected: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const providedDigest = createHash('sha256').update(provided).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

export function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const authorization = readHeader(request, 'authorization')
  if (!authorization?.startsWith('Bearer ')) return undefined
  return authorization.slice('Bearer '.length)
}

