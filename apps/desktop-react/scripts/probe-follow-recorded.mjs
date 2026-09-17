/**
 * Replay recorded UI events with historical messages in an isolated renderer.
 * No recorded command or tool is executed. Original store is read-only.
 * node scripts/probe-follow-recorded.mjs --label=recorded-A [--no-snap]
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { installSampler, summarize } from './probe-follow-aba.mjs'
import { startManualFollowProbe } from './lib/probe-manual-follow.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const sourcePath = path.join(appRoot, 'src/content/ChatStream.tsx')
let sessionId = '07689d94-b6e2-4376-8f75-83a4b61ab42e'
const messageId = '1e901d4b-1010-4f00-9ddc-e809791df129'
const original = path.join(process.env.HOME, '.onething/sessions', sessionId)
const label = process.argv.find(x => x.startsWith('--label='))?.slice(8) ?? 'recorded-A'
if (!/^[\w-]+$/.test(label)) throw new Error('Invalid label')
const enabled = !process.argv.includes('--no-snap')
const pixels = process.argv.includes('--pixels')
const promoteRow = process.argv.includes('--promote-row')
const relativeNudge = process.argv.includes('--relative-nudge')
const readoutLayer = process.argv.includes('--readout-layer')
const visibleTail = process.argv.includes('--visible-tail')
const layoutTail = process.argv.includes('--layout-tail')
const thinkingScroll = process.argv.includes('--thinking-scroll')
const manualScroll = process.argv.includes('--manual-scroll') || thinkingScroll
const beforeFix = process.argv.includes('--before-fix')
const seconds = thinkingScroll ? 16.5 : 68
const outDir = path.join(repoRoot, 'output/follow-aba', label)
const delay = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(name, test, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const x = await test(); if (x) return x; await delay(100) }
  throw new Error(`Timeout: ${name}`)
}

function makeReplay(events, start) {
  const selected = events.filter(e => e.seq >= start.seq && e.time <= start.time + seconds * 1000)
  const plan = []
  const offsets = new Map(), opened = new Set()
  for (const e of selected) {
    plan.push({ at: e.time - start.time, kind: 'ledger', record: e })
    if (e.type !== 'assistant/chunks') continue
    const d = e.data
    const key = `${d.messageId}:${d.requestIndex}:${d.partIndex}:${d.kind}`
    let offset = offsets.get(key) ?? 0
    if (d.kind === 'tool-input' && !opened.has(d.toolCallId)) {
      opened.add(d.toolCallId)
      plan.push({ at: d.time0 - start.time, kind: 'tool-start', data: d })
    }
    for (let i = 0; i < d.text.length; i++) {
      const text = d.text[i]
      const chunk = {
        type: d.kind === 'reasoning' ? 'reasoning-delta' : d.kind === 'tool-input' ? 'tool-input-delta' : 'text-delta',
        messageId: d.messageId, turnIndex: d.turnIndex,
        ...(d.placement ? { placement: d.placement } : {}),
        ...(d.kind === 'reasoning' ? { reasoning: text } : d.kind === 'tool-input' ? { argsTextDelta: text, toolCallId: d.toolCallId } : { text }),
        stamp: { messageId: d.messageId, runId: d.runId, requestIndex: d.requestIndex, partIndex: d.partIndex,
          kind: d.kind, charOffset: offset, gen: d.gen ?? 0, turnIndex: d.turnIndex },
      }
      plan.push({ at: d.time0 + d.dt[i] - start.time, kind: 'stream', chunk })
      offset += text.length
    }
    offsets.set(key, offset)
  }
  return plan.sort((a,b) => a.at - b.at)
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const raw = readFileSync(path.join(original,'events.jsonl'),'utf8')
  const hash = createHash('sha256').update(raw).digest('hex')
  const rendererHash = createHash('sha256')
    .update(readFileSync(sourcePath))
    .update(readFileSync(path.join(appRoot, 'src/content/ChatStream.module.css')))
    .update(readFileSync(path.join(appRoot, 'src/content/tail-snap.ts')))
    .digest('hex')
  const events = raw.trim().split('\n').map(x => JSON.parse(x))
  const start = events.find(e => e.type === 'run/start' && e.data.assistantMessageId === messageId)
  if (!start) throw new Error('Recorded run not found')
  const plan = makeReplay(events, start)
  const store = await mkdtemp(path.join(tmpdir(), 'recorded-follow-store-'))
  const udd = await mkdtemp(path.join(tmpdir(), 'recorded-follow-udd-'))
  let core, app, vite, transformed = 0
  const errors = []
  const startCore = async () => {
    core = spawn(process.execPath, [path.join(repoRoot,'dist/server/main.js')], {
      cwd: repoRoot, env: { ...process.env, ONETHING_STORE_PATH: store }, stdio: ['ignore','pipe','pipe'],
    })
    core.stdout.on('data', () => {})
    core.stderr.on('data', c => { errors.push(c.toString()); if (errors.length > 20) errors.shift() })
    return waitFor('temporary core', () => {
      try { const r = JSON.parse(readFileSync(path.join(store,'run/http.json'),'utf8')); return r.pid === core.pid ? r : false } catch { return false }
    })
  }
  const stopCore = async () => {
    const child = core
    if (!child || child.exitCode !== null || child.signalCode) return
    const ended = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([ended,delay(3000)])
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await ended }
  }
  try {
    writeFileSync(path.join(store,'settings.json'), JSON.stringify({ chat: { contextCompactEnabled: false }, diagnostics: { enabled: false }, tools: { enableToolCalls: false } }))
    const rec = await startCore()
    const response = await fetch(`http://${rec.host}:${rec.port}/api/rpc`, {
      method: 'POST', headers: { 'content-type':'application/json', authorization:`Bearer ${rec.token}` },
      body:JSON.stringify({ domain:'sessions', method:'create', payload:{ name:'Recorded follow investigation' } }),
    })
    const created = await response.json()
    if (!created.ok || !created.data?.session?.id) throw new Error('Could not create temporary session')
    sessionId = created.data.session.id
    await stopCore()
    const folder = path.join(store, 'sessions', sessionId)
    mkdirSync(folder, { recursive: true })
    const meta = JSON.parse(readFileSync(path.join(folder,'meta.json'),'utf8'))
    // No credentials/settings from the real store are copied.
    meta.workingDirectory = store
    meta.name = 'Recorded follow investigation'
    writeFileSync(path.join(folder,'meta.json'), JSON.stringify(meta))
    writeFileSync(path.join(folder,'events.jsonl'), events.filter(e => e.seq < start.seq).map(e => JSON.stringify(e.type === 'session/created' ? {...e,data:{...e.data,sessionId}} : e)).join('\n')+'\n')
    await rm(path.join(folder,'projection.checkpoint'),{force:true})
    await startCore()
    console.log(`[${label}] historical ledger loaded in temporary session`)
    vite = await createServer({ configFile: path.join(appRoot,'vite.config.ts'),
      server: { port: 5198, strictPort: true }, logLevel: 'error',
      plugins: [{ name: 'recorded-follow-probe', enforce: 'pre', transform(code,id) {
        if (beforeFix && id.split('?')[0] === path.join(appRoot, 'src/content/tail-snap.ts')) {
          if (!code.includes('held !== undefined && held <= natural &&')) throw new Error('Before-fix snap target changed')
          return { code: code.replace('held !== undefined && held <= natural &&', 'held !== undefined &&'), map: null }
        }
        if (id.split('?')[0] !== sourcePath) return
        if (code.split('    snapTail(el)').length !== 2) throw new Error('snapTail call changed')
        transformed++
        let result = code.replace('    snapTail(el)', `    globalThis.__abaCounters ??= { stick: 0, snap: 0 }; globalThis.__abaCounters.stick++;\n    ${enabled ? 'snapTail(el); globalThis.__abaCounters.snap++;' : '/* recorded B: skip only snapTail */'}\n    globalThis.__abaAfterStick?.(el)`)
        if (manualScroll) {
          result = result.replace('    globalThis.__abaAfterStick?.(el)', "    globalThis.__abaAfterStick?.(el); globalThis.__manualEvent?.('stick', { follow: followRef.current })")
          result = result.replace('      const wentUp = previousTop === undefined || el.scrollTop < previousTop', "      const wentUp = previousTop === undefined || el.scrollTop < previousTop\n      globalThis.__manualEvent?.('scroll-decision', { previousTop, wentUp, gap, follow: followRef.current })")
        }
        if (beforeFix) {
          if (!result.includes('if (!contentChanged && !containerChanged) return')) throw new Error('Before-fix resize target changed')
          result = result.replace('if (!contentChanged && !containerChanged) return', 'if (!contentGrew && !containerChanged) return')
        }
        if (promoteRow) result = result.replace('    const applied = tailSnapRef.current?.nudge ?? 0', "    tail.style.willChange = 'transform'\n    const applied = tailSnapRef.current?.nudge ?? 0")
        if (relativeNudge) {
          const target = '    if (nudge !== applied) tail.style.translate = `0 ${nudge}px`'
          if (!result.includes(target)) throw new Error('Relative nudge intervention target changed')
          result = result.replace(target, '    if (nudge !== applied) { tail.style.position = \'relative\'; tail.style.top = `${nudge}px` }')
          result = result.replace("previous.el.style.removeProperty('translate')", "previous.el.style.removeProperty('translate'); previous.el.style.removeProperty('top'); previous.el.style.removeProperty('position')")
        }
        return { code: result, map: null }
      } }],
    })
    await vite.listen()
    app = await electron.launch({ executablePath: electronBinary,
      args: [path.join(appRoot,'dist-electron/main.cjs'), `--user-data-dir=${udd}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: 'http://127.0.0.1:5198/', ONETHING_GATE_OFFSCREEN: '1' },
    })
    app.process().stdout?.on('data', () => {})
    app.process().stderr?.on('data', () => {})
    const page = await app.firstWindow()
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1280,860))
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('renderer ready', () => page.evaluate(() => window.__d0?.rpcOk))
    const click = id => page.evaluate(id => { const n = document.querySelector(`[data-testid="${id}"]`); n?.click(); return Boolean(n) }, id)
    await click('dock-tile-sessions')
    await waitFor('historical session', () => page.evaluate(id => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId))
    await click(`session-row-${sessionId}`)
    await waitFor('historical content', () => page.evaluate(() => document.querySelectorAll('[data-message-id]').length > 5))
    await delay(1500)
    // Match the recorded live scroll viewport; only its containing leaf width differs.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'claude'
      document.querySelector('[data-dock-reserve]')?.removeAttribute('data-dock-reserve')
      const scroll = document.querySelector('[data-testid="chat-stream"]')
      scroll.style.width = '946px'; scroll.style.flex = 'none'; scroll.style.height = '816px'
    })
    await page.evaluate(async id => {
      const { chatSources } = await import('/src/data/chat-source.ts')
      window.__recordedSource = chatSources.get(id)
      if (!window.__recordedSource) throw new Error('No live data source')
    }, sessionId)
    await delay(500)
    if (readoutLayer) await page.addStyleTag({ content: '[data-testid="chat-readout"] { will-change: transform; }' })
    if (visibleTail) await page.addStyleTag({ content: '[data-message-id]:has([data-testid="chat-readout"]) { content-visibility: visible; contain: none; }' })
    if (layoutTail) await page.addStyleTag({ content: '[data-testid="chat-stream"] > div > article:last-of-type { contain: layout style; }' })
    if (beforeFix) await page.addStyleTag({ content: '[data-testid="chat-stream"] > div > article { content-visibility: auto !important; }' })
    await installSampler(page)
    const environment = await page.evaluate(() => {
      const e = document.querySelector('[data-testid="chat-stream"]')
      return { dpr: devicePixelRatio, width: e.clientWidth, height: e.clientHeight, startScrollHeight: e.scrollHeight, rows: e.querySelectorAll('[data-message-id]').length }
    })
    console.log(JSON.stringify({ label, enabled, events: plan.length, environment }))
    await page.evaluate(({plan, sessionId, originalTime}) => {
      const source = window.__recordedSource
      const startAt = performance.now(), clockOffset = Date.now() - originalTime
      const shift = value => {
        if (typeof value === 'number' && value > 1700000000000 && value < 2000000000000) return value + clockOffset
        if (Array.isArray(value)) return value.map(shift)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,shift(v)]))
        return value
      }
      source.setState({ sentTick: source.getState().sentTick + 1 })
      let i = 0
      window.__recordedReplay = { done: false, delivered: 0, maxDelay: 0, sourceTime: 0,
        reasoningChars: 0, lastReasoningAt: null, lastStreamType: null }
      const step = () => {
        const elapsed = performance.now() - startAt
        while (i < plan.length && plan[i].at <= elapsed) {
          const item = plan[i++]
          window.__recordedReplay.maxDelay = Math.max(window.__recordedReplay.maxDelay, elapsed - item.at)
          if (item.kind === 'ledger') source.handleEvent({ sessionId, event: { type: 'session:ledger-event', record: shift(item.record) } })
          else if (item.kind === 'stream') {
            source.handleStream({ sessionId, chunk: item.chunk })
            window.__recordedReplay.lastStreamType = item.chunk.type
            if (item.chunk.type === 'reasoning-delta') {
              window.__recordedReplay.reasoningChars += item.chunk.reasoning.length
              window.__recordedReplay.lastReasoningAt = elapsed
            }
          }
          else source.handleEvent({ sessionId, event: { type: 'tool:input-start', messageId: item.data.messageId,
            toolCallId: item.data.toolCallId, toolName: item.data.toolName, toolCall: { timestamp: Date.now() } } })
        }
        window.__recordedReplay.delivered = i
        window.__recordedReplay.sourceTime = elapsed
        if (i < plan.length) setTimeout(step, Math.min(16, Math.max(0, plan[i].at - elapsed)))
        else window.__recordedReplay.done = true
      }
      step()
    }, { plan, sessionId, originalTime: start.time })
    const manualProbe = manualScroll ? await startManualFollowProbe(page, cdp, outDir, { thinkingScroll }) : null
    const capturePixels = async () => {
      if (!pixels) return
      const dir = path.join(outDir, 'pixels')
      mkdirSync(dir, { recursive:true })
      await waitFor('pixel window', () => page.evaluate(() => window.__recordedReplay.sourceTime >= 24000), 45000)
      const clip = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-readout"]')
        const r = el.getBoundingClientRect()
        return { x:Math.floor(r.left), y:Math.floor(r.top)-50, width:180, height:90 }
      })
      const samples = []
      await page.evaluate(() => {
        window.__pixelGeometry = () => {
          const el = document.querySelector('[data-testid="chat-readout"]')
          const span = el?.firstElementChild
          const row = el?.closest('[data-message-id]')
          const range = document.createRange()
          if (span) range.selectNodeContents(span)
          return { t:performance.now(), top:el?.getBoundingClientRect().top,
            spanTop:span?.getBoundingClientRect().top, glyphBoxTop:span?range.getBoundingClientRect().top:null,
            rowTop:row?.getBoundingClientRect().top, rowBottom:row?.getBoundingClientRect().bottom,
            rowContentVisibility:row ? getComputedStyle(row).contentVisibility : null,
            translate:row?.style.translate, relativeTop:row?.style.top, willChange:row?.style.willChange }
        }
      })
      for (;;) {
        const before = await page.evaluate(() => ({ ...window.__recordedReplay,
          ...window.__pixelGeometry() }))
        if (before.sourceTime >= 34000 || before.done) break
        const file = `${String(samples.length).padStart(4,'0')}.png`
        await page.screenshot({ path:path.join(dir,file), clip, scale:'device', caret:'initial' })
        const after = await page.evaluate(() => ({ sourceTime:window.__recordedReplay.sourceTime,
          ...window.__pixelGeometry() }))
        samples.push({ file, before, after })
        await delay(20)
      }
      writeFileSync(path.join(dir,'index.json'),JSON.stringify({clip,samples}))
      console.log(`[${label}] captured ${samples.length} fixed-region device-pixel screenshots`)
    }
    const pixelTask = capturePixels()
    for (const checkpoint of thinkingScroll ? [5,10,15,16.5] : [25,40,55,68]) {
      await waitFor(`replay ${checkpoint}s`, () => page.evaluate(at => window.__recordedReplay.sourceTime >= at*1000 || window.__recordedReplay.done, checkpoint), 90000)
      if (!pixels || checkpoint !== 25) await page.screenshot({ path: path.join(outDir,`at-${checkpoint}s.png`) })
      console.log(`[${label}] replay ${checkpoint}s`)
    }
    await pixelTask
    await manualProbe?.finish()
    await delay(500)
    const data = await page.evaluate(() => {
      window.__aba.stopped = true
      const s = window.__recordedSource.getState()
      return { frames: window.__aba.frames, stickFrames: window.__aba.stickFrames, counters: window.__abaCounters,
        replay: window.__recordedReplay, state: { status: s.status, activeMessageId: s.activeMessageId, messages: s.messages.length, error: s.error } }
    })
    const summary = summarize(data)
    writeFileSync(path.join(outDir,'data.json'), JSON.stringify({ environment, summary, transformed, enabled, promoteRow, relativeNudge, readoutLayer, visibleTail, layoutTail, manualScroll, thinkingScroll, beforeFix, sourceHash:hash, rendererHash, ...data }))
    console.log(JSON.stringify({ summary, state:data.state, replay:data.replay }))
    if (!transformed || summary.eligiblePairs < 60 || (!thinkingScroll && !summary.toolSeen)) throw new Error('Insufficient replay coverage')
    if (enabled && !data.counters?.snap) throw new Error('Compensation not exercised')
  } catch(error) {
    writeFileSync(path.join(outDir,'error.txt'),error.stack+'\n'+errors.join('').slice(-4000))
    throw error
  } finally {
    await app?.close().catch(()=>{})
    await vite?.close().catch(()=>{})
    await stopCore()
    await rm(store,{recursive:true,force:true})
    await rm(udd,{recursive:true,force:true})
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1})
