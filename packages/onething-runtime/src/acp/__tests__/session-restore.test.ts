import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient } from '../client.js'
import { FileACPSessionLinkStore, type ACPSessionLinkStore } from '../session-links.js'
import type { ACPAgentConfig } from '../types.js'

/**
 * 会话映射落盘 + 选项(2026-09-24,用户:「ACP 应该是直接用 agent,我们只是一个会话的映射」)。
 *
 * 夹具是一台**真子进程**的 ACP agent(`fixtures/fake-agent.mjs`,真 ndjson JSON-RPC),
 * 它把会话存在自己的目录里 —— 与 Claude Code / pi 把会话存在 CLI 自己那里同形。
 * 断言的是「断开重连(= 适配器被收 / 桌面重启)之后还是那条会话、模型还是选过的那个」,
 * 所以每条用例都真的 `disconnect()` 再开一只新的 `ACPClient`。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))

let root: string
let agentDir: string
let cwd: string
let links: ACPSessionLinkStore

function config(caps: 'load' | 'resume' | 'none'): ACPAgentConfig {
  return {
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: caps },
    connectTimeoutMs: 10_000,
  } as ACPAgentConfig
}

function client(caps: 'load' | 'resume' | 'none'): ACPClient {
  return new ACPClient(config(caps), { getSessionLinks: () => links })
}

async function say(c: ACPClient, localSessionId: string, prompt = 'hi'): Promise<string> {
  let text = ''
  for await (const event of c.streamPrompt({ localSessionId, prompt, cwd })) {
    if (event.type !== 'update') continue
    const update = event.notification.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') text += update.content.text
  }
  return text
}

/** agent 收到的会话类调用(`init` 那一行是握手,不算)。 */
function methods(): string[] {
  return calls().map(call => call.method).filter(method => method !== 'init')
}

