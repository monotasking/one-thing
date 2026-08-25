#!/usr/bin/env node
/**
 * 影子场景矩阵(S1b,`docs/design/session-event-sourcing-2026-08.md` §10.13/§10.14)。
 *
 *   bun run sessions:shadow-battery [--passes N] [--seed S] [--concurrency C]
 *                                   [--min-runs N] [--keep-store] [--only name,name]
 *                                   [--no-build]
 *
 * 门原来是「真机 runs ≥ 200 ∧ mismatch = 0」,全靠人肉聊天攒量:慢,而且每修一次
 * 投影就要重攒一遍。这个脚本把它变成**可重复的自证**:
 *
 *   起真 server(`dist/server/main.js`,不是测试替身)+ 假 provider
 *     → 在一个**临时 store** 上按场景表驱动**真引擎**
 *     → 每个 run 收尾时影子断言照常跑(`ONETHING_SESSION_SHADOW=1`)
 *     → 最后 `sessions:shadow-report --min-runs 200` 当门。
 *
 * 三条纪律:
 *  1. **不碰真实 store**:全程 `ONETHING_STORE_PATH=<临时目录>`,收尾删掉。
 *  2. **不掷不带种子的骰子**:变体只由 `--seed` 决定(默认 1),同一个种子跑出
 *     同一批文本与时序 —— 红了要能原样复现。
 *  3. **假 provider 零成本**:所有回答都是本地 SSE,一个 token 都不花。
 *
 * 已修的每一类失配都固化成至少一个场景(映射表在运行结束时打印,与
 * §10.14 的表逐条对应)。
 *
 * **四条泳道 + 两枚探针**(S3w-1 起两条,批 3 起三条,批 4 起四条,§15.10/§15.11):
 *  1. **场景矩阵** —— 按场景表 × passes 写会话(上面那条链);
 *  2/3. **冷加载补水**(`runHydrateLane`)—— 各把 server 换成一个**空 LRU 的新
 *     进程**,在(彼此不相交的)一批会话上各接一轮:冷加载真的走一遍,补水形状
 *     漂一格,收尾的影子当场红。两条分别跑**默认档**(批 3 起 = `projection`)与
 *     **显式回滚档**(`ONETHING_SESSION_HYDRATE=messages`)——回滚杆也要一直被测着;
 *  4. **停写**(`runTranscriptOffLane`)—— `ONETHING_SESSION_TRANSCRIPT=off` 下把
 *     全场景再跑一遍:抄本一个字节都不写,产品行为只能靠事件账本活着。判据除了
 *     场景自证与 0 新失配行,还多一条只有这条泳道有的:**`messages.jsonl` 不许长**。
 *
 * 两枚探针(`runWriteFailureProbe`,§14.6 裁定 7)在**各自的 store** 上把会话的
 * `events.jsonl` chmod 成只读,看 `off` 与 `shadow` 两档答得一不一样:前者命令
 * 报错、后者只计数。它们故意制造 `appendFailures`,所以绝不能跑在主 store 上。
 *
 * 门另外多了一条(§14.3-B):`session-shadow.jsonl` 里 `kind:'refold'` 的行
 * ——`events.jsonl` 文件字节重折 vs 内存活投影 —— 与语义层那两类一样,一行都不许有。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = path.join(REPO, 'dist/server/main.js')

// ============================================================ 参数

function parseArgs(argv) {
  const args = {
    passes: 0,
    seed: 1,
    concurrency: 4,
    minRuns: 200,
    keepStore: false,
    only: undefined,
    noBuild: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i]
    if (arg === '--passes') args.passes = Number(value())
    else if (arg === '--seed') args.seed = Number(value())
    else if (arg === '--concurrency') args.concurrency = Number(value())
    else if (arg === '--min-runs') args.minRuns = Number(value())
    else if (arg === '--keep-store') args.keepStore = true
    else if (arg === '--no-build') args.noBuild = true
    else if (arg === '--only') args.only = new Set(String(value()).split(',').map(s => s.trim()).filter(Boolean))
  }
  return args
}

const ARGS = parseArgs(process.argv.slice(2))

// ============================================================ 带种子的随机

/** mulberry32 —— 32 位、无依赖、可复现。全脚本**唯一**的随机源。 */
function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  '目录', '需求', '状态', '文档', '索引', '上线', '归档', '流程', '接口', '脚本',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
]

/** 变体:同一个场景的第 k 次,文本长度与时延都跟着种子走。 */
function makeVariant(rng, pass) {
  const words = 2 + Math.floor(rng() * 14)
  const chunks = 1 + Math.floor(rng() * 4)
  const body = Array.from({ length: words }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(' ')
  return {
    pass,
    body,
    chunks,
    // 20–120ms 的首字节延迟:既像真的,又不拖慢矩阵。
    firstByteMs: 20 + Math.floor(rng() * 100),
    perChunkMs: Math.floor(rng() * 12),
    tag: `p${pass}`,
  }
}

/** 把一段文本切成 n 块(至少 1 块,不产出空块)。 */
function splitInto(text, n) {
  if (n <= 1 || text.length <= n) return [text]
  const size = Math.ceil(text.length / n)
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

// ============================================================ 假 provider

/** 变体是 base64url —— 字符集必须带上 `-` 与 `_`,否则一半的变体认不出来。 */
const MARKER = /@@bat:([a-z0-9-]+):([A-Za-z0-9_-]+)@@/i

/** SSE 帧的小 DSL —— 场景脚本产出的就是这些。 */
const F = {
  sleep: ms => ({ kind: 'sleep', ms }),
  reasoning: text => ({ kind: 'delta', delta: { reasoning_content: text } }),
  text: text => ({ kind: 'delta', delta: { content: text } }),
  toolStart: (id, name) => ({
    kind: 'delta',
    delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] },
  }),
  toolArgs: chunk => ({
    kind: 'delta',
    delta: { tool_calls: [{ index: 0, function: { arguments: chunk } }] },
  }),
  /** 一次完整的工具调用(参数流式到达,与真机同形)。 */
  tool: (id, name, args, pieces = 2) => [
    F.toolStart(id, name),
    ...splitInto(JSON.stringify(args), pieces).map(F.toolArgs),
  ],
  stop: (usage) => ({ kind: 'finish', reason: 'stop', usage }),
  callTools: (usage) => ({ kind: 'finish', reason: 'tool_calls', usage }),
}

function usageOf(variant, turn) {
  return {
    prompt_tokens: 1000 + variant.body.length + turn * 37,
    completion_tokens: 20 + variant.body.length,
    total_tokens: 1020 + variant.body.length * 2 + turn * 37,
  }
}

/**
 * 假 provider:一个 OpenAI 兼容的 `/v1/chat/completions`。
 *
 * 轮次由**请求体自己**决定(数 role==='tool' 的消息),不数全局请求数 ——
 * 同一个 store 上还有别的消费者(压缩摘要、标题)会打到这里来。
 */
function startMockProvider(port, scenariosByName) {
  const server = http.createServer((req, res) => {
    // 生图走的是 provider 的 image REST API,不是 SSE 聊天口。矩阵里它**必然
    // 失败**(这里就是那格场景要的东西:`image-generation-failure`)——
    // 明确回一个错误体,而不是让 JSON 解析在 SSE 上炸出一句随机的话。
    if (String(req.url ?? '').includes('/images/generations')) {
      req.resume()
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'battery: image API unavailable' } }))
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const flat = messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n')
      const isCompactSummary = flat.includes('context summarization assistant')
        || String(messages[0]?.content ?? '').includes('context summarization assistant')

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      const send = obj => {
        if (res.writableEnded || res.destroyed) return false
        return res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finishReason = null, usage) => ({
        id: 'chatcmpl-bat',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      })

      const write = async frames => {
        for (const item of frames) {
          if (res.destroyed) return
          if (Array.isArray(item)) { await write(item); continue }
          if (item.kind === 'sleep') { await sleep(item.ms); continue }
          if (item.kind === 'delta') { send(frame(item.delta)); continue }
          if (item.kind === 'finish') { send(frame({}, item.reason, item.usage)); continue }
        }
      }

      const marker = MARKER.exec(flat)
      const scenario = marker ? scenariosByName.get(marker[1].toLowerCase()) : undefined

      try {
        if (isCompactSummary) {
          // 宿主校验摘要的格式(C5 六节 Markdown,必须有 `## Goal`);
          // 缺了它压缩会走失败路径,卡片是 `status:"failed"`。
          //
          // 摘要请求自己不带场景标记,但它把**被压掉的那段历史**原样喂了进来
          // ——`compact-failure` 那条会话的标记因此就在 `flat` 里,这是驱动
          // "真机上那条必现的失败路径"唯一的抓手(§13.10 M3)。
          await write(marker?.[1]?.toLowerCase() === 'compact-failure'
            ? [F.text('抱歉,我没法总结。'), F.stop()]
            : [
              F.text('## Goal\nthe shadow battery compacted this session.\n\n## Progress\n- one turn\n\n## Next\n- keep going\n'),
              F.stop(),
            ])
        } else if (!scenario) {
          // 没有标记的请求(标题生成之类)——给一句短回答,别让它卡住。
          await write([F.text('ok'), F.stop()])
        } else {
          const toolTurns = messages.filter(m => m.role === 'tool').length
          const variant = JSON.parse(Buffer.from(marker[2], 'base64url').toString('utf8'))
          await write(scenario.provider({ turn: toolTurns + 1, variant, payload, messages }))
        }
      } catch {
        // 假 provider 自己炸了不该拖着 server 一起 —— 收尾发个 stop。
        try { send(frame({}, 'stop')) } catch { /* ignore */ }
      }
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ============================================================ HTTP 客户端

function makeApi(port, token) {
  return async function api(method, route, body) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { raw: text, status: res.status } }
  }
}

/**
 * 通用 RPC 信封的裸调用面 —— 会话还没建出来(因而没有 Driver)的那几步也要用它:
 * 结构债 P4c 第五批把会话域整只迁进了 router,`POST /api/sessions/:id/{working-directory,
 * permission-mode,model,agent}` 随之删除。
 */
async function rpcCall(api, domain, method, payload) {
  const res = await api('POST', '/api/rpc', { domain, method, payload })
  if (!res || res.ok !== true) {
    throw new Error(`rpc ${domain}.${method} failed: ${JSON.stringify(res?.error ?? res)}`)
  }
  return res.data
}

