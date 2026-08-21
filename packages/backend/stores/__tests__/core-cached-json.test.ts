import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCoreCachedJsonState,
  getCoreCachedJsonFile,
  initializeCoreCachedJsonFile,
  invalidateCoreCachedJsonFile,
  isCoreCachedJsonInitialized,
  saveCoreCachedJsonFile,
  saveCoreCachedJsonFileAsync,
  updateCoreCachedJsonInMemory,
} from '@onething/core/storage'

interface TestSettings {
  enabled: boolean
  count: number
}

const tempDirs: string[] = []

function tempJsonPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-cached-json-'))
  tempDirs.push(dir)
  return path.join(dir, 'settings.json')
}

function options(filePath: string) {
  return {
    filePath,
    defaultValue: () => ({ enabled: true, count: 1 }),
    normalize: (value: unknown): TestSettings => {
      const record = value && typeof value === 'object' ? value as Partial<TestSettings> : {}
      return {
        enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
        count: typeof record.count === 'number' ? record.count : 1,
      }
    },
  }
}

describe('core cached json storage', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('initializes missing files with normalized defaults', async () => {
    const filePath = tempJsonPath()
    const state = createCoreCachedJsonState<TestSettings>()

    await expect(initializeCoreCachedJsonFile(state, options(filePath))).resolves.toEqual({
      enabled: true,
      count: 1,
    })

    expect(isCoreCachedJsonInitialized(state)).toBe(true)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({
      enabled: true,
      count: 1,
    })
  })

  it('uses sync fallback and caches normalized parsed values', () => {
    const filePath = tempJsonPath()
    fs.writeFileSync(filePath, JSON.stringify({ enabled: false }), 'utf-8')
    const state = createCoreCachedJsonState<TestSettings>()

    expect(getCoreCachedJsonFile(state, options(filePath))).toEqual({
      enabled: false,
      count: 1,
    })
    fs.writeFileSync(filePath, JSON.stringify({ enabled: true, count: 99 }), 'utf-8')
    expect(getCoreCachedJsonFile(state, options(filePath))).toEqual({
      enabled: false,
      count: 1,
    })
  })

  it('saves sync and async values back into the cache', async () => {
    const filePath = tempJsonPath()
    const state = createCoreCachedJsonState<TestSettings>()

    expect(saveCoreCachedJsonFile(state, options(filePath), { enabled: false, count: 2 })).toEqual({
      enabled: false,
      count: 2,
    })
    expect(getCoreCachedJsonFile(state, options(filePath))).toEqual({
      enabled: false,
      count: 2,
    })

    await expect(saveCoreCachedJsonFileAsync(state, options(filePath), { enabled: true, count: 3 }))
      .resolves.toEqual({
        enabled: true,
        count: 3,
      })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({
      enabled: true,
      count: 3,
    })
  })

  it('invalidates and updates the in-memory cache', () => {
    const filePath = tempJsonPath()
    const state = createCoreCachedJsonState<TestSettings>()
    saveCoreCachedJsonFile(state, options(filePath), { enabled: true, count: 4 })

    updateCoreCachedJsonInMemory(state, { enabled: false, count: 5 })
    expect(getCoreCachedJsonFile(state, options(filePath))).toEqual({
      enabled: false,
      count: 5,
    })

    invalidateCoreCachedJsonFile(state)
    expect(isCoreCachedJsonInitialized(state)).toBe(false)
    expect(getCoreCachedJsonFile(state, options(filePath))).toEqual({
      enabled: true,
      count: 4,
    })
  })
})
