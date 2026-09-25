// 一台最小的 ACP agent(测试夹具):真子进程、真 ndjson JSON-RPC。
// 会话存在 FAKE_AGENT_DIR 下的 JSON 里,所以进程重启之后还能 load 回来 ——
// 这正是「会话在 agent 自己那里」那件事的缩影。
// FAKE_AGENT_CAPS = 'load' | 'resume' | 'none' 决定它声明哪种恢复能力。
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const dir = process.env.FAKE_AGENT_DIR
const caps = process.env.FAKE_AGENT_CAPS ?? 'load'
mkdirSync(dir, { recursive: true })
const file = id => join(dir, `${id}.json`)
const readSession = id => (existsSync(file(id)) ? JSON.parse(readFileSync(file(id), 'utf8')) : undefined)
const writeSession = s => writeFileSync(file(s.id), JSON.stringify(s))
const logCall = entry => writeFileSync(join(dir, 'calls.log'), `${JSON.stringify(entry)}\n`, { flag: 'a' })

const MODELS = [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }]
const configOptions = s => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: MODELS },
]

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(conn => ({
  async initialize() {
    logCall({ method: 'init', proxy: process.env.HTTPS_PROXY ?? null })
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: caps === 'load',
        sessionCapabilities: caps === 'resume' ? { resume: {} } : {},
      },
    }
  },
  async newSession(params) {
    const s = { id: randomUUID(), cwd: params.cwd, model: 'alpha', turns: 0 }
    writeSession(s)
    logCall({ method: 'new', id: s.id, cwd: params.cwd })
    return { sessionId: s.id, configOptions: configOptions(s) }
  },
  async loadSession(params) {
    const s = readSession(params.sessionId)
    if (!s) throw new Error(`Unknown sessionId: ${params.sessionId}`)
    logCall({ method: 'load', id: s.id })
    // 真 agent 会回放历史;onething 此刻没有队列接,应当丢掉。
    await conn.sessionUpdate({
      sessionId: s.id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } },
    })
    return { configOptions: configOptions({ ...s, model: 'alpha' }) }
  },
  async unstable_resumeSession(params) {
    const s = readSession(params.sessionId)
    if (!s) throw new Error(`Unknown sessionId: ${params.sessionId}`)
    logCall({ method: 'resume', id: s.id })
    return { configOptions: configOptions({ ...s, model: 'alpha' }) }
  },
  async setSessionConfigOption(params) {
    const s = readSession(params.sessionId)
    s.model = params.value
    writeSession(s)
    logCall({ method: 'set', id: s.id, value: params.value })
    return { configOptions: configOptions(s) }
  },
  async prompt(params) {
    // 模拟 claude-agent-acp 登录过期:先吐一句正文,再以 authRequired 拒掉这一轮。
    if (process.env.FAKE_AGENT_FAIL === 'auth') {
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Failed to authenticate' } },
      })
      throw RequestError.authRequired()
    }
    if (process.env.FAKE_AGENT_FAIL === 'internal') throw new Error('boom from agent')
    const s = readSession(params.sessionId)
    s.turns += 1
    writeSession(s)
    await conn.sessionUpdate({
      sessionId: s.id,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `session=${s.id} model=${s.model} turns=${s.turns}` },
      },
    })
    return { stopReason: 'end_turn' }
  },
  async cancel() {},
  async authenticate() {},
}), stream)
