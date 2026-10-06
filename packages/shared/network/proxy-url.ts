/**
 * 代理地址的合法性判据(一处产地)。
 *
 * 后端的受管 fetch(`packages/backend/network/`)与 Electron 主进程给自己的 session 套代理
 * (`apps/desktop-react/electron/network-proxy.ts`)要对同一个地址给出同一个判词。第④步批 2b 起
 * 两者住在两个进程里,Electron 那一侧不再能运行期 import 后端,所以判据搬到 `@shared`:纯函数,零依赖。
 */
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
