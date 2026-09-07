import { get, type IncomingMessage } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { createManagedHttpServer, type ManagedHttpServer } from '../http-lifecycle.js'

const servers: ManagedHttpServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await server.whenClosed()
  }
})

async function listen(server: ManagedHttpServer): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  return `http://127.0.0.1:${address.port}`
}

function request(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => get(url, resolve).once('error', reject))
}

it('ends an active SSE response so graceful close does not wait forever', async () => {
  let subscriptions = 0
  const server = createManagedHttpServer((_request, response) => {
    subscriptions++
    response.once('close', () => { subscriptions-- })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ready\n\n')
  })
  const response = await request(await listen(server))
  const ended = new Promise<void>(resolve => response.once('end', resolve))
  response.resume()
  expect(subscriptions).toBe(1)
  server.stopAccepting()
  await Promise.all([ended, server.whenClosed()])
  expect(subscriptions).toBe(0)
})

it('stops admission without waiting for an in-flight request to finish', async () => {
  let finish!: () => void
  let started!: () => void
  const incoming = new Promise<void>(resolve => { started = resolve })
  const server = createManagedHttpServer((_request, response) => {
    finish = () => response.end('saved')
    started()
  })
  const responsePromise = request(await listen(server))
  await incoming
  server.stopAccepting()
  let closed = false
  const closing = server.whenClosed().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  finish()
  const response = await responsePromise
  response.resume()
  await closing
  expect(response.statusCode).toBe(200)
})

it('closing an unstarted server is idempotent', async () => {
  const server = createManagedHttpServer((_request, response) => response.end())
  expect(server.whenClosed()).toBe(server.whenClosed())
  await server.whenClosed()
  expect(() => server.listen(0, '127.0.0.1')).toThrow('shutting down')
})

it('waits for a pending hostname listen before reporting the server closed', async () => {
  const server = createManagedHttpServer((_request, response) => response.end())
  servers.push(server)
  server.listen(0, 'localhost')
  server.stopAccepting()
  await server.whenClosed()
  expect(server.listening).toBe(false)
  expect(server.address()).toBe(null)
})

it('ends an SSE response whose headers are produced after admission stops', async () => {
  let sendHeaders!: () => void
  let arrived!: () => void
  const started = new Promise<void>(resolve => { arrived = resolve })
  const server = createManagedHttpServer((_request, response) => {
    sendHeaders = () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ready\n\n')
    }
    arrived()
  })
  const pendingResponse = request(await listen(server))
  await started
  server.stopAccepting()
  sendHeaders()
  const response = await pendingResponse
  const ended = new Promise<void>(resolve => response.once('end', resolve))
  response.resume()
  await Promise.all([ended, server.whenClosed()])
  expect(server.listening).toBe(false)
})
