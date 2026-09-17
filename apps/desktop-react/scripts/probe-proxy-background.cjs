/* Isolated, loopback-only investigation. Run with Electron and a temporary
 * --user-data-dir. Never opens Claude or changes the user's proxy settings.
 * argv: <bundled-policy.cjs> <certificate.pem> <key.pem>
 */
const { app, session, BrowserWindow, WebContentsView } = require('electron')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const requireApp = createRequire(require('node:path').resolve(__dirname, '../package.json'))
const { WebSocketServer } = requireApp('ws')
const { ShellProxyPolicy } = require(process.argv[2])
app.commandLine.appendSwitch('host-resolver-rules', 'MAP proxy-probe.invalid 127.0.0.1')
app.commandLine.appendSwitch('disable-background-networking')
app.setName('onething proxy audit')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const sockets = new Set()
const servers = []
const windows = []
const observe = server => {
  servers.push(server)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return server
}
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port) })
})
let originPort, tlsPort, proxyPort
let originHits = [], proxyHits = [], wsMessages = []
const tunneledPorts = new Set()
const routeOf = req => req.headers['x-audit-via'] || (tunneledPorts.has(req.socket.remotePort) ? 'proxy-tunnel' : 'direct')
const pageHTML = `<!doctype html><title>Local proxy audit</title><script>
window.polls=0;window.failures=0;
window.startPolls=()=>{window.timer=setInterval(()=>fetch('/poll?i='+(++window.polls),{cache:'no-store'}).catch(()=>window.failures++),250)};
document.addEventListener('visibilitychange',()=>navigator.sendBeacon('/visibility',document.visibilityState));
window.connectSocket=(endpoint='ws://'+location.host+'/socket')=>new Promise(resolve=>{window.ws=new WebSocket(endpoint);ws.onopen=()=>resolve(true);ws.onerror=()=>resolve(false)});
</script>`
function originHandler(req, res) {
  originHits.push({ path: req.url, via: routeOf(req), time: Date.now() })
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.url.startsWith('/page')) { res.setHeader('Content-Type', 'text/html'); res.end(pageHTML) }
  else res.end('origin-ok')
}
const origin = observe(http.createServer(originHandler))
const secureOrigin = observe(https.createServer({ cert: fs.readFileSync(process.argv[3]), key: fs.readFileSync(process.argv[4]) }, originHandler))
const wsServer = new WebSocketServer({ noServer: true })
function acceptWebSocket(req, socket, head) {
  wsServer.handleUpgrade(req, socket, head, ws => {
    const via = routeOf(req)
    ws.on('message', message => { wsMessages.push({ text: message.toString(), via }); ws.send('ack') })
  })
}
origin.on('upgrade', acceptWebSocket)
secureOrigin.on('upgrade', acceptWebSocket)
let proxySockets = new Set()
function makeProxy() {
  const proxy = observe(http.createServer((req, res) => {
    const url = new URL(req.url)
    proxyHits.push({ kind: 'http', path: url.pathname })
    if (url.hostname !== 'proxy-probe.invalid') { res.writeHead(403); res.end(); return }
    const upstream = http.request({ host: '127.0.0.1', port: originPort, path: url.pathname + url.search,
      method: req.method, headers: { ...req.headers, 'x-audit-via': 'proxy' } }, back => {
      res.writeHead(back.statusCode, back.headers); back.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(upstream)
  }))
  proxy.on('connection', s => { proxySockets.add(s); s.on('close', () => proxySockets.delete(s)) })
  proxy.on('connect', (req, socket, head) => {
    proxyHits.push({ kind: 'connect', target: req.url })
    const allowedPort = [originPort, tlsPort].find(port => req.url === `proxy-probe.invalid:${port}`)
    if (!allowedPort) { socket.destroy(); return }
    const upstream = net.connect(allowedPort, '127.0.0.1', () => {
      const localPort = upstream.localPort
      tunneledPorts.add(localPort)
      upstream.on('close', () => tunneledPorts.delete(localPort))
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  })
  proxy.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url)
    proxyHits.push({ kind: 'websocket', path: url.pathname })
    if (url.hostname !== 'proxy-probe.invalid') { socket.destroy(); return }
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      const headers = { ...req.headers, 'x-audit-via': 'proxy' }
      upstream.write(`GET ${url.pathname} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  })
  return proxy
}
const record = (name, value) => { results.push({ name, ...value }); console.log(JSON.stringify(results.at(-1))) }
const url = (path, secure = false) => `${secure ? 'https' : 'http'}://proxy-probe.invalid:${secure ? tlsPort : originPort}${path}`
const settings = () => ({ enabled: true, url: `http://127.0.0.1:${proxyPort}`, bypassRules: 'localhost;127.0.0.1;::1;*.local' })
const secureSocket = () => `window.connectSocket(${JSON.stringify(`wss://proxy-probe.invalid:${tlsPort}/socket`)})`
async function fresh(name) {
  const s = session.fromPartition(`audit-${name}-${Date.now()}`)
  s.setCertificateVerifyProc((request, callback) => callback(request.hostname === 'proxy-probe.invalid' ? 0 : -3))
  await s.setProxy({ mode: 'direct' })
  return s
}
async function request(s, name, secure = false) {
  const start = originHits.length
  let status, error
  try { const res = await s.fetch(url('/' + name, secure), { signal: AbortSignal.timeout(2500), cache: 'no-store' }); status = res.status; await res.text() }
  catch (e) { error = e.message }
  return { status, error, destinationHits: originHits.slice(start).filter(h => h.path === '/' + name), resolved: await s.resolveProxy(url('/' + name, secure)) }
}
async function viewFor(s) {
  const window = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  windows.push(window)
  const view = new WebContentsView({ webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 400, height: 300 })
  await view.webContents.loadURL(url('/page'))
  return { window, view }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  originPort = await listen(origin)
  tlsPort = await listen(secureOrigin)
  let proxy = makeProxy()
  proxyPort = await listen(proxy)
  record('runtime', { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch })
  const s = await fresh('normal')
  const errors = []
  const policy = new ShellProxyPolicy({ defaultSession: () => s, onError: (where, e) => errors.push({ where, message: e.message }) })
  await policy.apply(ShellProxyPolicy.fromSettings(settings()))
  record('healthy-http', await request(s, 'healthy-http'))
  record('healthy-https', { ...await request(s, 'healthy-https', true), connectCount: proxyHits.filter(h => h.kind === 'connect').length })
  const { view } = await viewFor(s)
  view.setVisible(false)
  const backgroundStart = originHits.length
  await view.webContents.executeJavaScript('window.startPolls()')
  await delay(3200)
  record('hidden-background-polling', { visibility: await view.webContents.executeJavaScript('document.visibilityState'), hits: originHits.slice(backgroundStart), resolved: await s.resolveProxy(url('/poll')) })
  await view.webContents.executeJavaScript('clearInterval(window.timer)')
  record('healthy-websocket', { opened: await view.webContents.executeJavaScript('window.connectSocket()'), resolved: await s.resolveProxy(`ws://proxy-probe.invalid:${originPort}/socket`) })
  await view.webContents.executeJavaScript('ws.send("healthy-proxied")')
  await delay(100)
  record('healthy-websocket-route', { messages: wsMessages.slice(-1) })
  await view.webContents.executeJavaScript('ws.close()')
  record('healthy-secure-websocket', { opened: await view.webContents.executeJavaScript(secureSocket()) })
  await view.webContents.executeJavaScript('ws.send("healthy-proxied-wss")')
  await delay(100)
  record('healthy-secure-websocket-route', { messages: wsMessages.slice(-1) })
  const savedPort = proxyPort
  for (const socket of [...proxySockets]) socket.destroy()
  await new Promise(resolve => proxy.close(resolve))
  await s.closeAllConnections()
  record('proxy-down-http', await request(s, 'proxy-down-http'))
  record('proxy-down-https', await request(s, 'proxy-down-https', true))
  record('proxy-down-websocket', { opened: await view.webContents.executeJavaScript('window.connectSocket()') })
  record('proxy-down-secure-websocket', { opened: await view.webContents.executeJavaScript(secureSocket()) })
  // A listening but unresponsive proxy, as distinct from connection refusal.
  const blackhole = observe(net.createServer())
  const blackholePort = await listen(blackhole)
  await policy.apply(ShellProxyPolicy.fromSettings({ ...settings(), url: `http://127.0.0.1:${blackholePort}` }))
  await s.closeAllConnections()
  record('unresponsive-proxy-http', await request(s, 'unresponsive-proxy-http'))
  proxy = makeProxy()
  proxyPort = await listen(proxy, savedPort)
  await policy.apply(ShellProxyPolicy.fromSettings(settings()))
  record('proxy-restored-http', await request(s, 'proxy-restored-http'))
  const invalid = []
  await policy.apply(ShellProxyPolicy.fromSettings({ enabled: true, url: 'not a proxy' }, e => invalid.push(e)))
  record('invalid-enabled-config', { ...await request(s, 'invalid-enabled-config'), invalid })
  // Fault injection: the real policy receives a setProxy rejection while an
  // actual Chromium session remains on its prior DIRECT configuration.
  const rejectSession = await fresh('reject')
  const caught = []
  const rejecting = new ShellProxyPolicy({ defaultSession: () => ({ setProxy: async () => { throw new Error('injected setProxy failure') } }), onError: (where, e) => caught.push({ where, message: e.message }) })
  await rejecting.apply(ShellProxyPolicy.fromSettings(settings()))
  await rejecting.register({ setProxy: async () => { throw new Error('injected partition failure') } }).ready
  record('setProxy-rejected-prior-direct', { ...await request(rejectSession, 'setProxy-rejected-prior-direct'), caught, applyAndReadyResolved: true })
  await s.setProxy(ShellProxyPolicy.fromSettings(settings()))
  const retainedErrors = []
  const retaining = new ShellProxyPolicy({ defaultSession: () => ({ setProxy: async () => { throw new Error('injected setProxy failure with existing proxy') } }), onError: (where, e) => retainedErrors.push({ where, message: e.message }) })
  await retaining.apply(ShellProxyPolicy.fromSettings({ ...settings(), url: 'http://127.0.0.1:1' }))
  record('setProxy-rejected-prior-proxy', { ...await request(s, 'setProxy-rejected-prior-proxy'), retainedErrors })
  const bypass = await fresh('bypass')
  await bypass.setProxy(ShellProxyPolicy.fromSettings({ ...settings(), bypassRules: 'proxy-probe.invalid' }))
  record('explicit-bypass', await request(bypass, 'explicit-bypass'))
  // Existing WebSocket is established while DIRECT, then proxy is enabled using
  // the production policy, which does not call closeAllConnections.
  const persistent = await fresh('existing-socket')
  const pv = await viewFor(persistent)
  const directSocketOpened = await pv.view.webContents.executeJavaScript(secureSocket())
  const pp = new ShellProxyPolicy({ defaultSession: () => persistent })
  await pp.apply(ShellProxyPolicy.fromSettings(settings()))
  await pv.view.webContents.executeJavaScript('ws.send("after-enabling-proxy")')
  await delay(150)
  record('existing-direct-websocket-after-enable', { secure: true, directSocketOpened, messages: wsMessages.filter(m => m.text === 'after-enabling-proxy'), resolvedForNewRequest: await persistent.resolveProxy(url('/new')), socketState: await pv.view.webContents.executeJavaScript('ws.readyState') })
  await persistent.closeAllConnections()
  await delay(150)
  await pv.view.webContents.executeJavaScript('if(ws.readyState===1)ws.send("after-closeAllConnections")')
  await delay(150)
  record('closeAllConnections-websocket-state', { state: await pv.view.webContents.executeJavaScript('ws.readyState'), messages: wsMessages.filter(m => m.text === 'after-closeAllConnections') })
  record('policy-errors', { errors })
}).catch(e => { record('fatal', { error: e.stack }); process.exitCode = 1 }).finally(() => {
  for (const w of windows) if (!w.isDestroyed()) w.destroy()
  for (const s of sockets) s.destroy()
  for (const s of servers) s.close()
  wsServer.close()
  app.exit(process.exitCode || 0)
})
