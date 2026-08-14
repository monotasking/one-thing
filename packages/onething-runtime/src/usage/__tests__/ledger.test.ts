import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OnethingUsageLedger, onethingUsageLedgerFileName } from '../ledger.js'

describe('OnethingUsageLedger', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-usage-ledger-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('appends records into a per-month JSONL file', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: dir })
    const ts = new Date(2026, 6, 13).getTime() // 2026-07-13
    ledger.record({
      ts,
      sessionId: 's1',
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      platform: 'electron',
      source: 'chat',
      billing: 'api',
      usage: { input: 100, output: 50 },
    })
    await ledger.flush()

    const filePath = path.join(dir, onethingUsageLedgerFileName(ts))
    expect(fs.existsSync(filePath)).toBe(true)
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.sessionId).toBe('s1')
    expect(parsed.usage.total).toBe(150)
  })

  /**
   * 归属 space(批 B2)。**只加写入维度**:旧行没有这个字段,解析器一行不改,
   * 读回来就是 undefined —— 聚合侧照旧(usage 的 source 字段还接着历史 'memory'
   * 值,这条链上任何「顺手收紧」都会伤到旧账)。
   */
  it('carries workspaceId onto the written line, and omits it when absent', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: dir })
    const ts = new Date(2026, 6, 13).getTime()
    const base = {
      ts,
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      platform: 'electron',
      source: 'chat',
      billing: 'api' as const,
      usage: { input: 1, output: 1 },
    }
    ledger.record({ ...base, sessionId: 's1', workspaceId: 'work' })
    ledger.record({ ...base, sessionId: 's2' })
    await ledger.flush()

    const lines = fs
      .readFileSync(path.join(dir, onethingUsageLedgerFileName(ts)), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(lines[0].workspaceId).toBe('work')
    expect(lines[1]).not.toHaveProperty('workspaceId')

    const readBack = await ledger.readRecordsInRange(ts - 1, ts + 1)
    expect(readBack.map(record => record.workspaceId)).toEqual(['work', undefined])
  })

  /**
   * 凭证归因(批 B3)。默认空间**诚实缺席**:它的凭证源是 settings.ai,那里没有
   * entry id —— 造一个 'legacy' 只会污染将来的按 key 出账。旧行同理缺席。
   */
  it('carries credentialId only when a per-space pool entry was used', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: dir })
    const ts = new Date(2026, 6, 14).getTime()
    const base = {
      ts,
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      platform: 'electron',
      source: 'chat',
      billing: 'api' as const,
      usage: { input: 1, output: 1 },
    }
    ledger.record({ ...base, sessionId: 's1', workspaceId: 'work', credentialId: 'cred-1' })
    ledger.record({ ...base, sessionId: 's2', workspaceId: 'default' })
    await ledger.flush()

    const lines = fs
      .readFileSync(path.join(dir, onethingUsageLedgerFileName(ts)), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(lines[0].credentialId).toBe('cred-1')
    expect(lines[1]).not.toHaveProperty('credentialId')

    const readBack = await ledger.readRecordsInRange(ts - 1, ts + 1)
    expect(readBack.map(record => record.credentialId)).toEqual(['cred-1', undefined])
  })

  it('routes records into the correct monthly file even when queued out of order', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: dir })
    const julTs = new Date(2026, 6, 13).getTime()
    const augTs = new Date(2026, 7, 1).getTime()
    ledger.record({ ts: julTs, providerId: 'p', modelId: 'm', platform: 'electron', source: 'chat', billing: 'api', usage: { input: 1, output: 1 } })
    ledger.record({ ts: augTs, providerId: 'p', modelId: 'm', platform: 'electron', source: 'chat', billing: 'api', usage: { input: 2, output: 2 } })
    await ledger.flush()

    expect(fs.existsSync(path.join(dir, onethingUsageLedgerFileName(julTs)))).toBe(true)
    expect(fs.existsSync(path.join(dir, onethingUsageLedgerFileName(augTs)))).toBe(true)
  })

  it('readRecordsInRange filters by timestamp and spans multiple monthly files', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: dir })
    const junTs = new Date(2026, 5, 15).getTime()
    const julTs = new Date(2026, 6, 13).getTime()
    const augTs = new Date(2026, 7, 2).getTime()
    for (const ts of [junTs, julTs, augTs]) {
      ledger.record({ ts, providerId: 'p', modelId: 'm', platform: 'electron', source: 'chat', billing: 'api', usage: { input: 1, output: 1 } })
    }
    await ledger.flush()

    const records = await ledger.readRecordsInRange(julTs - 1, augTs)
    expect(records.map(r => r.ts)).toEqual([julTs])
  })

  it('returns an empty array when the ledger directory does not exist yet', async () => {
    const ledger = new OnethingUsageLedger({ ledgerDir: path.join(dir, 'does-not-exist') })
    const records = await ledger.readRecordsInRange(0, Date.now())
    expect(records).toEqual([])
  })
})
