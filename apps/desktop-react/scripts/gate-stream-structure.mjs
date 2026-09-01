#!/usr/bin/env node
/**
 * 流式**块结构**门(09-01 用户录屏报障:「用 agent 时,流式渲染中 think、table
 * 等内容会出现再消失,再出现」;09-01 二期扩到工具路径)。
 *
 * ── 它与 gate:monotone 的分工 ──────────────────────────────────────────
 * `gate:monotone` 量的是**正文总长**不回缩,素材纯正文、没有推理也没有表。这条报障
 * 恰恰落在它盖不到的两格上:
 *
 *  · 一整块思考消失时,后面的正文还在继续长 —— **总长曲线可以是单调的**;
 *  · 表格在 code ↔ table 之间来回换装,总长的涨落被别处的增长盖住。
 *
 * 所以这条门量的是**结构**:逐帧记下最后一条 assistant 消息里每一件东西的类型、
 * 位置、身份与文本,断言七条纪律。
 *
 * ── 素材 × 粒度矩阵 ────────────────────────────────────────────────────
 * 一期只有一条素材、一档粒度,而且**刻意关掉了工具**(`enableToolCalls:false`)——
 * 09-01 的勘察正是在那块空白里抓到最疼的一条病(多轮工具的正文错位再消失 992ms)。
 * 二期扩成矩阵:
 *
 *   think × {6, 2} 字/帧   推理 ↔ 正文交替 + 一张逐行长出来的表(A/B/C)
 *   tool  × {6, 2} 字/帧   三轮工具:说话 → 连查两次 → 说话 → 再查一次 → 收尾(D/E/F/G)
 *
 * 粒度是第二根轴,因为分片越细、一个块「半成形」的帧数越多:真机上 SSE 分片不等长,
 * 2 字/帧是它的下界包络。
 *
 * ── 七条断言(各自钉一条真机病)────────────────────────────────────────
 *  A. **思考块只增不减**(think)。修前:t=7441ms `[think,text,think]` →
 *     `[think,text]`,整段思考没了 2166ms 才回来。
 *  B. **思考块不搬家**(think)。钉交接的顺序闸。
 *  C. **表格成形后不再降级回 code**(think)。修前一条流里降级 17 帧。
 *  D. **工具边界的正文零消失**(tool)。修前真机逐帧:
 *     ```
 *     t=6839  think | text(14) | text(28) | tool-group   ← 第二轮正文在工具组上面
 *     t=6864  think | text(14) | tool-group | think(6)   ← 整段 28 字消失
 *     t=7856  think | text(14) | tool-group | text(28) | …  ← 992ms 后从下面回来
 *     ```
 *     病根:账本的 `message.content` 是全部正文,而 `contentParts` 只有已结算那几轮
 *     —— 交接把新一轮的正文交给了那条**turn 盲**的扁平车道(见 chat-fold 的
 *     `FoldLens.contentPlaceable`)。
 *  E. **正文不许跨过工具**(tool)。同一段正文在相邻两帧里,它前面有几个工具容器
 *     必须相等 —— D 那条病如果换个形(不消失、直接跳过去)由这条抓。
 *  F. **工具那一件东西零重挂**(tool)。修前:第二次调用到达时单卡整行替换成组卡
 *     (t=6614,DOM 不是同一个节点),违反「列表 key 稳定,禁整树重挂」。
 *     判据是 DOM 节点身份:采样器给每个节点盖一次号,同一位次的工具容器换号即红。
 *  G. **参数流式期屏幕上有东西**(tool)。修前:说完一句话之后 309ms 零呈现
 *     (`tool:input-start` t=1693ms 就到了,而屏幕要等 `tool/call` t=1929ms)。
 *
 * 每一格另有一条 **流式末帧 == 冷加载**:刷新重进会话,块序逐格相同。
 *
 * ── 三个测量坑(照抄 09-01 勘察的记录,别再踩一遍)──────────────────────
 *  1. 非前缀率若拿整条消息的 textContent 量会是 22–24%,其中 98% 是消息尾那行
 *     `Generating · N.Ns` **在跳秒**。所以可见文本只由采到的那几件东西拼,读数行
 *     根本不在采样口径里。
 *  2. 只挡 `chat-thought / data-block-kind / data-tool-group` 三种祖先会把 flow 块
 *     **自己带的** `data-prose` 重复计一遍(`<blockquote data-prose>` 里的 `<p>`),
 *     凭空多出几百次「换型」。判据必须是「身上有任何 `data-prose` 祖先的都不算一件
 *     东西」。
 *  3. 帧间身份**不能用文本头字认**:markdown 成形时块内文本会合法地非前缀变化
 *     (字面 `1.` → 生成序号、檐从 `Copy source` → `Copy Markdown`)。必须按节奏档
 *     做 LCS 对齐 —— 插入不算搬家,成长不算消失。
 *
 * 跑法:`node scripts/gate-stream-structure.mjs [--only=think|tool]`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每格一个全新的临时 store,跑完删干净;起的进程在 finally 里逐个收尸。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ── 素材一:推理 ↔ 正文交替 + 一张表 ─────────────────────────────────── */

