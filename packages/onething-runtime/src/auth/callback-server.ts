import http from 'node:http'
import type { OnethingAuthCallbackRegistration } from './auth-service.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('auth')

interface CallbackRegistration {
  flowId: string
  providerId: string
  state: string
  path: string
  expiresAt: number
  onCallback: OnethingAuthCallbackRegistration['onCallback']
}

interface ManagedServer {
  port: number
  server: http.Server
}

export class CallbackServerManager {
  private servers = new Map<number, ManagedServer>()
  private registrations = new Map<string, CallbackRegistration>()

  async registerFlow(options: OnethingAuthCallbackRegistration): Promise<{ redirectUri: string; port: number }> {
    const port = await this.ensureServer(options.ports)
    const registration: CallbackRegistration = {
      flowId: options.flowId,
      providerId: options.providerId,
      state: options.state,
      path: options.path,
      expiresAt: Date.now() + options.timeoutMs,
      onCallback: options.onCallback,
    }

    this.registrations.set(options.state, registration)
    const timeout = setTimeout(() => {
      const current = this.registrations.get(options.state)
      if (current?.flowId === options.flowId && Date.now() >= current.expiresAt) {
        this.registrations.delete(options.state)
      }
    }, options.timeoutMs)
    timeout.unref?.()

    return {
      redirectUri: `http://localhost:${port}${options.path}`,
      port,
    }
  }

  unregisterState(state: string): void {
    this.registrations.delete(state)
  }

  cleanup(): void {
    for (const managed of this.servers.values()) {
      managed.server.close()
    }
    this.servers.clear()
    this.registrations.clear()
  }

  private async ensureServer(ports: number[]): Promise<number> {
    for (const port of ports) {
      if (this.servers.has(port)) return port
      try {
        await this.startServer(port)
        return port
      } catch {
        // Try next callback port.
      }
    }
    throw new Error(`Unable to start OAuth callback server on ports ${ports.join(', ')}`)
  }

  private startServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(port, req, res)
      })

      server.on('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        this.servers.set(port, { port, server })
        resolve()
      })
    })
  }

  private handleRequest(port: number, req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const state = url.searchParams.get('state') || ''
    const code = url.searchParams.get('code') || ''
    const error = url.searchParams.get('error') || ''
    // RFC 9207: the AS stamps the authorization response with its issuer so
    // the client can detect mix-up attacks. Forwarded to whoever redeems the
    // code (MCP flows feed it to the SDK's strict iss validation).
    const iss = url.searchParams.get('iss') || ''
    const registration = state ? this.registrations.get(state) : undefined

    if (!registration || registration.path !== url.pathname) {
      this.writeCallbackPage(res, false, 'Authorization request was not recognized. Please return to the app and try again.')
      return
    }

    this.registrations.delete(state)

    if (error) {
      this.writeCallbackPage(res, false, 'Authorization failed. Please return to the app and try again.')
      return
    }

    if (!code) {
      this.writeCallbackPage(res, false, 'Authorization response was missing a code. Please return to the app and try again.')
      return
    }

    this.writeCallbackPage(res, true, 'Authorization complete. You can close this window and return to onething.')
    registration.onCallback({
      code,
      state,
      ...(iss ? { iss } : {}),
      flowId: registration.flowId,
      providerId: registration.providerId,
    }).catch((callbackError) => {
      log.error('oauth callback processing failed', {
        flowId: registration.flowId,
        providerId: registration.providerId,
      }, callbackError)
    })
  }

  private writeCallbackPage(res: http.ServerResponse, success: boolean, message: string): void {
    res.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${success ? 'Authorization Complete' : 'Authorization Failed'}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111; color: #f7f7f7; }
      main { width: min(520px, calc(100vw - 40px)); }
      h1 { font-size: 22px; margin: 0 0 10px; }
      p { color: #cfcfcf; line-height: 1.5; margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>${success ? 'Authorization Complete' : 'Authorization Failed'}</h1>
      <p>${message}</p>
    </main>
    <script>setTimeout(() => window.close(), 1800)</script>
  </body>
</html>`)
  }
}

export const callbackServerManager = new CallbackServerManager()
