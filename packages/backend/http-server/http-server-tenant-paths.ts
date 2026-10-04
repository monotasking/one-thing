import fs from 'node:fs'
import path from 'node:path'

const SAFE_TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MIGRATION_HINT = 'Use a unique ASCII tenant ID (letters, digits, underscore or hyphen). Existing data requires an explicit offline migration; no legacy directory is renamed or guessed.'

/** Retains existing safe names verbatim, including uppercase. Tenant IDs are not product space IDs. */
export function validateTenantId(value: string): string {
  if (!SAFE_TENANT_ID.test(value) || WINDOWS_RESERVED.test(value)) {
    throw new Error(`Invalid tenant ID ${JSON.stringify(value)}. ${MIGRATION_HINT}`)
  }
  return value
}

/** Validate the complete configured scope set, including case-insensitive filesystems. */
export function validateTenantScopes(ownerId: string, defaultScope: string, allowedScopes: readonly string[]): void {
  validateTenantId(ownerId)
  validateTenantId(defaultScope)
  if (!allowedScopes.includes(defaultScope)) throw new Error('The default tenant scope must be allowed')
  const spellings = new Map<string, string>()
  for (const scope of allowedScopes) {
    validateTenantId(scope)
    const key = scope.toLowerCase()
    const previous = spellings.get(key)
    if (previous !== undefined && previous !== scope) {
      throw new Error(`Tenant scopes ${JSON.stringify(previous)} and ${JSON.stringify(scope)} collide on supported filesystems. ${MIGRATION_HINT}`)
    }
    spellings.set(key, scope)
  }
}

function existingSpelling(parent: string, name: string): void {
  let entries: string[]
  try { entries = fs.readdirSync(parent) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const other = entries.find(entry => entry !== name && entry.toLowerCase() === name.toLowerCase())
  if (other) throw new Error(`Tenant directory ${JSON.stringify(name)} collides with existing ${JSON.stringify(other)}. ${MIGRATION_HINT}`)
}

export function tenantDirectory(root: string, ownerId: string, scopeId: string): string {
  validateTenantId(ownerId)
  validateTenantId(scopeId)
  existingSpelling(root, ownerId)
  const ownerRoot = path.join(root, ownerId)
  existingSpelling(ownerRoot, scopeId)
  return path.join(ownerRoot, scopeId)
}

export function tenantKey(ownerId: string, scopeId: string): string {
  return JSON.stringify([validateTenantId(ownerId), validateTenantId(scopeId)])
}

/**
 * 默认租户:单用户宿主上没有带身份的请求时,一律按这一位算(`local-user` / `default`)。
 * 2026-10-04 随 server runtime 拆分从 `http-server-runtime.ts` 搬来(决策 D219),各功能的
 * server 门面与名册读同一份。
 */
export function defaultRequestContext(): { userId: string; workspaceId: string } {
  return {
    userId: 'local-user',
    workspaceId: 'default',
  }
}

/** 这个请求上下文是不是默认租户(两格都相同)。 */
export function isDefaultServerRequestContext(
  context: { userId: string; workspaceId: string } = defaultRequestContext(),
): boolean {
  const defaultContext = defaultRequestContext()
  return (
    context.userId === defaultContext.userId &&
    context.workspaceId === defaultContext.workspaceId
  )
}

/** 按 owner 分表时用的键(校验两格,与 `tenantKey` 同一个算法)。 */
export function ownerKey(context: { userId: string; workspaceId: string } = defaultRequestContext()): string {
  return tenantKey(context.userId, context.workspaceId)
}
