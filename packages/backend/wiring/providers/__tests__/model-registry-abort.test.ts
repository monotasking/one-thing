import { beforeEach, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'

const ports = vi.hoisted(() => ({ settings: {} as ReturnType<typeof createDefaultSettings>, save: vi.fn(), fetch: vi.fn() }))
vi.mock('../../../stores/settings.js', () => ({ getSettings: () => ports.settings, saveSettings: ports.save }))
vi.mock('../../../provider-binding/bound-fetch.js', () => ({ createRequiredAppFetch: () => ports.fetch }))

const { refreshAllProviders } = await import('../model-registry.js')
beforeEach(() => { ports.settings = createDefaultSettings(); ports.save.mockReset(); ports.fetch.mockReset() })

it('cancels an in-flight catalog fetch and never saves its late result', async () => {
  const controller = new AbortController()
  let respond!: (response: Response) => void
  ports.fetch.mockImplementation((_input, init) => {
    expect(init.signal).toBeInstanceOf(AbortSignal)
    return new Promise(resolve => { respond = resolve })
  })
  const refresh = refreshAllProviders({ signal: controller.signal })
  expect(ports.fetch).toHaveBeenCalledOnce()
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
