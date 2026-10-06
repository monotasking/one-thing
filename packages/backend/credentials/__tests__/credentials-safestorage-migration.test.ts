/**
 * 存量 `safeStorage` 密文 → 主密钥信封的自动迁移(第④步批 0,施工单修正 1–3)。
 *
 *  ① 迁好:新信封是主密钥封的、条目逐条相等,旧文件改名 `.safestorage-backup` 且**字节未变**;
 *  ② 解不开:旧文件原样不动、新信封不写,这个空间记作「待迁」,状态答「已锁定 · 旧密文待迁移」;
 *  ③ 另一个活着的后端在服务这个 store:拒绝迁移,一个字节都不动;
 *  ④ 还没人交过旧密文(独立 server,或桌面还没交):不迁,记作待迁;读侧答空但不缓存,写侧拒绝覆盖;
 *     桌面交进来之后(`acceptLegacyCredentialsHandOver`,第④步批 2b「Electron 先读后交」)迁完、横幅撤下;
 *  ⑤ 上一次断在两次改名之间:下次启动补完;
 *  ⑥ 没有旧密文:什么都不做,也不去要钥匙。
 *
 * 旧解密器是一只假的 `safeStorage`(可逆的假变换,验的是链路)。批 2b 起后端不再拿到解密器本身,而是收
 * Electron 交进来的「密文 → 明文」:`handOver()` 扮演 Electron —— 读盘上的旧信封、用假 `safeStorage` 解开、
 * 把那一对交进来。主密钥走 `file` 档。
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
  acceptHandedOverLegacyPlaintexts,
  resetHandedOverLegacyPlaintextsForTests,
} from '../credentials-legacy-decryptor.js'
import {
  migrateSafeStorageCredentials,
  resetSafeStorageMigrationStateForTests,
  SAFESTORAGE_BACKUP_SUFFIX,
} from '../credentials-safestorage-migration.js'
import { acceptLegacyCredentialsHandOver, credentialsStatus } from '../credentials-locked-state.js'
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

/** 扮演 Electron:读出这几个空间盘上的旧信封,用假 `safeStorage` 解开,交「密文 → 明文」。解不开的不交。 */
function handOverPairs(spaceIds: readonly string[]): Array<{ ciphertext: string; plaintext: string }> {
  const pairs: Array<{ ciphertext: string; plaintext: string }> = []
  for (const spaceId of spaceIds) {
    const envelope = JSON.parse(fs.readFileSync(spaceCredentialsFilePath(spaceId), 'utf-8')) as { data: string }
    try {
      pairs.push({ ciphertext: envelope.data, plaintext: fakeSafeStorage.decryptString(Buffer.from(envelope.data, 'base64')) })
    } catch { /* Electron 解不开的那一条不交 */ }
  }
  return pairs
}

function handOver(...spaceIds: string[]): void {
  acceptHandedOverLegacyPlaintexts(handOverPairs(spaceIds))
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
  resetHandedOverLegacyPlaintextsForTests()
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
    handOver('default')

    const report = await migrateSafeStorageCredentials()
    expect(report).toMatchObject({ migrated: ['default'], entries: 2, pending: [] })
    expect(readSpaceCredentialsAtRest('default')).toBe('master-key')
    const onDisk = fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')
    expect(onDisk).not.toContain('sk-legacy')
    expect(onDisk).not.toContain('at-legacy')
    expect(fs.readFileSync(`${spaceCredentialsFilePath('default')}${SAFESTORAGE_BACKUP_SUFFIX}`, 'utf-8')).toBe(before)

    // 交进来的对照表清掉之后照样读得开:新信封只认主密钥。
    resetHandedOverLegacyPlaintextsForTests()
    resetSpaceCredentialsCacheForTests()
    expect(readSpaceCredentials('default')).toEqual(pool)
    expect(credentialsStatus()).toMatchObject({ tier: 'file', state: 'ready', encryption: 'master-key' })
    // 幂等:再跑一遍什么都不动。
    expect(await migrateSafeStorageCredentials()).toMatchObject({ migrated: [], pending: [] })
  })

  it('② 解不开:旧文件原样、新信封不写、记作待迁,状态答已锁定', async () => {
    const filePath = spaceCredentialsFilePath('work')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const data = Buffer.from('garbage').toString('base64')
    const before = JSON.stringify({ version: 2, encryption: 'safeStorage', data })
    fs.writeFileSync(filePath, before, 'utf-8')
    // Electron 解出来的是一段读不成凭证池的东西(真机上:钥匙对、内容坏)。
    acceptHandedOverLegacyPlaintexts([{ ciphertext: data, plaintext: 'not a credentials pool' }])

    const report = await migrateSafeStorageCredentials()
    expect(report).toMatchObject({ migrated: [], pending: ['work'], blockedBy: 'verify-failed' })
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before)
    expect(fs.existsSync(`${filePath}.migrating`)).toBe(false)
    expect(fs.existsSync(`${filePath}${SAFESTORAGE_BACKUP_SUFFIX}`)).toBe(false)
    expect(credentialsStatus()).toMatchObject({ state: 'locked', reason: 'legacy-safestorage' })
  })

  it('③ 另一个活着的后端在服务这个 store:拒绝迁移,一个字节都不动', async () => {
    const before = writeLegacyFile('default')
    handOver('default')

    const report = await migrateSafeStorageCredentials({ otherLiveBackend: async () => true })
    expect(report).toMatchObject({ migrated: [], pending: ['default'], blockedBy: 'other-backend-running' })
    expect(fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')).toBe(before)
    expect(fs.existsSync(masterKeyFilePath(store))).toBe(false)
  })

  it('④ 还没人交过旧密文:不迁、待迁;读答空但不缓存,写拒绝覆盖;桌面交进来之后迁完', async () => {
    const before = writeLegacyFile('default')
    const report = await migrateSafeStorageCredentials()
    expect(report).toMatchObject({ pending: ['default'], blockedBy: 'no-legacy-decryptor' })
    expect(readSpaceCredentials('default')).toEqual({ providers: {} })
    expect(() => writeSpaceCredentials('default', { providers: {} })).toThrow(CredentialsLockedError)
    expect(fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')).toBe(before)

    // 桌面来了(先读后交):交进来那一刻就迁完,读缓存跟着换,状态翻回 ready。
    const result = await acceptLegacyCredentialsHandOver(handOverPairs(['default']))
    expect(result).toMatchObject({ accepted: 1, migratedSpaces: 1 })
    expect(result.status.state).toBe('ready')
    expect(readSpaceCredentials('default')).toEqual(pool)
    expect(fs.readFileSync(`${spaceCredentialsFilePath('default')}${SAFESTORAGE_BACKUP_SUFFIX}`, 'utf-8')).toBe(before)
  })

  it('⑤ 上一次断在两次改名之间:补完那一次改名', async () => {
    writeLegacyFile('default')
    handOver('default')
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
    acceptHandedOverLegacyPlaintexts([{ ciphertext: 'dW5yZWxhdGVk', plaintext: '{}' }])
    expect(await migrateSafeStorageCredentials()).toEqual({ migrated: [], entries: 0, pending: [] })
    expect(fs.existsSync(masterKeyFilePath(store))).toBe(false)
  })
})
