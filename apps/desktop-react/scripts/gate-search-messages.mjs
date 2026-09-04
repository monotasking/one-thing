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

/**
 * 六个能力自述的 `labelKey` → 中文字面(S4a)。
 *
 * 门里**不该另存一份字典**,但它要判「tab 条上写的是不是自述那个键翻出来的字」,
 * 而门跑的是打包产物、拿不到 `src/i18n/zh.ts`。所以这里只抄**这一族键**,并且
 * 判的是「后端说的 labelKey → 这张表 → 屏幕上那个字」这条链对不对 ——
 * 后端换一个 labelKey 而这里没跟上,门会红在「tab 条逐格 = 自述表」那一条上,
 * 那正是它该红的地方。
 */
const LABELS = {
  'search.capability.chats': ['会话', 'Sessions'],
  'search.capability.messages': ['消息', 'Messages'],
  'search.capability.files': ['文件', 'Files'],
  'search.capability.daily': ['笔记', 'Notes'],
  'search.capability.prompts': ['提示词', 'Prompts'],
  'search.capability.actions': ['命令', 'Commands'],
}

/** `all` 那一格的两种写法(它在壳自己的字典里,不在任何一份自述里)。 */
const ALL_LABELS = ['所有', 'All']

/**
 * S4b 要点的那几句**壳自己的**文案(片的选项、行的动作)。
 *
 * 与 `LABELS` 同一条纪律:门跑的是打包产物、拿不到 `src/i18n/zh.ts`,所以这里
 * 抄下来 —— 但只抄**这几句**,而且判据仍然是「点得着那一条」:文案改了这道门会红
 * 在「菜单里没有一条能按的 X」上,那正是它该红的地方。
 *
 * 门跑起来是哪种语言由这台机器的设置决定,所以每一句都收两种写法,
 * 由 `clickMenuItem` 逐个试(第一句点不着就试第二句)。
 */
const ROLE_USER_LABEL = ['用户', 'User']
const ROLE_ANY_LABEL = ['不挑', 'Any']
const SPACE_ALL_LABEL = ['全部', 'All']
const SPACE_CURRENT_LABEL = ['当前', 'Current']
const SCOPE_IN_SESSION_LABEL = ['在此会话内搜', 'Search in this session']

/** 用户那句话里的记号 —— 角色片滤完之后靠它认出「剩下的是用户说的」。 */
const USER_SENTENCE_MARK = '我这句话里说了'

/**
 * 屏幕上那个字**认不认**这个 labelKey。
 *
 * 门跑起来是哪种语言由这台机器的设置决定(实测是 en),所以判据不能钉死一种 ——
 * 钉死的话这道门在中文机器上会红,而红的原因与它要守的东西无关。
 */
function labelMatches(labelKey, shown) {
  return (LABELS[labelKey] ?? [labelKey]).includes(shown)
}

/**
 * 两个 S4b 才用得上的判据词。
 *
 *  · `COMMON` —— **A 与 B 两条会话的助手回复里都有**。范围片那一条要它:
 *    「在此会话内搜」按下去之前屏幕上必须有两间会话的行,否则「只剩这一间」
 *    这句话是自动成立的,断言等于没写。
 *  · `ROLE_WORD` —— **同一间会话里,用户消息与助手回复各出现一次**。角色片那一条
 *    要它:滤成「用户」之后行数必须真的少一条,而且留下的那条是用户说的那句。
 */
const COMMON = 'gatecommonword'
const ROLE_WORD = 'gaterolewordx'

/** 三条会话的名字。都不含 NEEDLE —— 那正是反面对照要的。 */
const SESSION_A = '正文门 · 没有那个词的会话'
const SESSION_B = '正文门 · 埋了词的会话'
/**
 * **另一个工作区**里的第三条会话(S4b)。它的助手回复里同样埋了 NEEDLE ——
 * 于是「空间片」那一条有真东西可判:默认(当前空间)它不该出现,
 * 切到「全部空间」它出现,并且带一颗跨空间徽。
 */
const SESSION_C = '正文门 · 别的空间那条会话'
const SPACE_C = 'gatespace'

/** 助手回复的三段(B / C 那两条里带 NEEDLE)。够长,好让后端真的截出一段片段来。 */
const REPLY_A =
  '这一条回答里什么特别的词都没有,只是把上下文重复了一遍好占些长度。'
  + `不过它也说了 ${COMMON},那是两间会话都会提到的那个词。`
const REPLY_B =
  '这一段先说点别的凑够前文,好让后端真的从中间截一段出来。'
  + `关键的判据词是 ${NEEDLE},它只出现在这一条助手回复里。`
  + `顺带也说一句 ${COMMON}。`
  + '后面再补一段收尾,让片段两头都带上省略号。'
const REPLY_C =
  '这一条来自另一个工作区,内容与 B 那条无关,只是同样提到了那个判据词 '
  + `${NEEDLE},好让「全部空间」那一档有东西可看。`
/** 角色片那一条专用:助手也说一次 ROLE_WORD(用户那句里也有)。 */
const REPLY_ROLE = `助手这一条同样说到了 ${ROLE_WORD},所以两条都命中,滤了才见分晓。`

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
 * 回哪一段由**请求体自己**决定,不数请求序号:同一个 store 上还有别的消费者
 * (标题生成)会打到这里来。
 *
 * ── 认的是**最后一条 user 消息**,不是整段历史(S4b 修)───────────────────
 * 从前这里把 `messages` 全摊平再找记号。**同一间会话跑第二轮**的那一刻它就错了:
 * 第二轮的请求体里带着第一轮那句话,于是 `find` 先撞上第一轮的记号,第二轮回的
 * 是第一轮那一段。表现是「角色片那一条怎么滤都不对」,而病根在这里 ——
 * 一次对话的**这一轮**说了什么,只有最后那条 user 消息说得准。
 */
function startMockProvider(replies) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const asked = [...(payload.messages ?? [])].reverse().find(m => m.role === 'user')
      const flat = typeof asked?.content === 'string'
        ? asked.content
        : JSON.stringify(asked?.content ?? '')
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

