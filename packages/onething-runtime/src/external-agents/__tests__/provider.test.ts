import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  missingWorkingDirectoryNotice,
  UNBOUND_WORKING_DIRECTORY_NOTICE,
  createExternalAgentProvider,
} from '../provider.js'
import type {
  ExternalAgentConnector,
  ExternalAgentTurnRequest,
} from '../types.js'

/**
 * 一个**真的存在**的工作目录。provider 在开跑前查它(见
 * `missingWorkingDirectoryNotice`:绑了却已经没了的目录会被就地拒绝),
 * 所以这些用例不能再用一个凭空写死的路径。
 */
const EXISTING_CWD = tmpdir()


function captureConnector(captured: ExternalAgentTurnRequest[]): ExternalAgentConnector {
  return {
    id: 'acp',
    capabilities: {
      streamingText: true,
      thinking: true,
      toolSteps: true,
      permissionBridge: 'callback',
      resume: true,
      fork: true,
      steer: false,
      imagesIn: false,
      mcpInjection: 'config',
      concurrentSessions: 'per-process',
    },
    async *streamTurn(request) {
      captured.push(request)
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    },
    async interrupt() {},
    async dispose() {},
  }
}

describe('createExternalAgentProvider', () => {
  it('maps the pseudo-model to CLI default and forwards real models with thinking/effort', async () => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: captureConnector(captured),
      localSessionId: 'session-1',
      workingDirectory: EXISTING_CWD,
    })

    const drain = async (model: string) => {
      for await (const _event of provider.streamTurn!({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: 'enabled',
        reasoningEffort: 'xhigh',
        turn: 1,
      })) { /* drain */ }
    }

    await drain('acp')
    expect(captured.at(-1)).toMatchObject({
      model: undefined,
      thinking: 'enabled',
      reasoningEffort: 'xhigh',
      cwd: EXISTING_CWD,
    })

    await drain('claude-opus-4-8')
    expect(captured.at(-1)).toMatchObject({ model: 'claude-opus-4-8' })
  })

  /**
   * G9:在 E4 之前这里只取最后一条 user 文本,system 位整个被丢掉 —— 房间回合的
   * system prompt **就是** persona(`app/engine/prompt/system-prompt.ts`),丢了它
   * 群里的 Iris 就不是 Iris。
   */
  it('forwards the whole system prompt so the persona reaches the external agent', async () => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: captureConnector(captured),
      localSessionId: 'session-1',
      workingDirectory: EXISTING_CWD,
    })
    for await (const _event of provider.streamTurn!({
      model: 'claude-code',
      messages: [
        { role: 'system', content: '你是 Iris,一个眼光毒、嘴更毒的设计师。' },
        { role: 'system', content: '<context-variables>now=2026-08-05</context-variables>' },
        { role: 'user', content: '这版首页你怎么看?' },
      ],
      turn: 1,
    })) { /* drain */ }

    expect(captured.at(-1)?.systemPrompt).toBe(
      '你是 Iris,一个眼光毒、嘴更毒的设计师。\n\n<context-variables>now=2026-08-05</context-variables>',
    )
    // prompt 仍是最后一条 user 文本 —— 上下文归上下文,这一轮的问题归问题。
    expect(captured.at(-1)?.prompt).toBe('这版首页你怎么看?')
  })

  it('omits systemPrompt entirely when the turn carries no system message', async () => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: captureConnector(captured),
      localSessionId: 'session-1',
      workingDirectory: EXISTING_CWD,
    })
    for await (const _event of provider.streamTurn!({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'hi' }],
      turn: 1,
    })) { /* drain */ }
    expect(captured.at(-1)).not.toHaveProperty('systemPrompt')
  })

  /**
   * 止血 2(2026-08-11):以前这里兜底 `process.cwd()` —— 开发时那恰好是仓库根,
   * 打包后是 `/`,外部 agent 在空目录里摸索而界面上没有一个字。现在它**不开跑**,
   * 并且把「该做什么」说出来。
   */
  it.each([undefined, '', '   '])(
    'refuses to start and says why when the working directory is %p',
    async workingDirectory => {
      const captured: ExternalAgentTurnRequest[] = []
      const provider = createExternalAgentProvider({
        providerId: 'acp',
        connector: captureConnector(captured),
        localSessionId: 'session-1',
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      })
      const events = []
      for await (const event of provider.streamTurn!({
        model: 'claude-code',
        messages: [{ role: 'user', content: 'hi' }],
        turn: 1,
      })) events.push(event)

      // 连接器一次都没被调用 —— 拒绝发生在开跑之前。
      expect(captured).toHaveLength(0)
      expect(events).toEqual([
        { type: 'text-delta', turn: 1, delta: UNBOUND_WORKING_DIRECTORY_NOTICE },
        { type: 'finish', turn: 1, finishReason: 'error' },
      ])
      expect(UNBOUND_WORKING_DIRECTORY_NOTICE).toContain('/cd')
    },
  )

  /**
   * **绑了但没了**(2026-08-12 真机)。
   *
   * 用户拆掉一个 worktree 之后再在那条会话里发消息:目录不存在 → spawn 失败 →
   * SDK 把任何一种启动失败都翻成同一句「Claude Code binary failed to launch」,
   * 外加一段关于 musl / glibc 的排查建议。于是真正的原因(「你绑的目录被你删了」)
   * 被一条查 C 运行时的提示盖住了。
   *
   * 两态都要拒:**不存在**,以及**存在但是个文件**(`existsSync` 对它是真,
   * 只查存在会漏掉一半,而 spawn 照样失败、文案照样误导)。
   */
  it.each([
    ['一个不存在的目录', join(tmpdir(), `onething-missing-${Date.now()}`)],
    ['一个文件而不是目录', fileURLToPath(import.meta.url)],
  ])('refuses to start and names the real reason when the bound cwd is %s', async (_label, cwd) => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: captureConnector(captured),
      localSessionId: 'session-1',
      workingDirectory: cwd,
    })
    const events = []
    for await (const event of provider.streamTurn!({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'hi' }],
      turn: 1,
    })) events.push(event)

    // 连接器一次都没被调用 —— 拒绝发生在 spawn 之前,所以误导文案根本没机会出现。
    expect(captured).toHaveLength(0)
    expect(events).toEqual([
      { type: 'text-delta', turn: 1, delta: missingWorkingDirectoryNotice(cwd) },
      { type: 'finish', turn: 1, finishReason: 'error' },
    ])
    // 路径要写在脸上:用户得知道是**哪个**目录没了。
    expect(missingWorkingDirectoryNotice(cwd)).toContain(cwd)
    expect(missingWorkingDirectoryNotice(cwd)).toContain('/cd')
  })
})
