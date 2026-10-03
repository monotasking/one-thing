import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http'

export interface ManagedHttpServer extends Server {
  /** Stop accepting work and end SSE, without waiting for in-flight requests. */
  stopAccepting(): void
  /** Await only after runtime work has been stopped and drained. */
  whenClosed(): Promise<void>
}

export function createManagedHttpServer(handler: RequestListener): ManagedHttpServer {
  const responses = new Set<ServerResponse>()
  const streams = new Set<ServerResponse>()
  let stopping = false
  let closed: Promise<void> | undefined
  let startPending = false
  let startSettled: Promise<void> | undefined
  const server = createServer((request, response) => {
    if (stopping) {
      response.writeHead(503, { connection: 'close', 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: false, error: 'Server is shutting down' }))
      return
    }
    responses.add(response)
    response.once('close', () => { responses.delete(response); streams.delete(response) })
    response.once('finish', () => { if (stopping) request.socket.end() })
    const writeHead = response.writeHead
    response.writeHead = function (...args: Parameters<ServerResponse['writeHead']>) {
      // writeHead(headers) can bypass Node's getHeader cache. Mirror just the
      // content type before it sends the headers, including the raw array form.
      const headers = args[args.length - 1]
      if (headers && typeof headers === 'object') {
        const pairs = Array.isArray(headers)
          ? Array.from({ length: headers.length / 2 }, (_, index) => [headers[index * 2], headers[index * 2 + 1]])
          : Object.entries(headers)
        for (const [name, value] of pairs) {
          if (String(name).toLowerCase() === 'content-type' && value !== undefined) response.setHeader('content-type', value)
        }
      }
      const result = Reflect.apply(writeHead, response, args) as ServerResponse
      if (String(response.getHeader('content-type') ?? '').startsWith('text/event-stream')) {
        streams.add(response)
        if (stopping) queueMicrotask(() => response.end())
      }
      return result
    } as ServerResponse['writeHead']
    handler(request, response)
  }) as ManagedHttpServer

  const listen = server.listen
  server.listen = function (...args: Parameters<Server['listen']>) {
    if (stopping) throw new Error('HTTP server is shutting down')
    if (startPending || server.listening) return Reflect.apply(listen, server, args) as ManagedHttpServer
    startPending = true
    let finish!: () => void
    startSettled = new Promise<void>(resolve => { finish = resolve })
    const done = (): void => {
      startPending = false
      server.removeListener('listening', done)
      server.removeListener('error', done)
      finish()
    }
    server.once('listening', done)
    server.once('error', done)
    try { return Reflect.apply(listen, server, args) as ManagedHttpServer }
    catch (error) { done(); throw error }
  } as ManagedHttpServer['listen']

  server.stopAccepting = () => {
    if (stopping) return
    stopping = true
    closed = (async () => {
      // A pending hostname lookup may create a listening socket after close()
      // would otherwise report ERR_SERVER_NOT_RUNNING. Keep ownership until it settles.
      if (startPending) await startSettled
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        })
      })
    })()
    // Keep an observation attached even when the host is still draining work.
    void closed.catch(() => {})
    for (const response of responses) {
      response.shouldKeepAlive = false
      if (streams.has(response)) response.end()
    }
    server.closeIdleConnections()
  }
  server.whenClosed = () => {
    server.stopAccepting()
    return closed!
  }
  return server
}
