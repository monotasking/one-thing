/**
 * `gate:credentials` 的探针入口 —— 被 `scripts/gate-credentials.mjs` 用 esbuild 打成一份单文件 cjs,
 * 在**系统 Node** 下跑(第④步批 0,`docs/design/two-process-2026-10.md` §2.1 验收)。
 *
 * 它只 import 产品自己的模块,不抄一份加密 / 迁移逻辑:门守的是产品,不是抄件。每一项在一间新的
 * 临时 store 上跑,主密钥是 `file` 档(门脚本在环境里显式设了);要测钥匙串那一档的两项(④ ⑦)
 * 用一只假的 `security` 脚本 —— **绝不碰真钥匙串**:切到钥匙串档之前先断言命令已经换成假的。
 *
 * 七项:
 *  ① 种一份 `encryption: 'safeStorage'` 密文(假的旧解密器)→ 跑迁移 → 新信封、条目逐条相等;
 *  ② 口令导出 → 换一间 store(换一把主密钥)导入 → 条目相等;
 *  ③ `ONETHING_CREDENTIALS_KEYRING=none` 下 `credentialsStatus` 答 `'none'`;
 *  ④ 钥匙串超时 → `credentials:locked`(locked: true)→ `unlockCredentials` 重试成功 → locked: false;
 *  ⑤ 迁移后旧文件变成 `.safestorage-backup`,字节与迁移前逐字节相同;
 *  ⑥ 另一个活着的后端在服务这个 store(真起一个进程占端口、写发现文件)→ 拒绝迁移,一个字节不动;
 *  ⑦ `security` 挂住(假的慢命令)→ 有界时间内答「已锁定 · keychain-timeout」,不挂。
 *
 * 最后打一行 `__GATE_CREDENTIALS_RESULT__` + JSON,由门去判。
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  readSpaceCredentials,
  readSpaceCredentialsAtRest,
  resetSpaceCredentialsCacheForTests,
  spaceCredentialsFilePath,
  writeSpaceCredentials,
} from '../../packages/backend/credentials/credentials-pool.js'
import {
  configureCredentialsKeychainForTests,
  resetCredentialsMasterKeyForTests,
} from '../../packages/backend/credentials/credentials-master-key.js'
import {
  configureCredentialsLegacyDecryptorHost,
  resetCredentialsLegacyDecryptorHost,
} from '../../packages/backend/credentials/credentials-legacy-decryptor.js'
import {
  migrateSafeStorageCredentials,
  resetSafeStorageMigrationStateForTests,
} from '../../packages/backend/credentials/credentials-safestorage-migration.js'
import {
  credentialsStatus,
  installCredentialsLockBroadcaster,
  prepareCredentialsAtAssembly,
  prepareCredentialsWrite,
  unlockCredentials,
} from '../../packages/backend/credentials/credentials-locked-state.js'
import {
  exportCredentialsWithPassphrase,
  importCredentialsWithPassphrase,
} from '../../packages/backend/credentials/credentials-export.js'
import { isAnotherBackendServingStore } from '../../packages/backend/http-server/http-server-discovery.js'
import type { CredentialsLockedGlobalEvent } from '../../packages/shared/events/global-events.js'

interface Check {
  id: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-gate-credentials-'))

function record(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
}

/** 一间新的临时 store,主密钥 `file` 档。 */
function freshStore(name: string): string {
  const store = path.join(scratch, name)
  fs.mkdirSync(store, { recursive: true })
  process.env.ONETHING_STORE_PATH = store
  process.env.ONETHING_CREDENTIALS_KEYRING = 'file'
  configureCredentialsKeychainForTests({})
  resetCredentialsMasterKeyForTests()
  resetSpaceCredentialsCacheForTests()
  resetSafeStorageMigrationStateForTests()
  resetCredentialsLegacyDecryptorHost()
  return store
}