class Driver {
  constructor(api, sessionId, scenarioName, variant, store) {
    this.api = api
    this.sessionId = sessionId
    this.name = scenarioName
    this.variant = variant
    this.store = store
    this.marker = `@@bat:${scenarioName}:${Buffer.from(JSON.stringify(variant), 'utf8').toString('base64url')}@@`
  }

  /**
   * 一条会话命令。结构债 P4c 第四批把命令总线的入口整只迁到了 `session-command`
   * RPC 域,`POST /api/sessions/:id/commands` 随之删除 —— 这是唯一的路。
   * 返回值仍是 `{success, error?}`(域的 `emit` 输出),所以场景断言不用改。
   */
  command(command) {
    return this.rpc('session-command', 'emit', { sessionId: this.sessionId, command })
  }

  /**
   * 通用 RPC 信封(`POST /api/rpc`,`{ domain, method, payload }` 入、
   * `RpcResponse` 出)—— 结构债 P4c 把 permission 等域迁进 router 之后就**删掉了**
   * 对应的 REST 镜像,这是唯一的路。解包 `data`;`ok:false` 直接抛,不静默降级。
   */
  rpc(domain, method, payload) {
    return rpcCall(this.api, domain, method, payload)
  }

  send(text = 'go') {
    return this.command({
      type: 'command:send-message',
      content: `${text} ${this.marker}`,
      suppressTitleGeneration: true,
    })
  }

  abort() {
    // 结构债 P4c 第五批:停止属聊天域,`POST /api/streams/abort` 已随之删除。
    return this.rpc('chat', 'abortStream', { sessionId: this.sessionId })
  }

  /** 把这条会话钉在另一个模型上(生图那一格靠模型名走上特化流)。 */
  model(provider, model) {
    return this.rpc('sessions', 'updateModel', { sessionId: this.sessionId, provider, model })
  }

  /**
   * 换 agent —— `session/agent-changed` 的那条产地(§13.10 M7)。
   *
   * P4c 第五批起走的是会话域(桌面那条实现),它比从前那条 REST 多一道
   * 「agent 得在册」的门 —— 所以这里**断言成功**:静默失败不许再蒙混过去。
   */
  async agent(agentId) {
    const result = await this.rpc('sessions', 'updateAgent', { sessionId: this.sessionId, agentId })
    assert(result?.success === true, `switching to agent ${agentId} failed: ${result?.error}`)
    return result
  }

  /** 现造一个在册的 agent(换 agent 那格要一个 default 以外的落点)。 */
  async createAgent(name) {
    const created = await this.rpc('agents', 'create', { name })
    assert(created?.success === true && created.agent?.id, `agent create failed: ${created?.error}`)
    return created.agent.id
  }

  /**
   * 这条会话的事件账本(逐行 parse)。
   *
   * 写入口是排队的,所以按类型等 —— 场景要断言"某件事**记下来了**"时用它。
   */
  /** 账本上这一类事件现在有哪些(不等)。 */
  ledger(type) {
    const file = path.join(this.store, 'sessions', this.sessionId, 'events.jsonl')
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(event => event.type === type)
  }

  /**
   * 把这条会话的事件账本摘掉 —— 只在**它写下第一个字之前**用得上,用来造出
   * "日志诞生于一次 run 中途"那种账本(首事件不是 `session/created`)。
   *
   * 真机上那是崩溃/迁移留下的形状,这里没有别的造法:写侧的 surface 与活投影
   * 都在内存里,会话跑起来之后再动文件改不动它们。
   */
  dropEventLog() {
    const file = path.join(this.store, 'sessions', this.sessionId, 'events.jsonl')
    try { fs.rmSync(file) } catch { /* 还没建起来就是了 */ }
  }

  async ledgerUntil(type, { timeoutMs = 10_000, everyMs = 60 } = {}) {
    const file = path.join(this.store, 'sessions', this.sessionId, 'events.jsonl')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
          .map(line => JSON.parse(line)).filter(event => event.type === type)
        : []
      if (hit.length > 0) return hit
      await sleep(everyMs)
    }
    throw new Error(`[${this.name}] the ledger never got a ${type}`)
  }

  async messages() {
    // 结构债 P4c 第五批:取消息属会话域,`POST /api/chat/messages` 已随之删除。
    const result = await this.rpc('sessions', 'getMessages', { sessionId: this.sessionId })
    return result?.messages ?? []
  }

  async activeStreams() {
    // 结构债 P4c 第五批:活流表属聊天域,`GET /api/streams/active` 已随之删除。
    // 字段也只剩一个 —— 桌面那条实现回的是 `sessionIds`,读的是引擎自己那本
    // 活会话表(比从前 server 壳按事件维护的影子账更贴近"引擎还认不认它在跑")。
    const result = await this.rpc('chat', 'getActiveStreams', {})
    return result?.sessionIds ?? []
  }

  /** 轮询直到条件成立;超时就抛(场景当场判红,不静默过去)。 */
  async until(label, predicate, { timeoutMs = 30_000, everyMs = 60 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await this.messages()
      const hit = await predicate(last)
      if (hit) return last
      await sleep(everyMs)
    }
    throw new Error(`[${this.name}] timed out waiting for ${label} (messages=${JSON.stringify(last?.length ?? 0)})`)
  }

  /**
   * 真的收干净了 —— 三件事一起成立:
   *
   *  1. 助手消息够数;
   *  2. 没有一条消息还在流,也没有一次调用停在活状态 ——
   *     `isStreaming:false` 由 `processor.finalize()` 写下,而
   *     `finalizeLingeringAgentLoopToolWork`(把没结局的调用判死并写上那句话)
   *     排在它**后面**一行,只等 isStreaming 会读到修复之前的那一瞬间;
   *  3. **引擎自己也不再认为这条会话在跑**(`chat.getActiveStreams`)。
   *
   * 第 3 条是必须的:引擎释放会话比消息落 `isStreaming:false` 晚一步,那一步里
   * 发过去的下一条消息会被当成 **steering** 排进队列,而不是开一轮新的
   * —— 矩阵里 `compact` 偶发的"第二条助手消息永远不来"就是它。
   */
  async waitIdle(minAssistants = 1, options = {}) {
    const live = new Set(['input-streaming', 'executing', 'queued', 'pending', 'received'])
    const settled = async messages => {
      const assistants = messages.filter(m => m.role === 'assistant')
      if (assistants.length < minAssistants) return false
      if (messages.some(m => m.isStreaming)) return false
      if (messages.some(m => (m.toolCalls ?? []).some(c => live.has(c.status)))) return false
      return !(await this.activeStreams()).includes(this.sessionId)
    }
    await this.until(`idle (≥${minAssistants} assistant)`, settled, options)
    // 引擎摘掉自己那把控制器与 `stream:complete` 事件之间还有一小段;这一觉
    // 之后再确认一次,免得下一条消息落进 steering 队列。
    await sleep(150)
    return this.until(`idle settled (≥${minAssistants} assistant)`, settled, options)
  }

  lastAssistant(messages) {
    return [...messages].reverse().find(m => m.role === 'assistant')
  }
}

// ============================================================ 场景库

