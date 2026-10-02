import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RollingFileLogger } from '../rolling-file-logger.js'

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-logger-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('RollingFileLogger', () => {
  it('writes formatted log lines to the active file', async () => {
    const logger = new RollingFileLogger({
      logDir: tempDir,
      baseName: 'app',
      flushIntervalMs: 25,
    })

    logger.log({ level: 'info', source: 'main', message: 'hello log' })
    await logger.shutdown()

    const text = fs.readFileSync(path.join(tempDir, 'app.log'), 'utf-8')
    expect(text).toContain('[main] INFO')
    expect(text).toContain('hello log')
  })

  it('rotates oversized logs and compresses archives', async () => {
    const logger = new RollingFileLogger({
      logDir: tempDir,
      baseName: 'app',
      maxFileBytes: 1024,
      flushIntervalMs: 25,
      maintenanceIntervalMs: 60_000,
      compressArchives: true,
    })

    logger.log({ level: 'info', source: 'main', message: 'x'.repeat(1100) })
    await logger.flush()
    logger.log({ level: 'warn', source: 'main', message: 'rotated message' })
    await logger.shutdown()

    const files = await fsp.readdir(tempDir)
    const archive = files.find(file => file.startsWith('app-') && file.endsWith('.log.gz'))
    expect(archive).toBeTruthy()

    const archivedText = gunzipSync(fs.readFileSync(path.join(tempDir, archive!))).toString('utf-8')
    expect(archivedText).toContain('x'.repeat(100))

    const activeText = fs.readFileSync(path.join(tempDir, 'app.log'), 'utf-8')
    expect(activeText).toContain('rotated message')
  })

  it('cleans archives by age and max archive count', async () => {
    const logger = new RollingFileLogger({
      logDir: tempDir,
      baseName: 'app',
      maxArchiveFiles: 2,
      retentionDays: 7,
    })
    fs.writeFileSync(path.join(tempDir, 'app-old.log.gz'), 'old')
    fs.writeFileSync(path.join(tempDir, 'app-new-1.log.gz'), 'new1')
    fs.writeFileSync(path.join(tempDir, 'app-new-2.log.gz'), 'new2')
    fs.writeFileSync(path.join(tempDir, 'app-new-3.log.gz'), 'new3')

    const oldTime = Date.now() - 10 * 86400000
    fs.utimesSync(path.join(tempDir, 'app-old.log.gz'), oldTime / 1000, oldTime / 1000)
    fs.utimesSync(path.join(tempDir, 'app-new-1.log.gz'), new Date(Date.now() - 3000), new Date(Date.now() - 3000))
    fs.utimesSync(path.join(tempDir, 'app-new-2.log.gz'), new Date(Date.now() - 2000), new Date(Date.now() - 2000))
    fs.utimesSync(path.join(tempDir, 'app-new-3.log.gz'), new Date(Date.now() - 1000), new Date(Date.now() - 1000))

    const removed = await logger.cleanupArchives()
    expect(removed).toEqual(expect.arrayContaining(['app-old.log.gz', 'app-new-1.log.gz']))
    expect(fs.existsSync(path.join(tempDir, 'app-new-2.log.gz'))).toBe(true)
    expect(fs.existsSync(path.join(tempDir, 'app-new-3.log.gz'))).toBe(true)
  })
})
