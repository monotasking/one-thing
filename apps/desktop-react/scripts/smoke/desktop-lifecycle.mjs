import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { shellEsbuildOptions, searchWorkerEsbuildOptions } from '../build-electron.mjs'

async function deadline(work, ms, label) {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}

async function absent(file) {
  try { await lstat(file); return false }
  catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

/** Real main.ts, real hidden BrowserWindow, real signal/window exit. No direct Backend.dispose. */
export async function runDesktopLifecycleLanes({ appRoot, outDir, assert }) {
  const outdir = path.join(outDir, 'desktop')
  await build(shellEsbuildOptions({ entryPoints: { main: path.join(appRoot, 'electron/main.ts') }, outdir }))
  await build(shellEsbuildOptions({ entryPoints: { preload: path.join(appRoot, 'electron/preload.ts') }, outdir, nodeShims: false }))
  await build(searchWorkerEsbuildOptions({ outdir, repoRoot: path.resolve(appRoot, '../..') }))
  for (const route of ['SIGTERM', 'window-close']) {
    process.stdout.write(`\n[electron-${route}] 真实桌面宿主退出\n`)
    const store = await mkdtemp(path.join(tmpdir(), 'desktop-exit-'))
    const renderer = path.join(store, 'renderer')
    await mkdir(renderer)
    await writeFile(path.join(renderer, 'index.html'), '<!doctype html><title>Isolated lifecycle check</title>')
    // Lifecycle does not need a provider network request or the user's model credentials.
    await writeFile(path.join(store, 'settings.json'), JSON.stringify({ ai: { providers: { openai: { models: { 'smoke-local': { id: 'smoke-local', name: 'Smoke', contextLength: 1024 } } } } } }))
    const env = { ...process.env, ONETHING_STORE_PATH: store, ONETHING_GATE_HEADLESS: '1', ONETHING_GATE_DIST: renderer,
      ONETHING_REACT_DEV_SERVER_URL: '', ONETHING_SERVER_WORKSPACE_ROOT: path.join(store, 'workspace'),
      ONETHING_SERVER_DATA_ROOT: path.join(store, 'server-data'), ONETHING_SERVER_SETTINGS_ROOT: path.join(store, 'server-settings') }
    delete env.ELECTRON_RUN_AS_NODE
    let app
    let child
    let output = ''
    try {
      app = await electron.launch({ executablePath: electronBinary, args: [path.join(outdir, 'main.cjs'), `--user-data-dir=${path.join(store, 'chromium')}`], env })
      child = app.process()
      child.stdout?.on('data', bytes => { output = (output + bytes).slice(-12000) })
      child.stderr?.on('data', bytes => { output = (output + bytes).slice(-12000) })
      await app.firstWindow()
      const discovery = await deadline((async () => {
        while (child.exitCode === null) {
          try { return JSON.parse(await readFile(path.join(store, 'run/http.json'), 'utf8')) }
          catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
          await delay(20)
        }
        throw new Error(`Electron exited before HTTP ready: ${child.exitCode}`)
      })(), 20000, 'Desktop HTTP startup')
      assert(discovery.pid === child.pid && discovery.owner === 'shell', '当前Electron进程持有自己的HTTP发现记录')
      const base = `http://${discovery.host}:${discovery.port}`
      const headers = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' }
      const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ name: `exit-${route}` }) })).json()
      assert(created.success && created.session?.id, '实际HTTP入口创建会话')
      const id = created.session.id
      const messageId = `saved-${route}`
      const result = await (await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ domain: 'sessions', method: 'addSystemMessage', payload: {
        sessionId: id, message: { id: messageId, role: 'system', content: `save before ${route}`, timestamp: Date.now() },
      } }) })).json()
      assert(result.ok && result.data?.success, '实际RPC入口接受消息追加')
      const exited = once(child, 'exit')
      if (route === 'SIGTERM') child.kill('SIGTERM')
      else await app.evaluate(({ BrowserWindow }) => { setTimeout(() => { for (const window of BrowserWindow.getAllWindows()) window.close() }, 20) })
      const [code, signal] = await deadline(exited, 15000, 'Desktop shutdown')
      assert(code === 0 && signal === null, `宿主${route}正常退出码0`)
      assert(await absent(path.join(store, 'run/http.json')), '退出删除HTTP发现记录')
      assert(await absent(path.join(store, 'run/backend.lock')), '退出释放store lease')
      const meta = JSON.parse(await readFile(path.join(store, 'sessions', id, 'meta.json'), 'utf8'))
      assert(meta.name === `exit-${route}`, '退出保存节流中的会话元数据')
      const events = (await readFile(path.join(store, 'sessions', id, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      assert(events.some(event => event.data?.message?.id === messageId), '退出排空已接受的消息账本追加')
    } catch (error) {
      throw new Error(`${route}: ${error.stack ?? error}\n${output}`, { cause: error })
    } finally {
      if (app && child?.exitCode === null) {
        try { await deadline(app.close(), 7000, 'Desktop cleanup') }
        catch { child.kill('SIGKILL') }
      }
      await rm(store, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
}
