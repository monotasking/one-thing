/**
 * **旧 `safeStorage` 密文「先读后交」的 Electron 那一半**(第④步批 2b,`docs/design/two-process-2026-10.md`
 * §2.3 第 12 条)。
 *
 * 批 0 之前凭证池整份用 Electron 的 `safeStorage` 加密;批 0 起后端用自己的主密钥,存量密文由后端在装配时
 * 迁走 —— 那时后端还在 Electron 进程里,能直接拿 `safeStorage` 当旧解密器。批 2b 起后端是 Electron 拉起的
 * **另一个进程**,`safeStorage` 递不过去了(它绑着这个签过名的 app 身份,子进程是另一只 node)。所以改成:
 *
 *  1. Electron 在拉起后端**之前**,读出仍为 `encryption: 'safeStorage'` 的凭证文件
 *     (`<store>/workspaces/<id>/credentials.json`)与旧单槽 `<store>/oauth-tokens.json` 里的密文条目,
 *     用 `safeStorage` 解开 —— 此刻没有写者,OAuth 刷新不会让它们过期(施工单修正 3「停旧后端」那条顺序);
 *  2. 后端就绪后,`main.ts` 经主进程那台客户端把这里产出的「密文 → 明文」交给
 *     `spaces.handOverLegacyCredentials`(只给本机信任的来访者),后端按批 0 同一套判据封进主密钥信封、
 *     逐条校验、旧文件改名 `.safestorage-backup`。
 *
 * 这只文件**只读不写**:一个字节都不改,改名与新信封全是后端的事(那边有逐条校验)。读不到、解不开的条目
 * 跳过并计数 —— 交不进去的那几条,后端照旧答「已锁定 · 旧密文待迁移」,不会因为这里少交一条就写坏什么。
 *
 * 零 electron import:解密器由 `main.ts` 递(生产里是 `safeStorage`),于是这只文件在 vitest 与
 * `gate:credentials` 里跑得起来(门里递一只假的)。大多数机器上它什么都找不到(已经迁完了),
 * 那是常态:返回空表,`main.ts` 就不发那条 RPC。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 能解开旧密文的那一口(Electron `safeStorage` 的子集)。 */
export interface LegacySafeStorageReader {
  isEncryptionAvailable(): boolean
  decryptString(buffer: Buffer): string
}

/** 交给后端的一条:落盘那段 base64 密文原样 + 解开后的明文。 */
export interface LegacyHandOverEntry {
  readonly ciphertext: string
  readonly plaintext: string
}

export interface LegacyHandOverScan {
  readonly entries: LegacyHandOverEntry[]
  /** 找到的旧密文条数(凭证文件 + 旧单槽条目)。 */
  readonly found: number
  /** 其中解不开的条数。 */
  readonly undecryptable: number
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** 盘上所有还是旧 `safeStorage` 信封的凭证文件里那段 `data`。 */
function legacyCredentialCiphertexts(storePath: string): string[] {
  const workspaces = path.join(storePath, 'workspaces')
  let ids: string[]
  try {
    ids = fs.readdirSync(workspaces, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
  const out: string[] = []
  for (const id of ids) {
    const envelope = readJson(path.join(workspaces, id, 'credentials.json'))
    if (envelope?.encryption === 'safeStorage' && typeof envelope.data === 'string' && envelope.data) out.push(envelope.data)
  }
  return out
}

/**
 * 旧单槽 `oauth-tokens.json`:`{ providerId: <base64 密文 | JSON 明文> }`。只收密文那几条
 * (以 `{` 打头的是明文,后端自己读得开,判据与 `auth-token-store.ts` 的 `deserializeToken` 同一条)。
 */
function legacyOAuthSlotCiphertexts(storePath: string): string[] {
  const slot = readJson(path.join(storePath, 'oauth-tokens.json'))
  if (!slot) return []
  return Object.values(slot).filter((value): value is string => typeof value === 'string' && value !== '' && !value.trim().startsWith('{'))
}

/**
 * 扫这个 store、解开能解开的。解密器此刻不可用(`isEncryptionAvailable()` 为假、或它自己抛)= 一条都交不了,
 * 照实报 `undecryptable`。永不抛。
 */
export function readLegacySafeStorageForHandOver(storePath: string, reader: LegacySafeStorageReader | undefined): LegacyHandOverScan {
  const ciphertexts = [...new Set([...legacyCredentialCiphertexts(storePath), ...legacyOAuthSlotCiphertexts(storePath)])]
  if (ciphertexts.length === 0) return { entries: [], found: 0, undecryptable: 0 }
  let available = false
  try {
    available = reader?.isEncryptionAvailable() === true
  } catch {
    available = false
  }
  if (!reader || !available) return { entries: [], found: ciphertexts.length, undecryptable: ciphertexts.length }
  const entries: LegacyHandOverEntry[] = []
  for (const ciphertext of ciphertexts) {
    try {
      entries.push({ ciphertext, plaintext: reader.decryptString(Buffer.from(ciphertext, 'base64')) })
    } catch {
      // 解不开的那一条不交:后端照旧把它当「待迁」,下一次启动再试。
    }
  }
  return { entries, found: ciphertexts.length, undecryptable: ciphertexts.length - entries.length }
}
