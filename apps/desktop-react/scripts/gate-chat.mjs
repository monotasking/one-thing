#!/usr/bin/env node
/**
 * React 壳 D3 的验收门 —— **脚本级,拒人肉 QA**(方案 §4 P2 那一行门)。
 *
 * D0 的门证「连得上」,D1 的门证「会话列表就是 core 里那批」,D2 的门证「颜色来自
 * 主题管道」。D3 要证的是**聊天这条链路真的通了**,而且是双向的:
 *
 *  ① **写面**:在 React 的输入框里真敲一条、真点发送 → 断言它出现在屏幕的消息树
 *     上,且 HTTP `sessionEvents.listRaw` 里能看到对应的 `user/message` 事件
 *     (发送真的走到了账本,不是渲染层自己画了一条);
 *  ② **活折**:从脚本侧用 HTTP `session-command.emit` 直接注入第二条 → **不刷新**
 *     断言它经 SSE 账本事件出现在 React 屏幕上(推送 → 增量折 → 上屏,整条通);
 *  ③ **折叠 ≡ 读面**:React 折叠树的消息 id 序列与 HTTP `sessions.getMessagesPage`
 *     返回的逐条相等(同一份账本,两条路,同一个答案)。
 *
 * D1 开工批又加了两条(建会话 / 中止):
 *
 *  ④ **建会话**:在总览的组头上真点那颗 +,断言 core 那边**真的多了一条会话**
 *     (`sessions.listMeta` 多一条 + 那条会话自己的账本里有 `session/created`),
 *     并且屏幕跟着进了它。这一条是完整的真机往返,没有任何降级。
 *  ⑤ **中止**:见下面那段「这一条是降级的」。
 *
 * ── ⑤ 为什么是降级的,降在哪 ─────────────────────────────────────────────
 * 「按停止」这个动作要**引擎正在跑**才成立,而这台 core 没有配置任何 provider:
 * 一次 send 之后 run 开张即报错收摊,那个窗口短到没法稳定地在里面点一下按钮。
 * 拿一个偶尔才命中的断言当门,比没有断言更坏 —— 它会被人加 `|| true`。
 *
 * 所以这条门在两个**确定**的点上钉:
 *  a. **命令信封被 core 收下**:脚本按壳发出去的那一模一样的形状
 *     (`{ type: 'command:abort' }`,与 `data/chat-port.ts` 逐字相同)打一发
 *     `session-command.emit`,断言回执 success —— 证的是「壳发的这条命令,
 *     core 认」,那正是接线对不对的全部内容;
 *  b. **停止那副面孔在产物里活着**:断言发送键带着 `data-mode`,闲时是 `send`。
 *     忙时翻成 `stop` 由单测钉(Composer.test.tsx 直接掀 activeMessageId 那一格)。
 * 门里说不出的话,门里就不说:**「真流里按停止,那一轮真的停了」属真机手验**。
 * 要把它变成门,得先有一个像主仓 `sessions:shadow-battery` 那样的种子假 provider,
 * 那是另一件事(与文件头那条 markdown 留账同一个前提)。
 *
 * ── 门只验数据面 ──────────────────────────────────────────────────────
 * 这台 core 上**没有配置任何 provider**,所以发消息之后引擎会开一次 run 然后报错 ——
 * 用户消息照样落账(那正是 ① 要断言的),但**流式生成不会发生**。活尾巴那条链路
 * (`session:stream` 的 delta → 逐字上屏)因此不在这条门里,它属于真机手验。
 * 门里说不出的话,门里就不说。
 *
 * ── 留账:P1(markdown 基块)的门断言加不进来 ──────────────────────────
 * 想加的那条是「一条 markdown 消息上屏后含 code / table 块」。加不了,原因不是
 * 懒得写:**markdown 只解析 assistant 正文**(用户消息是气泡,不过解析器),而这台
 * core 没有 provider,永远长不出一条 assistant 消息;账本侧也没有「写一条 assistant
 * 消息」的 RPC 写面(sessionEvents 是只读的)。要补这条断言,得先有一个像主仓
 * `sessions:shadow-battery` 那样的**种子假 provider**,那是另一件事。
 * 在那之前,markdown 上屏由单测钉(翻译表 / 增量 / 六块冒烟),真机看一眼。
 *
 * 跑法:`node scripts/gate-chat.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
// Electron 本体不在这个应用里重装一份 —— 理由见 gate-connect.mjs 顶部那段。
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const SESSION_NAME = 'D3 门 · 聊天流'
/** ① 在 React 输入框里敲的那句。 */
const TYPED_TEXT = 'D3 门:这一句是从 React 输入框发出去的'
/** ② 从脚本侧注入的那句 —— 屏幕不刷新也必须自己长出来。 */
const INJECTED_TEXT = 'D3 门:这一句是脚本从 HTTP 注进去的'

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

