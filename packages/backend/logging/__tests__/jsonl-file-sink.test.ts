import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonlFileSink } from '../jsonl-file-sink.js'

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-jsonl-sink-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('JsonlFileSink', () => {
  it('writes one JSON.parse-able line per record', async () => {
    const sink = new JsonlFileSink({ logDir: tempDir, baseName: 'app', flushIntervalMs: 25 })
    sink.write({ time: 1, level: 'info', ns: 'engine.stream', msg: 'stream finished', fields: { sessionId: 's1' } })
    sink.write({
      time: 2,
      level: 'error',
      ns: 'sessions',
      msg: 'load failed',
      err: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at a\n    at b' },
    })
    await sink.close()

    const text = fs.readFileSync(path.join(tempDir, 'app.jsonl'), 'utf-8')
    const lines = text.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const records = lines.map(line => JSON.parse(line))
    for (const record of records) {
      expect(typeof record.time).toBe('number')
      expect(typeof record.level).toBe('string')
      expect(typeof record.ns).toBe('string')
    }
    // 多行栈进 `err.stack` 字段,而不是变成两行记录 —— 那是 app.log 38% 体积的来源。
    expect(records[1].err.stack.split('\n')).toHaveLength(3)
    expect(text).not.toContain('[object Object]')
  })

  it('rotates by size and gzips the archive, keeping the .jsonl extension', async () => {
    const sink = new JsonlFileSink({
      logDir: tempDir,
      baseName: 'app',
      maxFileBytes: 2048,
      flushIntervalMs: 10,
    })
    for (let index = 0; index < 60; index += 1) {
      sink.write({ time: Date.now(), level: 'info', ns: 'noise', msg: 'x'.repeat(80), fields: { index } })
      await sink.flush()
    }
    await sink.close()

    const names = fs.readdirSync(tempDir)
    const archives = names.filter(name => name.startsWith('app-') && name.endsWith('.jsonl.gz'))
    expect(archives.length).toBeGreaterThan(0)
    expect(names).toContain('app.jsonl')

    const archived = gunzipSync(fs.readFileSync(path.join(tempDir, archives[0]))).toString('utf-8')
    for (const line of archived.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('flushSync lands pending records (the process-exit path)', () => {
    const sink = new JsonlFileSink({ logDir: tempDir, baseName: 'server' })
    sink.write({ time: 1, level: 'fatal', ns: 'process', msg: 'uncaught exception' })
    sink.flushSync()

    const text = fs.readFileSync(path.join(tempDir, 'server.jsonl'), 'utf-8')
    expect(JSON.parse(text.trim()).msg).toBe('uncaught exception')
    expect(sink.getActivePath()).toBe(path.join(tempDir, 'server.jsonl'))
  })

  it('honours the ONETHING_LOG_* env group', () => {
    const previous = process.env.ONETHING_LOG_MAX_SIZE_MB
    process.env.ONETHING_LOG_MAX_SIZE_MB = '1'
    try {
      const sink = new JsonlFileSink({ logDir: tempDir })
      expect(sink.getActivePath().endsWith('app.jsonl')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.ONETHING_LOG_MAX_SIZE_MB
      else process.env.ONETHING_LOG_MAX_SIZE_MB = previous
    }
  })
})
