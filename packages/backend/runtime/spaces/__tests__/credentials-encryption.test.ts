/**
 * `credentials.json` 的落盘加密(批 B8-1)—— 清掉批 B6 勘误 1 记档的那颗雷。
 *
 * 守四件事:
 *
 *  1. **老明文文件零迁移**:读得出,并且**下一次写入自动升级成密文**。
 *  2. **密文往返**:apiKey / oauthToken 都不该以明文出现在盘上。
 *  3. **加密器缺席时诚实降级**:写明文,并在文件里**如实标注** `encryption: "none"`
 *     —— 假装加密比不加密更坏。
 *  4. **掩码 preview 在加密态下照常正确**:掩码算在解密后的内存结构上,
 *     加密只是落盘形态。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureRuntimeLogs } from '../../logging/index.js'
import {
  configureSpaceCredentialsCrypto,
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
} from '../credentials.js'
import { setRootDirForTests } from '../persistence.js'

let tmpDir: string

/**
 * safeStorage 的替身。真 `safeStorage` 是平台 keychain,测试里跑不了;形状与
 * `OnethingTokenCryptoAdapter` 逐字一致(这正是"沿用同一个端口"的意思),
 * 加密用一个可逆的假变换 —— 验的是**链路**,不是算法强度。
 */
function fakeCrypto(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf-8'),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString('utf-8')
      if (!raw.startsWith('enc:')) throw new Error('not our ciphertext')
      return raw.slice(4)
    },
  }
}

async function readRawFile(spaceId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(spaceCredentialsFilePath(spaceId), 'utf-8'))
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-creds-enc-'))
  setRootDirForTests(tmpDir)
  resetSpaceCredentialsCacheForTests()
  configureSpaceCredentialsCrypto(undefined)
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceCredentialsCacheForTests()
  // 端口是模块级全局 —— 不还原会污染同一进程里的其他测试文件。
  configureSpaceCredentialsCrypto(undefined)
  await fs.rm(tmpDir, { recursive: true, force: true })
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
    configureSpaceCredentialsCrypto(() => fakeCrypto())
    writeSpaceCredentials('work', pool)

    const raw = await readRawFile('work')
    expect(raw.encryption).toBe('safeStorage')
    expect(raw.version).toBe(SPACE_CREDENTIALS_SCHEMA_VERSION)
    expect(raw.providers).toBeUndefined()
    expect(JSON.stringify(raw)).not.toContain('sk-abcdef0123456789')

    resetSpaceCredentialsCacheForTests()
    expect(readSpaceCredentials('work').providers.deepseek.entries[0].apiKey).toBe(
      'sk-abcdef0123456789',
    )
  })

  it('covers oauth tokens too — the whole file is the secret zone', async () => {
    configureSpaceCredentialsCrypto(() => fakeCrypto())
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

  it('an unreadable ciphertext degrades to an empty pool, never a half pool', async () => {
    configureSpaceCredentialsCrypto(() => fakeCrypto())
    writeSpaceCredentials('work', pool)
    resetSpaceCredentialsCacheForTests()

    // 换了一把解不开的钥匙(换机器 / keychain 被重置)。
    configureSpaceCredentialsCrypto(() => ({
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text, 'utf-8'),
      decryptString: () => { throw new Error('wrong key') },
    }))
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

    configureSpaceCredentialsCrypto(() => fakeCrypto())
    expect(readSpaceCredentials('work').providers.deepseek.entries[0].apiKey).toBe(
      'sk-abcdef0123456789',
    )
  })

  it('upgrades it to ciphertext on the next write — no migration step', async () => {
    await fs.mkdir(path.join(tmpDir, 'work'), { recursive: true })
    await fs.writeFile(spaceCredentialsFilePath('work'), JSON.stringify(pool), 'utf-8')
    configureSpaceCredentialsCrypto(() => fakeCrypto())

    // 任意一次正常写入(这里是换密钥)就完成升级。
    upsertSpaceProviderApiKey('work', 'deepseek', { apiKey: 'sk-newkey0123456789' })

    const raw = await readRawFile('work')
    expect(raw.encryption).toBe('safeStorage')
    expect(JSON.stringify(raw)).not.toContain('sk-newkey0123456789')

    resetSpaceCredentialsCacheForTests()
    expect(getSpaceProviderCredentials('work', 'deepseek')?.entries[0].apiKey).toBe(
      'sk-newkey0123456789',
    )
  })
})

describe('honest degradation when no crypto adapter is available', () => {
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

  it('an adapter that reports encryption unavailable counts as absent', async () => {
    configureSpaceCredentialsCrypto(() => fakeCrypto(false))
    expect(spaceCredentialsEncryptionAtRest()).toBe('none')
    writeSpaceCredentials('work', pool)
    expect((await readRawFile('work')).encryption).toBe('none')
  })

  it('an adapter that throws is treated as absent, not as a crash', async () => {
    configureSpaceCredentialsCrypto(() => ({
      isEncryptionAvailable: () => { throw new Error('app not ready') },
      encryptString: (text: string) => text,
      decryptString: (buffer: Buffer) => buffer.toString('utf-8'),
    }))
    const logs = captureRuntimeLogs()
    expect(spaceCredentialsEncryptionAtRest()).toBe('none')
    expect(() => writeSpaceCredentials('work', pool)).not.toThrow()
    expect((await readRawFile('work')).encryption).toBe('none')
    logs.restore()
  })
})

describe('masked preview under encryption', () => {
  it('still previews head-6 tail-4 off the decrypted pool', () => {
    configureSpaceCredentialsCrypto(() => fakeCrypto())
    writeSpaceCredentials('work', pool)
    resetSpaceCredentialsCacheForTests()

    const entry = getSpaceProviderCredentials('work', 'deepseek')?.entries[0]
    expect(previewSpaceCredentialApiKey(entry?.apiKey)).toBe('sk-abc••••6789')
  })
})