async function waitFor(label, predicate, timeoutMs = 20_000) {
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

/** 用发现文件里的 token 打一条真 RPC —— 这是脚本侧「别人写进 store」的那只手。 */
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
  // rpc 信封(@shared/ipc/rpc.ts):{ ok:true, data } | { ok:false, error }。
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/** 点一个 testid。理由(为什么不用 page.click)见 gate-data.mjs 顶部那段。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * 在 contenteditable 里「打」一段话。
 *
 * 不能用 `page.keyboard.type`:输入框是 contenteditable,而这条门要的是「框里
 * 确实有这段字」而不是「逐键输入的时序」。落文本 + 发一次 input(组件靠它跑
 * @ / 的探测),然后走真正的发送按钮 —— 点的是同一个 React onClick。
 */
async function typeIntoComposer(page, text) {
  const ok = await page.evaluate(value => {
    const box = document.querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:[data-testid="composer-input"] 不在 DOM 里')
}

/** 屏幕上那棵树:按 DOM 序取 (id, role, 正文)。 */
function readScreenTree(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-message-id]')).map(el => ({
      id: el.getAttribute('data-message-id'),
      role: el.getAttribute('data-role'),
      text: el.textContent ?? '',
    })),
  )
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[d3-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[d3-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'd3-gate-'))
  let server
  let app
  try {
    console.log('\n[1/7] 起一台 core,建一条空会话')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
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

    const made = await rpc(record, 'sessions', 'create', { name: SESSION_NAME })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    assert(Boolean(sessionId), `建了一条空会话:${sessionId}`)

    console.log('\n[2/7] 拉起应用,进这条会话')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    const probe = await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    assert(probe.rpcOk === true, `连上了同一台 core(baseUrl=${probe.baseUrl})`)

    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览画出那张卡', () =>
      page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
    )
    await clickTestId(page, `card-${sessionId}`)
    // 进会话 = 聊天区起底(listRaw → 折)。空会话折出来是空树,不是错误。
    await waitFor('聊天区就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
    )
    assert(true, '进入了那条会话,聊天区起底完成')

    console.log('\n[3/7] ① 在 React 输入框里真发一条 —— 它必须同时出现在屏幕和账本上')
    await typeIntoComposer(page, TYPED_TEXT)
    await clickTestId(page, 'composer-send')

    const afterSend = await waitFor('那句话出现在屏幕的消息树上', async () => {
      const tree = await readScreenTree(page)
      const hit = tree.find(row => row.role === 'user' && row.text.includes(TYPED_TEXT))
      return hit ? { tree, hit } : undefined
    })
    assert(
      Boolean(afterSend.hit.id),
      `屏幕消息树上有它,且带着账本给的 id:${afterSend.hit.id}`,
    )

    const raw1 = await rpc(record, 'sessionEvents', 'listRaw', { sessionId })
    const typedEvent = (raw1.events ?? []).find(
      event => event.type === 'user/message' && event.data?.message?.content === TYPED_TEXT,
    )
    assert(
      Boolean(typedEvent),
      `账本里有对应的 user/message 事件(seq=${typedEvent?.seq})—— 发送真的走到了账本`,
    )
    assert(
      typedEvent.data.message.id === afterSend.hit.id,
      '屏幕上那条的 id 就是账本上那条的 id(不是渲染层自己编的号)',
    )

    console.log('\n[4/7] ② 脚本侧 HTTP 注入第二条 —— 不刷新,看它自己长出来')
    const before = (await readScreenTree(page)).length
    await rpc(record, 'session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: INJECTED_TEXT },
    })
    const afterInject = await waitFor('注入的那条经 SSE 账本事件上屏(全程没刷新)', async () => {
      const tree = await readScreenTree(page)
      return tree.some(row => row.role === 'user' && row.text.includes(INJECTED_TEXT))
        ? tree
        : undefined
    })
    assert(afterInject.length > before, `屏幕上多出了消息(${before} → ${afterInject.length})`)
    assert(true, '活折通了:推送 → 增量折 → 上屏,一次刷新都没有')

    console.log('\n[5/7] ③ 折叠树 ≡ 读面:同一份账本,两条路,同一个答案')
    // 引擎那边可能还在收尾(没有 provider,run 会报错落账)—— 等两侧稳下来再比。
    const compared = await waitFor('屏幕的 id 序列与 getMessagesPage 逐条相等', async () => {
      const page1 = await rpc(record, 'sessions', 'getMessagesPage', {
        sessionId,
        limit: 200,
        anchor: 'tail',
      })
      const expected = (page1.messages ?? []).map(message => message.id)
      const actual = (await readScreenTree(page)).map(row => row.id)
      return JSON.stringify(expected) === JSON.stringify(actual) ? { expected, actual } : undefined
    })
    assert(
      compared.expected.length >= 2,
      `两侧都是 ${compared.expected.length} 条:${JSON.stringify(compared.expected)}`,
    )

    console.log('\n[6/7] ④ 在总览组头上点那颗 + —— core 那边必须真的多一条会话')
    // 门里建的那条会话没有 workingDirectory,所以它落在「独立会话」组
    // (expose/projection.ts 的 LOOSE_GROUP_ID)。组头那颗 + 的落点就在它上面。
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览里那个组的组头就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="group-plus-loose"]'))),
    )
    const idsBefore = new Set(
      ((await rpc(record, 'sessions', 'listMeta')).sessions ?? []).map(s => s.id),
    )
    await clickTestId(page, 'group-plus-loose')

    const createdId = await waitFor('core 的会话列表里多出一条', async () => {
      const list = await rpc(record, 'sessions', 'listMeta')
      const fresh = (list.sessions ?? []).filter(s => !idsBefore.has(s.id))
      return fresh.length === 1 ? fresh[0].id : undefined
    })
    assert(Boolean(createdId), `真的建出来一条:${createdId}(建之前 ${idsBefore.size} 条)`)

    const rawNew = await rpc(record, 'sessionEvents', 'listRaw', { sessionId: createdId })
    assert(
      (rawNew.events ?? []).some(event => event.type === 'session/created'),
      '它自己的账本里有 session/created —— 建会话走到了账本,不是渲染层记了一笔',
    )
    /*
     * 「屏幕跟着进了新会话」的可观察证据:聊天区的消息树**空了**。
     * 这是一个真断言而不是恒真式 —— 上一条会话此刻有 ≥2 条消息(③ 刚数过),
     * 所以「树是空的」只可能是因为当前会话换成了刚建出来的那条。
     */
    const treeAfterCreate = await waitFor('新会话的聊天区是空的(它刚建出来)', async () => {
      const tree = await readScreenTree(page)
      return tree.length === 0 ? { tree } : undefined
    })
    assert(
      treeAfterCreate.tree.length === 0 && compared.expected.length >= 2,
      `进的是新那条:聊天区 0 条(上一条会话有 ${compared.expected.length} 条)`,
    )

    console.log('\n[7/7] ⑤ 中止 —— 这一条是**降级**的(理由见文件头)')
    const abortAck = await rpc(record, 'session-command', 'emit', {
      sessionId,
      // 与 src/data/chat-port.ts 的 abort() 逐字相同的信封:一个字段都不多。
      command: { type: 'command:abort' },
    })
    assert(
      abortAck?.success === true,
      '壳发出去的那条 command:abort 信封被 core 收下(接线成立)',
    )
    const sendMode = await page.evaluate(() =>
      document.querySelector('[data-testid="composer-send"]')?.getAttribute('data-mode'),
    )
    assert(sendMode === 'send', `发送键带着 data-mode,闲时是 send(读到:${sendMode})`)

    await app.close()
    app = undefined
    console.log('\n[d3-gate] ok —— 写面进了账本、活折通了、折叠树与读面逐条相等、建会话真的落了账')
    console.log('[d3-gate] 门里没验的:流式生成、以及「真流里按停止那一轮真的停了」')
    console.log('[d3-gate]   —— 两者都要真 provider,属真机手验(⑤ 因此是降级的)。')
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[d3-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
