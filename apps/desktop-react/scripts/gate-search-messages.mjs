#!/usr/bin/env node
/**
 * 消息正文检索的真机门(09-02)—— **脚本级,拒人肉 QA**。
 *
 * 它证的是用户报的那件事:「搜索有问题,有些 message 搜索不到」。
 * 从前壳里搜得到的只有会话标题 / 预览(首条用户消息的截断)/ 章节标题与摘要 ——
 * 助手那条长回复里的字**一个都搜不到**,而那正是人最想搜的东西。
 *
 * 四步,每一步都只有真机量得到:
 *
 *  ① **助手回复里的独有词搜得出来**。种两条会话,每条各跑一轮真流(假 provider),
 *     其中一条的助手回复里埋一个别处不出现的词。搜它 → 屏幕上要出现一行带
 *     「消息」徽的命中,行尾出处是**那条会话的名字**。
 *  ② **反面对照**:同一个词在会话标题 / 预览 / 章节里一次都不出现 ——
 *     所以这一行只可能来自正文那条新链路,不是老三样里蒙出来的。
 *  ③ **点它能落到那条消息上**。点击 → 进那条会话 → 那条 `data-message-id`
 *     真的在树上,而且拿到了落点高亮(`_flash_` 那个 CSS Module 类)。
 *     这一条是整批唯一「跨了两层异步」的手感,jsdom 里量不到:
 *     换会话要重开折叠、折出来的消息要渲染成节点。
 *  ④ **高亮画的是后端给的那一段**。命中片段里被 <mark> 起来的字必须**逐字**
 *     等于搜的那个词 —— 壳这一侧没有再 indexOf 一遍(两个产地各说一次
 *     「什么算命中」迟早漂移)。
 *
 * ── 为什么必须真机 ───────────────────────────────────────────────────────
 * 单测里那条链的两头都是替身:消息由 `patch` 种进 query 缓存、锚点由一只手写的
 * 宿主渲染。这条门跑的是**真后端**(`search.query` 的 `category:'messages'` →
 * `runtime/src/search/providers.ts` 的 `searchMessages` → 逐会话读 messages)、
 * 真会话账本(假 provider 跑出来的真流)、真聊天区(真折叠 + 真渲染)。
 *
 * 跑法:`node scripts/gate-search-messages.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次全新的临时 store,跑完删干净(收尸在 finally 里)。
 *
 * ── 真机输入探针的纪律(09-01 判例)─────────────────────────────────────
 * 从头到尾一次 `page.mouse` / `page.keyboard` 都不用:全部是页面内的 DOM 派发,
 * 只落在目标窗口里,不动真光标、不抢前台焦点。用户可以一边跑门一边用电脑。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/**
 * 埋在助手回复里的那个词。**刻意造得没人会碰上** —— 它同时是反面对照的判据:
 * 会话名、首条用户消息、章节标题里一次都不出现,所以搜到它只可能是走了正文那条路。
 */
const NEEDLE = 'zorbulax'

/** 两条会话的名字。都不含 NEEDLE —— 那正是反面对照要的。 */
const SESSION_A = '正文门 · 没有那个词的会话'
const SESSION_B = '正文门 · 埋了词的会话'

