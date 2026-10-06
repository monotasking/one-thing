/**
 * `credentials.json` 的落盘加密(批 B8-1 立,第④步批 0 换成后端自己的主密钥)。
 *
 * 守六件事:
 *
 *  1. **老明文文件零迁移**:读得出,并且**下一次写入自动升级成主密钥密文**。
 *  2. **密文往返**:apiKey / oauthToken 都不该以明文出现在盘上。
 *  3. **`none` 档诚实降级**:写明文,并在文件里**如实标注** `encryption: "none"`。
 *  4. **掩码 preview 在加密态下照常正确**:掩码算在解密后的内存结构上。
 *  5. **钥匙此刻不在 = 锁定,不是空池也不是明文**:读答空但不进缓存,写抛 `CredentialsLockedError`,
 *     绝不拿一份空池覆盖解不开的那份。
 *  6. **换过钥匙之后**:旧钥匙封的那份读不开,下一次写那个空间时改名留底。
 *
 * 加密那几条走 `file` 档(主密钥落在临时 store 里);vitest 全局 setup 强制的是 `none` 档。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureRuntimeLogs } from '../../logging/logging.js'
import {
  CredentialsLockedError,
  getSpaceProviderCredentials,
  previewSpaceCredentialApiKey,
  readSpaceCredentials,
  resetSpaceCredentialsCacheForTests,
  spaceCredentialsEncryptionAtRest,
  spaceCredentialsFilePath,
  SPACE_CREDENTIALS_SCHEMA_VERSION,
  upsertSpaceProviderApiKey,
  upsertSpaceProviderOAuthToken,
  writeSpaceCredentials,
} from '../credentials-pool.js'
import { masterKeyFilePath, resetCredentialsMasterKeyForTests } from '../credentials-master-key.js'
import { prepareCredentialsWrite } from '../credentials-locked-state.js'
import { setRootDirForTests } from '@onething/backend/space'

let tmpDir: string
let storeDir: string

async function readRawFile(spaceId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(spaceCredentialsFilePath(spaceId), 'utf-8'))
}

/** 换到 `file` 档:主密钥落在这间临时 store 里。 */
async function useFileTier(): Promise<void> {
  vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'file')
  resetCredentialsMasterKeyForTests()
  await prepareCredentialsWrite()
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-creds-enc-'))
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-creds-store-'))
  vi.stubEnv('ONETHING_STORE_PATH', storeDir)
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  resetCredentialsMasterKeyForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  vi.unstubAllEnvs()
  // 持有器按「档位 + store」分格,是模块级的 —— 不清会串到同一进程里的别的测试文件。
  resetCredentialsMasterKeyForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
  await fs.rm(storeDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const pool = {
  providers: {
    deepseek: {
      entries: [{
        id: 'e1',
        label: 'DeepSeek',
        authType: 'apiKey' as const,
        apiKey: 'sk-abcdef0123456789',
        source: 'user',
      }],
      policy: 'single',
    },
  },
}

describe('encrypted round trip', () => {
  it('never leaves the api key in the file body', async () => {
    await useFileTier()
    writeSpaceCredentials('work', pool)

    const raw = await readRawFile('work')
    expect(raw.encryption).toBe('master-key')
    expect(raw.version).toBe(SPACE_CREDENTIALS_SCHEMA_VERSION)
    expect(typeof raw.keyId).toBe('string')
    expect(raw.providers).toBeUndefined()
    expect(JSON.stringify(raw)).not.toContain('sk-abcdef0123456789')

    resetSpaceCredentialsCacheForTests()
    expect(readSpaceCredentials('work').providers.deepseek.entries[0].apiKey).toBe(
      'sk-abcdef0123456789',
    )
  })

  it('stores the file-tier key with 0600 permissions inside the store', async () => {
    await useFileTier()
    const stat = await fs.stat(masterKeyFilePath(storeDir))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('covers oauth tokens too — the whole file is the secret zone', async () => {
    await useFileTier()
    upsertSpaceProviderOAuthToken('work', 'codex', {
      label: 'me@example.com',
      token: { accessToken: 'at-supersecret', refreshToken: 'rt-supersecret', expiresAt: 1 },
    })

    const onDisk = await fs.readFile(spaceCredentialsFilePath('work'), 'utf-8')
    expect(onDisk).not.toContain('at-supersecret')
    expect(onDisk).not.toContain('rt-supersecret')

    resetSpaceCredentialsCacheForTests()
    const entry = readSpaceCredentials('work').providers.codex.entries[0]
    expect(entry.oauthToken).toMatchObject({ accessToken: 'at-supersecret' })
  })

  it('a tampered ciphertext degrades to an empty pool, never a half pool', async () => {
    await useFileTier()
    writeSpaceCredentials('work', pool)
    resetSpaceCredentialsCacheForTests()
    const raw = await readRawFile('work')
    const data = Buffer.from(String(raw.data), 'base64')
    data[data.length - 1] ^= 0xff
    await fs.writeFile(spaceCredentialsFilePath('work'), JSON.stringify({ ...raw, data: data.toString('base64') }), 'utf-8')

    const logs = captureRuntimeLogs()
    expect(readSpaceCredentials('work')).toEqual({ providers: {} })
    expect(logs.ofLevel('warn').length).toBeGreaterThan(0)
    logs.restore()
  })
})

describe('lazy upgrade from the legacy plaintext file', () => {
  it('reads a pre-B8 file that has no envelope at all', async () => {
    await fs.mkdir(path.join(tmpDir, 'work'), { recursive: true })
    await fs.writeFile(spaceCredentialsFilePath('work'), JSON.stringify(pool), 'utf-8')

    await useFileTier()
    expect(readSpaceCredentials('work').providers.deepseek.entries[0].apiKey).toBe(
      'sk-abcdef0123456789',
    )
  })

  it('upgrades it to ciphertext on the next write — no migration step', async () => {
    await fs.mkdir(path.join(tmpDir, 'work'), { recursive: true })
    await fs.writeFile(spaceCredentialsFilePath('work'), JSON.stringify(pool), 'utf-8')
    await useFileTier()

    // 任意一次正常写入(这里是换密钥)就完成升级。
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-newkey0123456789' })

    const raw = await readRawFile('work')
    expect(raw.encryption).toBe('master-key')
    expect(JSON.stringify(raw)).not.toContain('sk-newkey0123456789')

    resetSpaceCredentialsCacheForTests()
    expect(getSpaceProviderCredentials('work', 'deepseek')?.entries[0].apiKey).toBe(
      'sk-newkey0123456789',
    )
  })
})

describe('honest plaintext under the none tier', () => {
  it('writes plaintext and says so in the file', async () => {
    expect(spaceCredentialsEncryptionAtRest()).toBe('none')
    writeSpaceCredentials('work', pool)

    const raw = await readRawFile('work')
    expect(raw.encryption).toBe('none')
    expect(raw.version).toBe(SPACE_CREDENTIALS_SCHEMA_VERSION)
    expect(raw.providers).toBeDefined()

    resetSpaceCredentialsCacheForTests()
    expect(readSpaceCredentials('work').providers.deepseek.entries[0].apiKey).toBe(
      'sk-abcdef0123456789',
    )
  })
})

describe('locked: the key is not available right now', () => {
  it('a file tier with no key yet refuses a synchronous write instead of writing plaintext', () => {
    vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'file')
    resetCredentialsMasterKeyForTests()
    expect(spaceCredentialsEncryptionAtRest()).toBe('unavailable')
    expect(() => writeSpaceCredentials('work', pool)).toThrow(CredentialsLockedError)
  })

  it('the key went missing: reads come back empty (not cached), writes are refused', async () => {
    await useFileTier()
    writeSpaceCredentials('work', pool)
    await fs.rm(masterKeyFilePath(storeDir))
    resetCredentialsMasterKeyForTests()
    resetSpaceCredentialsCacheForTests()

    const logs = captureRuntimeLogs()
    expect(readSpaceCredentials('work')).toEqual({ providers: {} })
    expect(() => writeSpaceCredentials('work', pool)).toThrow(CredentialsLockedError)
    logs.restore()
    // 文件一个字节都没被动过:钥匙回来(或导入)之前它是唯一的那份。
    expect((await readRawFile('work')).encryption).toBe('master-key')
  })

  it('a user-initiated write after the key went missing replaces the key and keeps the old file aside', async () => {
    await useFileTier()
    writeSpaceCredentials('work', pool)
    const oldKeyId = (await readRawFile('work')).keyId
    await fs.rm(masterKeyFilePath(storeDir))
    resetCredentialsMasterKeyForTests()
    resetSpaceCredentialsCacheForTests()

    await prepareCredentialsWrite()
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-afterrekey0123' })

    const raw = await readRawFile('work')
    expect(raw.keyId).not.toBe(oldKeyId)
    await expect(fs.stat(`${spaceCredentialsFilePath('work')}.orphaned-${String(oldKeyId)}`)).resolves.toBeTruthy()
  })
})

describe('masked preview under encryption', () => {
  it('still previews head-6 tail-4 off the decrypted pool', async () => {
    await useFileTier()
    writeSpaceCredentials('work', pool)
    resetSpaceCredentialsCacheForTests()

    const entry = getSpaceProviderCredentials('work', 'deepseek')?.entries[0]
    expect(previewSpaceCredentialApiKey(entry?.apiKey)).toBe('sk-abc••••6789')
  })
})
