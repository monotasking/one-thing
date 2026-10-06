/**
 * 凭证的**口令导出 / 导入**(第④步批 0,`docs/design/two-process-2026-10.md` §2.1 第 5 条)。
 *
 * 主密钥丢了(钥匙串条目被删、换电脑)= 凭证全丢,所以导出 / 导入是长期功能,不只是迁移的一步。
 * 导出文件把**全部空间**的凭证池封进一份 JSON:口令经 scrypt(Node 内建)派生出一把 32 字节的钥匙,
 * AES-256-GCM 加密;文件自带格式名、版本、盐与派生参数,导入时不用猜。
 *
 * **任何接口不返回凭证原文**:导出交出去的是密文文件;导入只答「导入了几条、哪些空间不在」。
 * 口令只在这一次调用里活着,不落盘、不进日志。
 *
 * 导入是**合并**:同一个空间同一家服务商里,id 相同的条目换成文件里那一条,其余追加;池里原有
 * 的条目一条不删。文件里有、这台机器上没有的空间跳过并如实报出(空间要先建,凭证跟着空间走)。
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import {
  parseSpaceCredentialsFile,
  readSpaceCredentials,
  writeSpaceCredentials,
  type SpaceCredentialsFile,
  type SpaceProviderCredentials,
} from './credentials-pool.js'

export const CREDENTIALS_EXPORT_FORMAT = 'onething-credentials-export'
const EXPORT_VERSION = 1
/** scrypt 参数:N = 2^15 在一台普通笔记本上约 100ms,足够挡住离线猜口令里最便宜的那一档。 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const AAD = Buffer.from(`${CREDENTIALS_EXPORT_FORMAT}/v${EXPORT_VERSION}`, 'utf8')

export type CredentialsExportError = 'empty-passphrase' | 'not-an-export' | 'wrong-passphrase'

export class CredentialsExportFailure extends Error {
  constructor(readonly reason: CredentialsExportError) {
    super(`credentials export/import failed (${reason})`)
    this.name = 'CredentialsExportFailure'
  }
}

interface ExportFile {
  format: typeof CREDENTIALS_EXPORT_FORMAT
  version: number
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

interface ExportPayload {
  exportedAt: number
  spaces: Record<string, SpaceCredentialsFile>
}

/** 异步派生(scrypt 约 100ms,同步版会把后端的事件循环停住那么久)。 */
function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, 32, { ...params, maxmem: SCRYPT.maxmem }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

/**
 * 把这些空间的凭证池封成一份导出文件(文本)。调用方要先确认凭证此刻读得开 —— 锁着时读到的
 * 是空池,导出一份空文件只会让人以为备份过了。
 */
export async function exportCredentialsWithPassphrase(
  passphrase: string,
  spaceIds: readonly string[],
  now: number = Date.now(),
): Promise<{ fileName: string; data: string; entries: number }> {
  if (!passphrase) throw new CredentialsExportFailure('empty-passphrase')
  const spaces: Record<string, SpaceCredentialsFile> = {}
  let entries = 0
  for (const spaceId of spaceIds) {
    const pool = readSpaceCredentials(spaceId)
    const count = Object.values(pool.providers).reduce((sum, provider) => sum + provider.entries.length, 0)
    if (count === 0) continue
    spaces[spaceId] = pool
    entries += count
  }
  const payload: ExportPayload = { exportedAt: now, spaces }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt, SCRYPT), iv)
  cipher.setAAD(AAD)
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const file: ExportFile = {
    format: CREDENTIALS_EXPORT_FORMAT,
    version: EXPORT_VERSION,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  }
  const stamp = new Date(now).toISOString().slice(0, 10)
  return { fileName: `onething-credentials-${stamp}.json`, data: JSON.stringify(file, null, 2), entries }
}

function parseExportFile(text: string): ExportFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CredentialsExportFailure('not-an-export')
  }
  const file = raw as Partial<ExportFile> | null
  const kdf = file?.kdf
  if (
    !file || file.format !== CREDENTIALS_EXPORT_FORMAT || file.version !== EXPORT_VERSION
    || file.cipher !== 'aes-256-gcm' || !kdf || kdf.name !== 'scrypt'
    || ![kdf.N, kdf.r, kdf.p].every(n => Number.isInteger(n) && (n as number) > 0)
    || typeof kdf.salt !== 'string' || typeof file.iv !== 'string'
    || typeof file.tag !== 'string' || typeof file.data !== 'string'
  ) {
    throw new CredentialsExportFailure('not-an-export')
  }
  return file as ExportFile
}

/** 拆开一份导出文件。口令不对(GCM 校验不过)抛 `wrong-passphrase`。 */
export async function openCredentialsExport(passphrase: string, text: string): Promise<Record<string, SpaceCredentialsFile>> {
  if (!passphrase) throw new CredentialsExportFailure('empty-passphrase')
  const file = parseExportFile(text)
  let plaintext: string
  try {
    const key = await deriveKey(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'))
    decipher.setAAD(AAD)
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
    plaintext = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new CredentialsExportFailure('wrong-passphrase')
  }
  const payload = JSON.parse(plaintext) as Partial<ExportPayload>
  const spaces: Record<string, SpaceCredentialsFile> = {}
  for (const [spaceId, pool] of Object.entries(payload.spaces ?? {})) {
    const parsed = parseSpaceCredentialsFile(pool)
    if (parsed) spaces[spaceId] = parsed
  }
  return spaces
}

function mergeProvider(
  current: SpaceProviderCredentials | undefined,
  incoming: SpaceProviderCredentials,
): { section: SpaceProviderCredentials; changed: number } {
  if (!current) return { section: incoming, changed: incoming.entries.length }
  const entries = [...current.entries]
  for (const entry of incoming.entries) {
    const index = entries.findIndex(existing => existing.id === entry.id)
    if (index >= 0) entries[index] = entry
    else entries.push(entry)
  }
  return { section: { entries, policy: current.policy }, changed: incoming.entries.length }
}

/**
 * 把导出文件合并进这台机器的凭证池。写之前调用方要 `await prepareCredentialsWrite()`(钥匙丢了时
 * 导入就是换钥匙的那一刻)。
 */
export async function importCredentialsWithPassphrase(
  passphrase: string,
  text: string,
  hasSpace: (spaceId: string) => boolean,
): Promise<{ imported: number; skippedSpaces: string[] }> {
  const spaces = await openCredentialsExport(passphrase, text)
  let imported = 0
  const skippedSpaces: string[] = []
  for (const [spaceId, pool] of Object.entries(spaces)) {
    if (!hasSpace(spaceId)) {
      skippedSpaces.push(spaceId)
      continue
    }
    const current = readSpaceCredentials(spaceId)
    const providers = { ...current.providers }
    for (const [providerId, section] of Object.entries(pool.providers)) {
      const merged = mergeProvider(providers[providerId], section)
      providers[providerId] = merged.section
      imported += merged.changed
    }
    writeSpaceCredentials(spaceId, { providers })
  }
  return { imported, skippedSpaces }
}
