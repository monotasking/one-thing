/**
 * Deterministic A1 -> B -> A2 experiment for streaming follow jitter.
 * Run: node scripts/probe-follow-aba.mjs [--label=run-name]
 * Each lane uses its own store, user-data directory and offscreen Electron.
 * Only the test Vite response changes: B skips snapTail, retaining stick().
 * No production source, real provider or user session is changed.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { createServer } from 'vite'
import { fakeProviderAiSettings, FAKE_PROVIDER_ENV } from '../../../scripts/lib/gate-fake-provider.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const sourcePath = path.join(appRoot, 'src/content/ChatStream.tsx')
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) ?? new Date().toISOString().replace(/[:.]/g, '-')
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Invalid output label')
const outDir = path.join(repoRoot, 'output/follow-aba', label)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = value => createHash('sha256').update(value).digest('hex')
const MARKER = 'FOLLOW_ABA_FIXED_REPLAY'
const GAP_MS = 40
const WIDTH = 1060
const HEIGHT = 860

// Same paragraphs, same chunk boundaries and requested delays for all lanes.
const paragraphs = [
  'Let me check the report carefully. The content grows while the reader follows the last line. ',
  'Now test it locally against the same input. The command should return a deterministic result. ',
  'Options: keep the existing scroll position while browsing, and follow the reply only when pinned. ',
  '这一段用于检查持续输出时的位置。旧段落已经排好，新的文字继续追加，工具卡应保持清晰。',
  'Test 1: report_daily with synthetic data. Test 2: the section-3 logic and its output. ',
]
function chunks(text, field) {
  const sizes = [17, 31, 11, 23, 7, 29]
  const out = []
  for (let at = 0, n = 0; at < text.length; n++) {
    const piece = text.slice(at, at + sizes[n % sizes.length])
    out.push({ delta: { [field]: piece }, wait: GAP_MS })
    at += piece.length
  }
  return out
}
const rounds = [0, 1, 2].map(round => {
  const thought = Array.from({ length: 24 }, (_, n) => `${paragraphs[(n + round) % paragraphs.length]}\n\n`).join('')
  const plan = chunks(thought, 'reasoning_content')
  if (round < 2) {
    plan.push(...chunks('明白，检查这一组结果，然后继续。\n\n', 'content'))
    const args = JSON.stringify({ command: 'printf "ABA fixture complete\\n"' })
    plan.push({ delta: { tool_calls: [{ index: 0, id: `call_aba_${round}`, type: 'function', function: { name: 'bash', arguments: '' } }] }, wait: 100 })
    for (let i = 0; i < args.length; i += 12) plan.push({ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 12) } }] }, wait: 100 })
  } else {
    plan.push(...chunks(Array.from({ length: 14 }, (_, n) => `第 ${n + 1} 项：${paragraphs[n % paragraphs.length]}\n\n`).join(''), 'content'))
  }
  return plan
})
const fixtureHash = sha(JSON.stringify(rounds))

async function waitFor(name, predicate, timeout = 45000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(100) }
  throw new Error(`Timeout: ${name}`)
}
async function rpc(rec, domain, method, payload = {}) {
  const response = await fetch(`http://${rec.host}:${rec.port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rec.token}` },
    body: JSON.stringify({ domain, method, payload }),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(`RPC ${domain}.${method}: ${JSON.stringify(result.error)}`)
  return result.data
}
async function startProvider(state) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const messages = payload.messages ?? []
        const last = messages.at(-1)
        const selected = last?.role === 'tool' || (last?.role === 'user' && JSON.stringify(last.content).includes(MARKER))
        const round = messages.filter(m => m.role === 'tool').length
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const frame = (delta, finish = null) => ({ id: `chatcmpl-aba-${round}`, object: 'chat.completion.chunk', created: 1700000000, model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }] })
        const send = (delta, finish) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(frame(delta, finish))}\n\n`) }
        if (selected && round < rounds.length && !state.served.includes(round)) {
          state.served.push(round)
          const start = performance.now()
          await delay(700)
          for (let i = 0; i < rounds[round].length && !res.destroyed; i++) {
            const item = rounds[round][i]
            send(item.delta)
            state.emitted.push({ round, index: i, at: performance.now() - start, delta: item.delta })
            await delay(item.wait)
          }
          send({}, round < 2 ? 'tool_calls' : 'stop')
          if (round === 2) state.done = true
        } else send({}, 'stop')
        if (!res.destroyed) { res.end('data: [DONE]\n\n') }
      } catch (error) { state.error = String(error); res.destroy() }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

export async function installSampler(page) {
  return page.evaluate(() => {
    window.__aba = { frames: [], stickFrames: [], stopped: false, ids: new WeakMap(), nextId: 1 }
    const idOf = el => {
      if (!el) return null
      if (!window.__aba.ids.has(el)) window.__aba.ids.set(el, window.__aba.nextId++)
      return window.__aba.ids.get(el)
    }
    const box = el => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { id: idOf(el), top: r.top, bottom: r.bottom, height: r.height }
    }
    const sample = (reason, supplied) => {
      const scroll = supplied ?? [...document.querySelectorAll('[data-testid="chat-stream"]')].find(el => el.clientHeight > 0)
      if (!scroll) return
      const column = scroll.firstElementChild
      const row = [...column.children].reverse().find(el => el.matches('[data-message-id][data-role="assistant"]'))
      if (!row) return
      const sr = scroll.getBoundingClientRect()
      const candidates = [...row.querySelectorAll('p, [data-tool-card]')]
        .filter(el => !el.closest('[data-testid="chat-readout"], [data-testid="chat-actions"]'))
      const visible = candidates.filter(el => {
        const r = el.getBoundingClientRect()
        return r.bottom > sr.top && r.top < sr.bottom && r.height > 0
      }).slice(-8)
      const readout = row.querySelector('[data-testid="chat-readout"]')
      const card = row.querySelector('[data-tool-card]')
      const children = [...column.children]
      const seat = children.at(-1)?.hasAttribute('data-seat') ? children.at(-1) : null
      const f = {
        t: performance.now(), reason, st: scroll.scrollTop, sh: scroll.scrollHeight, ch: scroll.clientHeight,
        viewport: box(scroll), column: box(column), row: box(row), readout: box(readout), card: box(card),
        nudge: Number.parseFloat((row.style.translate || '0 0').split(/\s+/)[1]) || 0,
        translate: row.style.translate, seat: seat?.getBoundingClientRect().height ?? 0,
        streaming: Boolean(row.querySelector('[data-testid="chat-stop"]')),
        blocks: visible.map(el => ({ ...box(el), chars: el.textContent.length, kind: el.hasAttribute('data-tool-card') ? 'tool' : 'text' })),
      }
      window.__aba[reason === 'stick' ? 'stickFrames' : 'frames'].push(f)
    }
    window.__abaAfterStick = el => { if (!window.__aba.stopped) sample('stick', el) }
    // Sample in the task following rAF, not before the product ResizeObserver.
    // These are post-rAF geometry samples, not a guarantee of compositor timing.
    const tick = () => {
      if (window.__aba.stopped) return
      setTimeout(() => { if (!window.__aba.stopped) sample('post-raf') }, 0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

export function summarize(data) {
  const eps = 0.05
  const pairs = []
  const changed = []
  let direction = 0, lastMoveAt = 0, flips = 0, bodyDown = 0, blockPairs = 0
  for (let i = 1; i < data.frames.length; i++) {
    const a = data.frames[i - 1], b = data.frames[i]
    const eligible = a.streaming && b.streaming && a.row.id === b.row.id
      && a.readout && b.readout && a.readout.id === b.readout.id && a.seat < 0.01 && b.seat < 0.01
      && Math.abs(a.sh - a.ch - a.st) < 3 && Math.abs(b.sh - b.ch - b.st) < 3
    if (!eligible) { direction = 0; continue }
    const dy = b.readout.top - a.readout.top
    const dh = b.row.height - a.row.height
    pairs.push({ t: b.t, dy, dh, dst: b.st - a.st, dnudge: b.nudge - a.nudge })
    if (Math.abs(dy) > eps) {
      const dir = Math.sign(dy)
      if (direction && dir !== direction && b.t - lastMoveAt < 400) flips++
      direction = dir; lastMoveAt = b.t
      changed.push({ ...pairs.at(-1), from: a.readout.top, to: b.readout.top })
    }
    for (const block of b.blocks) {
      const prev = a.blocks.find(x => x.id === block.id && x.chars === block.chars && Math.abs(x.height - block.height) < 0.01)
      if (!prev) continue
      blockPairs++
      if (block.top - prev.top > eps) bodyDown++
    }
  }
  const near = pairs.filter(x => Math.abs(x.dy) <= 2)
  const max = values => values.length ? Math.max(...values) : 0
  const p95 = values => { const s = [...values].sort((a,b) => a-b); return s[Math.floor((s.length-1)*.95)] ?? 0 }
  const times = data.frames.slice(1).map((f,i) => f.t - data.frames[i].t)
  return {
    frames: data.frames.length, eligiblePairs: pairs.length, readoutFlips: flips,
    readoutMoves: changed.length, sub2pxMoves: near.filter(x => Math.abs(x.dy) > eps).length,
    maxReadoutStep: max(pairs.map(x => Math.abs(x.dy))),
    p95ReadoutStep: p95(pairs.map(x => Math.abs(x.dy))),
    trackedBlockPairs: blockPairs, bodyDownPairs: bodyDown,
    nudgeWritesObserved: data.frames.filter(f => f.translate !== '').length,
    calls: data.counters, toolSeen: data.frames.some(f => f.card),
    postRafIntervalP95: p95(times), longestInterval: max(times),
    examples: changed.slice(0,12),
  }
}

async function runLane(name, enabled) {
  const store = await mkdtemp(path.join(tmpdir(), 'follow-aba-store-'))
  const userData = await mkdtemp(path.join(tmpdir(), 'follow-aba-udd-'))
  const state = { served: [], emitted: [], done: false }
  let provider, core, app, vite
  let transformed = 0
  const stderr = []
  try {
    console.log(`[${name}] start; snapTail=${enabled}`)
    provider = await startProvider(state)
    const ai = fakeProviderAiSettings(provider.address().port)
    ai.providers.deepseek.modelCapabilitiesByModel['deepseek-chat'] = { tools: true, reasoning: true, vision: false }
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({ ai,
      tools: { enableToolCalls: true, permissionMode: 'dangerously-allow-all', tools: {} },
      chat: { contextCompactEnabled: false }, diagnostics: { enabled: false },
    }))
    core = spawn(process.execPath, [path.join(repoRoot, 'dist/server/main.js')], {
      cwd: repoRoot, env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store }, stdio: ['ignore','pipe','pipe'],
    })
    core.stdout.on('data', () => {})
    core.stderr.on('data', c => { stderr.push(c.toString()); if (stderr.length > 30) stderr.shift() })
    const rec = await waitFor('core discovery', () => {
      try { const x = JSON.parse(readFileSync(path.join(store, 'run/http.json'),'utf8')); return x.pid === core.pid ? x : false } catch { return false }
    })
    const sessionId = (await rpc(rec, 'sessions', 'create', { name: 'Follow ABA fixture' })).session.id
    await rpc(rec, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: store })
    vite = await createServer({
      configFile: path.join(appRoot, 'vite.config.ts'), server: { port: 5198, strictPort: true }, logLevel: 'error',
      plugins: [{ name: 'follow-aba-test-only', enforce: 'pre', transform(code, id) {
        if (id.split('?')[0] !== sourcePath) return
        if (code.split('    snapTail(el)').length !== 2) throw new Error('Expected exactly one snapTail call')
        transformed++
        return { code: code.replace('    snapTail(el)', `    globalThis.__abaCounters ??= { stick: 0, snap: 0 }; globalThis.__abaCounters.stick++;\n    ${enabled ? 'snapTail(el); globalThis.__abaCounters.snap++;' : '/* ABA B: skip snapTail only; fresh page has no previous translate. */'}\n    globalThis.__abaAfterStick?.(el)`), map: null }
      } }],
    })
    await vite.listen()
    app = await electron.launch({ executablePath: electronBinary,
      args: [path.join(appRoot, 'dist-electron/main.cjs'), `--user-data-dir=${userData}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: 'http://127.0.0.1:5198/', ONETHING_GATE_OFFSCREEN: '1' },
    })
    app.process().stdout?.on('data', () => {})
    app.process().stderr?.on('data', () => {})
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width: WIDTH, height: HEIGHT })
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('renderer RPC', () => page.evaluate(() => window.__d0?.rpcOk))
    const click = id => page.evaluate(value => { const el = document.querySelector(`[data-testid="${value}"]`); el?.click(); return Boolean(el) }, id)
    await click('dock-tile-sessions')
    await waitFor('session row', () => page.evaluate(id => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId))
    await click(`session-row-${sessionId}`)
    await waitFor('stream', () => page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))))
    await click('dock-tile-sessions')
    await delay(500)
    const environment = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      streamWidth: document.querySelector('[data-testid="chat-stream"]').clientWidth,
    }))
    await installSampler(page)
    // Use the real composer, including send-position and blank-space behavior.
    await page.locator('[data-testid="composer-input"]').fill(MARKER)
    await click('composer-send')
    for (let round = 0; round < 3; round++) {
      await waitFor(`round ${round}`, () => state.served.includes(round), 90000)
      console.log(`[${name}] streaming round ${round + 1}/3`)
    }
    await waitFor('provider done', () => state.done || state.error, 90000)
    if (state.error) throw new Error(state.error)
    await waitFor('renderer complete', () => page.evaluate(() => !document.querySelector('[data-testid="chat-stop"]')), 30000)
    await delay(600)
    const data = await page.evaluate(() => {
      window.__aba.stopped = true
      return { frames: window.__aba.frames, stickFrames: window.__aba.stickFrames, counters: window.__abaCounters }
    })
    await page.screenshot({ path: path.join(outDir, `${name}-end.png`) })
    const summary = summarize(data)
    const emissionHash = sha(JSON.stringify(state.emitted.map(x => ({ round: x.round, index: x.index, delta: x.delta }))))
    const result = { name, enabled, environment, fixtureHash, emissionHash, transformed, summary,
      emitted: state.emitted, ...data }
    writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(result))
    if (!transformed || !data.counters?.stick) throw new Error('Intervention instrumentation was not exercised')
    if (enabled && !data.counters.snap) throw new Error('A did not run snapTail')
    if (!enabled && (data.counters.snap || summary.nudgeWritesObserved)) throw new Error('B still applied a translate')
    if (summary.eligiblePairs < 60 || !summary.toolSeen) throw new Error('Insufficient follow coverage or missing tool card')
    console.log(`[${name}] ${JSON.stringify(summary)}`)
    return { name, enabled, environment, fixtureHash, emissionHash, transformed, summary }
  } catch (error) {
    writeFileSync(path.join(outDir, `${name}-error.txt`), `${error.stack}\n${stderr.join('').slice(-5000)}`)
    throw error
  } finally {
    await app?.close().catch(() => {})
    await vite?.close().catch(() => {})
    if (core && core.exitCode === null) {
      core.kill('SIGTERM')
      await Promise.race([new Promise(resolve => core.once('exit', resolve)), delay(3000)])
      if (core.exitCode === null) core.kill('SIGKILL')
    }
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
    await rm(store, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
}

async function main() {
  for (const p of ['dist/server/main.js', 'apps/desktop-react/dist-electron/main.cjs']) {
    if (!existsSync(path.join(repoRoot,p))) throw new Error(`Missing ${p}`)
  }
  mkdirSync(outDir, { recursive: true })
  const sourceHash = sha(readFileSync(sourcePath))
  writeFileSync(path.join(outDir, 'fixture.json'), JSON.stringify({ fixtureHash, rounds }, null, 2))
  const results = []
  for (const [name, enabled] of [['A1', true], ['B', false], ['A2', true]]) {
    results.push(await runLane(name, enabled))
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ sourceHash, results }, null, 2))
  }
  if (new Set(results.map(x => x.emissionHash)).size !== 1) throw new Error('Emitted content differs between lanes')
  if (new Set(results.map(x => JSON.stringify(x.environment))).size !== 1) throw new Error('Geometry environment differs between lanes')
  if (sha(readFileSync(sourcePath)) !== sourceHash) throw new Error('Product source changed during experiment')
  console.log(`ABA complete: ${outDir}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1 })
}