const THINK_1 =
  '先看清楚要做什么。素材里既有思考也有正文,还有一张表。要量的是:思考段在打包行到达的那一刻会不会从屏幕上消失。这一段要写得足够长,长到跨过两秒那道打包闸,不然打包行根本不会来。再补几句凑长度,让这一段思考至少两百个字符往上,确保它自己就吃掉一整个打包窗。'
const TEXT_1 = '先说结论:这条链路是通的。下面按步骤展开,每一步都给出可以复核的读数。'
const THINK_2 =
  '第二段思考。它开在正文之后,所以是**行内推理**而不是顶部推理 —— 落点不同,尾巴里的去处也不同。行内推理在流式期间没有物化成 part,打包行若把它从尾巴前端裁走,屏幕上就没有第二个产地。这正是 A 条要钉的那件事。再写长一点,凑过打包闸。'
/*
 * 表**故意长**(12 行往上,400 字符往上)。
 *
 * 打包闸是「段收尾 / 64 条 delta / 2000ms 三者先到」,6 字/帧时 2000ms ≈ 264 字符
 * —— 表短于这个数就可能整张被一条打包行一口吃掉,量不到「表流到一半账本先物化」
 * 那一刻。而 09-01 用户报的那条正是这一刻:**「显示原始字符串,其实 table 已经
 * 画出来了」——渲染出来的表与它的原始 markdown 同屏并存**。
 *
 * 每一行埋一个只出现一次的记号(`TK*`),H 条数它在一帧里出现几次:**同一截源文本
 * 任一时刻只许被画一次**(要么是表,要么是原文,不许并存)。
 */
const TEXT_2 = [
  '',
  '| 项 | 状态 | 备注 |',
  '| --- | --- | --- |',
  '| 传输 | 真 | TKA1 POST /api/rpc |',
  '| 账本 | 真 | TKB2 events.jsonl |',
  '| 表格 | 真 | TKC3 需要整行结构才成形 |',
  '| 归档 | 真 | TKD4 冷加载走全量解析 |',
  '| 校验 | 真 | TKE5 增量必须等于全量 |',
  '| 交接 | 真 | TKF6 账本画得出来多少就交多少 |',
  '| 锚点 | 真 | TKG7 工具卡插在它发生的那处 |',
  '| 节拍 | 真 | TKH8 十六毫秒一批 |',
  '| 打包 | 真 | TKI9 两秒一道闸 |',
  '| 重折 | 真 | TKJ10 缺号就整会话重折 |',
  '| 尾巴 | 真 | TKK11 还没进打包行的那一截 |',
  '| 冷热 | 真 | TKL12 两条路必须逐格相同 |',
  '',
  '表格上面一段 TKM13,表格下面一段 TKN14 —— 中间那张表在流式期间要逐行长出来。',
].join('\n')
const THINK_3 =
  '第三段思考,继续往后拖时间,让整条流跨过又一道打包闸。写满两百字以上,确保每一段都各自经历一次打包行到达。这里再补一些字,把长度垫够,免得整段被一次打包行一口吃掉,那样就量不到交接的那一刻了。'
const TEXT_3 = '最后一段正文收尾,`行内代码` 与 **加粗**,把这条流收干净。'