/** 断言小工具:场景内部自证(影子门之外的那一半)。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const SCENARIOS = [
  {
    name: 'plain-text',
    covers: ['baseline: 一轮纯文本'],
    provider: ({ variant }) => [
      F.sleep(variant.firstByteMs),
      ...splitInto(`好的。${variant.body}`, variant.chunks).flatMap(c => [F.text(c), F.sleep(variant.perChunkMs)]),
      F.stop(usageOf(variant, 1)),
    ],
    async drive(d) {
      await d.send('说点什么')
      const messages = await d.waitIdle(1)
      assert(d.lastAssistant(messages)?.content?.includes(d.variant.body), 'assistant text missing')
    },
  },

  {
    name: 'reasoning-top',
    covers: ['§10.9 类别2:推理的 top 落点(只进 message.reasoning)'],
    provider: ({ variant }) => [
      F.sleep(variant.firstByteMs),
      ...splitInto(`我先想想 ${variant.body}`, variant.chunks).map(F.reasoning),
      F.text(`结论:${variant.body}`),
      F.stop(usageOf(variant, 1)),
    ],
    async drive(d) {
      await d.send('想一下再答')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      assert(assistant?.reasoning, 'top reasoning did not land on the field')
      const parts = assistant.contentParts ?? []
      assert(!parts.some(p => p.type === 'reasoning'), 'top reasoning must NOT be a contentPart')
    },
  },

  {
    name: 'reasoning-two-spots',
    covers: ['§10.9 类别2:推理的两个落点(top + 工具之后的 inline)'],
    provider: ({ turn, variant }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        F.reasoning(`先看看 ${variant.body}`),
        F.text('我查一下。'),
        ...F.tool('call_two_spots', 'bash', { command: 'echo two-spots', description: 'peek' }, 2),
        F.callTools(usageOf(variant, 1)),
      ]
      : [
        F.sleep(variant.firstByteMs),
        F.reasoning(`再想想 ${variant.body}`),
        F.text(`结论:${variant.body}`),
        F.stop(usageOf(variant, 2)),
      ]),
    async drive(d) {
      await d.send('查一下再答')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      assert(assistant?.reasoning, 'top reasoning missing')
      assert((assistant.contentParts ?? []).some(p => p.type === 'reasoning'), 'inline reasoning missing')
    },
  },

  {
    name: 'tool-loop',
    covers: ['多轮工具循环(2+ 工具,同 run 续轮)'],
    provider: ({ turn, variant }) => {
      if (turn === 1) {
        return [
          F.sleep(variant.firstByteMs),
          F.text('第一步。'),
          ...F.tool('call_loop_1', 'bash', { command: 'echo one', description: 'step one' }, 3),
          F.callTools(usageOf(variant, 1)),
        ]
      }
      if (turn === 2) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_loop_2', 'bash', { command: 'echo two', description: 'step two' }, 2),
          F.callTools(usageOf(variant, 2)),
        ]
      }
      return [F.sleep(variant.firstByteMs), F.text(`两步都跑完了:${variant.body}`), F.stop(usageOf(variant, 3))]
    },
    async drive(d) {
      await d.send('跑两个命令')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      assert((assistant?.toolCalls ?? []).length === 2, `expected 2 tool calls, got ${(assistant?.toolCalls ?? []).length}`)
      assert((assistant?.steps ?? []).every(s => s.status === 'completed'), 'tool steps did not complete')
    },
  },

  {
    name: 'bash-step-types',
    covers: [
      '§10.10 steps[].type 写死字面量',
      '§10.11 缺陷1:step.type 冻在占位那一刻(参数定稿后要重算)',
    ],
    provider: ({ turn, variant, workdir }) => {
      const dir = workdir ?? ''
      if (turn === 1) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_type_write', 'bash', { command: `mkdir -p ${dir}/out-${variant.tag}`, description: 'make a dir' }, 3),
          F.callTools(usageOf(variant, 1)),
        ]
      }
      if (turn === 2) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_type_read', 'bash', { command: `cat ${dir}/note-${variant.tag}.md`, description: 'read the note' }, 3),
          F.callTools(usageOf(variant, 2)),
        ]
      }
      if (turn === 3) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_type_cmd', 'bash', { command: 'echo plain', description: 'plain command' }, 2),
          F.callTools(usageOf(variant, 3)),
        ]
      }
      return [F.sleep(variant.firstByteMs), F.text(`看完了:${variant.body}`), F.stop(usageOf(variant, 4))]
    },
    async drive(d) {
      await d.send('建目录、读文件、再跑个命令')
      const messages = await d.waitIdle(1)
      const steps = d.lastAssistant(messages)?.steps ?? []
      const byId = new Map(steps.map(s => [s.toolCallId, s]))
      assert(byId.get('call_type_write')?.type === 'file-write', `write step type = ${byId.get('call_type_write')?.type}`)
      assert(byId.get('call_type_read')?.type === 'file-read', `read step type = ${byId.get('call_type_read')?.type}`)
      assert(byId.get('call_type_cmd')?.type === 'command', `plain step type = ${byId.get('call_type_cmd')?.type}`)
    },
  },

  {
    name: 'skill-activation',
    covers: [
      '§10.11 缺陷2:skillUsed 一个判定点两个落点',
      '§10.11 投影缺陷:run 级技能名串到别的 step 标题上',
    ],
    provider: ({ turn, variant, workdir }) => {
      if (turn === 1) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_skill', 'bash', { command: `cat ${workdir}/skills/battery-skill/SKILL.md`, description: 'read the skill' }, 3),
          F.callTools(usageOf(variant, 1)),
        ]
      }
      if (turn === 2) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_skill_write', 'bash', { command: `mkdir -p ${workdir}/skill-out-${variant.tag}`, description: 'make a dir' }, 2),
          F.callTools(usageOf(variant, 2)),
        ]
      }
      return [F.sleep(variant.firstByteMs), F.text(`技能读完了:${variant.body}`), F.stop(usageOf(variant, 3))]
    },
    async drive(d) {
      await d.send('读一下技能再建个目录')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      assert(assistant?.skillUsed === 'battery-skill', `skillUsed = ${assistant?.skillUsed}`)
      const steps = new Map((assistant.steps ?? []).map(s => [s.toolCallId, s]))
      assert(steps.get('call_skill')?.type === 'skill-read', `skill step type = ${steps.get('call_skill')?.type}`)
      assert(steps.get('call_skill_write')?.type === 'file-write', `second step type = ${steps.get('call_skill_write')?.type}`)
    },
  },

  {
    name: 'tool-failure',
    covers: ['§10.12 第6类:失败但跑完了的工具(result 与 error 并存 + 自报标题)'],
    provider: ({ turn, variant, workdir }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        // 参数**合法**,是业务失败(越过文件末尾)—— 工具跑到了,也自报了标题。
        ...F.tool('call_fail', 'read', { path: `${workdir}/note-${variant.tag}.md`, offset: 9000 }, 2),
        F.callTools(usageOf(variant, 1)),
      ]
      : [F.sleep(variant.firstByteMs), F.text(`读失败了:${variant.body}`), F.stop(usageOf(variant, 2))]),
    async drive(d) {
      await d.send('读一段越界的内容')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      const step = (assistant?.steps ?? []).find(s => s.toolCallId === 'call_fail')
      assert(step, 'failed step missing')
      assert(step.status === 'failed', `failed step status = ${step.status}`)
      assert(step.error, 'failed step carries no error')
      assert(step.result !== undefined, 'failed step must still carry a result')
      const call = (assistant.toolCalls ?? []).find(c => c.id === 'call_fail')
      assert(call?.result !== undefined, 'failed toolCall lost its structured result')
      assert(step.title !== '调用工具: read', 'the tool reported a title — the step must use it')
    },
  },

  {
    name: 'tool-invalid-args',
    covers: [
      '§10.14 第8类:**不自报标题**的工具(参数校验就失败 → 永远停在占位标题)',
    ],
    provider: ({ turn, variant }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        // 参数名写错(模型天天干的事)—— zod 当场拒,工具根本没跑,
        // 于是一条 `annotate{title}` 都没有。
        ...F.tool('call_bad_args', 'read', { file_path: '/nope.md', offset: 3 }, 2),
        F.callTools(usageOf(variant, 1)),
      ]
      : [F.sleep(variant.firstByteMs), F.text(`参数写错了:${variant.body}`), F.stop(usageOf(variant, 2))]),
    async drive(d) {
      await d.send('用错参数名调一次')
      const messages = await d.waitIdle(1)
      const step = (d.lastAssistant(messages)?.steps ?? []).find(s => s.toolCallId === 'call_bad_args')
      assert(step, 'invalid-args step missing')
      assert(step.status === 'failed', `invalid-args step status = ${step.status}`)
      // 引擎从来没盖过这个标题 —— 投影必须说出同一句话。
      assert(step.title === '调用工具: read', `invalid-args step title = ${step.title}`)
    },
  },

  {
    name: 'permission-denied',
    covers: ['权限拒绝(带 reason)—— G6 的落点'],
    permissionMode: 'normal',
    // `echo` 在分类器里是只读命令,`normal` 模式下也不弹卡;`mkdir` 才会问。
    provider: ({ turn, variant, workdir }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        ...F.tool('call_denied', 'bash', { command: `mkdir -p ${workdir}/denied-${variant.tag}`, description: 'needs approval' }, 2),
        F.callTools(usageOf(variant, 1)),
      ]
      : [F.sleep(variant.firstByteMs), F.text(`那就算了:${variant.body}`), F.stop(usageOf(variant, 2))]),
    async drive(d) {
      await d.send('跑个要审批的命令')
      // 等审批卡挂起来 —— 不靠固定 sleep。
      const deadline = Date.now() + 30_000
      let pending
      while (Date.now() < deadline) {
        const result = await d.rpc('permission', 'getPending', { sessionId: d.sessionId })
        const list = result?.pending ?? []
        pending = Array.isArray(list) ? list.find(item => (item.callId ?? item.toolCallId) === 'call_denied') : undefined
        if (pending) break
        await sleep(60)
      }
      assert(pending, 'no pending permission prompt appeared')
      // **不带 channel**:server 会把待批那条的 targetChannel 认领过来(通道亲和)。
      await d.command({
        type: 'command:permission-respond',
        toolCallId: 'call_denied',
        decision: 'reject',
        rejectReason: '电池矩阵不批准这条命令',
      })
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      const call = (assistant?.toolCalls ?? []).find(c => c.id === 'call_denied')
      assert(call, 'denied tool call missing')
      assert(call.rejected === true || call.status === 'failed', `denied call status = ${call.status}`)
    },
  },

  {
    /**
     * A12(§13.6):**审批批准之后那条消息还对得上吗。**
     *
     * 投影现在会 join `permission/asked` 出"等确认"三格,而
     * `permission/answered{approved:true}` 是把那个状态收掉的唯一事件 ——
     * 修之前归约器对批准那一条**整条跳过**(它只关心拒绝的理由)。
     * 挂起的那一刻不进影子断言(断言在 run/end 比一次),这条场景钉的是
     * "批准之后收场的那一份两侧仍然逐字相同"。
     */
    name: 'permission-approved',
    covers: ['A12:审批挂起 → 批准 → 收场,等确认三格不许留在消息上'],
    permissionMode: 'normal',
    provider: ({ turn, variant, workdir }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        ...F.tool('call_approved', 'bash', { command: `mkdir -p ${workdir}/approved-${variant.tag}`, description: 'needs approval' }, 2),
        F.callTools(usageOf(variant, 1)),
      ]
      : [F.sleep(variant.firstByteMs), F.text(`建好了:${variant.body}`), F.stop(usageOf(variant, 2))]),
    async drive(d) {
      await d.send('跑个要审批的命令,这次批准')
      const deadline = Date.now() + 30_000
      let pending
      while (Date.now() < deadline) {
        const result = await d.rpc('permission', 'getPending', { sessionId: d.sessionId })
        const list = result?.pending ?? []
        pending = Array.isArray(list) ? list.find(item => (item.callId ?? item.toolCallId) === 'call_approved') : undefined
        if (pending) break
        await sleep(60)
      }
      assert(pending, 'no pending permission prompt appeared')
      await d.command({
        type: 'command:permission-respond',
        toolCallId: 'call_approved',
        decision: 'allow',
        scope: 'once',
      })
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      const call = (assistant?.toolCalls ?? []).find(c => c.id === 'call_approved')
      assert(call, 'approved tool call missing')
      // 收场之后确认闸必须是关的(引擎在那一刻把它写死成 false)。
      assert(call.requiresConfirmation !== true, `approved call still awaits confirmation: ${call.status}`)
    },
  },

  {
    name: 'abort-mid-text',
    covers: ['§10.14 第7类:被打断那一轮的 contentParts 从来没落地 + 中止的执行没有 usage'],
    provider: ({ turn, variant }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        F.text(`开始写:${variant.body}`),
        // 用户就在这段等待里按下停止。
        F.sleep(20_000),
        F.text('这段永远发不出去'),
        F.stop(usageOf(variant, 1)),
      ]
      : [F.text('unreachable'), F.stop()]),
    async drive(d) {
      await d.send('写一大段')
      await d.until('partial text', messages => {
        const assistant = d.lastAssistant(messages)
        return Boolean(assistant?.isStreaming && assistant.content)
      })
      await d.abort()
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      assert(assistant?.content?.includes('开始写'), 'partial text was lost')
      assert(assistant.usage === undefined, 'an aborted execution must not carry usage')
      assert((assistant.contentParts ?? []).every(p => p.type !== 'text'), 'the aborted turn must not persist text parts')
    },
  },

  {
    name: 'abort-mid-tool-input',
    covers: ['§10.14 第7类:参数流到一半被 abort —— 占位 step + 占位调用 + 那句 User cancelled'],
    provider: ({ turn, variant }) => {
      if (turn === 1) {
        return [
          F.sleep(variant.firstByteMs),
          F.reasoning(`先看看 ${variant.body}`),
          ...F.tool('call_orphan_1', 'bash', { command: 'echo first', description: 'first step' }, 2),
          F.callTools(usageOf(variant, 1)),
        ]
      }
      return [
        F.sleep(variant.firstByteMs),
        F.reasoning(`再想想 ${variant.body}`),
        F.toolStart('call_orphan_2', 'bash'),
        F.toolArgs('{"command": "grep -r '),
        // 参数写到一半,用户按停止。
        F.sleep(20_000),
        F.toolArgs('x ."}'),
        F.callTools(usageOf(variant, 2)),
      ]
    },
    async drive(d) {
      await d.send('查两轮')
      await d.until('orphan tool-input in flight', messages => {
        const assistant = d.lastAssistant(messages)
        return (assistant?.toolCalls ?? []).some(c => c.id === 'call_orphan_2' && c.status === 'input-streaming')
      })
      await d.abort()
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      const call = (assistant?.toolCalls ?? []).find(c => c.id === 'call_orphan_2')
      assert(call, 'orphan tool call missing from the message')
      assert(call.status === 'cancelled', `orphan call status = ${call.status}`)
      assert(call.error === 'User cancelled', `orphan call error = ${call.error}`)
      const step = (assistant.steps ?? []).find(s => s.toolCallId === 'call_orphan_2')
      assert(step, 'orphan step missing from the message (class 7)')
      assert(step.status === 'cancelled', `orphan step status = ${step.status}`)
      assert(step.title === '调用工具: bash', `orphan step title = ${step.title}`)
      assert(assistant.usage === undefined, 'an aborted execution must not carry usage')
    },
  },

  {
    name: 'abort-tool-in-flight',
    covers: [
      '§13.8 第一类:工具**已经派工**时按停止 —— 收场修复写下的结局与自报标题要进账本',
    ],
    /**
     * 与 `abort-mid-tool-input` 的分界:那一格停在**参数流**上(`tool/call`
     * 都不会来),这一格参数已经定稿、工具正在跑 —— 账本上有 `tool/call`、
     * 有 `tool/audit{outcome:'aborted'}`,唯独没有 `tool/result`。
     */
    provider: ({ turn, variant }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        F.reasoning(`先跑起来 ${variant.body}`),
        // 真的跑一条慢命令:停止按下去时它正在执行。
        ...F.tool('call_inflight', 'bash', { command: 'sleep 20', description: 'slow step' }, 2),
        F.callTools(usageOf(variant, 1)),
      ]
      : [F.text('unreachable'), F.stop()]),
    async drive(d) {
      await d.send('跑个慢的')
      await d.until('tool executing', messages => {
        const assistant = d.lastAssistant(messages)
        return (assistant?.toolCalls ?? []).some(c => c.id === 'call_inflight' && c.status === 'executing')
      })
      await d.abort()
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      const call = (assistant?.toolCalls ?? []).find(c => c.id === 'call_inflight')
      assert(call, 'in-flight tool call missing from the message')
      assert(call.status === 'cancelled', `in-flight call status = ${call.status}`)
      assert(call.error === 'User cancelled', `in-flight call error = ${call.error}`)
      const step = (assistant.steps ?? []).find(s => s.toolCallId === 'call_inflight')
      assert(step, 'in-flight step missing')
      assert(step.status === 'cancelled', `in-flight step status = ${step.status}`)
      assert(step.error === 'User cancelled', `in-flight step error = ${step.error}`)
      // 工具自报的标题(bash 报的是命令本身)—— 修复前账本上一个字都没有,
      // 投影只能给占位标题,影子当场记一条 `steps.0.title`。
      assert(step.title === 'sleep 20', `in-flight step title = ${step.title}`)
      assert(assistant.usage === undefined, 'an aborted execution must not carry usage')
    },
  },

  {
    name: 'image-generation-failure',
    covers: [
      '§13.8 第二类:生图**失败**那句正文只落在 `content` 上(没有 contentPart)',
    ],
    /**
     * 生图不走 SSE 聊天口:模型名带 `dall-e` 就转进特化流,请求打到假 provider
     * 的 `/v1/images/generations`(那里固定回 500)。所以这一格的 `provider`
     * 永远不会被调用 —— 留一句兜底,别让路由表缺一格。
     */
    provider: () => [F.text('unreachable'), F.stop()],
    async drive(d) {
      await d.model('deepseek', 'dall-e-3')
      await d.send('画一只猫')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      assert(
        assistant?.content?.startsWith('图片生成失败:'),
        `image failure body = ${JSON.stringify(assistant?.content)}`,
      )
      // 失败分支只写 `content` —— 多出一格 contentPart 就是新的不等。
      assert(
        (assistant.contentParts ?? []).length === 0,
        `image failure must not persist contentParts: ${JSON.stringify(assistant.contentParts)}`,
      )
    },
  },

  {
    name: 'tool-args-truncated',
    covers: [
      '参数流没写完就 stop —— 引擎补一次 `tool-call-start` 兜底并照样执行(不是孤儿)',
    ],
    provider: ({ turn, variant }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        F.text('我本来想查一下。'),
        F.toolStart('call_truncated', 'bash'),
        F.toolArgs('{"command": "ec'),
        // 参数没写完,模型自己收了 —— 正常 stop,不是 abort。
        // 引擎的 `planAgentLoopToolCallFallback` 会拿这半截参数收尾并照样跑,
        // 所以这里**不会**留下孤儿:真正的孤儿只有 abort / 请求出错那两条路
        // (`abort-mid-tool-input` 那一格)。
        F.stop(usageOf(variant, 1)),
      ]
      : [F.sleep(variant.firstByteMs), F.text(`参数没写完:${variant.body}`), F.stop(usageOf(variant, 2))]),
    async drive(d) {
      await d.send('半路收手')
      const messages = await d.waitIdle(1)
      // 兜底那次调用不一定落在最后一条助手消息上(失败之后引擎可能再开一条),
      // 所以在整条会话里找。
      const call = messages.flatMap(m => m.toolCalls ?? []).find(c => c.id === 'call_truncated')
      assert(call, 'truncated tool call missing')
      assert(call.status === 'failed' || call.status === 'completed', `truncated call status = ${call.status}`)
      const step = messages.flatMap(m => m.steps ?? []).find(s => s.toolCallId === 'call_truncated')
      assert(step, 'truncated step missing')
    },
  },

  {
    name: 'steering',
    covers: ['§10.12 第5类:steering 把一次执行劈成两条消息(回合号/用量跨 run 接着走)'],
    provider: ({ turn, variant }) => {
      if (turn === 1) {
        return [
          F.sleep(200),
          // 先把正文吐出来当发令枪:驱动方看到它就注入 steering,后面这 1.2 秒
          // 是留给注入的余量 —— steering 只有排在**下一轮开始之前**才会换 run。
          F.text('先跑一步。'),
          F.sleep(1200),
          ...F.tool('call_steer', 'bash', { command: 'echo steering', description: 'step one' }, 2),
          F.callTools(usageOf(variant, 1)),
        ]
      }
      // §10.12 的次序陷阱:零延迟的假 provider 会让记录器跑赢引擎的 chunk 队列,
      // 于是第 2 轮整段记到旧 run 名下。真机上模型的首字节延迟天然盖住了这一段
      // —— 这里按同样的量级补回来。
      return [
        F.sleep(800),
        F.reasoning(`收到新指示 ${variant.body}`),
        F.text(`改按新的来:${variant.body}`),
        F.stop(usageOf(variant, 2)),
      ]
    },
    async drive(d) {
      await d.send('先跑一步')
      await d.until('first turn text', messages => {
        const assistant = d.lastAssistant(messages)
        return Boolean(assistant?.isStreaming && assistant.content)
      })
      await d.command({ type: 'command:inject-steering', content: `换个方向 ${d.marker}` })
      const messages = await d.waitIdle(2, { timeoutMs: 60_000 })
      const assistants = messages.filter(m => m.role === 'assistant')
      assert(assistants.length >= 2, `steering did not split the execution (assistants=${assistants.length})`)
      const [first, second] = assistants
      assert(first.usage === undefined, 'the interrupted message must not carry usage')
      assert(second.usage !== undefined, 'the taking-over message must carry the whole execution usage')
    },
  },

  {
    name: 'edit-and-resend',
    covers: ['编辑重发:截断 + 新用户消息(surface replace)'],
    provider: ({ variant }) => [
      F.sleep(variant.firstByteMs),
      F.text(`回答:${variant.body}`),
      F.stop(usageOf(variant, 1)),
    ],
    async drive(d) {
      await d.send('第一版问题')
      const first = await d.waitIdle(1)
      const userMessage = first.find(m => m.role === 'user')
      assert(userMessage, 'no user message to edit')
      await d.command({
        type: 'command:edit-and-resend',
        messageId: userMessage.id,
        newContent: `第二版问题 ${d.marker}`,
      })
      const messages = await d.waitIdle(1, { timeoutMs: 45_000 })
      assert(messages.filter(m => m.role === 'user').length === 1, 'edit-and-resend left more than one user message')
      assert(messages.find(m => m.role === 'user')?.content.includes('第二版'), 'edited content did not land')
    },
  },

  {
    name: 'edit-changes',
    covers: ['§13.18 发现 A:edit/write 工具的 diff changes 落磁盘消息(顶层+step,重载不丢)'],
    provider: ({ turn, variant, workdir }) => {
      const dir = workdir ?? ''
      const file = `${dir}/edit-target-${variant.tag}.txt`
      if (turn === 1) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_write_seed', 'write', { path: file, content: 'alpha\nbeta\ngamma\n' }, 2),
          F.callTools(usageOf(variant, 1)),
        ]
      }
      if (turn === 2) {
        return [
          F.sleep(variant.firstByteMs),
          ...F.tool('call_edit_changes', 'edit', { path: file, edits: [{ oldText: 'beta', newText: 'BETA-changed' }] }, 3),
          F.callTools(usageOf(variant, 2)),
        ]
      }
      return [F.sleep(variant.firstByteMs), F.text(`改完了:${variant.body}`), F.stop(usageOf(variant, 3))]
    },
    async drive(d) {
      await d.send('写一个文件再改它')
      const messages = await d.waitIdle(1, { timeoutMs: 45_000 })
      const assistant = d.lastAssistant(messages)
      const editCall = (assistant?.toolCalls ?? []).find(c => c.id === 'call_edit_changes')
      assert(editCall, 'edit tool call missing from persisted message')
      assert(editCall.status === 'completed', `edit tool call did not complete: ${editCall.status}`)
      // 发现 A:changes 必须落在磁盘消息上(重载后 diff 才不空);HEAD 上此处丢。
      assert(editCall.changes?.filePath, 'edit tool call lost its diff changes on the persisted message')
    },
  },

  {
    name: 'retry-message',
    covers: ['重试/重新生成:砍掉旧助手消息再开一条新 run'],
    provider: ({ variant }) => [
      F.sleep(variant.firstByteMs),
      F.text(`回答:${variant.body}`),
      F.stop(usageOf(variant, 1)),
    ],
    async drive(d) {
      await d.send('答一次')
      const first = await d.waitIdle(1)
      const assistant = d.lastAssistant(first)
      await d.command({ type: 'command:retry-message', messageId: assistant.id })
      const messages = await d.waitIdle(1, { timeoutMs: 45_000 })
      const assistants = messages.filter(m => m.role === 'assistant')
      assert(assistants.length === 1, `retry left ${assistants.length} assistant messages`)
      assert(assistants[0].id !== assistant.id, 'retry reused the old assistant message id')
    },
  },

  {
    name: 'delete-message',
    covers: ['删除一条消息(message/deleted 遮蔽一格 surface)'],
    provider: ({ variant }) => [
      F.sleep(variant.firstByteMs),
      F.text(`回答:${variant.body}`),
      F.stop(usageOf(variant, 1)),
    ],
    async drive(d) {
      await d.send('先答一次')
      const first = await d.waitIdle(1)
      const victim = d.lastAssistant(first)
      await d.rpc('sessions', 'removeMessage', { sessionId: d.sessionId, messageId: victim.id })
      await d.send('再答一次')
      const messages = await d.waitIdle(1, { timeoutMs: 45_000 })
      assert(!messages.some(m => m.id === victim.id), 'the deleted message came back')
    },
  },

  {
    name: 'compact',
    covers: ['压缩(session/compacted:UI 照旧显示,只有模型历史被折叠)'],
    provider: ({ turn, variant }) => [
      F.sleep(variant.firstByteMs),
      F.text(`第 ${turn} 段:${variant.body}`),
      F.stop(usageOf(variant, turn)),
    ],
    async drive(d) {
      await d.send('第一段')
      await d.waitIdle(1)
      await d.send('第二段')
      await d.waitIdle(2)
      await d.command({ type: 'command:compact-context', manual: true })
      // 压缩自己不开 run,收尾看的是那条系统卡片(正文是一段 JSON)。
      const messages = await d.until('compact card', list =>
        list.some(m => m.role === 'system' && typeof m.content === 'string'
          && m.content.includes('"type":"context-compact"') && m.content.includes('"status":"completed"')),
        { timeoutMs: 45_000 })
      await d.send('压缩之后再问一句')
      const after = await d.waitIdle(3, { timeoutMs: 45_000 })
      assert(after.length > messages.length, 'nothing was written after the compaction')
    },
  },

  {
    name: 'compact-failure',
    covers: ['§13.10 M3:压缩**失败**(摘要没有 `## Goal`)—— 标记消息只有一条,红卡不是第二格'],
    provider: ({ turn, variant }) => [
      F.sleep(variant.firstByteMs),
      F.text(`第 ${turn} 段:${variant.body}`),
      F.stop(usageOf(variant, turn)),
    ],
    async drive(d) {
      await d.send('第一段')
      await d.waitIdle(1)
      await d.send('第二段')
      await d.waitIdle(2)
      await d.command({ type: 'command:compact-context', manual: true })
      const messages = await d.until('failed compact card', list =>
        list.some(m => m.role === 'system' && typeof m.content === 'string'
          && m.content.includes('"type":"context-compact"') && m.content.includes('"status":"failed"')),
        { timeoutMs: 45_000 })
      // 一次尝试 = **一条**标记消息。真机上投影比它多一条(占位一格 + 收尾一格),
      // 而事实侧从来就只有这一条 —— 这里钉住事实侧的口径。
      const cards = messages.filter(m => typeof m.content === 'string'
        && m.content.includes('"type":"context-compact"'))
      assert(cards.length === 1, `expected exactly one compact marker, got ${cards.length}`)
      // 账本上那一条**不遮蔽任何东西**(失败的压缩没压掉一句话)。
      const compacted = await d.ledgerUntil('session/compacted')
      assert(compacted.length === 1, `expected one session/compacted, got ${compacted.length}`)
      assert(compacted[0].data?.status === 'failed', 'the ledger did not record the failure')
      assert(compacted[0].surfaceOp === 'append', 'a failed compaction must not shadow the surface')
      // 失败的压缩什么都没遮蔽:接着说话照旧是完整历史。
      await d.send('压缩失败之后再问一句')
      const after = await d.waitIdle(3, { timeoutMs: 45_000 })
      assert(after.length > messages.length, 'nothing was written after the failed compaction')
    },
  },

  {
    name: 'agent-switch',
    covers: ['§13.10 M7:换 agent 记一条 `session/agent-changed`,而且下一轮照旧对得上'],
    provider: ({ turn, variant }) => [
      F.sleep(variant.firstByteMs),
      F.text(`第 ${turn} 段:${variant.body}`),
      F.stop(usageOf(variant, turn)),
    ],
    async drive(d) {
      await d.send('切换之前')
      await d.waitIdle(1)
      // 换 agent 不是一条消息:切完之后消息条数一个不多。
      const before = await d.messages()
      // 换的落点必须是**在册**的 agent(会话域比旧 REST 多一道这个门),
      // 而且不能是会话已有的那个(没变就不该记账)。
      const agentId = await d.createAgent(`battery-${d.variant.pass}-${Date.now()}`)
      await d.agent(agentId)
      const after = await d.messages()
      assert(after.length === before.length, 'switching the agent must not add a message')
      // …但账本上**必须**有那一行(修复前 `POST /api/sessions/:id/agent` 是无声的)。
      const changed = await d.ledgerUntil('session/agent-changed')
      assert(changed.length === 1, `expected one session/agent-changed, got ${changed.length}`)
      assert(changed[0].data?.to === agentId, `wrong agent recorded: ${JSON.stringify(changed[0].data)}`)
      await d.send('切换之后')
      await d.waitIdle(2)
    },
  },

  {
    name: 'compact-half-run-log',
    covers: [
      '批 P-b(§15.3):日志**首事件不是 `session/created`**(半截 run 开头)的那份账上压缩 —— '
      + '压缩节点必须真的遮住东西,投影的模型历史与 store 的压缩口径一致',
    ],
    /**
     * 真机 46dcec05 的病根形状:那份事件日志诞生于一次 run 中途,`session/created`
     * 从来没写过。压缩落账时写侧按当时的 surface 取切点,而这份 surface 的头
     * 不是会话的头 —— 一旦日志的头**事后**又被补过(迁移),写侧那句 `start`
     * 就落在了会话真正的头之后,前面那一段永远遮不掉(模型同时看到摘要和原文,
     * 预算翻倍而两边 token 账都是绿的)。
     *
     * 活进程里补头是做不到的(写侧 surface 与活投影都在内存里,补文件也改不动
     * 它们),所以那一半由 `projection-contract.test.ts` 的 fold 级用例钉住 ——
     * 那正是"新进程重折一份被改过的文件"。这一格钉的是活进程这一半:**没有
     * `session/created` 的账本上,压缩照样遮得干净**。
     */
    provider: ({ turn, variant }) => [
      F.sleep(variant.firstByteMs),
      F.text(`第 ${turn} 段:${variant.body}`),
      F.stop(usageOf(variant, turn)),
    ],
    async drive(d) {
      // 第一个字写进去之前先把账本摘掉:接下来落的第一条事件就不是
      // `session/created` 了(= 半截 run 开头的那份日志)。
      d.dropEventLog()
      await d.send('第一段')
      await d.waitIdle(1)
      await d.send('第二段')
      await d.waitIdle(2)
      const created = await d.ledger('session/created')
      assert(created.length === 0, 'the ledger was supposed to start mid-run')
      await d.command({ type: 'command:compact-context', manual: true })
      const messages = await d.until('compact card', list =>
        list.some(m => m.role === 'system' && typeof m.content === 'string'
          && m.content.includes('"type":"context-compact"') && m.content.includes('"status":"completed"')),
        { timeoutMs: 45_000 })
      const compacted = await d.ledgerUntil('session/compacted')
      const completed = compacted.filter(event => (event.data?.status ?? 'completed') === 'completed')
      assert(completed.length === 1, `expected one completed compaction, got ${completed.length}`)
      // 一次成功的压缩必须真的遮住东西 —— `append` 就是切点没解出来(F3),
      // 后果正是"摘要与原文同时在场"。
      const op = completed[0].surfaceOp
      assert(op && op !== 'append' && op.op === 'replace',
        `a completed compaction must shadow the surface, got ${JSON.stringify(op)}`)
      assert((completed[0].sourceEventSeqs ?? []).length > 0, 'the compaction declared nothing shadowed')
      // 压缩之后接着说话:这一轮的历史影子断言跑的就是"投影的模型历史 ≡
      // 引擎真发出去的那一份",压缩没遮干净它当场红。
      await d.send('压缩之后再问一句')
      const after = await d.waitIdle(3, { timeoutMs: 45_000 })
      assert(after.length > messages.length, 'nothing was written after the compaction')
    },
  },

  {
    name: 'provider-cost-usage',
    covers: [
      '批 P-a(§15.3):厂商报的 `providerCostUSD` 必须进事件面 —— 记录器的 usage 白名单漏一格,'
      + 'store 的 `steps[].usage` 有而投影没有,每个带成本读数的 run 记一条失配(真机 10 条)',
    ],
    /**
     * `providerCostUSD` 只有少数几家报,而 `deepseek` 的 usage 表里没有这一格 ——
     * 所以这一格把会话钉在 `openrouter` 上(它的方言读顶层 `cost`,而它本身就是
     * 一份 OpenAI chat 方言,同一个假 provider 接得住)。
     *
     * 必须有一次工具调用:成本落的是 **step** 那一格(`patchStepsUsageByTurn`),
     * 一句纯文本没有 step 可落,断言就没有着落。
     */
    provider: ({ turn, variant }) => (turn === 1
      ? [
        F.sleep(variant.firstByteMs),
        F.text('先查一下。'),
        ...F.tool('call_cost_1', 'bash', { command: 'echo cost', description: 'cost probe' }, 2),
        F.callTools({ ...usageOf(variant, 1), cost: 0.058543648 }),
      ]
      : [
        F.sleep(variant.firstByteMs),
        F.text(`报价:${variant.body}`),
        F.stop({ ...usageOf(variant, 2), cost: 0.075264032 }),
      ]),
    async drive(d) {
      await d.model('openrouter', 'battery-cost-model')
      await d.send('报个价')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      const costs = (assistant?.steps ?? []).map(step => step.usage?.providerCostUSD).filter(c => c !== undefined)
      // 前提断言:真相侧真的带上了成本。带不上就说明 provider 那一侧没读到
      // 顶层 `cost`,后面的影子对比会恒等成立 —— 这一格就白站了。
      assert(costs.length > 0, `store step usage carries no providerCostUSD: ${JSON.stringify((assistant?.steps ?? []).map(s => s.usage))}`)
      assert(costs.every(c => c > 0), `providerCostUSD must be positive: ${JSON.stringify(costs)}`)
      // 消息级用量走引擎累加器,累加器逐字段列名 —— 成本到不了这一格。
      assert(
        assistant?.usage === undefined || assistant.usage.providerCostUSD === undefined,
        `message-level usage must not carry cost: ${JSON.stringify(assistant?.usage)}`,
      )
    },
  },

  {
    name: 'long-multipart-text',
    covers: ['多段长正文(part 边界 + 攒批闸)'],
    provider: ({ variant }) => {
      const long = `${variant.body} `.repeat(40)
      return [
        F.sleep(variant.firstByteMs),
        ...splitInto(long, 12).flatMap(chunk => [F.text(chunk), F.sleep(1)]),
        F.stop(usageOf(variant, 1)),
      ]
    },
    async drive(d) {
      await d.send('写长一点')
      const messages = await d.waitIdle(1)
      const assistant = d.lastAssistant(messages)
      assert((assistant?.content ?? '').length > 200, 'long text did not accumulate')
    },
  },
]

