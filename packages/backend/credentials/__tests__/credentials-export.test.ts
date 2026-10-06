/**
 * 口令导出 / 导入(第④步批 0)。
 *
 *  ① 往返:一台机器导出,换一间 store(换一把主密钥)导入,条目逐条相等;
 *  ② 导出文件里没有任何凭证原文;
 *  ③ 口令不对 → `wrong-passphrase`,池子一个字节都不动;不是导出文件 → `not-an-export`;
 *  ④ 导入是合并:同 id 换掉、其余追加、原有的不删;这台机器上没有的空间跳过并报出。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readSpaceCredentials,
  resetSpaceCredentialsCacheForTests,
  spaceCredentialsFilePath,
  writeSpaceCredentials,
} from '../credentials-pool.js'
import { resetCredentialsMasterKeyForTests } from '../credentials-master-key.js'
import { prepareCredentialsWrite } from '../credentials-locked-state.js'
import {
  CredentialsExportFailure,
  exportCredentialsWithPassphrase,
  importCredentialsWithPassphrase,
} from '../credentials-export.js'
import { setRootDirForTests } from '@onething/backend/space'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 换到一台「机器」:一间 store + 一棵 workspaces + 它自己的主密钥(`file` 档)。 */
async function useMachine(): Promise<void> {
  vi.stubEnv('ONETHING_STORE_PATH', tempDir('onething-export-store-'))
  vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'file')
  setRootDirForTests(tempDir('onething-export-ws-'))
  resetCredentialsMasterKeyForTests()
  resetSpaceCredentialsCacheForTests()
  await prepareCredentialsWrite()
}

const apiKeyEntry = (id: string, apiKey: string) => ({ id, label: id, authType: 'apiKey' as const, apiKey, source: 'user' })

beforeEach(async () => {
  await useMachine()
})

afterEach(() => {
  setRootDirForTests(null)
  vi.unstubAllEnvs()
  resetCredentialsMasterKeyForTests()
  resetSpaceCredentialsCacheForTests()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('导出 / 导入', () => {
  it('① ② 往返相等,文件里没有原文', async () => {
    writeSpaceCredentials('default', { providers: { deepseek: { entries: [apiKeyEntry('e1', 'sk-export-0123456789')], policy: 'single' } } })
    writeSpaceCredentials('work', { providers: { openai: { entries: [apiKeyEntry('e2', 'sk-work-abcdef')], policy: 'priority-failover' } } })
    const exported = await exportCredentialsWithPassphrase('correct horse', ['default', 'work', 'missing'], Date.UTC(2026, 9, 6))
    expect(exported.entries).toBe(2)
    expect(exported.fileName).toBe('onething-credentials-2026-10-06.json')
    expect(exported.data).not.toContain('sk-export')
    expect(exported.data).not.toContain('sk-work')
    const before = { default: readSpaceCredentials('default'), work: readSpaceCredentials('work') }

    await useMachine()
    const result = await importCredentialsWithPassphrase('correct horse', exported.data, () => true)
    expect(result).toEqual({ imported: 2, skippedSpaces: [] })
    resetSpaceCredentialsCacheForTests()
    expect(readSpaceCredentials('default')).toEqual(before.default)
    expect(readSpaceCredentials('work')).toEqual(before.work)
  })

  it('③ 口令不对 / 不是导出文件:答原因码,池子不动', async () => {
    writeSpaceCredentials('default', { providers: { deepseek: { entries: [apiKeyEntry('e1', 'sk-a')], policy: 'single' } } })
    const exported = await exportCredentialsWithPassphrase('right', ['default'])
    const poolBefore = fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')

    await expect(importCredentialsWithPassphrase('wrong', exported.data, () => true))
      .rejects.toMatchObject({ reason: 'wrong-passphrase' })
    await expect(importCredentialsWithPassphrase('right', '{"hello":1}', () => true))
      .rejects.toBeInstanceOf(CredentialsExportFailure)
    await expect(exportCredentialsWithPassphrase('', ['default'])).rejects.toMatchObject({ reason: 'empty-passphrase' })
    expect(fs.readFileSync(spaceCredentialsFilePath('default'), 'utf-8')).toBe(poolBefore)
  })

  it('④ 合并:同 id 换掉、其余追加、原有的不删;没有的空间跳过', async () => {
    writeSpaceCredentials('default', { providers: { deepseek: { entries: [apiKeyEntry('e1', 'sk-new'), apiKeyEntry('e3', 'sk-third')], policy: 'single' } } })
    writeSpaceCredentials('ghost', { providers: { openai: { entries: [apiKeyEntry('g1', 'sk-ghost')], policy: 'single' } } })
    const exported = await exportCredentialsWithPassphrase('pw', ['default', 'ghost'])

    await useMachine()
    writeSpaceCredentials('default', { providers: { deepseek: { entries: [apiKeyEntry('e1', 'sk-old'), apiKeyEntry('e2', 'sk-keep')], policy: 'priority-failover' } } })
    const result = await importCredentialsWithPassphrase('pw', exported.data, spaceId => spaceId === 'default')
    expect(result).toEqual({ imported: 2, skippedSpaces: ['ghost'] })
    const merged = readSpaceCredentials('default').providers.deepseek
    expect(merged.policy).toBe('priority-failover')
    expect(merged.entries.map(entry => [entry.id, entry.apiKey])).toEqual([['e1', 'sk-new'], ['e2', 'sk-keep'], ['e3', 'sk-third']])
  })
})
