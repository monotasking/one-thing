/**
 * voice 域,端到端穿过 dispatcher(结构债 P4c 第十一批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/voice/__tests__/ipc.test.ts`
 * (那只裸 `ipcMain.handle` 工厂的用例)、bridge 上那十一条包装、server 的十一条
 * REST 路由与 `voice` adapter 上那十二个桩。值得钉的是:
 *  - 十一个方法都在 router 的白名单上,**两条推送不在**(它们早就是
 *    `configureVoiceHost` 的端口,本批一行没动),**`audioChunk` 也不在** ——
 *    高频 PCM 单向上行按拍板 #10 留在手写通道上(流式单向残留集);
 *  - `transport:'ipc'` 逐条转调 VoiceService / runtime 投影,与迁移前同义;
 *  - `transport:'http'` 逐字沿用旧 server adapter 的十一个答案 ——
 *    同一句话、同一份「停用」状态、同一份空模型表、`stop` 恒成功,
 *    **且一次都不碰 VoiceService**;
 *  - `runtimeReady` 的发起窗改由 `runtimeWindow.getWebContents` 端口指认。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { voiceRouter } from '@shared/ipc/voice.js'

const service = vi.hoisted(() => ({
  getState: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  submitUtterance: vi.fn(),
  submitTranscript: vi.fn(),
  synthesize: vi.fn(),
  handleRuntimeReady: vi.fn(),
  handleRuntimeEvent: vi.fn(),
  handleAudioChunk: vi.fn(),
}))

const providers = vi.hoisted(() => ({
  getOpenRouterTTSModels: vi.fn(),
  transcribeUtterance: vi.fn(),
}))

const settings = vi.hoisted(() => ({ getSettings: vi.fn() }))

vi.mock('../../wiring/voice/service.js', () => ({
  getVoiceService: () => service,
}))

vi.mock('../../wiring/voice/providers.js', () => ({
  getOpenRouterTTSModels: providers.getOpenRouterTTSModels,
  transcribeUtterance: providers.transcribeUtterance,
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => settings.getSettings(),
}))

const HTTP = { transport: 'http', sandboxRoot: '/w' } as const
const SERVER_VOICE_UNAVAILABLE_ERROR =
  'Voice runtime is not available in the web server runtime.'

async function loadDomain() {
  const [registry, domain, hostPorts] = await Promise.all([
    import('../registry.js'),
    import('../domains/voice.js'),
    import('@onething/runtime/voice/host-ports.wiring'),
  ])
  return { ...registry, ...domain, ...hostPorts }
}

function unwrap(response: { ok: boolean }) {
  expect(response.ok).toBe(true)
  return (response as { ok: true; data: unknown }).data as Record<string, any>
}

describe('voice RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    service.getState.mockReset().mockReturnValue({ status: 'idle', enabled: true, runtimeReady: true, updatedAt: 1 })
    service.start.mockReset().mockResolvedValue({ success: true })
    service.stop.mockReset().mockReturnValue({ success: true })
    service.submitUtterance.mockReset().mockResolvedValue({ success: true, transcript: 'hi' })
    service.submitTranscript.mockReset().mockResolvedValue({ success: true })
    service.synthesize.mockReset().mockResolvedValue({ success: true, requestId: 'r1' })
    service.handleRuntimeReady.mockReset()
    service.handleRuntimeEvent.mockReset()
    service.handleAudioChunk.mockReset()
    providers.getOpenRouterTTSModels.mockReset().mockResolvedValue({ success: true, models: [{ id: 'tts' }] })
    providers.transcribeUtterance.mockReset()
    settings.getSettings.mockReset().mockReturnValue({ voice: { tts: {}, asr: {} } })
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    const { resetRpcRegistryForTests } = await import('../registry.js')
    resetRpcRegistryForTests()
    const { configureVoiceHost } = await import('@onething/runtime/voice/host-ports.wiring')
    configureVoiceHost({})
    vi.resetModules()
  })

  it('forwards the desktop calls straight to the voice service', async () => {
    const { dispatchRpc, registerRouterHandlers, voiceRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(voiceRouter, voiceRpcHandlers)

    expect(unwrap(await dispatchRpc({ domain: 'voice', method: 'getState', payload: {} })))
      .toEqual({ success: true, state: expect.objectContaining({ status: 'idle' }) })

    await dispatchRpc({ domain: 'voice', method: 'start', payload: { sessionId: 's1', reason: 'manual' } })
    expect(service.start).toHaveBeenCalledWith({ sessionId: 's1', reason: 'manual' })

    await dispatchRpc({ domain: 'voice', method: 'stop', payload: { reason: 'manual', submit: false } })
    expect(service.stop).toHaveBeenCalledWith({ reason: 'manual', submit: false })

    await dispatchRpc({ domain: 'voice', method: 'synthesize', payload: { text: 'hello' } })
    expect(service.synthesize).toHaveBeenCalledWith({ text: 'hello' })

    expect(unwrap(await dispatchRpc({ domain: 'voice', method: 'getTTSModels', payload: { force: true } })))
      .toEqual(expect.objectContaining({ success: true }))
    expect(providers.getOpenRouterTTSModels).toHaveBeenCalledWith(true)
  })

  it('keeps the PCM uplink off the router (one-way channel, 拍板 #10)', async () => {
    const { dispatchRpc, registerRouterHandlers, voiceRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(voiceRouter, voiceRpcHandlers)

    const response = await dispatchRpc({
      domain: 'voice',
      method: 'audioChunk',
      payload: { sessionId: 's1', chunkBase64: 'AAAA', phase: 'recording' },
    })
    expect(response.ok).toBe(false)
    expect(service.handleAudioChunk).not.toHaveBeenCalled()
  })

  it('asks the host which window the runtime-ready came from', async () => {
    const { dispatchRpc, registerRouterHandlers, voiceRpcHandlers, configureVoiceHost } = await loadDomain()
    const webContents = { id: 7, send: vi.fn() }
    configureVoiceHost({ runtimeWindow: { getWebContents: () => webContents } })
    dispose = registerRouterHandlers(voiceRouter, voiceRpcHandlers)

    expect(unwrap(await dispatchRpc({ domain: 'voice', method: 'runtimeReady', payload: {} })))
      .toEqual({ success: true })
    expect(service.handleRuntimeReady).toHaveBeenCalledWith(webContents)
  })

  it('marks runtime-ready without a sender when no host window is injected', async () => {
    const { dispatchRpc, registerRouterHandlers, voiceRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(voiceRouter, voiceRpcHandlers)

    expect(unwrap(await dispatchRpc({ domain: 'voice', method: 'runtimeReady', payload: {} })))
      .toEqual({ success: true })
    expect(service.handleRuntimeReady).toHaveBeenCalledWith(undefined)
  })

  it('answers every http caller with the old server-runtime stubs', async () => {
    const { dispatchRpc, registerRouterHandlers, voiceRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(voiceRouter, voiceRpcHandlers)

    expect(unwrap(await dispatchRpc({ domain: 'voice', method: 'getState', payload: {} }, HTTP)))
      .toEqual({ success: true, state: expect.objectContaining({ status: 'disabled', enabled: false, runtimeReady: false }) })
    expect(unwrap(await dispatchRpc({ domain: 'voice', method: 'stop', payload: {} }, HTTP)))
      .toEqual({ success: true })
    expect(unwrap(await dispatchRpc({ domain: 'voice', method: 'getTTSModels', payload: {} }, HTTP)))
      .toEqual(expect.objectContaining({ success: true, models: [] }))

    for (const method of [
      'start', 'submitUtterance', 'submitTranscript', 'synthesize',
      'testASR', 'testTTS', 'runtimeReady', 'runtimeEvent',
    ]) {
      const data = unwrap(await dispatchRpc({ domain: 'voice', method, payload: {} }, HTTP))
      expect(data).toEqual(expect.objectContaining({
        success: false,
        error: SERVER_VOICE_UNAVAILABLE_ERROR,
      }))
    }

    // 一次都没碰真服务。
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
  })

  it('refuses a method that is not on the router', async () => {
    const { dispatchRpc, registerRouterHandlers, voiceRpcHandlers } = await loadDomain()
    dispose = registerRouterHandlers(voiceRouter, voiceRpcHandlers)

    const response = await dispatchRpc({ domain: 'voice', method: 'onVoiceEvent', payload: {} })
    expect(response.ok).toBe(false)
  })
})