// ============================================================ store 准备

function prepareStore(store, mockPort) {
  const workdir = path.join(store, 'work')
  fs.mkdirSync(path.join(workdir, 'skills', 'battery-skill'), { recursive: true })
  fs.writeFileSync(
    path.join(workdir, 'skills', 'battery-skill', 'SKILL.md'),
    '---\nname: battery-skill\n---\n\n# battery-skill\n\nthe shadow battery reads this file.\n',
  )
  fs.writeFileSync(path.join(workdir, 'note-p0.md'), 'note\n')
  for (let pass = 0; pass < 64; pass++) {
    fs.writeFileSync(path.join(workdir, `note-p${pass}.md`), `note for pass ${pass}\n`)
  }
  fs.writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
    ai: {
      provider: 'deepseek',
      temperature: 0.6,
      providers: {
        deepseek: {
          apiKey: 'sk-battery',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          model: 'deepseek-chat',
          selectedModels: ['deepseek-chat'],
          enabled: true,
          modelCapabilitiesByModel: {
            'deepseek-chat': { tools: true, reasoning: true, vision: false },
          },
        },
        // 批 P-a:`providerCostUSD` 只有少数几家报,deepseek 的 usage 表里没有这一格。
        // openrouter 的方言把顶层 `cost` 读进三桶(`OPENROUTER_USAGE_TABLE`),而它
        // 就是一份 OpenAI chat 方言 —— 同一个假 provider 接得住,`provider-cost-usage`
        // 那一格靠 `d.model('openrouter', …)` 钉过去。
        openrouter: {
          apiKey: 'sk-battery-openrouter',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          model: 'battery-cost-model',
          selectedModels: ['battery-cost-model'],
          enabled: true,
          modelCapabilitiesByModel: {
            'battery-cost-model': { tools: true, reasoning: false, vision: false },
          },
        },
      },
      customProviders: [],
      modelCatalog: {},
    },
    tools: {
      enableToolCalls: true,
      permissionMode: 'dangerously-allow-all',
      tools: {},
    },
    // 手动压缩要有东西可压:`selectCompactPlan` 保留最近 N 个用户回合,
    // 保留 1 个的话两个回合就够(默认 6 个,矩阵里没人聊那么久)。
    chat: { contextCompactEnabled: true, contextCompactKeepRecentTurns: 1 },
    diagnostics: { enabled: false },
  }, null, 2))
  return workdir
}

