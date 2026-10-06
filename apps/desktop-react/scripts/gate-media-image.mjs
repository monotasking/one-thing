#!/usr/bin/env node
/**
 * G 线 P5-a 的真机门 —— **生成的图在 React 壳上显出来**(正本
 * `docs/stream-geometry-2026-09.md` §23)。
 *
 * ── 它证的是哪一句 ────────────────────────────────────────────────────────
 * 生图流落到账本上是一段正文 `![Generated Image|mediaId:<id>](media://<id><ext>)`
 * (`provider-data.ts` 的 `buildOnethingGeneratedImageMarkdown`)。P5-a 之前资产层的
 * scheme 白名单没有 `media:`,屏幕上是一行「不支持的地址」。本批三段:后端
 * `media.readFile`(按文件名取字节,判据与 HTTP `/api/media/file/<name>` 同一只函数)、
 * 壳的 `media:` 一支 + `useMediaImage`、alt 剥机器标记。这道门在**真的排版、真的
 * core、真的媒体库**之下证它们合起来成立:
 *
 *  ① 经 RPC `media.saveImage` 存一张 8×8 的真 PNG(字节手写在下面),拿到 `filePath`;
 *  ② 往一条会话里种一条 assistant 消息,正文 = **产品自己的**
 *     `buildOnethingGeneratedImageMarkdown(id, '一句 prompt', ext)` 那一段(不抄格式:
 *     esbuild 把那只函数现打一份出来调 —— 格式哪天改了,门跟着改,不会拿旧格式自证);
 *  ③ 打开会话:`[data-testid="block-image"][data-state="ready"]` 在场、`naturalWidth === 8`、
 *     图块里没有诚实行;`<img alt>` 不含 `mediaId:`;檐上 meta = 文件名;
 *  ④ 关掉再打开(挤出视图池,照 `gate:continuity` ④):第二次挂载 `data-reserve="sized"`
 *     出现过、图上屏前后消息行高度差 0px(尺寸表按 `ref.url` 记的兑现);
 *  ⑤ 反证:把 `media:` 从白名单摘掉,③ 当场红。
 *
 * ── ⑤ 为什么不改盘上的文件 ────────────────────────────────────────────────
 * 施工单写的是「备份文件法」。那一手在**这道门自己**身上不能用:`verify` 跑在主检出里,
 * 用户的 `electron:dev`(vite 5175)正盯着同一棵 `src/` —— 门改一下 `resolve.ts`,
 * 用户那扇正在用的窗子跟着热更成「不支持的地址」,那是抢用户的机器。所以门里的反证
 * 在**门自己那台 vite** 上做:一只 transform 插件在开关打开时把 `resolve.ts` 白名单里
 * 那一格去掉 —— 只有门自己这扇窗吃到改过的模块,盘上一个字节不动。备份文件法
 * 那一趟由施工者手跑一次,读数记在正本 §23.6。prod 档没有 vite,⑤ 只在 dev 档跑
 * (verify 进的就是 dev 档)。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * 离屏 + 屏外档(`ONETHING_GATE_HEADLESS=1` + `ONETHING_GATE_OFFSCREEN=1`,两个一起传,
 * 判词在 electron/main.ts):不抢前台、不进 Dock、合成器不节流;输入一律走
 * `page.evaluate` / CDP;store 与 `--user-data-dir` 都是临时目录,跑完删干净,
 * **绝不连 `~/.onething`**;vite 端口 5313(避开用户的 5175 / 5174 与别的门的 5311);
 * `finally` 收尸 + `ps` 自查。
 *
 * 跑法:`npm run gate:media-image [-- --prod]`
 * (仓根先 `bun run server:build`;本目录先 `npm run electron:build`,`--prod` 还要
 *  `npm run app:build`。)
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { build as esbuild } from 'esbuild'
import {
  startFakeProvider,
  fakeProviderAiSettings,
  FAKE_PROVIDER_ENV,
} from '../../../scripts/lib/gate-fake-provider.mjs'
import { seedLargeLedger, lastSeqOfLedger } from './lib/seed-large-ledger.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const providerDataSource = path.join(repoRoot, 'packages/backend/provider/provider-data.ts')

const PROD = process.argv.includes('--prod')
const LANE = PROD ? 'prod' : 'dev'
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5313)

/** 8×8 的真 PNG(RGB 棋盘),手写在这里 —— 门不依赖任何图片文件。 */
const PNG_8X8_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGMwaDjwoOEAJsmAVdSg4QDDoNQBAH1ccgHuwM8DAAAAAElFTkSuQmCC'
const PROMPT = '一句 prompt'
/**
 * ④ 要把甲**挤出视图池**才算「关掉」:池子一片叶三格(`SESSION_VIEW_PARK_LIMIT`),
 * 甲之后再进四条会话它才被逐出(判词与 `gate:continuity` ④ 逐字同源)。
 */
