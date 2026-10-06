/**
 * 旧 `safeStorage` 密文的**解密器**(第④步批 0 立,批 2b 改成「Electron 先读后交」,
 * `docs/design/two-process-2026-10.md` §2.3 第 12 条)。
 *
 * 批 0 之前凭证池整份用 Electron 的 `safeStorage` 加密;之后改用后端自己的主密钥
 * (`credentials-master-key.ts`)。存量的 `encryption: 'safeStorage'` 文件要搬进新信封,而能解开它们的
 * 只有那个签过名的 Electron app。批 0 时后端还在 Electron 进程里,宿主端口那一格直接递 `safeStorage`;
 * 批 2b 起后端是 Electron 拉起的**另一个进程**,`safeStorage` 递不过来了,于是改成:
 *
 *  1. Electron 在拉起后端**之前**读出仍为 `encryption: 'safeStorage'` 的凭证文件(以及旧单槽
 *     `oauth-tokens.json` 里的密文条目),用 `safeStorage` 解开(此刻还没有写者,OAuth 刷新不会让它过期);
 *  2. 后端就绪后经 `spaces.handOverLegacyCredentials` 一条 RPC(只给本机信任的来访者)把
 *     「密文 → 明文」逐条交进来;
 *  3. 这里把那张对照表装成一只**只认这几条密文**的解密器,`credentials-safestorage-migration.ts` 用它
 *     走批 0 同一套判据:解开 → 写 `.migrating` → 逐条校验 → 旧文件改名 `.safestorage-backup`。
 *
 * 类型上仍然只有 `isEncryptionAvailable` 与 `decryptString` 两个方法(读池、迁移、旧单槽三处读者一个字
 * 不用改),写侧拿不到它。没交过的密文解不开 = 抛,读路照旧当「已锁定 · 旧密文待迁移」。
 * 独立 server 与 CLI 守护进程没有人交,遇到旧密文就进「已锁定」,等桌面来交。
 */

/** 能解开旧 `safeStorage` 密文的那一口。形状是 Electron `safeStorage` 的子集。 */
export interface LegacySafeStorageDecryptor {
  isEncryptionAvailable(): boolean
  decryptString(buffer: Buffer): string
}

/** Electron 交进来的一条:密文(落盘时那段 base64 原样)与它解开后的明文。 */
export interface LegacyCiphertextPlaintext {
  readonly ciphertext: string
  readonly plaintext: string
}

/** 交进来的对照表。进程级:一个后端进程只服务一个 store,交一次就够用到进程退出。 */
const handedOver: { table: Map<string, string> } = { table: new Map() }

/**
 * 收下 Electron 交进来的「密文 → 明文」。**累加**:同一条密文再交一次是同一个答案,不同的密文各记各的。
 * 空串密文丢掉(落盘格式里不存在那种密文,收下只会让一次空串查询「解得开」)。答收下了几条。
 */
export function acceptHandedOverLegacyPlaintexts(entries: readonly LegacyCiphertextPlaintext[]): number {
  let accepted = 0
  for (const entry of entries) {
    if (typeof entry?.ciphertext !== 'string' || typeof entry.plaintext !== 'string' || !entry.ciphertext) continue
    handedOver.table.set(entry.ciphertext, entry.plaintext)
    accepted += 1
  }
  return accepted
}

/** 测试之间清掉交进来的对照表。 */
export function resetHandedOverLegacyPlaintextsForTests(): void {
  handedOver.table.clear()
}

const handedOverDecryptor: LegacySafeStorageDecryptor = {
  isEncryptionAvailable: () => handedOver.table.size > 0,
  decryptString(buffer: Buffer): string {
    const plaintext = handedOver.table.get(buffer.toString('base64'))
    if (plaintext === undefined) throw new Error('this safeStorage ciphertext was not handed over by the desktop app')
    return plaintext
  },
}

/** 此刻能用的旧解密器;还没人交过任何一条就答 `undefined`。永不抛。 */
export function legacySafeStorageDecryptor(): LegacySafeStorageDecryptor | undefined {
  return handedOverDecryptor.isEncryptionAvailable() ? handedOverDecryptor : undefined
}