const THINK_SCRIPT = [
  ['reasoning', THINK_1],
  ['content', TEXT_1],
  ['reasoning', THINK_2],
  ['content', TEXT_2],
  ['reasoning', THINK_3],
  ['content', TEXT_3],
]

/* ── 素材二:三轮工具 ──────────────────────────────────────────────────
 *
 * 选 `time` 是因为它零副作用、必然回来,不会卡在权限审批上(卡住的话探针只会超时)。
 * 参数**故意写长**(一个 40 字往上的 JSON):要量的正是「参数逐片到达的那一段时间里
 * 屏幕上有没有东西」(G),短参数量不出来。
 *
 * **不放表格、不放围栏**:markdown 起手式先以字面上屏、成形时换装,那是另一档已知
 * 的「合法但可见」(勘察 §2.4/§2.5,属行为裁定未拍板)。混进来只会让 D 那条断言分不清
 * 是「工具边界丢了正文」还是「表格正在成形」—— 一条断言只钉一件事。
 */
const TOOL_TURNS = {
  1: async ({ say, callTool, finish }) => {
    await say('reasoning', '先想一下要做什么。这一段推理要长一点,跨过两秒那道打包闸:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥,天地玄黄宇宙洪荒日月盈昃辰宿列张。想完之后我要连着查两次时间,一次上海一次协调世界时。')
    await say('content', '我先查一下时间,连着查两次。\n')
    await callTool(0, 'call_a', 'time', '{"action":"now","timezone":"Asia/Shanghai","format":"iso8601"}')
    await callTool(1, 'call_b', 'time', '{"action":"now","timezone":"UTC","format":"iso8601"}')
    finish('tool_calls')
  },
  2: async ({ say, callTool, finish }) => {
    // ★ 这一段就是修前消失 992ms 的那一段:第二轮的正文,前面是工具、后面还是工具。
    // TKT1 埋在这里:它走的正是新开的那条「账本 parts 画不到、由 content 补出来」
    // 的车道 —— 补出来的那一截若与尾巴里那一截重叠,记号会在一帧里出现两次(H)。
    await say('content', '\n拿到了 TKT1。下面这段正文夹在两次工具之间,要看它落在哪一边。\n')
    await say('reasoning', '工具结果回来之后的一段行内推理。它前面是工具、后面还是工具,正是「工具与正文、推理夹杂」那一格。再补些字跨过打包闸:云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜。')
    await callTool(0, 'call_c', 'time', '{"action":"now","timezone":"America/New_York","format":"iso8601"}')
    finish('tool_calls')
  },
  3: async ({ say, finish }) => {
    await say('content', '\n三次时间都拿到了,收尾一句 `行内代码` 把这条流收干净。上面那段正文要一直待在两组工具之间,一帧都不许走开。\n')
    finish('stop')
  },
}

/**
 * 每条素材里**只出现一次**的记号 —— H 条(零双画)数的就是它们。
 *
 * 判据一句话:**同一截源文本,任一时刻只许被画一次**。渲染出来的表里有 `TKA1`,
 * 它的原始 markdown 里也有 `TKA1` —— 两者同屏就是一帧里数到 2。
 */
const TOKENS = {
  think: [
    'TKA1', 'TKB2', 'TKC3', 'TKD4', 'TKE5', 'TKF6',
    'TKG7', 'TKH8', 'TKI9', 'TKJ10', 'TKK11', 'TKL12', 'TKM13', 'TKN14',
  ],
  tool: ['TKT1'],
}

const CASES = {
  think: { tools: false, pieces: [6, 2] },
  tool: { tools: true, pieces: [6, 2] },
}

const TRIGGER = 'STREAM_STRUCTURE_GATE'
const PIECE_DELAY_MS = 45

/* ── 假慢流 provider ──────────────────────────────────────────────────── */

/** 当前这一格的分片粒度 —— 同一个 mock 服务两格(省一次 electron 冷启)。 */
const mockState = { piece: 6, tools: false }
const pieces = text => text.match(new RegExp(`[\\s\\S]{1,${mockState.piece}}`, 'g')) ?? []

