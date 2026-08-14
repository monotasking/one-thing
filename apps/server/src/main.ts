import { createOnethingHttpServer } from './http.js'
import { createDevelopmentOnethingServerRuntime } from './runtime.js'

const port = Number.parseInt(process.env.ONETHING_SERVER_PORT || '8787', 10)
const host = process.env.ONETHING_SERVER_HOST || '127.0.0.1'
const corsOrigin = process.env.ONETHING_CORS_ORIGIN || 'http://127.0.0.1:5174'
const authToken = process.env.ONETHING_SERVER_TOKEN
const workspaceRoot = process.env.ONETHING_SERVER_WORKSPACE_ROOT
const dataRoot = process.env.ONETHING_SERVER_DATA_ROOT
const settingsRoot = process.env.ONETHING_SERVER_SETTINGS_ROOT

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1'])
const allowInsecure = ['1', 'true', 'yes'].includes(
  (process.env.ONETHING_SERVER_ALLOW_INSECURE || '').toLowerCase(),
)
// Fail fast before paying the runtime-creation cost: a non-loopback bind
// without a shared-secret token exposes the full API to the LAN.
if (!authToken && !loopbackHosts.has(host)) {
  if (!allowInsecure) {
    console.error(
      `[onething-server] FATAL: refusing to listen on ${host} without ONETHING_SERVER_TOKEN — `
      + 'the API would be reachable from other machines without authentication.\n'
      + '  Set ONETHING_SERVER_TOKEN to a shared secret, or start with '
      + 'ONETHING_SERVER_ALLOW_INSECURE=1 to bypass this check (not recommended).',
    )
    process.exit(1)
  }
  console.warn(
    `[onething-server] WARNING: listening on ${host} without ONETHING_SERVER_TOKEN — `
    + 'the API is reachable from other machines without authentication.',
  )
}

const runtimeCreateStart = Date.now()
const serverRuntime = await createDevelopmentOnethingServerRuntime({ workspaceRoot, dataRoot, settingsRoot })
console.log(`[Perf][Startup] runtime-created in ${Date.now() - runtimeCreateStart}ms`)
const server = createOnethingHttpServer({
  runtime: serverRuntime.runtime,
  corsOrigin,
  authToken,
  // Taken from the runtime rather than from `workspaceRoot` above: the runtime
  // is where the env var + tmpdir fallback are resolved, and a second
  // resolution here could drift into a *different* root — which for the
  // sandbox-scoped RPC domains would mean clamping against the wrong tree.
  workspaceRoot: serverRuntime.workspaceRoot,
})

server.listen(port, host, () => {
  console.log(`[onething-server] listening on http://${host}:${port}`)
  // Pairing line for mobile clients: scan/encode this JSON as a QR code.
  const pairing: Record<string, unknown> = { host, port }
  if (authToken) pairing.token = authToken
  console.log(`[onething-server] pairing ${JSON.stringify(pairing)}`)
  console.log(`[Perf][Startup] http-listening +${Math.round(process.uptime() * 1000)}ms since process start`)
})

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[onething-server] received ${signal}, shutting down`)
  server.close(() => {
    serverRuntime.shutdown()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