/** 助手回复的两段(B 那条里带 NEEDLE)。够长,好让后端真的截出一段片段来。 */
const REPLY_A = '这一条回答里什么特别的词都没有,只是把上下文重复了一遍好占些长度。'
const REPLY_B =
  '这一段先说点别的凑够前文,好让后端真的从中间截一段出来。'
  + `关键的判据词是 ${NEEDLE},它只出现在这一条助手回复里。`
  + '后面再补一段收尾,让片段两头都带上省略号。'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => {
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
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
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
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/**
 * 假 provider —— 一个 OpenAI 兼容的 `/v1/chat/completions`,回一段 SSE。
 *
 * 回哪一段由**请求体自己**决定(最后一条 user 消息里带哪个记号),不数请求序号:
 * 同一个 store 上还有别的消费者(标题生成)会打到这里来。
 */
function startMockProvider(replies) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const flat = (payload.messages ?? [])
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
        .join('\n')
      const key = Object.keys(replies).find(mark => flat.includes(mark))
      const text = key ? replies[key] : '收到。'
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const frame = (delta, finishReason = null) => ({
        id: 'chatcmpl-gate',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })
      // 逐字发:真流的形状(一次性整段发也行,但那不是真机上的样子)。
      for (const piece of text.match(/.{1,16}/gs) ?? []) {
        res.write(`data: ${JSON.stringify(frame({ content: piece }))}\n\n`)
      }
      res.write(`data: ${JSON.stringify(frame({}, 'stop'))}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 一条会话跑一轮:发一句话,等账本上那条助手消息落定。 */
async function runTurn(record, store, sessionId, mark) {
  await rpc(record, 'session-command', 'emit', {
    sessionId,
    command: {
      type: 'command:send-message',
      content: `请随便说点什么 ${mark}`,
      suppressTitleGeneration: true,
    },
  })
  return waitFor(`会话 ${sessionId} 的助手消息落账`, async () => {
    const page = await rpc(record, 'sessions', 'getMessagesPage', {
      sessionId,
      limit: 20,
      anchor: 'tail',
    })
    const done = (page.messages ?? []).find(
      m => m.role === 'assistant' && !m.isStreaming && (m.content ?? '').length > 0,
    )
    return done ?? undefined
  })
}

async function clickSelector(page, selector) {
  const clicked = await page.evaluate(css => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

async function typeQuery(page, value) {
  await page.evaluate(text => {
    const input = document.querySelector('[data-testid="search-panel"] input')
    if (!input) throw new Error('检索框不在 DOM 里')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

/** 屏幕上那几行:徽 / 原文 / 出处 三列按位置取,外加这一行高亮起来的那几段。 */
function readRows(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="search-panel"]')
    if (!panel) return { panel: false, rows: [] }
    const rows = [...panel.querySelectorAll('[role="option"]')].filter(
      el => el.getAttribute('data-row') !== 'more',
    )
    return {
      panel: true,
      rows: rows.map((row, index) => ({
        index,
        badge: (row.children[0]?.textContent ?? '').trim(),
        text: (row.children[1]?.textContent ?? '').trim(),
        origin: (row.children[2]?.textContent ?? '').trim(),
        marks: [...row.querySelectorAll('mark')].map(m => m.textContent ?? ''),
      })),
    }
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[msg-search-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[msg-search-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'msg-search-gate-'))
  let mock
  let server
  let app
  try {
    console.log('\n[1/6] 起假 provider,写一份只指向它的 settings')
    mock = await startMockProvider({ '@@a@@': REPLY_A, '@@b@@': REPLY_B })
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify({
        ai: {
          provider: 'deepseek',
          providers: {
            // 钥匙走环境变量(headless 没有 safeStorage,写进 settings 迁不动)。
            deepseek: {
              baseUrl: `http://127.0.0.1:${mock.port}/v1`,
              model: 'deepseek-chat',
              selectedModels: ['deepseek-chat'],
              enabled: true,
            },
          },
        },
      }),
    )

    console.log('\n[2/6] 起一台 core,建两条会话,各跑一轮真流')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-gate' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))

    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    const madeA = await rpc(record, 'sessions', 'create', { name: SESSION_A })
    const madeB = await rpc(record, 'sessions', 'create', { name: SESSION_B })
    const idA = madeA?.session?.id
    const idB = madeB?.session?.id
    if (!idA || !idB) throw new Error('sessions.create 没给出会话 id')

    const replyA = await runTurn(record, store, idA, '@@a@@')
    const replyB = await runTurn(record, store, idB, '@@b@@')
    assert(!replyA.content.includes(NEEDLE), `A 那条助手回复里没有「${NEEDLE}」`)
    assert(replyB.content.includes(NEEDLE), `B 那条助手回复里有「${NEEDLE}」(消息 ${replyB.id})`)

    /*
     * ② 反面对照,**在真数据上量**:这个词在老三样(会话名 / 预览 / 章节)里
     * 一次都不出现。所以后面搜到它,只可能是走了正文那条新链路。
     */
    const listed = await rpc(record, 'sessions', 'listMeta', {})
    const oldSurfaces = (listed.sessions ?? []).flatMap(s => [
      s.name ?? '',
      s.previewText ?? '',
      s.lastMessagePreview ?? '',
    ])
    assert(
      oldSurfaces.every(text => !text.includes(NEEDLE)),
      `会话名 / 预览 / 最近一句里都没有「${NEEDLE}」—— 老三样搜不到它`,
    )

    /*
     * 后端那条口自己先答一次:这一步把「壳没接上」与「后端没搜到」分开 ——
     * 门红的时候不必猜是哪一半。
     */
    const backend = await rpc(record, 'search', 'query', {
      query: NEEDLE,
      category: 'messages',
      limit: 20,
    })
    const backendHit = (backend.results ?? []).find(r => r.messageId === replyB.id)
    assert(Boolean(backendHit), '后端 search.query(messages)自己就搜得到那条助手消息')
    assert(
      Array.isArray(backendHit.matchRanges) && backendHit.matchRanges.length > 0,
      `后端给了命中区间:${JSON.stringify(backendHit.matchRanges)}`,
    )

    console.log('\n[3/6] 拉起应用,开检索面板')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('检索瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-search"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )

    console.log(`\n[4/6] 搜「${NEEDLE}」—— 正文命中要出现在屏幕上`)
    await typeQuery(page, NEEDLE)
    const shown = await waitFor('正文命中画出来', async () => {
      const state = await readRows(page)
      const hit = state.rows.find(row => row.text.includes(NEEDLE))
      return hit ? { ...state, hit } : undefined
    })
    console.log('  · 那一行:', JSON.stringify(shown.hit))
    // ① 徽是「消息」(zh)/ MSG(en)——按语言取,不背词表。
    assert(
      shown.hit.badge === '消息' || shown.hit.badge === 'MSG',
      `行首是消息徽:「${shown.hit.badge}」`,
    )
    // 出处是**所属会话名**(与预览 / 章节同一形),不是后端回执里那份快照。
    assert(shown.hit.origin === SESSION_B, `出处是所属会话名:「${shown.hit.origin}」`)
    assert(
      shown.rows.every(row => row.origin !== SESSION_A),
      'A 那条会话一行都没有 —— 它既不叫这个名字,回复里也没有这个词',
    )

    console.log('\n[5/6] ④ 高亮画的是后端给的那一段')
    assert(
      shown.hit.marks.length === 1 && shown.hit.marks[0] === NEEDLE,
      `命中段逐字等于那个词:${JSON.stringify(shown.hit.marks)}`,
    )
    /*
     * 上面那一条**还判不出产地**:词与后端说的那一段恰好重合,拆掉整条 ranges 通路
     * 它照样绿。真正的判据要一个**两个产地会给出不同答案**的词 —— 后端的
     * `normalizeQuery` 会剥掉开头的 `/`(与 `>`),本地那一遍不会:
     *  · 后端:搜 `zorbulax`,命中,回一段落在片段上的区间;
     *  · 本地:拿 `/zorbulax` 去 indexOf,一个字都找不到 → 零个 <mark>。
     * 所以「行还在、而且照样高亮着那个词」只可能是用了后端给的那一份。
     */
    await typeQuery(page, `/${NEEDLE}`)
    const slashed = await waitFor('带斜杠的词照样搜得到', async () => {
      const state = await readRows(page)
      const hit = state.rows.find(row => row.text.includes(NEEDLE))
      return hit ?? undefined
    })
    console.log('  · 带斜杠那一行的高亮:', JSON.stringify(slashed.marks))
    assert(
      slashed.marks.length === 1 && slashed.marks[0] === NEEDLE,
      `搜「/${NEEDLE}」时高亮仍是「${NEEDLE}」—— 本地那条路在这个词上会给零段,所以画的是后端那一份`,
    )
    // 回到那个词,后面几步接着用它。
    await typeQuery(page, NEEDLE)
    await waitFor('回到不带斜杠的那一屏', async () => {
      const state = await readRows(page)
      return state.rows.some(row => row.text.includes(NEEDLE)) ? state : undefined
    })

    console.log('\n[6/6] ③ 点它:进那条会话,并落到那条消息上')
    await clickSelector(
      page,
      `[data-testid="search-panel"] [role="option"][data-row="${shown.hit.index}"]`,
    )
    const landed = await waitFor('落到那条消息上', async () => {
      const state = await page.evaluate(id => {
        const node = document.querySelector(`[data-message-id="${id}"]`)
        if (!node) return { onTree: false }
        return {
          onTree: true,
          // 落点高亮是 CSS Module 的 `flash` 类(哈希后缀由构建决定,按前缀认)。
          flashed: [...node.classList].some(name => name.startsWith('_flash_')),
          role: node.getAttribute('data-role'),
        }
      }, replyB.id)
      return state.onTree && state.flashed ? state : undefined
    })
    assert(landed.onTree, `那条消息(${replyB.id})真的在聊天区的树上`)
    assert(landed.role === 'assistant', '而且它就是那条**助手**回复(不是首条用户消息)')
    assert(landed.flashed, '它拿到了落点高亮 —— 「滚过去 + 点亮」这一手真的跑了')
    // 面板收回 Dock:与点会话行同一个手感。
    await waitFor('面板收回 Dock 了', () =>
      page.evaluate(() => !document.querySelector('[data-testid="search-panel"]')),
    )

    await app.close()
    app = undefined
    console.log(
      '\n[msg-search-gate] ok —— 助手回复里的词搜得到、徽与出处对、高亮来自后端、点了能落到那条消息',
    )
  } finally {
    // 收尸:自己起的每一个进程都在这里逐个杀掉,临时目录一并删干净。
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    if (server && pidAlive(server.pid)) server.kill('SIGKILL')
    if (mock) await new Promise(resolve => mock.server.close(resolve))
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[msg-search-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