function startMockProvider(port) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const flat = (Array.isArray(payload.messages) ? payload.messages : [])
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
        .join('\n')
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = obj => {
        if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-structure',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-reasoner',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const done = () => { res.write('data: [DONE]\n\n'); res.end() }
      if (!flat.includes(TRIGGER)) {
        send(frame({ content: 'ok' }))
        send(frame({}, 'stop'))
        done()
        return
      }
      const say = async (kind, text) => {
        for (const piece of pieces(text)) {
          if (res.destroyed) return
          send(frame(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece }))
          await delay(PIECE_DELAY_MS)
        }
      }
      if (mockState.tools) {
        // 第几轮由**已经回来了几条 tool 消息**决定 —— 与真实 agent-loop 同一条口径。
        const turn = (payload.messages ?? []).filter(m => m.role === 'tool').length === 0
          ? 1
          : (payload.messages ?? []).filter(m => m.role === 'tool').length <= 2 ? 2 : 3
        const callTool = async (index, id, name, args) => {
          send(frame({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }))
          await delay(PIECE_DELAY_MS)
          for (const piece of pieces(args)) {
            if (res.destroyed) return
            send(frame({ tool_calls: [{ index, function: { arguments: piece } }] }))
            await delay(PIECE_DELAY_MS)
          }
        }
        await TOOL_TURNS[turn]({ say, callTool, finish: reason => send(frame({}, reason)) })
        done()
        return
      }
      for (const [kind, text] of THINK_SCRIPT) {
        for (const piece of pieces(text)) {
          if (res.destroyed) return
          send(frame(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece }))
          await delay(PIECE_DELAY_MS)
        }
      }
      send(frame({}, 'stop'))
      done()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/* ── 支架(照 gate-stream-monotone.mjs)──────────────────────────────────── */