// ============================================================ 跑

async function withConcurrency(items, limit, worker) {
  const queue = [...items]
  const running = []
  const results = []
  const next = async () => {
    const item = queue.shift()
    if (!item) return
    results.push(await worker(item))
    await next()
  }
  for (let i = 0; i < Math.max(1, limit); i++) running.push(next())
  await Promise.all(running)
  return results
}


// ============================================================ 补水泳道(S3w-1)

/** `<store>/log/session-shadow.jsonl` 现在有多少行(泳道二只认它之后新增的)。 */
function countShadowLines(store) {
  const file = path.join(store, 'log', 'session-shadow.jsonl')
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/**
 * 冷加载补水泳道(S3w-1,§14.4 / §15.4;批 3 起跑**两条**,§15.10)。
 *
 * 泳道一写完的那批会话,换一个空 LRU 的新进程再各接一轮。第一次 `getSession`
 * 就是冷加载;那一轮的 run 收尾时影子照常比"store vs 投影"。判据是**这条泳道
 * 期间新增的失配行必须为 0** —— 补水形状漂一格就当场红,不必新造判据。
 *
 * 批 3 把默认翻成 `projection` 之后,这里跑两趟,`env` 决定跑的是哪一档:
 *  - **默认档**(不设 `ONETHING_SESSION_HYDRATE`)—— 今天等于 `projection`,
 *    验的是"产品出厂时走的那条路";
 *  - **显式 legacy 档**(`ONETHING_SESSION_HYDRATE=messages`)—— 验的是**回滚杆
 *    本身**:扳回老路后冷加载仍然要能读出完整历史、接着写的那轮仍然要 0 失配。
 *    回滚杆没被测着 = 真要回滚的那天才发现它坏了。
 *
 * 两趟各取样上限 8 条,且**互不相交**(`exclude`):泳道的价值在"冷加载路径被
 * 真的走了一遍",不在遍历全矩阵;每条会话都要起一轮真执行,全量会把 45s 的
 * 矩阵拖成两倍。相交还会让"是哪一档漂的"变成一道推理题。
 */
async function runHydrateLane({ store, api, library, stopServer, startServer, targets, label, env, exclude }) {
  const lane = { label, attempted: 0, failed: [], mismatchLines: 0, skipped: false }
  const scenario = library.find(entry => entry.name === 'plain-text') ?? library[0]
  if (!scenario || targets.length === 0) {
    lane.skipped = true
    return lane
  }

  // 每个场景取一条,最多 8 条 —— 覆盖不同形状(工具 / 压缩 / steering / 编辑)。
  const picked = []
  const seen = new Set()
  for (const entry of targets) {
    if (seen.has(entry.scenario)) continue
    if (exclude?.has(entry.sessionId)) continue
    seen.add(entry.scenario)
    picked.push(entry)
    if (picked.length >= 8) break
  }
  if (picked.length === 0) {
    lane.skipped = true
    return lane
  }
  for (const entry of picked) exclude?.add(entry.sessionId)

  await stopServer()
  await sleep(300)
  const before = countShadowLines(store)
  console.log(`[battery] hydrate lane [${label}]: restarting with an empty LRU (${picked.length} session(s))`)
  await startServer(env)

  for (const entry of picked) {
    lane.attempted += 1
    try {
      const variant = makeVariant(makeRng(entry.sessionId.length + lane.attempted), 0)
      const d = new Driver(api, entry.sessionId, scenario.name, variant, store)
      // 冷加载发生在这一句:新进程的 LRU 是空的,store 从投影补水。
      const beforeMessages = await d.messages()
      const assistants = beforeMessages.filter(m => m.role === 'assistant').length
      if (beforeMessages.length === 0) throw new Error('cold load produced an empty session')
      await d.send('再说一句')
      const after = await d.waitIdle(assistants + 1)
      // 补水没吞历史:接着写的这一轮是**加**在原来那段上面的。
      if (after.length < beforeMessages.length + 2) {
        throw new Error(`history shrank after hydrate: ${beforeMessages.length} → ${after.length}`)
      }
    } catch (error) {
      lane.failed.push(`${entry.scenario}/${entry.sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  await sleep(2500)
  lane.mismatchLines = countShadowLines(store) - before
  return lane
}

// ============================================================ 停写泳道(S3w-2)

/** 这条会话的 `messages.jsonl` 有多大(不存在 = 0)。停写档它必须一直是 0。 */
function transcriptBytes(store, sessionId) {
  try {
    return fs.statSync(path.join(store, 'sessions', sessionId, 'messages.jsonl')).size
  } catch {
    return 0
  }
}

/**
 * **停写泳道**(S3w-2,§14.3-A/C)—— `ONETHING_SESSION_TRANSCRIPT=off` 下把
 * **全场景**再跑一遍。
 *
 * 它是"events 成为唯一持久化"的端到端预演:抄本一个字节都不写,所有产品行为
 * (读、补水、压缩、steering、权限、生图…)只能靠事件账本活着。
 *
 * 判据换了口径(§14.3-C:一次性 store 上依赖 `messages.jsonl` 的断言在这条泳道
 * 改 refold + store):
 *  - 场景自证照旧(它们读的是 `sessions.getMessages`,S2b 之后本来就是投影);
 *  - **抄本不许长**:每条会话跑完 `messages.jsonl` 必须仍然是 0 字节 / 不存在
 *    —— 这条是停写本身的断言,别处没有;
 *  - **影子法官换 refold + store**:这条泳道期间新增的 `session-shadow.jsonl`
 *    行必须为 0。那份文件里现在有两类行:`messages`/`history`(store vs 投影,
 *    语义层)与 `refold`(文件字节 vs 内存活投影,耐久层)——一条都不许有。
 *
 * 只跑**一趟**(每个场景一次),不乘 passes:这条泳道要的是"每个场景在停写档
 * 下都走得通",不是再攒一遍 run 数;乘上去只会把 45s 的矩阵拖成两倍。
 */
async function runTranscriptOffLane({ store, api, library, stopServer, startServer, workdir, seed }) {
  const lane = { attempted: 0, failed: [], mismatchLines: 0, transcriptGrew: [] }

  await stopServer()
  await sleep(300)
  const before = countShadowLines(store)
  console.log(`[battery] transcript-off lane: restarting with ONETHING_SESSION_TRANSCRIPT=off (${library.length} scenario(s))`)
  await startServer({ ONETHING_SESSION_TRANSCRIPT: 'off' })

  for (const scenario of library) {
    lane.attempted += 1
    const label = `${scenario.name}#off`
    let sessionId
    try {
      const created = await api('POST', '/api/sessions', { name: label })
      sessionId = created?.session?.id ?? created?.data?.id ?? created?.id
      if (!sessionId) throw new Error(`no session id: ${JSON.stringify(created).slice(0, 200)}`)
      await rpcCall(api, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: workdir })
      await rpcCall(api, 'sessions', 'updatePermissionMode', {
        sessionId,
        permissionMode: scenario.permissionMode ?? 'dangerously-allow-all',
      })
      const variant = makeVariant(makeRng(seed + lane.attempted), 0)
      const driver = new Driver(api, sessionId, scenario.name, variant, store)
      await scenario.drive(driver)
      // 停写本身的断言:抄本一个字节都不许长出来。
      const bytes = transcriptBytes(store, sessionId)
      if (bytes > 0) lane.transcriptGrew.push(`${scenario.name}/${sessionId}: ${bytes} byte(s)`)
    } catch (error) {
      lane.failed.push(`${label}: ${String(error?.message ?? error)}`)
    }
  }

  await sleep(2500)
  lane.mismatchLines = countShadowLines(store) - before
  return lane
}

// ============================================================ 写失败上抛(S3w-2 裁定 7)

/** 起一个只服务这次探针的 server(自己的 store、自己的端口)。 */
async function bootProbeServer({ store, port, token, extraEnv, out }) {
  const env = {
    ...process.env,
    ONETHING_STORE_PATH: store,
    ONETHING_SERVER_PORT: String(port),
    ONETHING_SERVER_TOKEN: token,
    ONETHING_SESSION_SHADOW: '1',
    ONETHING_LOG: 'warn',
    ...extraEnv,
  }
  delete env.ONETHING_SESSION_HYDRATE
  const proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.on('data', d => out.push(String(d)))
  proc.stderr.on('data', d => out.push(String(d)))
  for (let i = 0; i < 150; i++) {
    await sleep(200)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })
      if (res.ok) {
        return async () => {
          proc.kill('SIGTERM')
          await new Promise(resolve => { proc.on('exit', resolve); setTimeout(resolve, 10_000) })
        }
      }
    } catch { /* not yet */ }
  }
  proc.kill('SIGKILL')
  throw new Error(`probe server never came up:\n${out.join('').slice(-3000)}`)
}

