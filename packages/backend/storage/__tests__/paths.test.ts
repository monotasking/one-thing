import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureOnethingStoreDirs,
  getOnethingLogDir,
  getOnethingSessionDatabasePath,
  getOnethingSessionPath,
  getOnethingStorePath,
  onethingStorePathOptions,
} from '../paths.js'

const originalStorePath = process.env.ONETHING_STORE_PATH

afterEach(() => {
  if (originalStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = originalStorePath
})

describe('onething runtime storage paths', () => {
  it('keeps onething store defaults out of core storage', () => {
    delete process.env.ONETHING_STORE_PATH

    expect(getOnethingStorePath()).toBe(path.join(os.homedir(), '.onething'))
    expect(getOnethingSessionDatabasePath()).toBe(path.join(os.homedir(), '.onething', 'onething.sqlite'))
  })

  it('honors ONETHING_STORE_PATH and explicit storePath overrides', () => {
    process.env.ONETHING_STORE_PATH = '/env/onething'

    expect(getOnethingStorePath()).toBe('/env/onething')
    expect(getOnethingLogDir()).toBe(path.join('/env/onething', 'log'))
    expect(getOnethingSessionPath('abc')).toBe(path.join('/env/onething', 'sessions', 'abc.json'))
    expect(getOnethingStorePath({ storePath: '/explicit/onething' })).toBe('/explicit/onething')
  })

  it('resolves onething defaults before path construction', () => {
    expect(onethingStorePathOptions({ storePath: '/tmp/onething' })).toMatchObject({
      storePath: '/tmp/onething',
      defaultStoreDirName: '.onething',
      sessionDatabaseFilename: 'onething.sqlite',
    })
  })

  it('creates onething store directories through the runtime wrapper', () => {
    const root = path.join(os.tmpdir(), `onething-runtime-store-${Date.now()}`)
    try {
      ensureOnethingStoreDirs({ storePath: root })
      expect(getOnethingSessionDatabasePath({ storePath: root })).toBe(path.join(root, 'onething.sqlite'))
      expect(getOnethingLogDir({ storePath: root })).toBe(path.join(root, 'log'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