const FIXTURE_TINY = { messages: 6, targetBytes: 0, targetToolCalls: 0, largeResults: 0, images: 0 }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
}

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

function portConnects(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(100)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

/**
 * **产品自己的** markdown 生成函数,现打一份出来调。
 *
 * 不在门里抄一行 `![Generated Image|mediaId:…](media://…)`:抄的那一行会永远与门自己
 * 一致,哪天引擎改了格式,门拿旧格式证一张新壳,绿得毫无意义。`?raw` 的 `.md` 是
 * core 里提示词文件的导入形状,与这只函数无关,按文本装载只为让打包走得通。
 */
async function loadGeneratedImageMarkdown() {
  const out = await esbuild({
    stdin: {
      contents: `export { buildOnethingGeneratedImageMarkdown, generatedImageUrlExtension } from ${JSON.stringify(providerDataSource)}`,
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'error',
    loader: { '.md': 'text' },
  })
  const code = out.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

/**
 * 种一条「生图回合」:一问一答,答的正文就是引擎那一段 markdown。
 *
 * 事件形照 `lib/seed-large-ledger.mjs` 的 `buildTurn`(`request/end` 不是可选的:
 * `materializeContentParts` 的 `requestSettled` 闸没有它 `contentParts` 一格都出不来)。
 * **趁 core 停着写**(活着的 core 会按字节大小认出外来写手)。
 */
function seedImageTurn(store, sessionId, { userId, assistantId, markdown }) {
  const sessionDir = path.join(store, 'sessions', sessionId)
  const ledgerPath = path.join(sessionDir, 'events.jsonl')
  let seq = lastSeqOfLedger(ledgerPath)
  let time = Date.UTC(2026, 8, 25, 9, 0, 0)
  const lines = []
  const push = (type, data) => {
    seq += 1
    time += 40
    lines.push(JSON.stringify({ seq, time, type, data }))
  }
  const runId = `${assistantId}-run`
  push('user/message', { message: { id: userId, role: 'user', content: '画一张 8×8 的棋盘', timestamp: time } })
  push('run/start', {
    runId, kind: 'send', assistantMessageId: assistantId, triggerMessageId: userId,
    provider: 'deepseek', model: 'deepseek-chat', timestamp: time,
  })
  push('request/start', { requestIndex: 1, messageId: assistantId, runId })
  push('assistant/chunks', {
    runId, requestIndex: 1, messageId: assistantId, partIndex: 0, kind: 'text',
    time0: time, dt: [0], text: [markdown], turnIndex: 1,
  })
  push('assistant/part-end', {
    runId, requestIndex: 1, messageId: assistantId, partIndex: 0, kind: 'text', len: markdown.length,
  })
  push('request/end', {
    requestIndex: 1, stopReason: 'stop', runId,
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  })
  push('run/end', { runId, outcome: 'completed' })
  mkdirSync(sessionDir, { recursive: true })
  const text = `${lines.join('\n')}\n`
  if (existsSync(ledgerPath)) appendFileSync(ledgerPath, text)
  else writeFileSync(ledgerPath, text)
}

/** 这一屏(显示中的那一片)里的聊天滚动容器 —— 停靠着的那几棵树也在 DOM 上。 */
const ACTIVE_STREAM = `(document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
  ?? document.querySelector('[data-testid="chat-stream"]'))`

/** ③ 的读数一次取回(一次 evaluate = 同一个瞬间的同一份布局)。 */
function readImageBlock(page, assistantId) {
  return page.evaluate(([id, streamExpr]) => {
    const stream = new Function(`return ${streamExpr}`)()
    const row = stream?.querySelector(`[data-message-id="${id}"]`)
    const section = row?.querySelector('section[data-block-kind="image"]')
    const img = section?.querySelector('[data-testid="block-image"]')
    // 檐:`<header><span 身份><span id>image</span><span meta>…</span></span>…`
    const ident = section?.querySelector('header > span:first-child')
    const meta = ident && ident.children.length > 1 ? ident.lastElementChild?.textContent ?? null : null
    return {
      row: Boolean(row),
      section: Boolean(section),
      state: img?.getAttribute('data-state') ?? null,
      naturalWidth: img ? img.naturalWidth : null,
      alt: img?.getAttribute('alt') ?? null,
      honest: section ? Array.from(section.querySelectorAll('[role="note"]')).map((n) => n.textContent) : [],
      meta,
    }
  }, [assistantId, ACTIVE_STREAM])
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error('[media-image-gate] 找不到 dist/server/main.js —— 先在仓根跑 `bun run server:build`')
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[media-image-gate] 找不到 dist-electron/main.cjs —— 先跑 `npm run electron:build`')
    process.exit(1)
  }
  if (PROD && !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[media-image-gate] --prod 档先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'media-image-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'media-image-gate-udd-'))
  let mockProvider
  let server
  let app
  let vite
  const readings = { lane: LANE }

  const startCore = async () => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store, ONETHING_CREDENTIALS_KEYRING: 'file' },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const err = []
    child.stderr.on('data', (chunk) => err.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === child.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${err.join('').slice(-2000)}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')
    return { child, record }
  }
  const stopCore = async (child) => {
    if (!child) return
    child.kill('SIGTERM')
    await delay(1200)
    if (!child.killed) child.kill('SIGKILL')
    await delay(300)
  }

  try {
    console.log(`\n[media-image-gate] 档位:${LANE}`)
    console.log('\n[1/6] 起假 provider + core;① 经 RPC media.saveImage 存一张 8×8 PNG')
    mockProvider = await startFakeProvider(0, 'P5-a 门 · 假 provider(这道门里一次都不会被调用)')
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify({
        ai: fakeProviderAiSettings(mockProvider.address().port),
        tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
        diagnostics: { enabled: false },
      }, null, 2),
    )
    let core = await startCore()
    server = core.child
    const createSession = async (name) => {
      const id = (await rpc(core.record, 'sessions', 'create', { name }))?.session?.id
      if (!id) throw new Error(`sessions.create 没给出会话 id(${name})`)
      return id
    }
    const idA = await createSession('P5-a 门 · 生图会话')
    const others = []
    for (const name of ['乙', '丙', '丁', '戊']) others.push(await createSession(`P5-a 门 · 挤池 ${name}`))

    const assistantId = `mig-a-${idA.slice(0, 8)}`
    const userId = `mig-u-${idA.slice(0, 8)}`
    const saved = await rpc(core.record, 'media', 'saveImage', {
      base64: PNG_8X8_BASE64, prompt: PROMPT, model: 'gate-image', sessionId: idA, messageId: assistantId,
    })
    const fileName = path.basename(saved?.filePath ?? '')
    assert(Boolean(saved?.id) && Boolean(fileName), `① media.saveImage 落库:id=${saved?.id} · 文件 ${fileName}`)
    /* 后端那一半顺手问一句:同一个名字经 readFile 取得回 data URL(壳走的就是这一发)。 */
    const direct = await rpc(core.record, 'media', 'readFile', { fileName })
    assert(
      typeof direct?.dataUrl === 'string' && direct.dataUrl.startsWith('data:image/png;base64,'),
      `① media.readFile 按名取回 data URL(${direct?.dataUrl ? `${direct.dataUrl.length} 字符 · ${direct.mimeType}` : 'null'})`,
    )

    console.log('[2/6] ② 停 core,种生图回合(产品自己的 markdown)+ 四条挤池小会话,再起回来')
    const { buildOnethingGeneratedImageMarkdown, generatedImageUrlExtension } = await loadGeneratedImageMarkdown()
    const markdown = buildOnethingGeneratedImageMarkdown(saved.id, PROMPT, generatedImageUrlExtension(saved.filePath))
    console.log(`      正文:${JSON.stringify(markdown)}`)
    const refUrl = /\]\((media:\/\/[^)]+)\)/.exec(markdown)?.[1]
    assert(refUrl === `media://${fileName}`, `② 引擎写的地址 = media://<落库文件名>(${refUrl})`)
    await stopCore(server)
    seedImageTurn(store, idA, { userId, assistantId, markdown })
    const tiny = others.map((id) => seedLargeLedger(store, id, FIXTURE_TINY))
    core = await startCore()
    server = core.child

    let rendererUrl
    if (PROD) console.log('[3/6] prod 档:吃 dist/ 产物,不起 vite')
    else {
      console.log(`[3/6] 起 vite dev(端口 ${DEV_PORT},不是 5175 / 5174)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
        plugins: [counterPlugin()],
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    }

    console.log('[4/6] 拉起应用(离屏 + 屏外 · 独立 user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store, ONETHING_CREDENTIALS_KEYRING: 'file',
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl ?? '',
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const booted = async () => {
      await waitFor('渲染层完成一次 RPC 往返', async () => {
        const v = await page.evaluate(() => window.__d0 ?? null).catch(() => null)
        return v && v.rpcOk ? v : undefined
      }, 60_000)
    }
    await booted()

    const clickTestId = async (id) => {
      const ok = await page.evaluate((x) => {
        const el = document.querySelector(`[data-testid="${x}"]`)
        if (!el) return false
        el.click()
        return true
      }, id)
      if (!ok) throw new Error(`点不到 [data-testid="${id}"]`)
    }
    /** 进一条会话 = 在总览里点它那一行;总览没开就开(与用户的手势同一条路)。 */
    const openSession = async (sessionId, lastMessageId) => {
      const rowShown = () => page.evaluate((id) =>
        Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
      for (let n = 0; n < 5 && !(await rowShown()); n += 1) {
        await clickTestId('dock-tile-sessions').catch(() => undefined)
        await delay(500)
      }
      await waitFor(`总览画出会话 ${sessionId} 那一行`, rowShown)
      await clickTestId(`session-row-${sessionId}`)
      await waitFor(`会话 ${sessionId} 的树立起来(${lastMessageId} 在树上)`, () => page.evaluate(([id, streamExpr]) => {
        const stream = new Function(`return ${streamExpr}`)()
        const row = stream?.querySelector(`[data-message-id="${id}"]`)
        return Boolean(row && row.getBoundingClientRect().height > 0)
      }, [lastMessageId, ACTIVE_STREAM]))
    }

    /* ── ③ 第一次打开 ──────────────────────────────────────────────────── */
    console.log('\n[5/6] ③ 打开会话:图上屏、alt 干净、檐上 meta = 文件名')
    await installRowSampler(page, assistantId)
    await openSession(idA, assistantId)
    const first = await waitFor('图块到 ready', async () => {
      const r = await readImageBlock(page, assistantId)
      return r.state === 'ready' || r.honest.length ? r : undefined
    }, 20_000).catch(async () => readImageBlock(page, assistantId))
    const firstRows = await stopRowSampler(page)
    readings.first = { ...first, rowSamples: firstRows.summary }
    /*
     * ③ 的五格写成一张表,⑤ 拿同一张表问「这一回有几格不成立」—— 反证与正证是同一把尺,
     * 不是另写一套「红的样子」。诚实行按 `[role="note"]` 判,不按字面:界面语言不是这道门的事。
     */
    const threeChecks = (r) => [
      [r.state === 'ready', `[data-testid="block-image"][data-state="ready"] 在场(state=${r.state})`],
      [r.naturalWidth === 8, `naturalWidth === 8(读到 ${r.naturalWidth})`],
      [r.honest.length === 0, `图块里没有诚实行(${r.honest.length ? JSON.stringify(r.honest) : '无'})`],
      [r.alt !== null && !r.alt.includes('mediaId:'), `<img alt> 不含 mediaId:(alt=${JSON.stringify(r.alt)})`],
      [r.meta === fileName, `檐上 meta = 文件名(读到 ${JSON.stringify(r.meta)},期望 ${fileName})`],
    ]
    const judgeThree = (r, tag) => {
      for (const [ok, line] of threeChecks(r)) assert(ok, `${tag} ${line}`)
    }
    judgeThree(first, '③')
    console.log(`      第一次加载(只报不判,没有尺寸元数据的诚实代价):占位档 ${firstRows.summary.reserves.join(' → ') || '—'}`
      + ` · 行高 ${firstRows.summary.heightBefore ?? '—'} → ${firstRows.summary.heightAfter ?? '—'}px`)

    /* ── ④ 关掉再打开 ──────────────────────────────────────────────────── */
    console.log('\n[6/6] ④ 挤出视图池 → 再打开:sized 占位出现过、行高前后差 0px')
    await page.evaluate((streamExpr) => {
      window.__migNode = new Function(`return ${streamExpr}`)()
    }, ACTIVE_STREAM)
    for (let i = 0; i < others.length; i += 1) {
      await openSession(others[i], tiny[i].lastMessageId)
      await delay(200)
    }
    const evicted = await page.evaluate(() => (window.__migNode ? !window.__migNode.isConnected : false))
    assert(evicted, '④ 甲那棵树真的卸载了(离开前那只滚动容器已不在文档上)')
    await installRowSampler(page, assistantId)
    await openSession(idA, assistantId)
    const second = await waitFor('第二次挂载图块到 ready', async () => {
      const r = await readImageBlock(page, assistantId)
      return r.state === 'ready' || r.honest.length ? r : undefined
    }, 20_000).catch(async () => readImageBlock(page, assistantId))
    await delay(300)
    const secondRows = await stopRowSampler(page)
    readings.second = secondRows.summary
    const s2 = secondRows.summary
    console.log(`      第二次:占位档 ${s2.reserves.join(' → ') || '—'} · 占位期行高 ${JSON.stringify(s2.reservedHeights)}`
      + ` · 上屏后行高 ${JSON.stringify(s2.readyHeights)} · 取样 ${s2.samples} 帧`)
    assert(second.state === 'ready', `④ 第二次挂载图照样上屏(state=${second.state})`)
    assert(s2.reserves.includes('sized'), `④ 第二次挂载 data-reserve="sized" 出现过(序列 ${s2.reserves.join(' → ') || '空'})`)
    /* 「出现过」不够:尺寸表记不住(键错了)时序列是 blank → sized → none —— sized 也出现过。
     * 第二次挂载的判据是**一帧 blank 都没有**:记住多大,第一帧就该按它占。 */
    assert(!s2.reserves.includes('blank'), `④ 第二次挂载一帧 blank 占位都没有(序列 ${s2.reserves.join(' → ') || '空'})`)
    const heightDelta = s2.reservedHeights.length && s2.readyHeights.length
      ? Math.max(...s2.reservedHeights, ...s2.readyHeights) - Math.min(...s2.reservedHeights, ...s2.readyHeights)
      : Number.POSITIVE_INFINITY
    assert(
      heightDelta === 0,
      `④ 图上屏前后消息行高度差 ${Number.isFinite(heightDelta) ? heightDelta : '∞(没取到占位期或上屏期的样本)'}px = 0`,
    )
    readings.heightDelta = heightDelta

    /* ── ⑤ 反证 ───────────────────────────────────────────────────────── */
    if (PROD) console.log('\n[⑤] prod 档跳过:没有 vite,出不了一份改过的模块(反证在 dev 档跑,verify 进的是 dev 档)')
    else {
      console.log('\n[⑤] 反证:门自己那台 vite 出一份摘掉 `media:` 的 resolve.ts(盘上不动),重载后 ③ 必须当场红')
      const patched = await counterProof(vite, page, booted, openSession, idA, assistantId)
      readings.counter = patched
      assert(patched.intercepted, `⑤ vite 出的 resolve.ts 真的摘掉了白名单那一格(${patched.intercepted ? `改了 ${COUNTER.hits} 次` : '一次都没改到 —— 反证是空的'})`)
      const reds = threeChecks(patched.read).filter(([ok]) => !ok).map(([, line]) => line)
      console.log(`      摘掉之后 ③ 的五格里红了 ${reds.length} 格:${reds.join(' / ') || '—'}`)
      assert(
        reds.length > 0 && patched.read.honest.length > 0,
        '⑤ 摘掉 media: 之后 ③ 当场红(图不上屏、落诚实行)—— 门判得出这条病',
      )
    }
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (vite) await vite.close().catch(() => undefined)
    if (server) server.kill('SIGTERM')
    await delay(400)
    if (server && !server.killed) server.kill('SIGKILL')
    if (mockProvider) {
      mockProvider.closeAllConnections?.()
      await new Promise((resolve) => mockProvider.close(resolve))
    }
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  /* 收尸自查(壳 CLAUDE.md「真机 harness 退出必须收尸」)。 */
  try {
    const ps = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf-8' })
    const mine = ps.split('\n').filter((l) =>
      l.includes('media-image-gate-store-') || l.includes('media-image-gate-udd-') || (!PROD && l.includes(`:${DEV_PORT}`)))
    if (mine.length) console.log(`\n[media-image-gate] **残留自查:还有 ${mine.length} 条**\n  ${mine.join('\n  ')}`)
    else console.log('\n[media-image-gate] 残留自查:干净(vite / electron / server 都收了)')
  } catch {
    console.log('\n[media-image-gate] 残留自查:ps 跑不起来,跳过')
  }

  if (process.argv.includes('--json')) console.log(JSON.stringify(readings))
  if (failures.length) {
    console.error(`\n[media-image-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`\n[media-image-gate] ok(${LANE})—— 生成的图上屏、alt 干净、檐上是文件名;关掉再打开 sized 占位、行高零位移`
    + (PROD ? '' : ';反证成立'))
}

/**
 * 行高取样器:每一帧(rAF)+ 每一次 DOM 变动(MutationObserver)读一次**那条 assistant
 * 消息行**的高、图框的 `data-reserve`、img 的 `data-state`。
 *
 * 两路一起取:sized 占位可能只活一两帧(RPC 在本机很快),rAF 那一路可能恰好错过;
 * MutationObserver 在「框被插进 DOM」那一刻就回调,抓得住它。读 `getBoundingClientRect`
 * 会逼一次排版,但这是在取样口里,取的正是这一帧要画的那一份。
 */
async function installRowSampler(page, assistantId) {
  await page.evaluate(([id]) => {
    window.__migSamples = []
    const sample = (via) => {
      const stream = document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
        ?? document.querySelector('[data-testid="chat-stream"]')
      const row = stream?.querySelector(`[data-message-id="${id}"]`)
      const frame = row?.querySelector('[data-testid="block-image-frame"]')
      if (!row || !frame) return
      const img = frame.querySelector('[data-testid="block-image"]')
      window.__migSamples.push({
        via,
        h: Math.round(row.getBoundingClientRect().height * 100) / 100,
        reserve: frame.getAttribute('data-reserve'),
        state: img?.getAttribute('data-state') ?? null,
      })
    }
    const observer = new MutationObserver(() => sample('mo'))
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-reserve', 'data-state'] })
    let alive = true
    const tick = () => {
      if (!alive) return
      sample('raf')
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__migStop = () => {
      alive = false
      observer.disconnect()
    }
  }, [assistantId])
}

async function stopRowSampler(page) {
  const samples = await page.evaluate(() => {
    window.__migStop?.()
    return window.__migSamples ?? []
  })
  const reserves = []
  for (const s of samples) {
    const tag = s.reserve ?? 'none'
    if (reserves[reserves.length - 1] !== tag) reserves.push(tag)
  }
  // 占位期 = 框还带 data-reserve(**不论哪一档**:blank 那一帧也是「图上屏之前」,它若比真高
  // 矮一截,那正是这道门要抓的位移 —— 只取 sized 的样本会让它从尺子底下溜过去,反证实测过);
  // 上屏期 = img ready 且占位撤了。rAF 与 MO 两路读的是同一行,差 0 就是差 0。
  const reservedHeights = [...new Set(samples.filter((s) => s.reserve).map((s) => s.h))]
  const readyHeights = [...new Set(samples.filter((s) => s.state === 'ready' && !s.reserve).map((s) => s.h))]
  const withFrame = samples.filter((s) => s.reserve || s.state)
  return {
    samples,
    summary: {
      samples: samples.length,
      reserves,
      reservedHeights,
      readyHeights,
      heightBefore: withFrame[0]?.h ?? null,
      heightAfter: withFrame[withFrame.length - 1]?.h ?? null,
    },
  }
}

/**
 * ⑤ 的开关与那一刀。门自己起的那台 vite 挂一只 transform 插件:开关打开时,
 * `resolve.ts` 出 vite 的那一刻把白名单那一格的 `'media:'` 去掉(判词见文件头)。
 * 只动 `new Set([...])` 那一格,`scheme === 'media:'` 那一支留着 —— 摘掉的是「认不认」,
 * 不是整条路。盘上一个字节不动,用户那台 vite(5175)根本看不见这只插件。
 */
const COUNTER = { on: false, hits: 0 }
const RESOLVE_MODULE = path.join(appRoot, 'src/content/blocks/asset/resolve.ts')
function counterPlugin() {
  return {
    name: 'gate-media-image-counterproof',
    enforce: 'post',
    transform(code, id) {
      if (!COUNTER.on || id.split('?')[0] !== RESOLVE_MODULE) return undefined
      const next = code.replace(/(new Set\(\[[^\]]*?),\s*["']media:["']/, '$1')
      if (next !== code) COUNTER.hits += 1
      return { code: next, map: null }
    },
  }
}

/**
 * ⑤:开关打开 → 让 vite 忘掉那只模块已经转换过的结果 → 重载页面 → 再开一次那条会话。
 * (试过两条网络层的拦法:Playwright `page.route` 在 Electron 下把**不相干**的模块请求一起
 * 弄成 `net::ERR_FAILED`,裸 CDP `Fetch` 连导航本身都失败 —— 拦截器与 Electron 的会话
 * 不对付。插件这一手不经过网络层,是 vite 自己出一份不同的模块。)
 */
async function counterProof(vite, page, booted, openSession, idA, assistantId) {
  COUNTER.on = true
  for (const mod of vite.moduleGraph.getModulesByFile(RESOLVE_MODULE) ?? []) vite.moduleGraph.invalidateModule(mod)
  await page.evaluate(() => location.reload())
  await delay(500)
  await booted()
  await openSession(idA, assistantId)
  await delay(1500)
  const read = await readImageBlock(page, assistantId)
  COUNTER.on = false
  return { intercepted: COUNTER.hits > 0, read }
}

main().catch((error) => {
  console.error(`\n[media-image-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
