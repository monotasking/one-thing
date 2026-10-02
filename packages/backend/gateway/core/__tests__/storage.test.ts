import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getGatewayDataPath,
  getGatewayStorePath,
  readGatewayJsonFile,
  writeGatewayJsonFile,
} from '../storage.js'

const originalStorePath = process.env.ONETHING_STORE_PATH

afterEach(() => {
  if (originalStorePath === undefined) {
    delete process.env.ONETHING_STORE_PATH
  } else {
    process.env.ONETHING_STORE_PATH = originalStorePath
  }
})

describe('gateway storage', () => {
  it('keeps gateway-owned state under the onething store path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-gateway-storage-'))
    process.env.ONETHING_STORE_PATH = root

    expect(getGatewayStorePath()).toBe(root)
    expect(getGatewayDataPath('wechat-token.json')).toBe(path.join(root, 'gateway', 'wechat-token.json'))
  })

  it('reads and writes JSON without depending on the onething business runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-gateway-json-'))
    const filePath = path.join(root, 'gateway', 'allowlist.json')

    expect(readGatewayJsonFile(filePath, { mode: 'open' })).toEqual({ mode: 'open' })

    writeGatewayJsonFile(filePath, { mode: 'strict', ids: ['user-1'] })

    expect(readGatewayJsonFile(filePath, null)).toEqual({ mode: 'strict', ids: ['user-1'] })
  })
})