/**
 * 一条会话跑一轮:发一句话,等账本上那条助手消息落定。
 *
 * `content` 收的是**整句话**(S4b 起)——角色片那一条要用户消息里也埋一个词,
 * 而从前这里把那句话写死成 `请随便说点什么 ${mark}`。假 provider 认的仍然是
 * 那个 `mark`(它按请求体里出现哪个记号选回哪一段),所以调用方只要把 mark
 * 包在句子里就行。
 */
async function runTurn(record, store, sessionId, mark, content = `请随便说点什么 ${mark}`) {
  /*
   * **先数一次**这间会话此刻有几条落定的助手消息(S4b 修)。
   *
   * 从前这里不数,等的是「页里第一条助手消息」—— 同一间会话跑第二轮时那一条
   * **上一轮就在**,于是 waitFor 立刻返回,门带着一条旧消息往下走。数一次再等
   * 「多出来一条」,判据才真的是「这一轮落账了」。
   */
  const settledAssistants = async () => {
    const page = await rpc(record, 'sessions', 'getMessagesPage', {
      sessionId,
      limit: 50,
      anchor: 'tail',
    })
    return (page.messages ?? []).filter(
      m => m.role === 'assistant' && !m.isStreaming && (m.content ?? '').length > 0,
    )
  }
  const before = (await settledAssistants()).length

  await rpc(record, 'session-command', 'emit', {
    sessionId,
    command: {
      type: 'command:send-message',
      content,
      suppressTitleGeneration: true,
    },
  })
  /*
   * 等的是**这一轮**那条助手消息 —— 取的是最后一条,不是页里第一条(S4b 修)。
   * 同一间会话跑第二轮时,「页里第一条助手消息」是**上一轮**那条:它当场就在,
   * 于是这只 waitFor 立刻返回,门带着一条旧消息往下走(表现是后面那条
   * 「落到那条消息上」永远等不到,因为它等的根本不是屏幕上那一条)。
   */
  return waitFor(`会话 ${sessionId} 的这一轮助手消息落账`, async () => {
    const done = await settledAssistants()
    return done.length > before ? done.at(-1) : undefined
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

/**
 * 屏幕上那几行:徽 / 原文 / 出处 三列按位置取,外加这一行高亮起来的那几段。
 *
 * S4a 起多读四样(§10 S4 行那七条断言要的读数):这一行的 `target.kind` 与
 * 产它的能力(两个 data-* 属性)、行上那几颗事实徽、组头、以及底部那几条读数。
 * 全部按**属性**读而不是按文案读 —— 文案会随语言变,属性是契约。
 */
function readRows(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="search-panel"]')
    if (!panel) return { panel: false, rows: [], tabs: [], groups: [], readouts: {} }
    const rows = [...panel.querySelectorAll('[role="option"]')].filter(
      el => el.getAttribute('data-row') !== 'more',
    )
    const readouts = {}
    for (const el of panel.querySelectorAll('[data-readout]')) {
      readouts[el.getAttribute('data-readout')] = (el.textContent ?? '').trim()
    }
    // 预览窗(S4b):状态 + 媒介 kind + 正文。按属性读,不按文案读。
    const previewEl = panel.querySelector('[data-preview]')
    return {
      panel: true,
      // tab 条:文案 + 选中态。「tab 随注册表」那一条读它。
      tabs: [...panel.querySelectorAll('[role="radio"]')].map(el => ({
        label: (el.textContent ?? '').trim(),
        on: el.getAttribute('aria-checked') === 'true',
      })),
      // 组头:全部档才有,按能力 id 认(不按名字 —— 名字会随语言变)。
      groups: [...panel.querySelectorAll('[data-group]')].map(el => el.getAttribute('data-group')),
      // 组头右边那两格读数(S4b:total 与「没搜成」都按能力 id 挂属性)。
      groupTotals: Object.fromEntries(
        [...panel.querySelectorAll('[data-group-total]')]
          .map(el => [el.getAttribute('data-group-total'), (el.textContent ?? '').trim()]),
      ),
      groupErrors: [...panel.querySelectorAll('[data-group-error]')]
        .map(el => el.getAttribute('data-group-error')),
      // 片条(S4b):这一档摆得出哪几颗片、各自挑过了没有、片上写着什么。
      filters: [...panel.querySelectorAll('[data-filter]')].map(el => ({
        name: el.getAttribute('data-filter'),
        on: el.getAttribute('data-on') === 'true',
        text: (el.textContent ?? '').trim(),
      })),
      preview: previewEl === null ? null : {
        state: previewEl.getAttribute('data-preview'),
        kind: previewEl.getAttribute('data-preview-kind'),
        text: (previewEl.textContent ?? '').trim(),
        turns: [...previewEl.querySelectorAll('[data-preview-turn]')]
          .map(el => el.getAttribute('data-preview-turn')),
      },
      query: panel.querySelector('input')?.value ?? '',
      readouts,
      rows: rows.map((row, index) => ({
        index,
        badge: (row.children[0]?.textContent ?? '').trim(),
        text: (row.children[1]?.textContent ?? '').trim(),
        origin: (row.children[2]?.textContent ?? '').trim(),
        marks: [...row.querySelectorAll('mark')].map(m => m.textContent ?? ''),
        kind: row.getAttribute('data-target-kind'),
        capability: row.getAttribute('data-capability'),
        tags: [...row.querySelectorAll('[data-tag]')].map(el => el.getAttribute('data-tag')),
      })),
    }
  })
}

/**
 * 开一颗过滤片的菜单(片身是那颗 `<button>`,菜单 portal 到 body)。
 * 与整份脚本同一条纪律:页面内 DOM 派发,不动真光标、不抢前台焦点。
 */
async function clickChip(page, name) {
  const ok = await page.evaluate(chip => {
    const el = document.querySelector(`[data-filter="${chip}"] button`)
    if (!el) return false
    el.click()
    return true
  }, name)
  if (!ok) throw new Error(`片条上没有「${name}」这一颗`)
}