const POOL = {
  providers: {
    deepseek: {
      entries: [{ id: 'e1', label: 'D', authType: 'apiKey' as const, apiKey: 'sk-gate-0123456789', source: 'user' }],
      policy: 'priority-failover',
    },
    codex: {
      entries: [{
        id: 'o1', label: 'me', authType: 'oauth' as const, source: 'user',
        oauthToken: { accessToken: 'at-gate', refreshToken: 'rt-gate', expiresAt: 4_000_000_000_000, tokenType: 'Bearer' },
      }],
      policy: 'single',
    },
  },
}

/** 假的旧 safeStorage:`enc:` 前缀 + 原文(验链路,不验算法)。 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  decryptString: (buffer: Buffer) => {
    const raw = buffer.toString('utf-8')
    if (!raw.startsWith('enc:')) throw new Error('not our ciphertext')
    return raw.slice(4)
  },
}

function seedLegacy(spaceId: string): Buffer {
  const filePath = spaceCredentialsFilePath(spaceId)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const data = Buffer.from(`enc:${JSON.stringify(POOL)}`, 'utf-8').toString('base64')
  fs.writeFileSync(filePath, JSON.stringify({ version: 2, encryption: 'safeStorage', data }, null, 2), 'utf-8')
  return fs.readFileSync(filePath)
}

function fakeSecurity(body: string): string {
  const file = path.join(scratch, `security-${Math.random().toString(36).slice(2)}.sh`)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

/** 换到钥匙串档,但命令一定是假的那只。命令没换上就不切档(门宁可红,也不碰真钥匙串)。 */
function useFakeKeychain(command: string, timeoutMs: number): void {
  if (!command.startsWith(scratch)) throw new Error('refusing to switch to the keychain tier without a fake security command')
  configureCredentialsKeychainForTests({ command, timeoutMs })
  process.env.ONETHING_CREDENTIALS_KEYRING = 'keychain'
  resetCredentialsMasterKeyForTests()
}

async function checkMigration(): Promise<void> {
  freshStore('migrate')
  const before = seedLegacy('default')
  configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)
  const report = await migrateSafeStorageCredentials()
  resetCredentialsLegacyDecryptorHost()
  resetSpaceCredentialsCacheForTests()
  const atRest = readSpaceCredentialsAtRest('default')
  const onDisk = fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')
  const equal = isDeepStrictEqual(readSpaceCredentials('default'), POOL)
  record('①', report.migrated.includes('default') && atRest === 'master-key' && equal && !onDisk.includes('sk-gate') && !onDisk.includes('at-gate'),
    `migrated=${JSON.stringify(report.migrated)} atRest=${atRest} entriesEqual=${equal} plaintextOnDisk=${onDisk.includes('sk-gate')}`)
  const backup = `${spaceCredentialsFilePath('default')}.safestorage-backup`
  const backupBytes = fs.existsSync(backup) ? fs.readFileSync(backup) : null
  record('⑤', Boolean(backupBytes && backupBytes.equals(before)), `backup=${fs.existsSync(backup)} bytesEqual=${Boolean(backupBytes?.equals(before))}`)
}

async function checkExportImport(): Promise<void> {
  freshStore('export-a')
  await prepareCredentialsWrite()
  writeSpaceCredentials('default', POOL)
  const exported = await exportCredentialsWithPassphrase('gate passphrase', ['default'])
  const leaks = exported.data.includes('sk-gate') || exported.data.includes('at-gate')
  freshStore('export-b')
  await prepareCredentialsWrite()
  const result = await importCredentialsWithPassphrase('gate passphrase', exported.data, () => true)
  resetSpaceCredentialsCacheForTests()
  const equal = isDeepStrictEqual(readSpaceCredentials('default'), POOL)
  let wrong = false
  try {
    await importCredentialsWithPassphrase('not it', exported.data, () => true)
  } catch (error) {
    wrong = (error as { reason?: string }).reason === 'wrong-passphrase'
  }
  record('②', equal && !leaks && result.imported === 2 && wrong,
    `imported=${result.imported} entriesEqual=${equal} plaintextInExport=${leaks} wrongPassphraseRefused=${wrong}`)
}

