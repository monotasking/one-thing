export function parseJwtPayload(token?: string): Record<string, any> | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length < 2) return null

  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

export function parseJwtExpiration(token?: string): number | undefined {
  const payload = parseJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}