/**
 * 点一条菜单项(片的选项菜单与行的右键菜单共用它 —— 两者都是 `ui/Menu`)。
 * 收的是一张**候选表**(中英各一句),逐个试 —— 门跑起来是哪种语言由这台机器定。
 */
async function clickMenuItem(page, labels) {
  const candidates = Array.isArray(labels) ? labels : [labels]
  const ok = await page.evaluate(names => {
    const buttons = [...document.querySelectorAll('[role="menu"] button, [role="listbox"] button')]
    for (const name of names) {
      const el = buttons.find(node => (node.textContent ?? '').trim() === name)
      if (el && !el.disabled) {
        el.click()
        return true
      }
    }
    return false
  }, candidates)
  if (!ok) throw new Error(`菜单里没有一条能按的「${candidates.join(' / ')}」`)
}

/** 右键一行 —— 动作单产地是右键上下文菜单(09-01 判例)。 */
async function rightClickRow(page, index) {
  const ok = await page.evaluate(at => {
    const el = document.querySelector(`[data-testid="search-panel"] [role="option"][data-row="${at}"]`)
    if (!el) return false
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    return true
  }, index)
  if (!ok) throw new Error(`右键不到第 ${index} 行`)
}

/** 往检索框上派一下方向键(↑ = 回上一条查询,判据见 SearchPanel 的 onKeyDown)。 */
async function pressInInput(page, key) {
  await page.evaluate(name => {
    const input = document.querySelector('[data-testid="search-panel"] input')
    if (!input) throw new Error('检索框不在 DOM 里')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  }, key)
}

/**
 * 屏幕上那条**正文命中**是哪一行。
 *
 * S4b 之前这里写的是「第一条含 NEEDLE 的行」,而那时 `all` 档只画壳自带的三类。
 * 今天 `all` 档由后端的 `groups` 说了算 —— 提示词那一类会答一条「新建提示词
 * 『zorbulax』」的快捷项,它排在消息那一组前面,于是「第一条含那个词的行」
 * 是它而不是命中。判据因此改成**按能力认**:`data-capability` 是契约,
 * 「第几行」不是。
 */
function messageHitOf(state) {
  return state.rows.find(row => row.capability === 'messages' && row.text.includes(NEEDLE))
}

