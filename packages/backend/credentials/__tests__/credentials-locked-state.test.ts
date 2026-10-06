/**
 * 「凭证已锁定」状态与它的广播(第④步批 0,决策 D10)。
 *
 *  ① `none` 档看得见:状态如实答 `tier: 'none'`、`encryption: 'none'`,不是静默明文;
 *  ② 钥匙串超时 → 状态「已锁定 · keychain-timeout」并发一条 `credentials:locked`(locked: true);
 *     「重试」成功 → 再发一条 locked: false;同一个状态不重复发;
 *  ③ 写入口在锁定时拒绝(`CredentialsLockedError` 带原因码),不写空池顶替。
 *
 * 钥匙串那一档用假的 `security`,绝不碰真钥匙串。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialsLockedGlobalEvent } from '@shared/events/global-events.js'
import { configureCredentialsKeychainForTests, resetCredentialsMasterKeyForTests } from '../credentials-master-key.js'
import {
  credentialsStatus,
  installCredentialsLockBroadcaster,
  prepareCredentialsAtAssembly,
  prepareCredentialsWrite,
  unlockCredentials,
} from '../credentials-locked-state.js'
import { CredentialsLockedError } from '../credentials-pool.js'
import { setRootDirForTests } from '@onething/backend/space'

let dir: string

function fakeSecurity(body: string): string {
  const file = path.join(dir, `security-${Math.random().toString(36).slice(2)}.sh`)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-lock-state-'))
  vi.stubEnv('ONETHING_STORE_PATH', path.join(dir, 'store'))
  setRootDirForTests(path.join(dir, 'workspaces'))
  resetCredentialsMasterKeyForTests()
})

afterEach(() => {
  setRootDirForTests(null)
  vi.unstubAllEnvs()
  configureCredentialsKeychainForTests({})
  resetCredentialsMasterKeyForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('凭证锁定状态', () => {
  it('① none 档如实答出来', async () => {
    await prepareCredentialsAtAssembly()
    expect(credentialsStatus()).toEqual({ tier: 'none', state: 'ready', encryption: 'none' })
  })

  it('② 钥匙串超时 → 已锁定并广播;重试成功 → 广播解开;同一状态不重发', async () => {
    vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'keychain')
    configureCredentialsKeychainForTests({ command: fakeSecurity('sleep 30'), timeoutMs: 200 })
    const events: CredentialsLockedGlobalEvent[] = []
    const off = installCredentialsLockBroadcaster({ emitGlobal: event => { events.push(event) } })

    const status = await prepareCredentialsAtAssembly()
    expect(status).toMatchObject({ tier: 'keychain', state: 'locked', reason: 'keychain-timeout' })
    expect(events.at(-1)).toMatchObject({ type: 'credentials:locked', locked: true, reason: 'keychain-timeout' })

    await expect(prepareCredentialsWrite()).rejects.toBeInstanceOf(CredentialsLockedError)

    configureCredentialsKeychainForTests({ command: fakeSecurity(`echo ${'cd'.repeat(32)}`), timeoutMs: 2000 })
    const unlocked = await unlockCredentials()
    expect(unlocked).toMatchObject({ state: 'ready', encryption: 'master-key' })
    expect(events.at(-1)).toMatchObject({ type: 'credentials:locked', locked: false, state: 'ready' })
    const count = events.length
    await unlockCredentials()
    expect(events.length).toBe(count)
    off()
  })
})
