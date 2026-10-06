/**
 * 存量 `safeStorage` 密文 → 主密钥信封的自动迁移(第④步批 0,施工单修正 1–3)。
 *
 *  ① 迁好:新信封是主密钥封的、条目逐条相等,旧文件改名 `.safestorage-backup` 且**字节未变**;
 *  ② 解不开:旧文件原样不动、新信封不写,这个空间记作「待迁」,状态答「已锁定 · 旧密文待迁移」;
 *  ③ 另一个活着的后端在服务这个 store:拒绝迁移,一个字节都不动;
 *  ④ 宿主没递旧解密器(独立 server):不迁,记作待迁;读侧答空但不缓存,写侧拒绝覆盖;
 *  ⑤ 上一次断在两次改名之间:下次启动补完;
 *  ⑥ 没有旧密文:什么都不做,也不去要钥匙。
 *
 * 旧解密器是一只假的 `safeStorage`(可逆的假变换,验的是链路);主密钥走 `file` 档。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CredentialsLockedError,
  readSpaceCredentials,
  readSpaceCredentialsAtRest,
  resetSpaceCredentialsCacheForTests,
  spaceCredentialsFilePath,
  writeSpaceCredentials,
} from '../credentials-pool.js'
import { masterKeyFilePath, resetCredentialsMasterKeyForTests } from '../credentials-master-key.js'
import {
  configureCredentialsLegacyDecryptorHost,
  resetCredentialsLegacyDecryptorHost,
} from '../credentials-legacy-decryptor.js'
import {
  migrateSafeStorageCredentials,
  resetSafeStorageMigrationStateForTests,
  SAFESTORAGE_BACKUP_SUFFIX,
} from '../credentials-safestorage-migration.js'
import { credentialsStatus, unlockCredentials } from '../credentials-locked-state.js'
import { setRootDirForTests } from '@onething/backend/space'

let root: string
let store: string

const pool = {
  providers: {
    deepseek: {
      entries: [{ id: 'e1', label: 'D', authType: 'apiKey', apiKey: 'sk-legacy-0123456789', source: 'user' }],
      policy: 'priority-failover',
    },
    codex: {
      entries: [{
        id: 'o1', label: 'me', authType: 'oauth', source: 'user',
        oauthToken: { accessToken: 'at-legacy', refreshToken: 'rt-legacy', expiresAt: 4_000_000_000_000, tokenType: 'Bearer' },
      }],
      policy: 'single',
    },
  },
}

/** 假 safeStorage:`enc:` 前缀 + 原文。 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  decryptString: (buffer: Buffer) => {
    const raw = buffer.toString('utf-8')
    if (!raw.startsWith('enc:')) throw new Error('not our ciphertext')
    return raw.slice(4)
  },
}

function writeLegacyFile(spaceId: string, payload: unknown = pool): string {
  const filePath = spaceCredentialsFilePath(spaceId)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const data = Buffer.from(`enc:${JSON.stringify(payload)}`, 'utf-8').toString('base64')
  fs.writeFileSync(filePath, JSON.stringify({ version: 2, encryption: 'safeStorage', data }, null, 2), 'utf-8')
  return fs.readFileSync(filePath, 'utf-8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-ss-migration-ws-'))
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-ss-migration-store-'))
  vi.stubEnv('ONETHING_STORE_PATH', store)
  vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'file')
  setRootDirForTests(root)
  resetCredentialsMasterKeyForTests()
  resetSpaceCredentialsCacheForTests()
  resetSafeStorageMigrationStateForTests()
})

afterEach(() => {
  resetCredentialsLegacyDecryptorHost()
  resetSafeStorageMigrationStateForTests()
  setRootDirForTests(null)
  vi.unstubAllEnvs()
  resetCredentialsMasterKeyForTests()
  resetSpaceCredentialsCacheForTests()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(store, { recursive: true, force: true })
})

describe('safeStorage → 主密钥', () => {
  it('① 迁好:主密钥信封、逐条相等、旧文件改名留底且字节未变', async () => {
    const before = writeLegacyFile('default')
    configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)

    const report = await migrateSafeStorageCredentials()
    expect(report).toMatchObject({ migrated: ['default'], entries: 2, pending: [] })
    expect(readSpaceCredentialsAtRest('default')).toBe('master-key')
    const onDisk = fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')
    expect(onDisk).not.toContain('sk-legacy')
    expect(onDisk).not.toContain('at-legacy')
    expect(fs.readFileSync(`${spaceCredentialsFilePath('default')}${SAFESTORAGE_BACKUP_SUFFIX}`, 'utf-8')).toBe(before)

    // 旧解密器撤掉之后照样读得开:新信封只认主密钥。
    resetCredentialsLegacyDecryptorHost()
    resetSpaceCredentialsCacheForTests()
    expect(readSpaceCredentials('default')).toEqual(pool)
    expect(credentialsStatus()).toMatchObject({ tier: 'file', state: 'ready', encryption: 'master-key' })
    // 幂等:再跑一遍什么都不动。
    expect(await migrateSafeStorageCredentials()).toMatchObject({ migrated: [], pending: [] })
  })

  it('② 解不开:旧文件原样、新信封不写、记作待迁,状态答已锁定', async () => {
    const filePath = spaceCredentialsFilePath('work')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const before = JSON.stringify({ version: 2, encryption: 'safeStorage', data: Buffer.from('garbage').toString('base64') })
    fs.writeFileSync(filePath, before, 'utf-8')
    configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)

    const report = await migrateSafeStorageCredentials()
    expect(report).toMatchObject({ migrated: [], pending: ['work'], blockedBy: 'verify-failed' })
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before)
    expect(fs.existsSync(`${filePath}.migrating`)).toBe(false)
    expect(fs.existsSync(`${filePath}${SAFESTORAGE_BACKUP_SUFFIX}`)).toBe(false)
    expect(credentialsStatus()).toMatchObject({ state: 'locked', reason: 'legacy-safestorage' })
  })

  it('③ 另一个活着的后端在服务这个 store:拒绝迁移,一个字节都不动', async () => {
    const before = writeLegacyFile('default')
    configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)

    const report = await migrateSafeStorageCredentials({ otherLiveBackend: async () => true })
    expect(report).toMatchObject({ migrated: [], pending: ['default'], blockedBy: 'other-backend-running' })
    expect(fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')).toBe(before)
    expect(fs.existsSync(masterKeyFilePath(store))).toBe(false)
  })

  it('④ 宿主没递旧解密器:不迁、待迁;读答空但不缓存,写拒绝覆盖', async () => {
    const before = writeLegacyFile('default')
    const report = await migrateSafeStorageCredentials()
    expect(report).toMatchObject({ pending: ['default'], blockedBy: 'no-legacy-decryptor' })
    expect(readSpaceCredentials('default')).toEqual({ providers: {} })
    expect(() => writeSpaceCredentials('default', { providers: {} })).toThrow(CredentialsLockedError)
    expect(fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')).toBe(before)

    // 桌面来了(递了旧解密器),「重试」把它迁完,读缓存跟着换。
    configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)
    const status = await unlockCredentials()
    expect(status.state).toBe('ready')
    expect(readSpaceCredentials('default')).toEqual(pool)
  })

  it('⑤ 上一次断在两次改名之间:补完那一次改名', async () => {
    writeLegacyFile('default')
    configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)
    await migrateSafeStorageCredentials()
    const filePath = spaceCredentialsFilePath('default')
    // 造现场:正本挪回 `.migrating`(备份还在)= 第二次改名之前进程没了。
    fs.renameSync(filePath, `${filePath}.migrating`)
    resetSpaceCredentialsCacheForTests()

    await migrateSafeStorageCredentials()
    expect(fs.existsSync(`${filePath}.migrating`)).toBe(false)
    expect(readSpaceCredentials('default')).toEqual(pool)
  })

  it('⑥ 没有旧密文:什么都不做,也不去要钥匙', async () => {
    configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)
    expect(await migrateSafeStorageCredentials()).toEqual({ migrated: [], entries: 0, pending: [] })
    expect(fs.existsSync(masterKeyFilePath(store))).toBe(false)
  })
})