function calls(): Array<{ method: string; id?: string; value?: string; proxy?: string | null }> {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  } catch {
    return []
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-restore-'))
  agentDir = join(root, 'agent')
  cwd = join(root, 'work')
  links = new FileACPSessionLinkStore(() => join(root, 'store', 'acp', 'session-links.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ACP 会话映射落盘', () => {
  it('load 型 agent:重连后回到同一条会话,回放的历史不进这一轮', async () => {
    const first = client('load')
    const a = await say(first, 'local-1')
    await first.disconnect()

    const second = client('load')
    const b = await say(second, 'local-1')
    await second.disconnect()

    const idA = /session=(\S+)/.exec(a)?.[1]
    expect(idA).toBeTruthy()
    expect(b).toContain(`session=${idA}`)
    expect(b).toContain('turns=2')
    expect(b).not.toContain('REPLAYED')
    expect(methods()).toEqual(['new', 'load'])
  })

  it('resume 型 agent 走 resume,不走 load', async () => {
    const first = client('resume')
    await say(first, 'local-1')
    await first.disconnect()
    const second = client('resume')
    const b = await say(second, 'local-1')
    await second.disconnect()
    expect(b).toContain('turns=2')
    expect(methods()).toEqual(['new', 'resume'])
  })

  it('不会恢复的 agent 照旧新开(不报错)', async () => {
    const first = client('none')
    await say(first, 'local-1')
    await first.disconnect()
    const second = client('none')
    const b = await say(second, 'local-1')
    await second.disconnect()
    expect(b).toContain('turns=1')
    expect(methods()).toEqual(['new', 'new'])
  })

  it('link 上记的会话在 agent 那边没了 → 退回新开,并记下新的那条', async () => {
    links.putLink({ agentId: 'fake', localSessionId: 'local-1', acpSessionId: 'gone', cwd, options: {}, updatedAt: 0 })
    const c = client('load')
    const text = await say(c, 'local-1')
    await c.disconnect()
    expect(text).toContain('turns=1')
    const newId = /session=(\S+)/.exec(text)?.[1]
    expect(links.getLink('fake', 'local-1')?.acpSessionId).toBe(newId)
  })
})

describe('agent 自述的选项', () => {
  it('读到的是 agent 列的那几格;改了之后这一轮就用新值', async () => {
    const c = client('load')
    const options = await c.getSessionOptions('local-1', cwd)
    expect(options).toEqual([
      expect.objectContaining({ id: 'model', category: 'model', currentValue: 'alpha' }),
    ])
    expect(options[0].choices.map(choice => choice.value)).toEqual(['alpha', 'beta'])

    const next = await c.setSessionOption('local-1', cwd, 'model', 'beta')
    expect(next[0].currentValue).toBe('beta')
    expect(await say(c, 'local-1')).toContain('model=beta')
    await c.disconnect()
  })

  it('重连后把这条会话选过的值重放回去(load 回来的会话是缺省值)', async () => {
    const first = client('load')
    await first.setSessionOption('local-1', cwd, 'model', 'beta')
    await first.disconnect()

    const second = client('load')
    const text = await say(second, 'local-1')
    await second.disconnect()
    expect(text).toContain('model=beta')
  })

  it('新会话按这台 agent 上次选的值开', async () => {
    const first = client('load')
    await first.setSessionOption('local-1', cwd, 'model', 'beta')
    await first.disconnect()

    const second = client('load')
    const text = await say(second, 'local-2')
    await second.disconnect()
    expect(text).toContain('model=beta')
    expect(links.getProfile('fake')?.preferred).toEqual({ model: 'beta' })
  })

  it('选项面板与发送同时要同一条会话,只开一次', async () => {
    const c = client('load')
    await c.connect()
    await Promise.all([c.getSessionOptions('local-1', cwd), c.getSessionOptions('local-1', cwd)])
    await c.disconnect()
    expect(calls().filter(call => call.method === 'new')).toHaveLength(1)
  })

  it('空串目录按「没绑」处理,不原样递给 agent', async () => {
    const c = client('load')
    await c.getSessionOptions('local-1', '')
    await c.disconnect()
    expect(calls().find(call => call.method !== 'init')).toMatchObject({ method: 'new' })
    expect(links.getLink('fake', 'local-1')?.cwd).toBe(process.cwd())
  })
})

/**
 * 真机那一句 `[object Object]`(2026-09-24 16:46 / 16:53 两次):claude-agent-acp 登录过期时
 * 以 JSON-RPC `authRequired` 拒掉 `session/prompt`,SDK 把那个**普通对象**原样 reject 出来。
 * 这里走的是真子进程 + 真协议,断言的是会话最终拿到的那一句话。
 */
describe('agent 拒掉一轮时交给会话的那句话', () => {
  async function failWith(mode: 'auth' | 'internal'): Promise<unknown> {
    const c = new ACPClient(
      { ...config('load'), env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: 'load', FAKE_AGENT_FAIL: mode } } as ACPAgentConfig,
      { getSessionLinks: () => links },
    )
    try {
      await say(c, 'local-1')
      return undefined
    } catch (error) {
      return error
    } finally {
      await c.disconnect()
    }
  }

  it('authRequired → 一个真 Error,说「没登录」', async () => {
    const error = await failWith('auth')
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('[object Object]')
    expect((error as Error).message).toContain('"Fake" is not logged in')
  })

  it('agent 内部错误 → 带 agent 原话的 Error', async () => {
    const error = await failWith('internal')
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('boom from agent')
  })
})

/** 用户:「而且没有走代理」—— 适配器子进程的环境由宿主给底,桌面给的是「进程环境 + 应用代理」。 */
describe('适配器子进程的环境', () => {
  it('宿主给的环境(应用代理)进了子进程;agent 自己配置的 env 仍然在上面', async () => {
    const c = new ACPClient(config('load'), {
      getSessionLinks: () => links,
      getSpawnEnv: () => ({ ...process.env, HTTPS_PROXY: 'http://proxy.test:7890' }),
    })
    await c.connect()
    await c.disconnect()
    expect(calls()[0]).toEqual({ method: 'init', proxy: 'http://proxy.test:7890' })
  })

  it('没有宿主注入 → 只继承进程环境(旧行为)', async () => {
    const saved = process.env.HTTPS_PROXY
    delete process.env.HTTPS_PROXY
    try {
      const c = client('load')
      await c.connect()
      await c.disconnect()
      expect(calls()[0]).toEqual({ method: 'init', proxy: null })
    } finally {
      if (saved !== undefined) process.env.HTTPS_PROXY = saved
    }
  })
})