/**
 * **写失败上抛**的注入用例(§14.6 裁定 7)。
 *
 * 注入法:把这条会话的 `events.jsonl` chmod 成只读 —— 之后每一次 append 都
 * EACCES。这是能在真 server 上造出"账本写不进去"的最省事的一刀,而且它命中的
 * 正是那条排队落盘链(不是某个 mock 的分支)。
 *
 * 观察点选 `sessions.removeMessage`:它经命令面 → 翻译器 → 写口,**同步**,
 * 而且不开新的一轮执行 —— 一次 RPC 的成败就是"调用方感不感知得到"的答案。
 * (send-message 也走命令面,但它随后展开一整轮执行,失败会散落在收尾链的
 * 好几处,判据不干净。)
 *
 * 两档的分歧就是裁定 7 本身:
 *  - `off` —— 至少有一次 `removeMessage` **报错**(账本是唯一持久化,写不进去
 *    不再可吞);
 *  - `shadow` —— 两次都不报错,失败**只计数**(`appendFailures > 0`)。
 *
 * 探针跑在**自己的 store 上**:它故意制造 `appendFailures`,留在主 store 里会
 * 让最后那道 `sessions:shadow-report` 以一个假理由变红。
 */
async function runWriteFailureProbe({ transcript, mockPort, port, scenarioName, seed }) {
  const probe = { transcript, ok: false, detail: '' }
  const store = fs.mkdtempSync(path.join(os.tmpdir(), `onething-shadow-probe-${transcript}-`))
  const token = `battery-probe-${transcript}`
  const out = []
  let stop
  try {
    const workdir = prepareStore(store, mockPort)
    stop = await bootProbeServer({ store, port, token, extraEnv: { ONETHING_SESSION_TRANSCRIPT: transcript }, out })
    const api = makeApi(port, token)

    const created = await api('POST', '/api/sessions', { name: `write-failure-${transcript}` })
    const sessionId = created?.session?.id ?? created?.data?.id ?? created?.id
    if (!sessionId) throw new Error(`no session id: ${JSON.stringify(created).slice(0, 200)}`)
    await rpcCall(api, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: workdir })
    await rpcCall(api, 'sessions', 'updatePermissionMode', { sessionId, permissionMode: 'dangerously-allow-all' })

    const variant = makeVariant(makeRng(seed), 0)
    const d = new Driver(api, sessionId, scenarioName, variant, store)
    await d.send('先答一次')
    const messages = await d.waitIdle(1)
    const victim = d.lastAssistant(messages)
    const user = messages.find(m => m.role === 'user')
    if (!victim || !user) throw new Error('the probe session never got both a user and an assistant message')

    // 注入:账本从这一刻起写不进去。
    const ledger = path.join(store, 'sessions', sessionId, 'events.jsonl')
    fs.chmodSync(ledger, 0o444)

    // "调用方感知得到"有两种长相,都算数:RPC 信封 `ok:false`(抛到 `rpcCall`),
    // 或者会话域自己把异常收成 `{success:false, error}` —— 后者正是
    // `sessions.removeMessage` 走的路(`removeOnethingMessageForIpc` 的 catch)。
    // 只认前一种的话,这枚探针会在"其实已经报错了"的时候判红。
    let surfaced
    for (const messageId of [victim.id, user.id]) {
      try {
        const result = await d.rpc('sessions', 'removeMessage', { sessionId, messageId })
        if (result?.success === false) surfaced ??= String(result.error ?? 'success:false')
      } catch (error) {
        surfaced ??= String(error?.message ?? error)
      }
      // 第一刀的失败是**排队之后**才发生的,所以给队列一点时间把它变成事实;
      // 上抛的落点是**下一次**同步写口(见 `event-log.ts` 的 `writeFailure`)。
      await sleep(900)
    }
    fs.chmodSync(ledger, 0o644)

    const stats = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(store, 'log', 'session-shadow-stats.json'), 'utf8'))
      } catch {
        return {}
      }
    })()
    const appendFailures = Number(stats.appendFailures) || 0
    if (appendFailures === 0) throw new Error('the injection never bit: appendFailures stayed 0')

    if (transcript === 'off') {
      if (!surfaced) throw new Error('off: the append failure was swallowed — no command error surfaced')
      // 报的必须是**这件事**:一个 "Message not found" 也会让 `surfaced` 有值,
      // 而那时探针就在拿一个不相干的错误当绿灯。
      if (!/session event log write failed/.test(surfaced)) {
        throw new Error(`off: the command failed for another reason — ${surfaced}`)
      }
      probe.detail = `command failed as designed (appendFailures=${appendFailures})`
    } else {
      if (surfaced) throw new Error(`shadow: the failure was raised to the caller — ${surfaced}`)
      probe.detail = `counted only, no command error (appendFailures=${appendFailures})`
    }
    probe.ok = true
  } catch (error) {
    probe.detail = String(error?.message ?? error)
  } finally {
    await stop?.()
    fs.rmSync(store, { recursive: true, force: true })
  }
  return probe
}

