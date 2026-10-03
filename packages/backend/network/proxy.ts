export interface OnethingProxySettings {
  enabled: boolean
  url: string
  bypassRules?: string
}

export type OnethingProxyUrlValidationResult =
  | { valid: true; normalizedUrl: string }
  | { valid: false; error: string }

export function validateOnethingProxyUrl(url: string): OnethingProxyUrlValidationResult {
  const trimmed = url.trim()
  if (!trimmed) return { valid: false, error: 'Proxy URL is required when proxy is enabled.' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { valid: false, error: 'Proxy URL is not a valid URL.' }
  }

  const protocol = parsed.protocol.toLowerCase()
  if (!['http:', 'https:', 'socks5:'].includes(protocol)) {
    return { valid: false, error: 'Proxy URL must use http://, https://, or socks5://.' }
  }
  if (!parsed.hostname) {
    return { valid: false, error: 'Proxy URL must include a host.' }
  }

  return { valid: true, normalizedUrl: parsed.toString() }
}

export function normalizeOnethingProxySettings<T extends OnethingProxySettings>(
  proxy?: T,
): (T & { enabled: true; url: string }) | undefined {
  if (!proxy?.enabled) return undefined
  const validated = validateOnethingProxyUrl(proxy.url)
  if (!validated.valid) {
    throw new Error(validated.error)
  }
  return {
    ...proxy,
    enabled: true,
    url: validated.normalizedUrl,
  }
}

export function splitOnethingProxyBypassRules(rules?: string): string[] {
  return (rules || '')
    .split(/[;,]/)
    .map(rule => rule.trim())
    .filter(Boolean)
}

export function onethingHostnameMatchesProxyBypassRule(hostname: string, rule: string): boolean {
  const lowerHost = hostname.toLowerCase()
  const lowerRule = rule.toLowerCase()
  if (lowerRule === '<local>') return !lowerHost.includes('.')
  if (lowerRule === lowerHost) return true
  if (lowerRule.startsWith('*.')) {
    const suffix = lowerRule.slice(1)
    return lowerHost.endsWith(suffix)
  }
  if (lowerRule.endsWith('*')) {
    return lowerHost.startsWith(lowerRule.slice(0, -1))
  }
  return false
}

export function shouldBypassOnethingProxy(input: RequestInfo | URL, bypassRules?: string): boolean {
  let url: URL
  try {
    url = input instanceof URL ? input : new URL(String(input))
  } catch {
    return false
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  return splitOnethingProxyBypassRules(bypassRules).some(rule =>
    onethingHostnameMatchesProxyBypassRule(hostname, rule),
  )
}

export function getOnethingNetworkDispatcherCacheKey(
  proxy: OnethingProxySettings | undefined,
): string {
  if (proxy) return `proxy#${proxy.url}#${proxy.bypassRules || ''}`
  return 'direct'
}
