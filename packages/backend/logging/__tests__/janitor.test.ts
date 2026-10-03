import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_DIR_POLICY, LogDirJanitor } from '../janitor.js'

let logDir = ''

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-log-janitor-'))
})

afterEach(() => {
  fs.rmSync(logDir, { recursive: true, force: true })
})

const DAY = 86400000

/** 稀疏文件:声明 n 字节但不真占盘,几百 MiB 的用例才跑得动。 */
function sparseFile(relPath: string, bytes: number, ageDays = 0): void {
  const abs = path.join(logDir, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const fd = fs.openSync(abs, 'w')
  if (bytes > 0) {
    fs.ftruncateSync(fd, bytes)
  }
  fs.closeSync(fd)
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * DAY)
    fs.utimesSync(abs, when, when)
  }
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(logDir, relPath))
}

describe('LogDirJanitor', () => {
  it('trims archives over the total cap and never touches the live ledgers', async () => {
    // 活动账本(正在写的那几本)
    sparseFile('app.jsonl', 4 * 1024 * 1024)
    sparseFile('server.jsonl', 1024 * 1024)
    sparseFile('daemon.log', 16 * 1024)
    sparseFile('dev.log', 2 * 1024 * 1024)
    // 归档:合计 ~600MiB,超过 512MiB 上限
    for (let index = 0; index < 12; index += 1) {
      sparseFile(`app-2026-08-0${index % 9}-00${index}-size.jsonl.gz`, 50 * 1024 * 1024, index)
    }

    const result = await new LogDirJanitor({ logDir }).run()

    expect(result.bytesBefore).toBeGreaterThan(LOG_DIR_POLICY.totalCapMiB * 1024 * 1024)
    expect(result.bytesAfter).toBeLessThanOrEqual(LOG_DIR_POLICY.totalCapMiB * 1024 * 1024)
    expect(result.deleted.length).toBeGreaterThan(0)
    // 账本一个不少
    expect(exists('app.jsonl')).toBe(true)
    expect(exists('server.jsonl')).toBe(true)
    expect(exists('daemon.log')).toBe(true)
    expect(exists('dev.log')).toBe(true)
    // 删的全是归档
    for (const name of result.deleted) expect(name).toMatch(/^app-/)
  })

  it('drops archives past the retention window and beyond the archive count', async () => {
    sparseFile('app.jsonl', 1024)
    sparseFile('app-old-001-size.jsonl.gz', 1024, 40)   // 超 14 天
    sparseFile('app-new-002-size.jsonl.gz', 1024, 1)
    sparseFile('dev-old-001-size.log.gz', 1024, 30)     // dev 保留 7 天
    sparseFile('dev-new-002-size.log.gz', 1024, 2)

    const result = await new LogDirJanitor({ logDir }).run()

    expect(exists('app-old-001-size.jsonl.gz')).toBe(false)
    expect(exists('dev-old-001-size.log.gz')).toBe(false)
    expect(exists('app-new-002-size.jsonl.gz')).toBe(true)
    expect(exists('dev-new-002-size.log.gz')).toBe(true)
    expect(result.deleted.sort()).toEqual(['app-old-001-size.jsonl.gz', 'dev-old-001-size.log.gz'])
  })

  it('bounds the provider-request dump directory by age and total size', async () => {
    sparseFile('dumps/provider-requests/old__deepseek__x__chat.json.gz', 1024, 30)
    for (let index = 0; index < 8; index += 1) {
      sparseFile(`dumps/provider-requests/n${index}__deepseek__x__chat.json`, 20 * 1024 * 1024, index === 0 ? 2 : 0)
    }

    await new LogDirJanitor({ logDir }).run()

    expect(exists('dumps/provider-requests/old__deepseek__x__chat.json.gz')).toBe(false)
    const remaining = fs.readdirSync(path.join(logDir, 'dumps/provider-requests'))
    const total = remaining.reduce(
      (sum, name) => sum + fs.statSync(path.join(logDir, 'dumps/provider-requests', name)).size,
      0,
    )
    expect(total).toBeLessThanOrEqual(LOG_DIR_POLICY.dumps['dumps/provider-requests'].maxTotalMiB * 1024 * 1024)
  })

  it('leaves plugin-owned agent logs and unknown files alone, but reports the unknown ones', async () => {
    sparseFile('agent-2026-08-20.log', 1024, 40)
    sparseFile('mystery.txt', 1024, 40)

    const result = await new LogDirJanitor({ logDir }).run()

    expect(exists('agent-2026-08-20.log')).toBe(true)
    expect(exists('mystery.txt')).toBe(true)
    expect(result.deleted).toEqual([])
    expect(result.unknown).toEqual(['mystery.txt'])
  })

  it('start() runs a sweep and stop() clears the timer', async () => {
    sparseFile('app-old-001-size.jsonl.gz', 1024, 90)
    const janitor = new LogDirJanitor({ logDir, intervalMs: 60_000 })
    janitor.start()
    await new Promise(resolve => setTimeout(resolve, 30))
    janitor.stop()
    expect(exists('app-old-001-size.jsonl.gz')).toBe(false)
  })
})
