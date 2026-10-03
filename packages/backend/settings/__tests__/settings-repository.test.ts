import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOnethingSettingsRepository } from '../settings-repository.js'

interface TestSettings {
  enabled: boolean
  count: number
}

const tempDirs: string[] = []

function tempJsonPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-settings-runtime-'))
  tempDirs.push(dir)
  return path.join(dir, 'settings.json')
}

function normalize(value: unknown): TestSettings {
  const record = value && typeof value === 'object' ? value as Partial<TestSettings> : {}
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    count: typeof record.count === 'number' ? record.count : 1,
  }
}

describe('onething settings repository', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('initializes missing settings with normalized defaults', async () => {
    const filePath = tempJsonPath()
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const repository = createOnethingSettingsRepository<TestSettings>({
      filePath,
      defaultValue: () => ({ enabled: true, count: 1 }),
      normalize,
      logger,
    })

    await expect(repository.initialize()).resolves.toEqual({ enabled: true, count: 1 })
    expect(repository.isInitialized()).toBe(true)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ enabled: true, count: 1 })
    expect(logger.log).toHaveBeenCalledWith('[Settings] Loaded from disk successfully')
  })

  it('supports sync fallback, sync save, async save, invalidate, and in-memory updates', async () => {
    const filePath = tempJsonPath()
    fs.writeFileSync(filePath, JSON.stringify({ enabled: false }), 'utf-8')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const repository = createOnethingSettingsRepository<TestSettings>({
      filePath: () => filePath,
      defaultValue: () => ({ enabled: true, count: 1 }),
      normalize,
      logger,
    })

    expect(repository.get()).toEqual({ enabled: false, count: 1 })
    expect(logger.warn).toHaveBeenCalledWith('[Settings] getSettings() called before initialization, using sync fallback')

    repository.updateInMemory({ enabled: true, count: 9 })
    expect(repository.get()).toEqual({ enabled: true, count: 9 })

    expect(repository.save({ enabled: false, count: 2 })).toEqual({ enabled: false, count: 2 })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ enabled: false, count: 2 })

    await expect(repository.saveAsync({ enabled: true, count: 3 }))
      .resolves.toEqual({ enabled: true, count: 3 })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ enabled: true, count: 3 })

    repository.invalidate()
    fs.writeFileSync(filePath, JSON.stringify({ count: 4 }), 'utf-8')
    expect(repository.get()).toEqual({ enabled: true, count: 4 })
  })
})
