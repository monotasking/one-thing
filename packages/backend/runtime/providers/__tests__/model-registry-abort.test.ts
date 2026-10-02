import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@onething/backend/stores/defaults/settings.js'

const ports = vi.hoisted(() => ({ settings: {} as ReturnType<typeof createDefaultSettings>, save: vi.fn(), fetch: vi.fn() }))
vi.mock('@onething/backend/stores/settings.js', () => ({ getSettings: () => ports.settings, saveSettings: ports.save }))
vi.mock('@onething/backend/provider-binding/bound-fetch.js', () => ({ createRequiredAppFetch: () => ports.fetch }))

const { refreshAllProviders } = await import('../model-registry-service.js')
// 目录走单份磁盘缓存(`<store>/cache/models-dev.json`):每条用例一个新 store,
// 上一条迟到的应答落进缓存不该让下一条读到「新鲜缓存」而不打网络。
let store = ''
beforeEach(() => {
  store = mkdtempSync(path.join(tmpdir(), 'model-registry-abort-'))
  vi.stubEnv('ONETHING_STORE_PATH', store)
  ports.settings = createDefaultSettings(); ports.save.mockReset(); ports.fetch.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(store, { recursive: true, force: true })
})

it('cancels an in-flight catalog fetch and never saves its late result', async () => {
  const controller = new AbortController()
  let respond!: (response: Response) => void
  ports.fetch.mockImplementation((_input, init) => {
    expect(init.signal).toBeInstanceOf(AbortSignal)
    return new Promise(resolve => { respond = resolve })
  })
  const refresh = refreshAllProviders({ signal: controller.signal })
  // 缓存先读盘(没有文件)再打网络,所以这一发不再是同步发出的。
  await vi.waitFor(() => expect(ports.fetch).toHaveBeenCalledOnce())
  expect(ports.save).toHaveBeenCalledOnce()
  controller.abort(new Error('desktop shutdown'))
  // Even a non-cooperative network adapter cannot commit after cancellation.
  respond(new Response('{}', { status: 200 }))
  await expect(refresh).rejects.toBe(controller.signal.reason)
  expect(ports.save).toHaveBeenCalledOnce()
})

it('rejects cancellation before any settings mutation and preserves genuine network failures', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(refreshAllProviders({ signal: controller.signal })).rejects.toBe(controller.signal.reason)
  expect(ports.save).not.toHaveBeenCalled()
  expect(ports.fetch).not.toHaveBeenCalled()
  const failure = new Error('catalog network failed')
  ports.fetch.mockRejectedValueOnce(failure)
  await expect(refreshAllProviders()).rejects.toBe(failure)
})