/** 换一档:点那一格 radio(不数 Tab —— tab 条现在是从自述算出来的)。 */
async function selectTab(page, label) {
  const ok = await page.evaluate(text => {
    const el = [...document.querySelectorAll('[data-testid="search-panel"] [role="radio"]')]
      .find(node => (node.textContent ?? '').trim() === text)
    if (!el) return false
    el.click()
    return true
  }, label)
  if (!ok) throw new Error(`tab 条上没有「${label}」这一格`)
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
    mock = await startMockProvider({
      '@@a@@': REPLY_A,
      '@@b@@': REPLY_B,
      '@@c@@': REPLY_C,
      '@@role@@': REPLY_ROLE,
    })
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
    /*
     * 第三条建在**另一个工作区**里(S4b)。空间片与跨空间徽两条断言都要它:
     * 后端投影器把 `meta.workspaceId` 写成文档的 `spaceId` facet,
     * 而壳默认发的是「当前空间」那一格 —— 于是它默认搜不到,切「全部空间」才出现。
     */
    const madeC = await rpc(record, 'sessions', 'create', { name: SESSION_C, workspaceId: SPACE_C })
    const idA = madeA?.session?.id
    const idB = madeB?.session?.id
    const idC = madeC?.session?.id
    if (!idA || !idB || !idC) throw new Error('sessions.create 没给出会话 id')

    const replyA = await runTurn(record, store, idA, '@@a@@')
    /*
     * B 跑两轮,**带 ROLE_WORD 的那一轮在前**:第二轮那条(埋着 NEEDLE)于是是 B 的
     * 最后一条助手消息 —— 后面「点它能落到那条消息上」认的就是屏幕上那一条。
     * 第一轮:用户那句里也埋一个词,助手回来那条同样说它 —— 角色片那一条要的
     * 就是这一对(滤成「用户」之后行数必须真的少一条)。
     */
    await runTurn(
      record, store, idB, '@@role@@',
      `我这句话里说了 ${ROLE_WORD},看看滤角色之后还剩几条 @@role@@`,
    )
    const replyB = await runTurn(record, store, idB, '@@b@@')
    await runTurn(record, store, idC, '@@c@@')
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
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        /*
         * **窗子离屏起**(与 gate-focus / gate-a11y / gate-perf 同一手,09-04 判例:
         * 真机门不许抢用户的前台)。不 `show()`、不进 Dock —— 判据落在
         * `electron/main.ts` 的 `ONETHING_GATE_HEADLESS` 那一段上。
         * 这道门从头到尾只用页面内 DOM 派发,不需要真焦点,所以连
         * `Emulation.setFocusEmulationEnabled` 都不必补。
         */
        ONETHING_GATE_HEADLESS: '1',
      },
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
      const hit = messageHitOf(state)
      return hit ? { ...state, hit } : undefined
    }, 20_000)
    console.log('  · 那一行:', JSON.stringify(shown.hit))
    // ① 徽是「消息」(zh)/ MSG(en)——按语言取,不背词表。
    assert(
      shown.hit.badge === '消息' || shown.hit.badge === 'MSG',
      `行首是消息徽:「${shown.hit.badge}」`,
    )
    // 出处是**所属会话名**(与预览 / 章节同一形),不是后端回执里那份快照。
    assert(shown.hit.origin === SESSION_B, `出处是所属会话名:「${shown.hit.origin}」`)
    assert(
      shown.rows.filter(row => row.capability === 'messages').every(row => row.origin !== SESSION_A),
      'A 那条会话一条正文命中都没有 —— 它既不叫这个名字,回复里也没有这个词',
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
      return messageHitOf(state) ?? undefined
    }, 20_000)
    console.log('  · 带斜杠那一行的高亮:', JSON.stringify(slashed.marks))
    assert(
      slashed.marks.length === 1 && slashed.marks[0] === NEEDLE,
      `搜「/${NEEDLE}」时高亮仍是「${NEEDLE}」—— 本地那条路在这个词上会给零段,所以画的是后端那一份`,
    )
    // 回到那个词,后面几步接着用它。
    await typeQuery(page, NEEDLE)
    /*
     * **重新读一次那一行的下标**(S4b)。从前这里复用的是上面 `shown.hit.index`,
     * 而那时 `all` 档只画壳自带的三类、次序是壳自己拼的,所以下标稳。今天这一档
     * 由后端的 `groups` 说了算 —— 各组是**谁先答完谁先到**(fanout §6.4 ④),
     * 于是「消息那一组排第几」在两次查询之间不保证一样,一个隔了两屏的旧下标
     * 会点到别的组的行上。下标是**这一屏的事实**,不是跨屏的常量。
     */
    const backOnNeedle = await waitFor('回到不带斜杠的那一屏', async () => {
      const state = await readRows(page)
      const hit = messageHitOf(state)
      return hit ? { state, hit } : undefined
    }, 20_000)

    console.log('\n[6/6] ③ 点它:进那条会话,并落到那条消息上')
    console.log('  · 这一屏那一行的下标:', backOnNeedle.hit.index, '/ 全屏', backOnNeedle.state.rows.length, '行')
    await clickSelector(
      page,
      `[data-testid="search-panel"] [role="option"][data-row="${backOnNeedle.hit.index}"]`,
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

    /* ═══════════════════════════════════════════════════════════════════
     * [7/7] 检索重建 S4a 的七条(设计 §10 S4 行 / §9)
     *
     * 每一条都标了它**靠什么证**:真数据、还是注入的假读数。第七条(读者模式)
     * 只能注入 —— 索引持有权(§5.6)拍点庚 09-04 裁「先不做」,真机上 `mode`
     * 恒 `owner`,所以那一行在真数据下**永远画不出来**。注入证的是「画它的逻辑在」。
     * ═══════════════════════════════════════════════════════════════════ */
    console.log('\n[7/7] S4a:tab 随注册表 / 分组 / total / 放宽 / 两颗徽 / 读者模式行')
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板重新开出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )

    /* ── ① tab 随注册表(真数据)──────────────────────────────────────
     * tab 条上那几格 = `search.capabilities` 回来的六份自述 + 固定第一的 `all`。
     * 判据不是「有六格」而是**逐格对上后端此刻真的注册着的那几个** —— 所以先问
     * 后端要一份,再拿它算出期望的次序(`all` 第一,其余按 order)。
     * 反证:把 `tabsOf` 换成写死的表,后端注销一个能力时这一条当场红。
     */
    const catalog = await rpc(record, 'search', 'capabilities', {})
    const manifests = catalog.capabilities ?? []
    assert(manifests.length > 0, `后端注册着 ${manifests.length} 个能力`)
    const expectedKeys = [...manifests].sort((a, b) => a.order - b.order).map(m => m.labelKey)
    const withTabs = await readRows(page)
    const shownLabels = withTabs.tabs.map(t => t.label)
    console.log('  · tab 条:', JSON.stringify(shownLabels))
    console.log('  · 自述按 order:', JSON.stringify(expectedKeys))
    assert(
      shownLabels.length === expectedKeys.length + 1,
      `tab 条一共 ${shownLabels.length} 格 = 自述 ${expectedKeys.length} 个 + 固定第一的 all`,
    )
    assert(ALL_LABELS.includes(shownLabels[0]), `第一格是「不挑」那一档:「${shownLabels[0]}」`)
    assert(
      expectedKeys.every((key, i) => labelMatches(key, shownLabels[i + 1])),
      `其余逐格 = 自述的 labelKey 按 order 翻出来的字:${JSON.stringify(expectedKeys)} → ${JSON.stringify(shownLabels.slice(1))}`,
    )
    assert(withTabs.tabs[0].on, '开出来停在 `all` 那一档')

    /* ── ② 分组(真数据)────────────────────────────────────────────
     * 全部档按能力归堆,每一组的第一行前面一条组头。判据是**组头的 data-group
     * 逐字等于能力 id**,而且组内的行确实都是那个能力产的。
     */
    await typeQuery(page, NEEDLE)
    const grouped = await waitFor('全部档画出分组', async () => {
      const state = await readRows(page)
      return state.groups.length > 0 && messageHitOf(state) !== undefined
        ? state
        : undefined
    })
    console.log('  · 组头:', JSON.stringify(grouped.groups))
    assert(
      grouped.groups.every(id => manifests.some(m => m.id === id)),
      `每一条组头都是一个真能力:${JSON.stringify(grouped.groups)}`,
    )
    assert(
      grouped.groups.length === new Set(grouped.groups).size,
      '同一个能力只有一条组头 —— 归堆是稳定的,不是每行前面来一条',
    )
    // 目标渲染注册表真的在分发:每一行都带 `data-target-kind`,而且有渲染器认它。
    assert(
      grouped.rows.every(r => typeof r.kind === 'string' && r.kind.length > 0),
      '每一行都报了自己的 target.kind —— 行是按 kind 从渲染注册表取的',
    )
    assert(
      grouped.rows.every(r => r.badge.length > 0),
      '每一行都画出了徽 —— 徽是那一类的渲染器答的,缺渲染器就是空徽',
    )

    /* ── ③ 归档徽(真数据)──────────────────────────────────────────
     * S3b 之后**归档会话里的消息搜得到了**(索引照建它们的文档)。那是一次
     * 行为变化,所以屏幕上必须能一眼看出这一行来自一间已归档的会话。
     * 归档 B 那条会话,再搜同一个词 —— 那一行还在,而且多了一颗「已归档」徽。
     */
    await rpc(record, 'sessions', 'updateArchived', { sessionId: idB, isArchived: true })
    /*
     * 索引是**账本的投影**,归档改的是 `meta.json` —— 所以要等投影器把这间会话
     * 重折一遍(检查点比 `metaRev`,S3 的判据)。先问后端要一次,拿到带
     * `archived: true` 的那一份再去看屏幕:这样门红的时候能一眼分清是
     * 「索引还没跟上」还是「壳没画」。
     */
    const archivedFromBackend = await waitFor('后端的命中上 archived 翻成 true', async () => {
      const answer = await rpc(record, 'search', 'query', {
        query: NEEDLE, category: 'messages', limit: 20,
      })
      const hit = (answer.results ?? []).find(r => r.messageId === replyB.id)
      return hit?.facets?.archived === true ? hit : undefined
    }, 20_000)
    console.log('  · 后端那一条的 facets:', JSON.stringify(archivedFromBackend.facets))
    assert(
      archivedFromBackend.facets.archived === true,
      '后端把 archived 这一格如实带回来了 —— 归档会话的消息**搜得到**(S3b 治好的病)',
    )
    /*
     * **reload 一次再看**。理由是缓存的语义,不是不信任它:正文那一路是键控的
     * 一格 query(键 = 词 + 这一页要多少条),刚才那一发是**归档之前**问到的 ——
     * 同一个键再问一次是 `ensure` 的「问过就算了」,不会重发。清掉词再打一遍
     * 也回到同一个键。让渲染层重开一次是这里最诚实的一手:它不去戳缓存的内部,
     * 也不靠一个「换个词绕开键」的小聪明(那会让门在验一件别的事)。
     */
    await page.reload()
    await waitFor('reload 之后渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('检索瓦回到位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-search"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板重开', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )
    await typeQuery(page, NEEDLE)
    const archived = await waitFor('归档之后那一行还在,并且带上了归档徽', async () => {
      const state = await readRows(page)
      const hit = messageHitOf(state)
      return hit && hit.tags.includes('archived') ? hit : undefined
    }, 15_000).catch(error => {
      throw new Error(`${error.message}\n最后一屏:${JSON.stringify(shown.rows?.slice(0, 3))}`)
    })
    assert(archived.tags.includes('archived'), `归档会话的命中带「已归档」徽:${JSON.stringify(archived.tags)}`)

    /* ── ④ 跨空间徽(**今天画不出来,这一条证的是它不该出现**)────────
     * §9 的原话:空间徽**只在「全部空间」过滤下画**。那格过滤片是 S4b,今天
     * 恒关,所以默认这一档里一颗都不该有 —— 画一颗恒不出现的徽等于骗自己,
     * 而如果它此刻出现了,说明判据写反了(把「不同空间」画成了「所有行」)。
     */
    const spaceTags = archived.tags.filter(tag => tag === 'space')
    assert(
      spaceTags.length === 0,
      '默认档下一颗空间徽都没有 —— 过滤片(S4b)开出来之前它本来就不该出现',
    )

    /* ── ⑤ total(真数据)────────────────────────────────────────────
     * 后端给了真数才画。走一个**通用档**(壳没有自带产地的那几类,它们的结果
     * 直接来自 `search.query`)—— 单类档的能力知道 total 就给。
     */
    /*
     * **先问后端哪一档给得出 total**,再去屏幕上找那一行 —— 判据因此是
     * 「后端说了多少,壳就画多少」,而不是「屏幕上恰好有一行数字」。
     * 一档都给不出 total 时这一条**如实跳过并喊出来**(不是悄悄绿):
     * 那说明今天没有一个走通用路的能力答得出全集大小,那是一条读数,不是一次通过。
     */
    const genericIds = manifests
      .map(m => m.id)
      .filter(id => !['chats', 'messages', 'files'].includes(id))
    let genericTab
    let backendTotal
    for (const id of genericIds) {
      const probe = await rpc(record, 'search', 'query', { query: 'a', category: id, limit: 20 })
      console.log(`  · 后端 ${id} 档:total=${probe.total} relaxed=${probe.relaxed} 条数=${(probe.results ?? []).length}`)
      if (typeof probe.total === 'number') {
        genericTab = manifests.find(m => m.id === id)
        backendTotal = probe.total
        break
      }
    }
    if (genericTab === undefined) {
      genericTab = manifests.find(m => m.id === genericIds[0])
      console.log('  ! 今天没有一个走通用路的能力答得出 total —— 那一行因此画不出来(如实记账)')
    }
    assert(Boolean(genericTab), `有一个走通用路的档可以试:${genericTab?.id}`)
    // 点那一格 —— 名字按当前语言取(两种写法都认)。
    const genericLabel = (await readRows(page)).tabs
      .map(t => t.label)
      .find(label => labelMatches(genericTab.labelKey, label))
    assert(Boolean(genericLabel), `tab 条上找得到 ${genericTab.id} 那一格:「${genericLabel}」`)
    await selectTab(page, genericLabel)
    await typeQuery(page, 'a')
    /*
     * 等的是**答复落地**,不是「tab 变了」—— 换档是同步的,而这一档的结果要走
     * 一次真查询(还带 220ms 的合并窗口)。等 tab 就等于在结果回来之前读屏,
     * 那一读永远是空的,而断言会因此**红得没有信息量**(或者更糟:绿得没有意义)。
     */
    const generic = await waitFor('通用档的答复落地', async () => {
      const state = await readRows(page)
      const onGeneric = state.tabs.some(t => t.on && !ALL_LABELS.includes(t.label))
      if (!onGeneric) return undefined
      // 有行、或者有底部读数 —— 两者任一说明这一发已经回来了。
      return state.rows.length > 0 || Object.keys(state.readouts).length > 0 ? state : undefined
    }, 15_000)
    console.log('  · 通用档的底部读数:', JSON.stringify(generic.readouts))
    if (backendTotal !== undefined) {
      // 后端说了全集有多大 → 屏幕上必须有那一行,而且写的是**那个数**。
      assert(
        generic.readouts.total !== undefined
          && generic.readouts.total.includes(String(backendTotal)),
        `后端说 total=${backendTotal},屏幕上就画了它:「${generic.readouts.total}」`,
      )
    } else {
      /*
       * 后端答不出 total → 那一行**不许画**。缺席 = 不知道,不是 0;
       * 画一个 0 就是替能力下了一句它没下过的断言。这一条是真断言不是跳过:
       * 把「不知道就画 0」写进壳里,它当场红。
       */
      assert(
        generic.readouts.total === undefined,
        `${genericTab.id} 这一档答不出 total,那一行就没画 —— 不知道就不说`,
      )
    }

    /* ── ⑥ 放宽(真数据 or 结构)────────────────────────────────────
     * `relaxed > 0` 才画。严格档就中了的查询上它本来就不该出现。
     */
    assert(
      generic.readouts.relaxed === undefined || generic.readouts.relaxed.length > 0,
      '「已放宽」那一行要么不画,要么画的是一句真话',
    )

    /* ═══════════════════════════════════════════════════════════════════
     * [8/8] 检索重建 S4b(设计 §9 第五条 / §4.5 / §4.6 / §7.2)
     *
     * 五件事,每一件都标了它靠什么证。前四件全是**真数据**(真索引、真会话、
     * 真过滤);第五件(全部档的组来自后端 `groups`)靠**注入一个陌生能力** ——
     * 这台上注册的六个能力壳全都认得,证不出「后端多答一组屏上就多一组」。
     * ═══════════════════════════════════════════════════════════════════ */
    console.log('\n[8/8] S4b:过滤片 / 预览窗 / 范围片 / 查询历史 / 后端 groups')

    // 回到「所有」那一档,后面几步从这里起。
    const allLabel = (await readRows(page)).tabs.map(t => t.label).find(l => ALL_LABELS.includes(l))
    await selectTab(page, allLabel)

    /* ── ①-b 角色片(真数据)────────────────────────────────────────
     * 同一间会话里,`ROLE_WORD` 在**用户那句**与**助手那条**里各出现一次。
     * 挑「角色 = 用户」之后行数必须真的少一条,而且留下的那条是用户说的。
     * 反证:把 `filtersOf` 里角色那一格改成不发,这一条当场红(行数不变)。
     */
    const messagesLabel = (await readRows(page)).tabs
      .map(t => t.label)
      .find(label => labelMatches('search.capability.messages', label))
    assert(Boolean(messagesLabel), `tab 条上找得到消息那一档:「${messagesLabel}」`)
    await selectTab(page, messagesLabel)
    await typeQuery(page, ROLE_WORD)
    const bothRoles = await waitFor('用户那句与助手那条都搜得到', async () => {
      const state = await readRows(page)
      const hits = state.rows.filter(row => row.text.includes(ROLE_WORD))
      return hits.length >= 2 ? { state, hits } : undefined
    }, 20_000)
    console.log('  · 滤之前:', JSON.stringify(bothRoles.hits.map(r => r.text)))
    const roleChip = bothRoles.state.filters.find(f => f.name === 'role')
    assert(Boolean(roleChip), `消息那一档摆得出角色片(它自述里声明了 role):${JSON.stringify(bothRoles.state.filters.map(f => f.name))}`)
    await clickChip(page, 'role')
    await clickMenuItem(page, ROLE_USER_LABEL)
    const onlyUser = await waitFor('滤成「用户」之后只剩用户说的那条', async () => {
      const state = await readRows(page)
      const hits = state.rows.filter(row => row.text.includes(ROLE_WORD))
      if (hits.length === 0 || hits.length >= bothRoles.hits.length) return undefined
      return { state, hits }
    }, 20_000)
    console.log('  · 滤之后:', JSON.stringify(onlyUser.hits.map(r => r.text)))
    assert(
      onlyUser.hits.every(row => row.text.includes(USER_SENTENCE_MARK)),
      `剩下的每一条都是**用户**说的那句:${JSON.stringify(onlyUser.hits.map(r => r.text))}`,
    )
    assert(
      onlyUser.state.filters.find(f => f.name === 'role')?.on === true,
      '角色那颗片显示成「挑过了」—— 挑过与缺省一眼分得开',
    )
    // 收回缺省,后面几步从「不挑」起。
    await clickChip(page, 'role')
    await clickMenuItem(page, ROLE_ANY_LABEL)

    /* ── ②-b 空间片 + 跨空间徽(真数据)──────────────────────────────
     * C 那条会话建在另一个工作区里。默认(当前空间)它不该出现;切到「全部空间」
     * 它出现,并且带一颗跨空间徽 —— §9 原话「空间徽只在『全部空间』下画」。
     * 反证:把空间那一格改成恒不发,第一条断言当场红(默认档里就看见它了)。
     */
    await typeQuery(page, NEEDLE)
    const defaultSpace = await waitFor('默认档下 B 那条搜得到', async () => {
      const state = await readRows(page)
      return messageHitOf(state)?.origin === SESSION_B ? state : undefined
    }, 20_000)
    const messageRows = state => state.rows.filter(row => row.capability === 'messages')
    console.log('  · 默认(当前空间)那一屏的出处:', JSON.stringify(messageRows(defaultSpace).map(r => r.origin)))
    assert(
      messageRows(defaultSpace).every(row => row.origin !== SESSION_C),
      '默认(当前空间)那一档里**没有**别的空间那条会话的行',
    )
    assert(
      defaultSpace.rows.every(row => !row.tags.includes('space')),
      '默认档下一颗跨空间徽都没有(整屏,不只消息那一组)',
    )
    await clickChip(page, 'space')
    await clickMenuItem(page, SPACE_ALL_LABEL)
    const allSpaces = await waitFor('切到「全部空间」之后别的空间那条出现,并带一颗徽', async () => {
      const state = await readRows(page)
      const other = messageRows(state).find(row => row.origin === SESSION_C)
      return other && other.tags.includes('space') ? { state, other } : undefined
    }, 20_000)
    console.log('  · 别的空间那一行:', JSON.stringify(allSpaces.other))
    assert(allSpaces.other.tags.includes('space'), '别的空间那一行带「其它空间」徽')
    assert(
      messageRows(allSpaces.state).some(row => row.origin === SESSION_B),
      '本空间那条照旧在 —— 「全部」是放宽,不是换一份',
    )
    // 收回缺省。
    await clickChip(page, 'space')
    await clickMenuItem(page, SPACE_CURRENT_LABEL)

    /* ── ③-b 预览窗(真数据 + 零副作用)──────────────────────────────
     * 选中一条正文命中(键盘位默认停在第一行),预览窗要出现 `message-context`
     * 那种载荷,里面既有命中那条也有上下文那几条。
     *
     * **零副作用**是硬规矩(§4.5 ④):预览前后 `sessions.listMeta` 里那条会话
     * 逐字节相同 —— 没进会话、没改已读、没动时间戳。
     */
    await typeQuery(page, NEEDLE)
    const metaBefore = await rpc(record, 'sessions', 'listMeta', {})
    const beforeB = JSON.stringify((metaBefore.sessions ?? []).find(x => x.id === idB))
    const previewed = await waitFor('预览窗画出命中 ±2', async () => {
      const state = await readRows(page)
      return state.preview?.state === 'ready' && state.preview.kind === 'message-context'
        ? state
        : undefined
    }, 20_000)
    console.log('  · 预览窗:', JSON.stringify({
      state: previewed.preview.state,
      kind: previewed.preview.kind,
      turns: previewed.preview.turns,
    }))
    assert(
      previewed.preview.turns.includes('hit'),
      `预览里认得出哪一条是命中:${JSON.stringify(previewed.preview.turns)}`,
    )
    assert(
      previewed.preview.turns.length >= 2,
      `命中那条前后还带着上下文(±2):一共 ${previewed.preview.turns.length} 条`,
    )
    assert(
      previewed.preview.text.includes(NEEDLE),
      '预览正文里就有那个词 —— 画的是命中那一条,不是随便一条',
    )
    const metaAfter = await rpc(record, 'sessions', 'listMeta', {})
    const afterB = JSON.stringify((metaAfter.sessions ?? []).find(x => x.id === idB))
    assert(
      beforeB === afterB,
      '**零副作用**:预览前后那条会话的 meta 逐字节相同(没进会话、没改已读、没动时间戳)',
    )
    assert(
      await page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"]'))),
      '而且面板还开着 —— 预览不是一次「打开」',
    )

    /* ── ④-b 范围片(真数据)────────────────────────────────────────
     * `COMMON` 在 A 与 B 两条会话里都出现。右键一条 B 的命中 →「在此会话内搜」
     * → 屏幕上必须**只剩那一间**。这一条同时证了两件事:片真的落成了一格
     * `sessionId` 过滤,以及后端真的按它筛了。
     */
    await typeQuery(page, COMMON)
    const twoSessions = await waitFor('两间会话都有命中', async () => {
      const state = await readRows(page)
      const origins = new Set(messageRows(state).map(r => r.origin))
      return origins.has(SESSION_A) && origins.has(SESSION_B) ? state : undefined
    }, 20_000)
    console.log('  · 收范围之前的出处:', JSON.stringify(messageRows(twoSessions).map(r => r.origin)))
    const bRow = messageRows(twoSessions).find(row => row.origin === SESSION_B)
    await rightClickRow(page, bRow.index)
    await waitFor('行的动作菜单开出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[role="menu"]'))),
    )
    await clickMenuItem(page, SCOPE_IN_SESSION_LABEL)
    const scoped = await waitFor('收进那一间之后只剩它', async () => {
      const state = await readRows(page)
      if (state.filters.find(f => f.name === 'scope') === undefined) return undefined
      const origins = [...new Set(messageRows(state).map(r => r.origin))]
      return origins.length > 0 && origins.every(o => o === SESSION_B) ? { state, origins } : undefined
    }, 20_000)
    console.log('  · 收范围之后的出处:', JSON.stringify(scoped.origins))
    assert(
      scoped.origins.every(origin => origin === SESSION_B),
      `「在此会话内搜」之后屏幕上只剩那一间:${JSON.stringify(scoped.origins)}`,
    )
    assert(
      scoped.state.query === COMMON,
      `而且**词留着** —— 范围片是加一格过滤,不是换一次查询:「${scoped.state.query}」`,
    )

    /* ── ⑤-b 查询历史(真数据)──────────────────────────────────────
     * ↑ 在「输入框空着且停在第一行」那一形回上一条查询。上一条正是按范围片
     * **之前**那一步(词 = COMMON、不带范围片),所以按完之后词回来、片没了。
     */
    await typeQuery(page, '')
    await waitFor('输入框空了', async () => (await readRows(page)).query === '')
    await pressInInput(page, 'ArrowUp')
    const recalled = await waitFor('↑ 把上一条查询捞回来了', async () => {
      const state = await readRows(page)
      return state.query === COMMON ? state : undefined
    }, 8000)
    console.log('  · ↑ 之后:', JSON.stringify({ query: recalled.query, filters: recalled.filters.map(f => f.name) }))
    assert(recalled.query === COMMON, `↑ 回到了上一条查询的**词**:「${recalled.query}」`)
    assert(
      recalled.filters.find(f => f.name === 'scope') === undefined,
      '**四格一起还原**:范围片跟着回去了,不是只把词填回来',
    )

    /* ── ⑥-b 全部档的组来自后端 `groups`(**注入一个陌生能力**)──────
     * 这台上注册的六个能力壳全都认得,所以真数据证不出「后端多答一组屏上就
     * 多一组」。这里在 `search.capabilities` 与 `search.query` 两条回执上各
     * 补一格 —— 壳里**一个字都没改**,tab 条要多一格、`all` 档要多一组,
     * 而那一组的行走「缺渲染器 = 画标题行」那条路(它的 target.kind 没人认得)。
     */
    await page.addInitScript(() => {
      const real = window.fetch
      const FAKE = {
        id: 'gate-unknown',
        labelKey: 'search.capability.gateUnknown',
        icon: 'Sparkles',
        kind: 'remote',
        budget: { default: 3, timeoutMs: 300 },
        order: 99,
      }
      window.fetch = async (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : ''
        if (!body.includes('"domain":"search"')) return real(input, init)
        const response = await real(input, init)
        if (body.includes('"method":"capabilities"')) {
          const json = await response.clone().json()
          if (json?.ok && Array.isArray(json.data?.capabilities)) {
            json.data.capabilities = [...json.data.capabilities, FAKE]
            return new Response(JSON.stringify(json), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          }
          return response
        }
        if (body.includes('"method":"query"') && body.includes('"category":"all"')) {
          const json = await response.clone().json()
          if (json?.ok && Array.isArray(json.data?.groups)) {
            json.data.groups = [...json.data.groups, {
              capability: FAKE.id,
              label: FAKE.labelKey,
              total: 1,
              results: [{
                id: 'gate-unknown-1',
                type: 'plugin',
                title: '陌生能力答的那一行',
                subtitle: '来自一个壳没见过的能力',
                target: { kind: 'gate-unknown-target', payload: {} },
              }],
            }]
            return new Response(JSON.stringify(json), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          }
          return response
        }
        return response
      }
    })
    await page.reload()
    await waitFor('reload 之后渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('检索瓦回到位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-search"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板在注入之后开出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )
    const withFake = await waitFor('tab 条自己多了一格', async () => {
      const state = await readRows(page)
      // 文案键不在壳的字典里 → 画原文(判据在 capabilities.ts 的 labelTextOf)。
      return state.tabs.some(t => t.label === 'search.capability.gateUnknown') ? state : undefined
    }, 15_000)
    console.log('  · 注入之后的 tab 条:', JSON.stringify(withFake.tabs.map(t => t.label)))
    assert(
      withFake.tabs.some(t => t.label === 'search.capability.gateUnknown'),
      'tab 条按自述多了一格,而且翻不出来的文案键画的是原文(不是一格空白)',
    )
    await typeQuery(page, NEEDLE)
    const grouped2 = await waitFor('`all` 档多了那一组,并且它的行画出来了', async () => {
      const state = await readRows(page)
      const row = state.rows.find(r => r.capability === 'gate-unknown')
      return state.groups.includes('gate-unknown') && row ? { state, row } : undefined
    }, 20_000)
    console.log('  · 注入之后的组头:', JSON.stringify(grouped2.state.groups))
    assert(
      grouped2.state.groups.includes('gate-unknown'),
      `全部档的组**来自后端的 groups** —— 后端多答一组,屏上就多一组:${JSON.stringify(grouped2.state.groups)}`,
    )
    assert(
      grouped2.row.text.includes('陌生能力答的那一行'),
      '那一组的行照样画出来了 —— §4.3「绝不因为壳没跟上而把结果吞掉」',
    )
    assert(
      grouped2.row.badge === '',
      '它没有渲染器,所以是**空徽 + 标题行**(而不是整行消失)',
    )
    assert(
      grouped2.state.groupTotals['gate-unknown']?.includes('1'),
      `组头右边那格 total 是**后端说的那个数**:「${grouped2.state.groupTotals['gate-unknown']}」`,
    )

    /* ── ⑦ 读者模式行(**注入的假 status**)──────────────────────────
     * 真机上 `search.status.mode` 恒 `owner`(§5.6 拍点庚 09-04 裁「先不做」),
     * 所以这一行在真数据下永远画不出来。这里把渲染层那格 status 换成 reader,
     * 证「画它的逻辑在」—— 持有权落地那天壳一个字都不用改。
     * 「索引更新中」那一行同一手一起证(pending 真机上通常已经追平)。
     */
    /*
     * 注入走**页面加载前**那一手(`addInitScript`)+ 一次 reload,理由是链路:
     * 面板挂载时 `ensureSearchCatalog()` 问一次状态,而 `ensure` 是**幂等**的 ——
     * 问过就不会再问。所以只把 `window.fetch` 换掉再开一次面板是没用的:那一格
     * 早就有答案了。reload 把渲染层的模块状态整个清掉,注入的答复才轮得到。
     *
     * 换掉的是 `search.status` **那一发**,别的 RPC 原样放行 —— 这道门后面还要
     * 读屏,不能把整台 core 断掉。
     */
    await page.addInitScript(() => {
      const real = window.fetch
      window.fetch = async (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : ''
        if (body.includes('"domain":"search"') && body.includes('"method":"status"')) {
          return new Response(
            JSON.stringify({
              ok: true,
              data: { mode: 'reader', pending: 7, vector: 'off', owner: { host: 'gate-host', pid: 1 } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return real(input, init)
      }
    })
    await page.reload()
    await waitFor('reload 之后渲染层又完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('检索瓦回到位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-search"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板在注入之后开出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )
    const readerState = await waitFor('读者模式那两行画出来', async () => {
      const state = await readRows(page)
      return state.readouts['index-reader'] !== undefined ? state : undefined
    }, 8000)
    console.log('  · 注入 reader 之后的底部读数:', JSON.stringify(readerState.readouts))
    assert(
      readerState.readouts['index-reader'].includes('gate-host'),
      `「由 <host> 维护」画出来了:「${readerState.readouts['index-reader']}」`,
    )
    assert(
      /7/.test(readerState.readouts['index-pending'] ?? ''),
      `「索引更新中(剩 7)」画出来了:「${readerState.readouts['index-pending']}」`,
    )

    console.log(
      '\n[msg-search-gate] ok —— 助手回复里的词搜得到、徽与出处对、高亮来自后端、点了能落到那条消息;'
      + '\n                   S4a:tab 随注册表、全部档分组、每行按 target.kind 取渲染器、归档徽、'
      + '空间徽按规矩不出现、total/放宽两行按事实画、读者模式行(注入证);'
      + '\n                   S4b:全部档的组来自后端 groups(注入一个陌生能力 → 屏上多一组)、'
      + '过滤片(角色 / 全部空间 + 跨空间徽)、预览窗(命中 ±2 且零副作用)、'
      + '范围片(只剩那一间)、查询历史(↑ 回上一条)',
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
