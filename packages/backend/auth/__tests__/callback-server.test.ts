import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallbackServerManager } from '../callback-server.js'

async function getAvailablePort(): Promise<number> {
  const server = net.createServer()
  return await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate port')))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

describe('CallbackServerManager', () => {
  const managers: CallbackServerManager[] = []

  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.cleanup()
    }
  })

  it('serves OAuth callback responses and invokes the registered flow callback once', async () => {
    const manager = new CallbackServerManager()
    managers.push(manager)
    const port = await getAvailablePort()
    const onCallback = vi.fn(async () => undefined)

    const registration = await manager.registerFlow({
      flowId: 'flow-1',
      providerId: 'codex',
      state: 'state-1',
      path: '/callback',
      ports: [port],
      timeoutMs: 30_000,
      onCallback,
    })

    expect(registration).toEqual({
      redirectUri: `http://localhost:${port}/callback`,
      port,
    })

    const response = await fetch(`http://127.0.0.1:${port}/callback?state=state-1&code=abc123`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Authorization Complete')
    expect(onCallback).toHaveBeenCalledWith({
      code: 'abc123',
      state: 'state-1',
      flowId: 'flow-1',
      providerId: 'codex',
    })

    const replay = await fetch(`http://127.0.0.1:${port}/callback?state=state-1&code=abc123`)
    expect(replay.status).toBe(400)
    expect(onCallback).toHaveBeenCalledTimes(1)
  })
})
