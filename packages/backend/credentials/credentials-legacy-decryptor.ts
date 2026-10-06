/**
 * 旧 `safeStorage` 密文的**解密器**,宿主端口里的一格(`OnethingHostPorts.legacySafeStorageForMigration`,
 * 第④步批 0,`docs/design/two-process-2026-10.md` §2.1)。
 *
 * 批 0 之前凭证池整份用 Electron 的 `safeStorage` 加密;之后改用后端自己的主密钥
 * (`credentials-master-key.ts`)。存量的 `encryption: 'safeStorage'` 文件要搬进新信封,而能解开它们的
 * 只有那个签过名的 Electron app —— 所以桌面宿主把 `safeStorage` 递进来,**只当迁移用的旧解密器**:
 * 类型上只有 `isEncryptionAvailable` 与 `decryptString` 两个方法,写侧再也拿不到它。独立 server 与
 * CLI 守护进程写 `null`:它们解不开旧密文,遇到就进「已锁定」,等桌面来迁。
 *
 * 旧单槽 `<store>/oauth-tokens.json`(只剩读)的密文也是 `safeStorage` 封的,归位时同样经这一格解。
 *
 * 批 2 拆进程之后后端不在 Electron 里,这一格改成「Electron 先读旧文件、解开后交给后端」——
 * 那一步写在施工单 §2.3 的待办里,今天不做。
 */

/** 能解开旧 `safeStorage` 密文的那一口。形状是 Electron `safeStorage` 的子集。 */
export interface LegacySafeStorageDecryptor {
  isEncryptionAvailable(): boolean
  decryptString(buffer: Buffer): string
}

/** 宿主递进来的取法:每次现问(`safeStorage` 在 app ready 之前会抛)。 */
export type LegacySafeStorageProvider = () => LegacySafeStorageDecryptor | undefined

const legacySlot: { provider: LegacySafeStorageProvider | null } = { provider: null }

export function configureCredentialsLegacyDecryptorHost(provider: LegacySafeStorageProvider): void {
  legacySlot.provider = provider
}

/** 还原到未注入态(`applyHostPorts` 的还原函数逆序调它)。 */
export function resetCredentialsLegacyDecryptorHost(): void {
  legacySlot.provider = null
}

/** 此刻能用的旧解密器;宿主没给、或给了但此刻不可用,都答 `undefined`。永不抛。 */
export function legacySafeStorageDecryptor(): LegacySafeStorageDecryptor | undefined {
  try {
    const decryptor = legacySlot.provider?.()
    return decryptor?.isEncryptionAvailable() ? decryptor : undefined
  } catch {
    return undefined
  }
}
