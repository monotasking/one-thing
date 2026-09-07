import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { bumpSessionShadowStats, flushSessionEventStats, getSessionShadowStatsPath, readSessionShadowStats, resetSessionEventStatsCache } from '../event-stats.js'

let root: string
let previous: string | undefined
beforeEach(() => {
  previous = process.env.ONETHING_STORE_PATH
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-owner-'))
  resetSessionEventStatsCache()
})
afterEach(() => {
  flushSessionEventStats()
  resetSessionEventStatsCache()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  fs.rmSync(root, { recursive: true, force: true })
})

it('flushes an old buffer to A and loads fresh B statistics without a cache reset', () => {
  process.env.ONETHING_STORE_PATH = path.join(root, 'a')
  const a = getSessionShadowStatsPath()
  bumpSessionShadowStats({ runs: 3 })
  process.env.ONETHING_STORE_PATH = path.join(root, 'b')
  const b = getSessionShadowStatsPath()
  flushSessionEventStats()
  expect(JSON.parse(fs.readFileSync(a, 'utf8')).runs).toBe(3)
  expect(fs.existsSync(b)).toBe(false)
  expect(readSessionShadowStats().runs).toBe(0)
  bumpSessionShadowStats({ runs: 1 })
  flushSessionEventStats()
  expect(JSON.parse(fs.readFileSync(b, 'utf8')).runs).toBe(1)
  process.env.ONETHING_STORE_PATH = path.join(root, 'a')
  expect(readSessionShadowStats().runs).toBe(3)
})
