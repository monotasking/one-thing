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
    return this.api('POST', '/api/streams/abort', { sessionId: this.sessionId })
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
    const result = await this.api('GET', '/api/streams/active')
    return result?.streams ?? result?.sessionIds ?? []
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
   *  3. **引擎自己也不再认为这条会话在跑**(`/api/streams/active`)。
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

  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: store,
      ONETHING_SERVER_PORT: String(serverPort),
      ONETHING_SERVER_TOKEN: token,
      ONETHING_SESSION_SHADOW: '1',
      ONETHING_LOG: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverOut = []
  server.stdout.on('data', d => serverOut.push(String(d)))
  server.stderr.on('data', d => serverOut.push(String(d)))

  const api = makeApi(serverPort, token)
  const results = []
  let stopped = false
  const stopServer = async () => {
    if (stopped) return
    stopped = true
    server.kill('SIGTERM')
    await new Promise(resolve => { server.on('exit', resolve); setTimeout(resolve, 10_000) })
  }

  try {
    let up = false
    for (let i = 0; i < 150; i++) {
      await sleep(200)
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/api/sessions`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (res.ok) { up = true; break }
      } catch { /* not yet */ }
    }
    if (!up) throw new Error(`server never came up:\n${serverOut.join('').slice(-4000)}`)
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