async function checkNoneTier(): Promise<void> {
  freshStore('none')
  process.env.ONETHING_CREDENTIALS_KEYRING = 'none'
  resetCredentialsMasterKeyForTests()
  const status = await prepareCredentialsAtAssembly()
  record('③', status.tier === 'none' && status.encryption === 'none' && status.state === 'ready', JSON.stringify(status))
}

async function checkKeychainTimeoutAndRetry(): Promise<void> {
  freshStore('keychain')
  useFakeKeychain(fakeSecurity('sleep 30'), 400)
  const events: CredentialsLockedGlobalEvent[] = []
  const off = installCredentialsLockBroadcaster({ emitGlobal: event => { events.push(event) } })
  const started = Date.now()
  const locked = await prepareCredentialsAtAssembly()
  const elapsed = Date.now() - started
  const lockedEvent = events.find(event => event.locked && event.reason === 'keychain-timeout')
  record('⑦', locked.state === 'locked' && locked.reason === 'keychain-timeout' && elapsed < 3000,
    `state=${locked.state} reason=${locked.reason} elapsedMs=${elapsed}`)
  configureCredentialsKeychainForTests({ command: fakeSecurity(`echo ${'ef'.repeat(32)}`), timeoutMs: 3000 })
  const unlocked = await unlockCredentials()
  const unlockedEvent = events.at(-1)
  off()
  record('④', Boolean(lockedEvent) && unlocked.state === 'ready' && unlockedEvent?.locked === false,
    `lockedEvent=${Boolean(lockedEvent)} afterRetry=${unlocked.state} lastEvent=${JSON.stringify(unlockedEvent)}`)
}

async function checkOtherBackendRefusal(): Promise<void> {
  const store = freshStore('other-backend')
  const before = seedLegacy('default')
  configureCredentialsLegacyDecryptorHost(() => fakeSafeStorage)
  // 真起一个「别的后端」:另一个进程占一个回环端口,发现文件指向它。
  const child = spawn(process.execPath, ['-e',
    "const s=require('node:net').createServer(()=>{});s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port)+'\\n')})"],
  { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout?.once('data', chunk => resolve(Number(String(chunk).trim())))
      child.once('error', reject)
      setTimeout(() => reject(new Error('stand-in backend did not start')), 5000)
    })
    fs.mkdirSync(path.join(store, 'run'), { recursive: true })
    fs.writeFileSync(path.join(store, 'run', 'http.json'), JSON.stringify({
      port, host: '127.0.0.1', token: 'gate-token', pid: child.pid, startedAt: Date.now(), owner: 'server',
    }), { mode: 0o600 })
    const seen = await isAnotherBackendServingStore({ storePath: store })
    const report = await migrateSafeStorageCredentials({ otherLiveBackend: () => isAnotherBackendServingStore({ storePath: store }) })
    const untouched = fs.readFileSync(spaceCredentialsFilePath('default')).equals(before)
    record('⑥', seen && report.blockedBy === 'other-backend-running' && untouched && credentialsStatus().reason === 'legacy-safestorage',
      `otherBackendSeen=${seen} blockedBy=${report.blockedBy} legacyFileUntouched=${untouched} status=${JSON.stringify(credentialsStatus())}`)
  } finally {
    child.kill('SIGKILL')
    resetCredentialsLegacyDecryptorHost()
  }
}

async function main(): Promise<void> {
  try {
    await checkMigration()
    await checkExportImport()
    await checkNoneTier()
    await checkKeychainTimeoutAndRetry()
    await checkOtherBackendRefusal()
  } catch (error) {
    record('crash', false, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  process.stdout.write(`__GATE_CREDENTIALS_RESULT__${JSON.stringify(checks)}\n`)
}

void main()