function readDiscovery(store) {
  try { return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8')) } catch { return undefined }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}
async function waitFor(label, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(120)
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
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}
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
 * rAF 采样器:逐帧记**最后一条 assistant 消息的结构**。
 *
 * 一件东西 = 一个思考块 / 一个正文块 / 一件工具(单卡或组)。三条判据:
 *  · **身上有任何 `data-prose` 祖先的都不是一件东西**(测量坑 2);
 *  · 每件记 `k`(节奏档,LCS 对齐认的就是它)、`d`(真身:块 kind / 工具状态 /
 *    tool-group)、`n`(文本长度)、`h`(头 40 字,只用来在报错里指认,不作身份);
 *  · **`id` 是 DOM 节点身份**:第一次见到就在节点上盖一个号,换了节点就是换了号
 *    —— F 条(零重挂)靠它,别的判据都看不出「同一个位置换了个节点」。
 *
 * 可见文本(`full`)由这几件拼,**不取整条消息的 textContent**:消息尾那行
 * `Generating · N.Ns` 在跳秒,拿整条量出来的非前缀率 98% 是它(测量坑 1)。
 */
function installSampler(page, tokens) {
  return page.evaluate((marks) => {
    const baseline = document.querySelectorAll('[data-message-id][data-role="assistant"]').length
    window.__struct = { frames: [], done: false, baseline, seenReadout: false }
    /**
     * 一帧里每个记号出现了几次(H 条:零双画)。
     *
     * 数的是**整条消息的 textContent**,不是采到的那几件东西 —— 双画的两份可能
     * 一份在块里、一份在别处,按件数会漏。读数行(`Generating · N.Ns`)里不含记号,
     * 所以那条跳秒的读数在这一路上无害(测量坑 1 只针对前缀比对)。
     */
    const countMarks = text => {
      const out = []
      for (const mark of marks) {
        let n = 0
        let at = text.indexOf(mark)
        while (at >= 0) { n += 1; at = text.indexOf(mark, at + mark.length) }
        out.push(n)
      }
      return out
    }
    let nodeSeq = 0
    const shapeOf = el => {
      const out = []
      for (const node of el.querySelectorAll('[data-prose],[data-tool-status],[data-tool-group]')) {
        if (node.parentElement?.closest('[data-prose]')) continue
        if (node.parentElement?.closest('[data-testid="chat-thought"]')) continue
        if (node.parentElement?.closest('[data-block-kind]')) continue
        if (node.parentElement?.closest('[data-tool-group]')) continue
        const toolStatus = node.getAttribute('data-tool-status')
        const isTool = Boolean(toolStatus) || node.hasAttribute('data-tool-group')
        if (!node.__structId) node.__structId = ++nodeSeq
        const text = node.textContent ?? ''
        out.push({
          // 节奏档:工具那两种形(单卡 / 组)**归同一档** —— 它们是同一件东西的
          // 两种长相,分档的话「单卡变成组」会被 LCS 当成一件消失 + 一件插入。
          k: isTool
            ? 'tool'
            : (node.getAttribute('data-testid') === 'chat-thought' ? 'think' : node.getAttribute('data-prose')),
          d: node.getAttribute('data-block-kind')
            ?? (node.hasAttribute('data-tool-group') ? 'tool-group' : undefined)
            ?? toolStatus
            ?? node.tagName.toLowerCase(),
          // 组里那几行各自的状态 —— G 条(参数流式期有呈现)读它。
          st: isTool
            ? Array.from(node.querySelectorAll('[data-tool-status]'))
                .map(row => row.getAttribute('data-tool-status'))
                .concat(toolStatus ? [toolStatus] : [])
                .join(',')
            : '',
          n: text.length,
          h: text.slice(0, 40).replace(/\s+/g, ' '),
          id: node.__structId,
        })
      }
      return out
    }
    const tick = () => {
      const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
      const art = rows.length > baseline ? rows[rows.length - 1] : undefined
      if (document.querySelector('[data-testid="chat-readout"]')) window.__struct.seenReadout = true
      if (art) {
        window.__struct.frames.push({
          t: Math.round(performance.now()),
          s: shapeOf(art),
          m: countMarks(art.textContent ?? ''),
        })
      }
      if (!window.__struct.done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, tokens)
}

/** 屏幕上那条消息此刻的块序(冷加载对照用,与采样器同一套判据)。 */
function readShape(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
    const art = rows[rows.length - 1]
    if (!art) return '(没有 assistant 消息)'
    const out = []
    for (const node of art.querySelectorAll('[data-prose],[data-tool-status],[data-tool-group]')) {
      if (node.parentElement?.closest('[data-prose]')) continue
      if (node.parentElement?.closest('[data-testid="chat-thought"]')) continue
      if (node.parentElement?.closest('[data-block-kind]')) continue
      if (node.parentElement?.closest('[data-tool-group]')) continue
      const status = node.getAttribute('data-tool-status')
      const isTool = Boolean(status) || node.hasAttribute('data-tool-group')
      const k = isTool
        ? 'tool'
        : (node.getAttribute('data-testid') === 'chat-thought' ? 'think' : node.getAttribute('data-prose'))
      const d = node.getAttribute('data-block-kind')
        ?? (node.hasAttribute('data-tool-group') ? 'tool-group' : undefined)
        ?? status
        ?? node.tagName.toLowerCase()
      out.push(`${k}:${d}`)
    }
    return out.join(' | ')
  })
}

/* ── 分析器 ────────────────────────────────────────────────────────────
 *
 * 帧间身份靠**对齐**,不靠头字(测量坑 3)。流是只追加的,所以"同一件东西"= 同一个
 * 节奏档;LCS 对齐之后,插入不再被误判成搬家、成长不再被误判成消失。
 */

function alignByKind(A, B) {
  const n = A.length
  const m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i].k === B[j].k ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs = []
  const delA = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i].k === B[j].k) { pairs.push([i, j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) delA.push(i++)
    else j++
  }
  while (i < n) delA.push(i++)
  return { pairs, delA }
}

/** 一件东西前面有几个工具容器 —— E 条(正文不许跨过工具)的坐标。 */
const toolsBefore = (frame, index) => frame.slice(0, index).filter(item => item.k === 'tool').length

function analyse(frames) {
  const out = { vanishText: [], crossed: [], toolRemount: [], sawInputStreaming: false, toolFrames: 0 }
  for (let f = 1; f < frames.length; f++) {
    const A = frames[f - 1].s
    const B = frames[f].s
    const { pairs, delA } = alignByKind(A, B)
    for (const i of delA) {
      if (A[i].k === 'text' && A[i].n > 0) {
        out.vanishText.push({ t: frames[f].t, d: A[i].d, n: A[i].n, h: A[i].h.slice(0, 22) })
      }
    }
    for (const [i, j] of pairs) {
      if (A[i].k !== 'text') continue
      const was = toolsBefore(A, i)
      const now = toolsBefore(B, j)
      if (was !== now) out.crossed.push({ t: frames[f].t, was, now, h: A[i].h.slice(0, 22) })
    }
    // F:同一位次的工具容器换了 DOM 节点 = 那一行被卸载重挂。
    const toolsA = A.filter(item => item.k === 'tool')
    const toolsB = B.filter(item => item.k === 'tool')
    for (let x = 0; x < Math.min(toolsA.length, toolsB.length); x++) {
      if (toolsA[x].id !== toolsB[x].id) {
        out.toolRemount.push({ t: frames[f].t, at: x, was: toolsA[x].d, now: toolsB[x].d })
      }
    }
  }
  for (const frame of frames) {
    const tools = frame.s.filter(item => item.k === 'tool')
    if (tools.length > 0) out.toolFrames += 1
    if (tools.some(item => (item.st ?? '').includes('input-streaming'))) out.sawInputStreaming = true
  }
  return out
}

/**
 * H:**零双画** —— 同一截源文本任一时刻只被画一次。
 *
 * 09-01 用户真机证词:「markdown 的渲染很奇怪,它会显示原始字符串,其实 table 已经
 * 画出来了」。那是同一截内容被画了两遍(一份成了表,一份还是原始 markdown),
 * 病灶落在交接线上:账本画了一份、尾巴又画了一份,而两条车道的记账对不上。
 *
 * 判据不看形态、只数记号:素材里每个 `TK*` 只出现一次,屏幕上它就只许出现一次。
 * 一帧里数到 2 就是双画 —— 不管那两份长成表还是长成原文。
 */
function findDoubleDrawn(frames, tokens) {
  const out = []
  for (const frame of frames) {
    (frame.m ?? []).forEach((count, index) => {
      if (count > 1) out.push({ t: frame.t, token: tokens[index], count })
    })
  }
  return out
}

/** A:思考块的条数只增不减。 */
function findThinkVanished(frames) {
  const out = []
  for (let i = 1; i < frames.length; i += 1) {
    const before = frames[i - 1].s.filter(b => b.k === 'think').length
    const after = frames[i].s.filter(b => b.k === 'think').length
    if (after < before) out.push({ i, t: frames[i].t, before, after })
  }
  return out
}

/** B:同一块思考(按头 40 字认)在相邻两帧里的位置序号不许变。 */
function findThinkMoved(frames) {
  const out = []
  let prev
  for (const frame of frames) {
    const pos = new Map()
    frame.s.forEach((block, index) => { if (block.k === 'think') pos.set(block.h, index) })
    if (prev) {
      for (const [head, index] of pos) {
        const was = prev.get(head)
        if (was !== undefined && was !== index) out.push({ t: frame.t, head, was, now: index })
      }
    }
    prev = pos
  }
  return out
}

/**
 * C:表格成形之后不再降级回 code。
 *
 * 判据读**块的檐**:表格檐是「Copy Markdown / Copy CSV」,代码檐是「Copy source」
 * —— 两者都是块壳画上去的第一段文字,所以块的 textContent 开头就说得出它此刻是谁。
 */
function findTableDowngrades(frames) {
  const out = []
  let formed = false
  for (const frame of frames) {
    for (const block of frame.s) {
      if (block.k !== 'object') continue
      if (block.h.startsWith('Copy Markdown')) formed = true
      else if (formed && block.h.startsWith('Copy source')) out.push({ t: frame.t, head: block.h })
    }
  }
  return out
}

/* ── 一格 ──────────────────────────────────────────────────────────────── */

async function runCell({ record, page, kind, piece, index }) {
  mockState.piece = piece
  console.log(`\n── ${kind} @ ${piece} 字/帧 ────────────────────────────────`)
  const made = await rpc(record, 'sessions', 'create', { name: `结构门 ${kind}-${piece}` })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
  await clickTestId(page, 'dock-tile-sessions')
  await waitFor('总览画出那张卡', () =>
    page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
  )
  await clickTestId(page, `card-${sessionId}`)
  await waitFor('聊天区就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
  )

  await installSampler(page, TOKENS[kind] ?? [])
  await rpc(record, 'session-command', 'emit', {
    sessionId,
    command: { type: 'command:send-message', content: `${TRIGGER} 请开始`, suppressTitleGeneration: true },
  })
  await waitFor('assistant 完稿', async () => {
    const state = await page.evaluate(() => ({
      readout: Boolean(document.querySelector('[data-testid="chat-readout"]')),
      seen: window.__struct?.seenReadout ?? false,
      n: window.__struct?.frames.length ?? 0,
    }))
    return state.seen && !state.readout && state.n > 50 ? state : undefined
  }, 180_000)
  await delay(400)
  const frames = await page.evaluate(() => { window.__struct.done = true; return window.__struct.frames })
  const liveShape = await readShape(page)

  /*
   * **流式落定 vs 冷加载**:同一条消息,刷一次页面再读一遍结构。流式那条路
   * (账本 + 活尾巴 + 增量解析)与冷加载那条路(全量 parseFrame)如果给出不同的
   * 块序,那就是「屏幕上看到的」与「刷新后看到的」分叉。
   */
  await page.reload()
  await waitFor('刷新后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
  )
  await clickTestId(page, 'dock-tile-sessions')
  await waitFor('刷新后总览画出那张卡', () =>
    page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
  )
  await clickTestId(page, `card-${sessionId}`)
  await waitFor('刷新后那条 assistant 消息回来', () =>
    page.evaluate(() => document.querySelectorAll('[data-message-id][data-role="assistant"]').length > 0),
  )
  await delay(2500)
  const coldShape = await readShape(page)

  console.log(`  采到 ${frames.length} 帧`)
  console.log(`  流式末帧 : ${liveShape}`)
  console.log(`  冷加载   : ${coldShape}`)
  assert(frames.length > 100, `采到 ${frames.length} 帧结构读数`)
  assert(liveShape === coldShape, '流式末帧与冷加载逐格相同')

  const marks = TOKENS[kind] ?? []
  const doubled = findDoubleDrawn(frames, marks)
  if (doubled.length > 0) {
    const shown = doubled.slice(0, 5).map(d => `t=${d.t}ms「${d.token}」×${d.count}`).join(' · ')
    throw new Error(
      `断言失败:H 同一截源文本被画了两遍,共 ${doubled.length} 帧(${shown})` +
      '\n  —— 用户证词的形:「显示原始字符串,其实 table 已经画出来了」',
    )
  }
  const seen = marks.filter((_, index) => frames.some(frame => (frame.m ?? [])[index] > 0)).length
  assert(
    seen === marks.length,
    `H 零双画(${marks.length} 个记号全程各只画一次;${seen}/${marks.length} 个真的上过屏)`,
  )

  const stat = analyse(frames)
  if (kind === 'think') {
    const finalThinks = frames[frames.length - 1].s.filter(b => b.k === 'think').length
    assert(finalThinks >= 3, `完稿时屏幕上有 ${finalThinks} 个思考块(素材给了 3 段)`)
    assert(frames[frames.length - 1].s.some(b => b.k === 'object'), '完稿时那张表在屏幕上')

    const vanished = findThinkVanished(frames)
    if (vanished.length > 0) {
      const shown = vanished.slice(0, 5).map(v => `t=${v.t}ms ${v.before}→${v.after}`).join(' · ')
      throw new Error(`断言失败:A 思考块消失了 ${vanished.length} 次(${shown})`)
    }
    assert(true, `A 思考块全程只增不减(${frames.length} 帧零消失)`)

    const moved = findThinkMoved(frames)
    if (moved.length > 0) {
      const shown = moved.slice(0, 5).map(m => `t=${m.t}ms「${m.head}」${m.was}→${m.now}`).join(' · ')
      throw new Error(`断言失败:B 思考块搬家 ${moved.length} 次(${shown})`)
    }
    assert(true, 'B 思考块全程不搬家(位置序号一帧都没变过)')

    const downgrades = findTableDowngrades(frames)
    if (downgrades.length > 0) {
      throw new Error(
        `断言失败:C 表格成形后又降级回 code,共 ${downgrades.length} 帧(首次 t=${downgrades[0].t}ms)`,
      )
    }
    assert(true, 'C 表格成形后再没降级回 code(单向闸)')
    return
  }

  // ── 工具那一路(D/E/F/G)────────────────────────────────────────────
  const finalTools = frames[frames.length - 1].s.filter(b => b.k === 'tool').length
  assert(finalTools >= 2, `完稿时屏幕上有 ${finalTools} 件工具(素材给了两组:两连发 + 一次)`)
  assert(
    frames[frames.length - 1].s.filter(b => b.k === 'text').length >= 3,
    '完稿时三轮正文都在屏幕上',
  )

  if (stat.vanishText.length > 0) {
    const shown = stat.vanishText.slice(0, 5).map(v => `t=${v.t}ms 「${v.h}」(${v.n} 字)`).join(' · ')
    throw new Error(`断言失败:D 工具边界上有正文整块消失 ${stat.vanishText.length} 次(${shown})`)
  }
  assert(true, `D 工具边界正文零消失(${frames.length} 帧,LCS 对齐后)`)

  if (stat.crossed.length > 0) {
    const shown = stat.crossed.slice(0, 5).map(c => `t=${c.t}ms 「${c.h}」工具数 ${c.was}→${c.now}`).join(' · ')
    throw new Error(`断言失败:E 正文跨过了工具 ${stat.crossed.length} 次(${shown})`)
  }
  assert(true, 'E 正文一次都没跨过工具(它前面有几件工具,逐帧不变)')

  if (stat.toolRemount.length > 0) {
    const shown = stat.toolRemount.slice(0, 5).map(r => `t=${r.t}ms 第${r.at + 1}件 ${r.was}→${r.now}`).join(' · ')
    throw new Error(`断言失败:F 工具那一件东西被卸载重挂 ${stat.toolRemount.length} 次(${shown})`)
  }
  assert(true, `F 工具零重挂(${stat.toolFrames} 帧里工具容器始终是同一个 DOM 节点)`)

  assert(stat.sawInputStreaming, 'G 参数逐片到达的那一段时间里,屏幕上有一行在等(input-streaming)')
  void index
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

async function runCase(kind) {
  const spec = CASES[kind]
  const store = await mkdtemp(path.join(tmpdir(), `structure-gate-${kind}-`))
  const mockPort = 18800 + Math.floor(Math.random() * 200)
  let mock
  let server
  let app
  try {
    mockState.tools = spec.tools
    mock = await startMockProvider(mockPort)
    // 钥匙走环境变量(headless core 没有 safeStorage,理由见 gate-stream-monotone.mjs)。
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: {
        provider: 'deepseek',
        temperature: 0.6,
        providers: {
          deepseek: {
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            model: 'deepseek-reasoner',
            selectedModels: ['deepseek-reasoner'],
            enabled: true,
            modelCapabilitiesByModel: {
              'deepseek-reasoner': { tools: spec.tools, reasoning: true, vision: false },
            },
          },
        },
        customProviders: [],
        modelCatalog: {},
      },
      tools: { enableToolCalls: spec.tools },
    }))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-structure-gate' },
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
    assert(await portConnects(record.host, record.port), `[${kind}] core 端口 ${record.port} 可连`)

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
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )

    // 同一台应用跑完这条素材的全部粒度 —— 每格一条新会话,省掉冷启的那几秒。
    for (const [index, piece] of spec.pieces.entries()) {
      await runCell({ record, page, kind, piece, index })
    }

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    if (mock) mock.close()
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[structure-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[structure-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }
  const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
  // `--pieces=6` 只跑矩阵的一列。**门自己永远跑满矩阵**(CI 不传参),这个口是给
  // 反证用的:拆掉一条修法之后要快速看它红在哪一格,不必等满矩阵跑完。
  const pieces = process.argv.find(a => a.startsWith('--pieces='))?.slice(9)
  const kinds = only ? only.split(',') : Object.keys(CASES)
  for (const kind of kinds) {
    if (!CASES[kind]) throw new Error(`没有这条素材:${kind}(有的是 ${Object.keys(CASES).join(' / ')})`)
    if (pieces) CASES[kind].pieces = pieces.split(',').map(Number)
    await runCase(kind)
  }
  console.log('\n[structure-gate] ok —— 思考块不消失不搬家、表格不回退;工具边界正文不消失不跨界、工具行不重挂、参数流式期有呈现')
}

main().catch(error => {
  console.error('\n[structure-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
