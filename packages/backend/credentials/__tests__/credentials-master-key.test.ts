/**
 * 凭证主密钥(第④步批 0)。守五件事:
 *
 *  1. **档位判据**:环境变量不设时 macOS 是钥匙串、别的平台是文件,**永远不是 `none`**;
 *  2. **钥匙串条目带 store 路径的哈希**:临时 store 撞不上 `~/.onething` 那一条,路径本身不进钥匙串;
 *  3. **`security` 挂住也不挂死**:到点就杀,答「已锁定 · 钥匙串没有回应」,不抛;
 *  4. **读到 / 找不到 / 被拒 / 读不懂** 各落到对的状态;新装(找不到且盘上没有封过的)现造一把;
 *  5. **封与拆**往返,换一把钥匙拆不开。
 *
 * 钥匙串那一档全用假的 `security`(一只 shell 脚本),**绝不碰真钥匙串**。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  awaitMasterKey,
  configureCredentialsKeychainForTests,
  ensureMasterKeyForWrite,
  keychainAccountForStore,
  masterKeyStateNow,
  openWithMasterKey,
  reloadMasterKey,
  resetCredentialsMasterKeyForTests,
  resolveCredentialsKeyringTier,
  sealWithMasterKey,
  type MasterKey,
  type MasterKeyContext,
} from '../credentials-master-key.js'

let dir: string
const nothingSealed: MasterKeyContext = { sealedDataExists: () => false }
const somethingSealed: MasterKeyContext = { sealedDataExists: () => true }
const KEY_HEX = 'ab'.repeat(32)

/** 写一只假的 `security`:脚本体就是这一次要它做的事。 */
function fakeSecurity(body: string): string {
  const file = path.join(dir, `security-${Math.random().toString(36).slice(2)}.sh`)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

function useFakeKeychain(body: string, timeoutMs = 2000): void {
  vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'keychain')
  configureCredentialsKeychainForTests({ command: fakeSecurity(body), timeoutMs })
  resetCredentialsMasterKeyForTests()
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-master-key-'))
  vi.stubEnv('ONETHING_STORE_PATH', path.join(dir, 'store'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  configureCredentialsKeychainForTests({})
  resetCredentialsMasterKeyForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('档位判据', () => {
  it('环境变量不设时:macOS 是钥匙串,别的平台是文件 —— 永远不是 none', () => {
    expect(resolveCredentialsKeyringTier({}, 'darwin')).toBe('keychain')
    expect(resolveCredentialsKeyringTier({}, 'linux')).toBe('file')
    expect(resolveCredentialsKeyringTier({}, 'win32')).toBe('file')
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as const) {
      expect(resolveCredentialsKeyringTier({}, platform)).not.toBe('none')
      expect(resolveCredentialsKeyringTier({ ONETHING_CREDENTIALS_KEYRING: '' }, platform)).not.toBe('none')
      expect(resolveCredentialsKeyringTier({ ONETHING_CREDENTIALS_KEYRING: 'bogus' }, platform)).not.toBe('none')
    }
  })

  it('显式三档各认各的(大小写与空白不计较)', () => {
    expect(resolveCredentialsKeyringTier({ ONETHING_CREDENTIALS_KEYRING: 'none' }, 'darwin')).toBe('none')
    expect(resolveCredentialsKeyringTier({ ONETHING_CREDENTIALS_KEYRING: ' FILE ' }, 'darwin')).toBe('file')
    expect(resolveCredentialsKeyringTier({ ONETHING_CREDENTIALS_KEYRING: 'keychain' }, 'linux')).toBe('keychain')
  })

  it('vitest 全局 setup 强制的是 none 档(测试进程摸不到真钥匙串)', () => {
    vi.unstubAllEnvs()
    expect(process.env.ONETHING_CREDENTIALS_KEYRING).toBe('none')
  })
})

describe('钥匙串条目的名字', () => {
  it('带 store 路径的哈希:不同 store 不同条目,路径本身不进钥匙串', () => {
    const real = keychainAccountForStore('/Users/someone/.onething')
    const temp = keychainAccountForStore('/var/folders/x/onething-gate-store')
    expect(real).not.toBe(temp)
    expect(real).toMatch(/^store-[0-9a-f]{16}$/)
    expect(real).not.toContain('onething')
    expect(keychainAccountForStore('/Users/someone/.onething/')).toBe(real)
  })
})

describe('钥匙串档(假的 security)', () => {
  it('挂住不回 → 到点杀掉,答「已锁定 · 钥匙串没有回应」,不抛', async () => {
    useFakeKeychain('sleep 30', 300)
    const started = Date.now()
    const state = await awaitMasterKey(nothingSealed)
    expect(state).toEqual({ status: 'locked', reason: 'keychain-timeout' })
    expect(Date.now() - started).toBeLessThan(2500)
  })

  it('同步口不等子进程:第一次问答 loading,读完之后答 ready', async () => {
    useFakeKeychain(`echo ${KEY_HEX}`)
    expect(masterKeyStateNow(nothingSealed).status).toBe('loading')
    const state = await awaitMasterKey(nothingSealed)
    expect(state.status).toBe('ready')
    expect(masterKeyStateNow(nothingSealed).status).toBe('ready')
  })

  it('找不到条目(退出码 44):盘上没有封过的 → absent;有 → 已锁定 · 找不到密钥', async () => {
    useFakeKeychain('exit 44')
    expect((await awaitMasterKey(nothingSealed)).status).toBe('absent')
    resetCredentialsMasterKeyForTests()
    expect(await awaitMasterKey(somethingSealed)).toEqual({ status: 'locked', reason: 'key-missing' })
  })

  it('用户点了拒绝(退出码 128)→ 已锁定 · 钥匙串拒绝了访问', async () => {
    useFakeKeychain('exit 128')
    expect(await awaitMasterKey(nothingSealed)).toEqual({ status: 'locked', reason: 'keychain-denied' })
  })

  it('输出读不懂 / 退出码说不准 → 已锁定 · keychain-failed(不猜原因)', async () => {
    useFakeKeychain('echo not-a-key')
    expect(await awaitMasterKey(nothingSealed)).toEqual({ status: 'locked', reason: 'keychain-failed' })
    useFakeKeychain('exit 3')
    expect(await awaitMasterKey(nothingSealed)).toEqual({ status: 'locked', reason: 'keychain-failed' })
  })

  it('新装:找不到就现造一把并写进钥匙串(参数里有服务名与这个 store 的账户名)', async () => {
    const argsFile = path.join(dir, 'args.txt')
    useFakeKeychain(`case "$1" in find-generic-password) exit 44;; *) echo "$@" > "${argsFile}";; esac`)
    const state = await ensureMasterKeyForWrite(nothingSealed)
    expect(state.status).toBe('ready')
    const args = fs.readFileSync(argsFile, 'utf-8')
    expect(args).toContain('add-generic-password')
    expect(args).toContain('onething-credentials')
    expect(args).toContain(keychainAccountForStore(path.join(dir, 'store')))
  })

  it('钥匙丢了(盘上有封过的):不悄悄换钥匙;只有用户亲手的写(allowRekey)才换', async () => {
    useFakeKeychain('case "$1" in find-generic-password) exit 44;; *) exit 0;; esac')
    expect((await ensureMasterKeyForWrite(somethingSealed)).status).toBe('locked')
    expect((await ensureMasterKeyForWrite(somethingSealed, { allowRekey: true })).status).toBe('ready')
  })

  it('超时与拒绝永远不换钥匙(钥匙在,只是此刻拿不到)', async () => {
    useFakeKeychain('exit 128')
    expect(await ensureMasterKeyForWrite(nothingSealed, { allowRekey: true })).toEqual({ status: 'locked', reason: 'keychain-denied' })
  })

  it('「重试」:锁定之后换成能答的钥匙串,重读就绪', async () => {
    useFakeKeychain('sleep 30', 200)
    expect((await awaitMasterKey(nothingSealed)).status).toBe('locked')
    configureCredentialsKeychainForTests({ command: fakeSecurity(`echo ${KEY_HEX}`), timeoutMs: 2000 })
    expect((await reloadMasterKey(nothingSealed)).status).toBe('ready')
  })
})

describe('文件档', () => {
  it('同步答得出;新装 absent,写的时候现造,0600', async () => {
    vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'file')
    resetCredentialsMasterKeyForTests()
    expect(masterKeyStateNow(nothingSealed).status).toBe('absent')
    expect((await ensureMasterKeyForWrite(nothingSealed)).status).toBe('ready')
    const keyFile = path.join(dir, 'store', 'credentials-master.key')
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    resetCredentialsMasterKeyForTests()
    expect(masterKeyStateNow(nothingSealed).status).toBe('ready')
  })

  it('坏掉的钥匙文件不覆盖(那可能是唯一的那把),答已锁定', async () => {
    vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'file')
    resetCredentialsMasterKeyForTests()
    fs.mkdirSync(path.join(dir, 'store'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'store', 'credentials-master.key'), 'garbage')
    expect(await ensureMasterKeyForWrite(nothingSealed, { allowRekey: true })).toEqual({ status: 'locked', reason: 'keychain-failed' })
    expect(fs.readFileSync(path.join(dir, 'store', 'credentials-master.key'), 'utf-8')).toBe('garbage')
  })
})

describe('封与拆', () => {
  it('往返;换一把钥匙拆不开', async () => {
    vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'file')
    resetCredentialsMasterKeyForTests()
    const state = await ensureMasterKeyForWrite(nothingSealed)
    if (state.status !== 'ready') throw new Error('key not ready')
    const sealed = sealWithMasterKey(state.key, '{"providers":{}}')
    expect(sealed.keyId).toBe(state.key.keyId)
    expect(openWithMasterKey(state.key, sealed)).toBe('{"providers":{}}')
    const other: MasterKey = { key: Buffer.alloc(32, 7), keyId: 'x' }
    expect(() => openWithMasterKey(other, sealed)).toThrow()
  })
})