async function main() {
  // **默认每次都重建**:矩阵验的是 `packages/**` 里那份投影,而跑的是
  // `dist/server/main.js` 里那份。忘了重建就会拿旧 bundle 报绿(第一次写这个
  // 脚本时就踩了:标题那一类修好了,矩阵照旧红)。`--no-build` 只在反向对照
  // (自己控制 bundle 内容)时用。
  if (!fs.existsSync(SERVER_ENTRY) || !ARGS.noBuild) {
    console.log('[battery] building the server bundle (bun run server:build) …')
    const built = spawnSync('bun', ['run', 'server:build'], { cwd: REPO, encoding: 'utf8' })
    if (built.status !== 0) {
      console.error(built.stdout, built.stderr)
      throw new Error('server:build failed')
    }
  }

  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-shadow-battery-'))
  const mockPort = 18940 + (ARGS.seed % 40)
  const serverPort = 19040 + (ARGS.seed % 40)
  const token = `battery-${ARGS.seed}`
  const workdir = prepareStore(store, mockPort)

  const library = ARGS.only ? SCENARIOS.filter(s => ARGS.only.has(s.name)) : SCENARIOS
  if (library.length === 0) throw new Error('no scenario selected')

  // 一个 pass 大约值多少 run:粗算(每个场景至少 1,steering/编辑/重试/删除/压缩多几个)。
  const runsPerPass = library.length + 5
  const passes = ARGS.passes > 0 ? ARGS.passes : Math.max(1, Math.ceil(ARGS.minRuns / runsPerPass))

  console.log(`[battery] store       : ${store}`)
  console.log(`[battery] scenarios   : ${library.length}`)
  console.log(`[battery] passes      : ${passes} (seed ${ARGS.seed}, concurrency ${ARGS.concurrency})`)

  const mock = await startMockProvider(mockPort, new Map(
    library.map(scenario => [scenario.name, {
      provider: input => scenario.provider({ ...input, workdir }),
    }]),
  ))

  // 三趟都用它起 server:场景矩阵那趟 + 两条补水泳道,差别只在 `extraEnv`
  // (S3w-1 的补水泳道,见下面 `runHydrateLane`)。
  const serverOut = []
  let server
  let stopped = true
  const startServer = async extraEnv => {
    const env = {
      ...process.env,
      ONETHING_STORE_PATH: store,
      ONETHING_SERVER_PORT: String(serverPort),
      ONETHING_SERVER_TOKEN: token,
      ONETHING_SESSION_SHADOW: '1',
      ONETHING_LOG: 'warn',
    }
    // 补水档由脚本自己说了算:先把继承来的那一格摘掉,免得开发者 shell 里
    // 恰好导出过 `ONETHING_SESSION_HYDRATE`,把"默认档泳道"悄悄变成显式档
    // ——那样两条泳道会验同一件事,而报告照样说自己在验两档。
    delete env.ONETHING_SESSION_HYDRATE
    Object.assign(env, extraEnv)
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stopped = false
    server.stdout.on('data', d => serverOut.push(String(d)))
    server.stderr.on('data', d => serverOut.push(String(d)))
    for (let i = 0; i < 150; i++) {
      await sleep(200)
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/api/sessions`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (res.ok) return
      } catch { /* not yet */ }
    }
    throw new Error(`server never came up:\n${serverOut.join('').slice(-4000)}`)
  }

  const api = makeApi(serverPort, token)
  const results = []
  const hydrateLanes = []
  let offLane
  const writeFailureProbes = []
  const stopServer = async () => {
    if (stopped) return
    stopped = true
    const dying = server
    dying.kill('SIGTERM')
    await new Promise(resolve => { dying.on('exit', resolve); setTimeout(resolve, 10_000) })
  }

  try {
    await startServer()
    console.log('[battery] server up')

    const rng = makeRng(ARGS.seed)
    const jobs = []
    for (let pass = 0; pass < passes; pass++) {
      for (const scenario of library) {
        jobs.push({ scenario, variant: makeVariant(rng, pass) })
      }
    }

    const started = Date.now()
    let done = 0
    await withConcurrency(jobs, ARGS.concurrency, async ({ scenario, variant }) => {
      const label = `${scenario.name}#${variant.pass}`
      let sessionId
      try {
        const created = await api('POST', '/api/sessions', { name: label })
        sessionId = created?.session?.id ?? created?.data?.id ?? created?.id
        if (!sessionId) throw new Error(`no session id: ${JSON.stringify(created).slice(0, 200)}`)
        await rpcCall(api, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: workdir })
        await rpcCall(api, 'sessions', 'updatePermissionMode', {
          sessionId,
          permissionMode: scenario.permissionMode ?? 'dangerously-allow-all',
        })
        const driver = new Driver(api, sessionId, scenario.name, variant, store)
        await scenario.drive(driver)
        results.push({ label, scenario: scenario.name, sessionId, ok: true })
      } catch (error) {
        results.push({ label, scenario: scenario.name, sessionId, ok: false, error: String(error?.message ?? error) })
      } finally {
        done += 1
        if (done % 10 === 0) {
          process.stdout.write(`[battery] ${done}/${jobs.length} (${Math.round((Date.now() - started) / 1000)}s)\n`)
        }
      }
    })

    // 统计表是 1s 节流写、`unref` 的定时器,关停时没人 flush —— 等它自己落一次。
    await sleep(2500)

    // ---- 补水泳道(S3w-1,§14.4;批 3 起两条,§15.10)
    //
    // 第一趟把会话写完就把进程杀掉;后面每一趟都换一个**空 LRU 的新进程**,
    // 再往一批(彼此不相交的)会话上各接一轮。那一轮的第一件事就是冷加载,
    // 接着 run 收尾时影子照常比"store vs 投影":补水形状只要漂了一格,当场红。
    // 换句话说,这两条泳道用**既有的影子法官**验补水,不新造判据。
    //
    //  - `default` —— 不设 `ONETHING_SESSION_HYDRATE`。批 3 翻默认之后它 = 投影
    //    补水,验的就是产品出厂那条路;
    //  - `legacy` —— 显式 `ONETHING_SESSION_HYDRATE=messages`,即**回滚杆**。
    //    它也必须一直被测着:没人跑的回滚杆,等到真要回滚那天才发现是坏的。
    const laneTargets = results.filter(entry => entry.ok && entry.sessionId)
    const laneTaken = new Set()
    for (const spec of [
      { label: 'default (= projection)', env: {} },
      { label: 'legacy rollback (ONETHING_SESSION_HYDRATE=messages)', env: { ONETHING_SESSION_HYDRATE: 'messages' } },
    ]) {
      hydrateLanes.push(await runHydrateLane({
        store, api, library, stopServer, startServer,
        targets: laneTargets, label: spec.label, env: spec.env, exclude: laneTaken,
      }))
    }

    // ---- 停写泳道(S3w-2,§14.3-A/C):`ONETHING_SESSION_TRANSCRIPT=off` 全场景
    //
    // 放在最后:它把 server 换到停写档,之后这个 store 上再建的会话都不写抄本
    // —— 前面两条泳道要的正是"抄本还在"的世界,顺序不能反。
    offLane = await runTranscriptOffLane({
      store, api, library, stopServer, startServer, workdir, seed: ARGS.seed + 991,
    })

    // ---- 写失败上抛(S3w-2 裁定 7):同一刀注两档,看两档答得一不一样。
    // 各跑在自己的 store 上(它们故意制造 appendFailures),端口也各占一个。
    const probeScenario = (library.find(s => s.name === 'plain-text') ?? library[0]).name
    for (const [index, transcript] of ['off', 'shadow'].entries()) {
      console.log(`[battery] write-failure probe [${transcript}] …`)
      writeFailureProbes.push(await runWriteFailureProbe({
        transcript,
        mockPort,
        port: serverPort + 100 + index,
        scenarioName: probeScenario,
        seed: ARGS.seed + 7 + index,
      }))
    }
  } finally {
    await stopServer()
    mock.close()
    await sleep(300)
  }

  // ---- 报告

  const shadowLog = path.join(store, 'log', 'session-shadow.jsonl')
  const lines = fs.existsSync(shadowLog)
    ? fs.readFileSync(shadowLog, 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    : []
  const mismatchesBySession = new Map()
  for (const line of lines) {
    mismatchesBySession.set(line.sessionId, (mismatchesBySession.get(line.sessionId) ?? 0) + 1)
  }

  const perScenario = new Map()
  for (const result of results) {
    const entry = perScenario.get(result.scenario)
      ?? { ok: 0, failed: 0, mismatches: 0, errors: [] }
    if (result.ok) entry.ok += 1
    else { entry.failed += 1; entry.errors.push(`${result.label}: ${result.error}`) }
    entry.mismatches += mismatchesBySession.get(result.sessionId) ?? 0
    perScenario.set(result.scenario, entry)
  }

  console.log('\n[battery] per scenario:')
  let anyRed = false
  for (const scenario of library) {
    const entry = perScenario.get(scenario.name) ?? { ok: 0, failed: 0, mismatches: 0, errors: [] }
    const red = entry.failed > 0 || entry.mismatches > 0
    if (red) anyRed = true
    console.log(
      `  ${red ? 'FAIL' : 'PASS'}  ${scenario.name.padEnd(22)} ok=${entry.ok} failed=${entry.failed} mismatch-lines=${entry.mismatches}`,
    )
    for (const error of entry.errors.slice(0, 3)) console.log(`        ${error}`)
  }

  if (hydrateLanes.length > 0) {
    console.log('\n[battery] hydrate lanes (S3w-1 cold load, §15.10 两档):')
    for (const lane of hydrateLanes) {
      // 跳过也算红:两档都必须真的跑过 —— 静默少跑一档,门就不再看着回滚杆了。
      const red = lane.skipped || lane.failed.length > 0 || lane.mismatchLines > 0
      if (red) anyRed = true
      console.log(
        `  ${red ? 'FAIL' : 'PASS'}  ${lane.label}`
        + ` sessions=${lane.attempted} failed=${lane.failed.length}`
        + ` new-mismatch-lines=${lane.mismatchLines}${lane.skipped ? ' (skipped — no target session)' : ''}`,
      )
      for (const error of lane.failed.slice(0, 5)) console.log(`        ${error}`)
    }
  }

  if (offLane) {
    console.log('\n[battery] transcript-off lane (S3w-2,§14.3-A/C:events 是唯一持久化):')
    const red = offLane.failed.length > 0 || offLane.mismatchLines > 0 || offLane.transcriptGrew.length > 0
    if (red) anyRed = true
    console.log(
      `  ${red ? 'FAIL' : 'PASS'}  ONETHING_SESSION_TRANSCRIPT=off`
      + ` scenarios=${offLane.attempted} failed=${offLane.failed.length}`
      + ` new-mismatch-lines=${offLane.mismatchLines} transcript-grew=${offLane.transcriptGrew.length}`,
    )
    for (const error of offLane.failed.slice(0, 5)) console.log(`        ${error}`)
    for (const grew of offLane.transcriptGrew.slice(0, 5)) console.log(`        messages.jsonl grew — ${grew}`)
  } else {
    // 泳道没跑到 = 前面就抛了。静默略过等于门自己少看一格。
    anyRed = true
    console.log('\n[battery] transcript-off lane: FAIL (never ran)')
  }

  if (writeFailureProbes.length > 0) {
    console.log('\n[battery] write-failure probes (S3w-2 裁定 7:off 上抛 / shadow 计数):')
    for (const probe of writeFailureProbes) {
      if (!probe.ok) anyRed = true
      console.log(`  ${probe.ok ? 'PASS' : 'FAIL'}  transcript=${probe.transcript.padEnd(7)} ${probe.detail}`)
    }
  } else {
    anyRed = true
    console.log('\n[battery] write-failure probes: FAIL (never ran)')
  }

  console.log('\n[battery] fixed-class coverage:')
  for (const scenario of SCENARIOS) {
    for (const covered of scenario.covers) console.log(`  ${scenario.name.padEnd(22)} ${covered}`)
  }
  console.log('  (TODO) 会话清空 —— 后端 `clearSessionMessages` 今天没有 HTTP/命令出口')

  const report = spawnSync('node', [
    path.join(REPO, 'scripts/session-shadow-report.mjs'),
    '--store', store,
    '--min-runs', String(ARGS.minRuns),
  ], { cwd: REPO, encoding: 'utf8' })
  console.log(`\n${report.stdout ?? ''}${report.stderr ?? ''}`)

  if (ARGS.keepStore) console.log(`[battery] store kept at ${store}`)
  else fs.rmSync(store, { recursive: true, force: true })

  if (anyRed || report.status !== 0) {
    console.error('[battery] RED')
    process.exit(1)
  }
  console.log('[battery] GREEN')
}

main().catch(error => {
  console.error('[battery] fatal:', error)
  process.exit(1)
})
