/**
 * Host injection point for OAuth. The Electron host supplies net.fetch (with
 * app-fetch fallback); headless hosts leave it unset and get plain app fetch.
 *
 * 凭证的落盘加密从前也挂在这一格(`tokenCryptoAdapter`,Electron 的 `safeStorage`)。第④步批 0 起
 * 后端自己持有主密钥(`credentials/credentials-master-key.ts`),这一格删掉;旧 `safeStorage` 密文的
 * 迁移用解密器另立一格 `OnethingHostPorts.legacySafeStorageForMigration`(归凭证功能)。
 *
 * Late-bound: consulted per call, so wiring at host startup takes effect even
 * though the auth singletons are constructed at module import.
 */
export interface AuthHostPorts {
  authFetch?: typeof fetch
}

let hostPorts: AuthHostPorts = {}

export function configureAuthHost(ports: AuthHostPorts): void {
  hostPorts = ports
}

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetAuthHost(): void {
  hostPorts = {}
}

export function getAuthHostPorts(): AuthHostPorts {
  return hostPorts
}
