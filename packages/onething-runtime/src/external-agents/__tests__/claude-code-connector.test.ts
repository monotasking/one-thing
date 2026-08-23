import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CODE_AGENT_CONNECTOR_ID,
  createClaudeCodeConnector,
} from '../claude-code-connector.js'
import type {
  ClaudeCodeQueryOptions,
  ClaudeCodeSdkMessage,
  ClaudeCodeSdkUserMessage,
} from '../claude-code-connector.js'
import type {
  ExternalAgentEvent,
  ExternalAgentPermissionAsk,
  ExternalAgentPermissionDecision,
} from '../types.js'

async function* replay(messages: ClaudeCodeSdkMessage[]): AsyncGenerator<ClaudeCodeSdkMessage, void, void> {
  for (const message of messages) yield message
}

async function collect(events: AsyncIterable<ExternalAgentEvent>): Promise<ExternalAgentEvent[]> {
  const out: ExternalAgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const initMessage: ClaudeCodeSdkMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'claude-session-1',
}

const fullTurnFixture: ClaudeCodeSdkMessage[] = [
  initMessage,
  {
    type: 'stream_event',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } },
  },
  {
    type: 'stream_event',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Listing files. ' } },
  },
  {
    type: 'stream_event',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' },
    },
  },
  {
    type: 'stream_event',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
  },
  {
    type: 'stream_event',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 2 },
  },
  {
    type: 'user',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file-a\nfile-b' }],
    },
  },
  {
    type: 'stream_event',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  },
  {
    type: 'result',
    subtype: 'success',
    session_id: 'claude-session-1',
    result: 'Done.',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 80 },
  },
]

describe('ClaudeCodeConnector', () => {
  it('maps the SDK stream to normalized events with externally-executed tools', async () => {
    const captured: {
      prompt: AsyncIterable<ClaudeCodeSdkUserMessage>
      promptText: string
      options: ClaudeCodeQueryOptions
    }[] = []
    const connector = createClaudeCodeConnector({
      executablePath: '/usr/local/bin/claude',
      permissionHandler: async () => ({ behavior: 'allow' as const }),
      queryFn: params => {
        captured.push(params)
        return replay(fullTurnFixture)
      },
      now: () => 1000,
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      messageId: 'msg-1',
      prompt: 'list files',
      cwd: '/tmp/project',
      turn: 1,
    }))

    /**
     * **prompt 必须是迭代器**(2026-08-11 后台子代理审批事故)。字符串形状会让 SDK
     * 把这一轮标成 `isSingleUserTurn`,于是第一条 result 就关掉 CLI 的 stdin ——
     * 而那正是 `canUseTool` 的控制通道。原文并列走 `promptText`。
     */
    expect(captured[0].promptText).toBe('list files')
    expect(typeof (captured[0].prompt as AsyncIterable<unknown>)[Symbol.asyncIterator])
      .toBe('function')
    const firstInput = await captured[0].prompt[Symbol.asyncIterator]().next()
    // 无图的普通回合形状**逐字不变**(2026-08-12 加图片块之后的回归线):
    // 一条消息一个文本块,没有多出来的任何东西。
    expect(firstInput.value?.message.content).toEqual([{ type: 'text', text: 'list files' }])

    expect(captured[0].options).toMatchObject({
      cwd: '/tmp/project',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      includePartialMessages: true,
      permissionMode: 'default',
    })

    expect(events[0]).toEqual({
      type: 'session-established',
      link: {
        localSessionId: 'session-1',
        connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
        externalSessionId: 'claude-session-1',
        cwd: '/tmp/project',
        createdAt: 1000,
        lastUsedAt: 1000,
      },
    })
    expect(events.slice(1).map(event => event.type)).toEqual([
      'reasoning-delta',
      'text-delta',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-done',
      'tool-result',
      // F4:工具结果到齐、下一段正文开始 = 新的一轮。这条 finish(tool_calls) 与
      // 本地 provider 的 turn 分界逐字相同,执行器据它给下一轮另开一个
      // `data-steps` 锚点 —— 少了它,后面的工具卡会全部塌回第一个锚点。
      'finish',
      'text-delta',
      'provider-data',
      'finish',
    ])
    expect(events.filter(event => event.type === 'finish').map(event => (
      (event as { finishReason: string }).finishReason
    ))).toEqual(['tool_calls', 'stop'])
    const done = events.find(event => event.type === 'tool-call-done')
    expect(done).toMatchObject({
      toolCall: { id: 'toolu_1', name: 'Bash', arguments: '{"command":"ls"}', externallyExecuted: true },
    })
    const result = events.find(event => event.type === 'tool-result')
    expect(result).toMatchObject({ result: { content: 'file-a\nfile-b' } })
    const finish = events.at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      // Anthropic 口径:总输入 = input_tokens + cache_read(互斥),所以
      // 100 + 80 = 180 —— P1-d2 的行为修正,以前这里少算了缓存命中的那 80。
      usage: { inputTokens: 180, outputTokens: 40, totalTokens: 220, cacheReadTokens: 80 },
    })
    const cost = events.find(event => event.type === 'provider-data')
    expect(cost).toMatchObject({ providerData: { type: 'cost', costUSD: 0.0123 } })
  })

  /**
   * **P1-2**(`docs/audit/claude-code-sdk-audit-2026-08-11.md`「两不管地带」)。
   *
   * 缺席 = SDK 加载全部文件系统设置,用户全局 `~/.claude/settings.json` 的 allow
   * 规则在 CLI 侧先行放行,`canUseTool` 不被调用 —— 审批面就此失明。而 CLAUDE.md
   * 的读取又恰恰依赖 'project' 这一源。两件事咬在同一个字段上,所以它必须是显式的。
   */
  it('只声明 project 一层设置源:摘掉全局白名单的先行放行,同时保住仓库 CLAUDE.md', async () => {
    const captured: { options: ClaudeCodeQueryOptions }[] = []
    const connector = createClaudeCodeConnector({
      queryFn: params => {
        captured.push(params)
        return replay([initMessage, { type: 'result', subtype: 'success', session_id: 's' }])
      },
    })
    await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'hi',
      cwd: '/tmp/project',
      turn: 1,
    }))

    expect(captured[0].options.settingSources).toEqual(['project'])
    // 'user' 与 'local' 都是**看不见的**白名单,一个都不收。
    expect(captured[0].options.settingSources).not.toContain('user')
    expect(captured[0].options.settingSources).not.toContain('local')
  })

  /**
   * **P1-3**(`docs/audit/claude-code-sdk-audit-2026-08-11.md`「两不管地带」)。
   *
   * `SDKPermissionDeniedMessage` 是 `type:'system'` 的子类,而翻译器此前只认四种
   * 消息类型 —— 被 CLI 侧规则拒掉的工具在 UI 上凭空消失,用户只看到模型忽然改口。
   */
  it('CLI 侧 auto-deny 结算成那张卡自己的失败,理由写在卡上', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => replay([
        initMessage,
        {
          type: 'stream_event',
          session_id: 'claude-session-1',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_denied', name: 'Bash' },
          },
        },
        {
          type: 'stream_event',
          session_id: 'claude-session-1',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"command":"rm -rf ./build"}' },
          },
        },
        { type: 'stream_event', session_id: 'claude-session-1', event: { type: 'content_block_stop', index: 0 } },
        {
          type: 'system',
          subtype: 'permission_denied',
          session_id: 'claude-session-1',
          tool_name: 'Bash',
          tool_use_id: 'toolu_denied',
          decision_reason_type: 'rule',
          decision_reason: 'Bash(rm:*) is denied by settings',
        },
        { type: 'result', subtype: 'success', session_id: 'claude-session-1' },
      ]),
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'clean up',
      cwd: '/tmp/project',
      turn: 1,
    }))
    const result = events.find(event => event.type === 'tool-result') as
      | { toolCall: { id: string }; result: { error?: string } }
      | undefined
    expect(result?.toolCall.id).toBe('toolu_denied')
    expect(result?.result.error).toContain('被 Claude Code 侧配置拒绝')
    expect(result?.result.error).toContain('rule')
    expect(result?.result.error).toContain('Bash(rm:*) is denied by settings')
    // 一次拒绝只结算一次 —— 后到的 is_error tool_result 会被 settled 挡掉。
    expect(events.filter(event => event.type === 'tool-result')).toHaveLength(1)
  })

  it('拒得比工具卡还早时回落成一句可见的正文,而不是静默', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => replay([
        initMessage,
        {
          type: 'system',
          subtype: 'permission_denied',
          session_id: 'claude-session-1',
          tool_name: 'Write',
          tool_use_id: 'toolu_unknown',
          // 理由缺席:两级回落都空的那一支也必须说得出话。
        },
        { type: 'result', subtype: 'success', session_id: 'claude-session-1' },
      ]),
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'write it',
      cwd: '/tmp/project',
      turn: 1,
    }))
    const text = events.find(event => event.type === 'text-delta') as { delta: string } | undefined
    expect(text?.delta).toContain('工具 Write 被 Claude Code 侧配置拒绝')
    expect(events.some(event => event.type === 'tool-result')).toBe(false)
  })

  it('system 的其它 subtype 照旧沉默(init 不该变成正文)', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => replay([
        initMessage,
        { type: 'result', subtype: 'success', session_id: 'claude-session-1' },
      ]),
    })
    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'hi',
      cwd: '/tmp/project',
      turn: 1,
    }))
    expect(events.some(event => event.type === 'text-delta')).toBe(false)
  })

  it('routes canUseTool through the permission handler and denies on deny/throw/missing', async () => {
    const asks: ExternalAgentPermissionAsk[] = []
    let verdict: ExternalAgentPermissionDecision | Error = { behavior: 'allow' }
    const handler = async (ask: ExternalAgentPermissionAsk) => {
      asks.push(ask)
      if (verdict instanceof Error) throw verdict
      return verdict
    }

    let canUseTool: NonNullable<ClaudeCodeQueryOptions['canUseTool']> | undefined
    const capture = createClaudeCodeConnector({
      permissionHandler: handler,
      queryFn: params => {
        canUseTool = params.options.canUseTool
        return replay([initMessage, { type: 'result', subtype: 'success', session_id: 'claude-session-1' }])
      },
    })
    await collect(capture.streamTurn({
      localSessionId: 'session-1',
      messageId: 'msg-7',
      prompt: 'hi',
      cwd: '/tmp/p',
      turn: 1,
    }))
    if (!canUseTool) throw new Error('canUseTool was not passed to the SDK')
    const signal = new AbortController().signal

    await expect(
      canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 'toolu_01' }),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    })
    expect(asks.at(-1)).toEqual({
      connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
      localSessionId: 'session-1',
      messageId: 'msg-7',
      cwd: '/tmp/p',
      toolName: 'Bash',
      input: { command: 'ls' },
      // G1:SDK 给的 toolUseID 必须原样过桥,否则卡片永远匹配不上 toolCall。
      toolCallId: 'toolu_01',
    })

    verdict = { behavior: 'deny', message: '无人响应,权限请求在 120 秒后自动拒绝' }
    await expect(canUseTool('Bash', {}, { signal, toolUseID: 't2' })).resolves.toEqual({
      behavior: 'deny',
      message: '无人响应,权限请求在 120 秒后自动拒绝',
    })

    verdict = new Error('boom')
    await expect(canUseTool('Bash', {}, { signal, toolUseID: 't3' })).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('boom'),
    })

    // Connector without a handler must fail closed.
    let noHandlerCanUse: NonNullable<ClaudeCodeQueryOptions['canUseTool']> | undefined
    const noHandler = createClaudeCodeConnector({
      queryFn: params => {
        noHandlerCanUse = params.options.canUseTool
        return replay([{ type: 'result', subtype: 'success' }])
      },
    })
    await collect(noHandler.streamTurn({
      localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1,
    }))
    await expect(
      noHandlerCanUse!('Bash', {}, { signal, toolUseID: 't4' }),
    ).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('skips subagent-nested messages and settles unreported tool calls at result', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => replay([
        initMessage,
        // Nested under a Task subagent — must be ignored entirely.
        {
          type: 'stream_event',
          session_id: 'claude-session-1',
          parent_tool_use_id: 'toolu_parent',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NESTED' } },
        },
        // Backfill path: assistant message declares a tool call with no prior stream events.
        {
          type: 'assistant',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a.ts' } }],
          },
        },
        { type: 'result', subtype: 'error_max_turns', session_id: 'claude-session-1' },
      ]),
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'read',
      cwd: '/tmp',
      turn: 1,
    }))

    // 嵌套在 Task 子 agent 下的那段正文一个字都不该冒出来。
    expect(events.some(event => event.type === 'text-delta' && event.delta.includes('NESTED')))
      .toBe(false)
    expect(events.map(event => event.type)).toEqual([
      'session-established',
      'tool-call-start',
      'tool-call-done',
      'tool-result',
      // 失败 result 现在先补一条可见正文(止血 1),再收 finish。
      'text-delta',
      'finish',
    ])
    const done = events.find(event => event.type === 'tool-call-done')
    expect(done).toMatchObject({
      toolCall: { id: 'toolu_2', name: 'Read', arguments: '{"file_path":"a.ts"}', externallyExecuted: true },
    })
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' })
  })

  /**
   * 止血 1(2026-08-11):失败要说人话。限流 / 额度用尽 / 登录过期 / resume 失效
   * 在此之前一律表现为「回合突然结束什么都没说」,原文只进 console.warn。
   */
  it('surfaces the SDK failure text as visible content before finishing with error', async () => {
    const warned: string[] = []
    const connector = createClaudeCodeConnector({
      logger: { log: () => {}, warn: (line: string) => warned.push(line) },
      queryFn: () => replay([
        initMessage,
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'claude-session-1',
          is_error: true,
          result: 'Claude AI usage limit reached|1754899200',
        },
      ]),
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'go',
      cwd: '/tmp',
      turn: 1,
    }))

    const notice = events.find(event => event.type === 'text-delta')
    expect(notice).toBeDefined()
    // 原文一字不改地带出来,subtype 同屏 —— 排障时这两个是两个不同的结论。
    expect((notice as { delta: string }).delta).toContain('Claude AI usage limit reached|1754899200')
    expect((notice as { delta: string }).delta).toContain('error_during_execution')
    // 正文在 finish 之前,否则回合已经收了才补文本,面上还是什么都不显示。
    expect(events.map(event => event.type)).toEqual(['session-established', 'text-delta', 'finish'])
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'error' })
    // 日志那条保留(排障要全量 JSON),但它不再是唯一的出口。
    expect(warned).toHaveLength(1)
  })

  it('still says something when the failed result carries no text at all', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => replay([{ type: 'result', subtype: 'error_max_turns', session_id: 's' }]),
    })
    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'go',
      cwd: '/tmp',
      turn: 1,
    }))
    const notice = events.find(event => event.type === 'text-delta') as { delta: string } | undefined
    expect(notice?.delta).toContain('error_max_turns')
    expect(notice?.delta.length).toBeGreaterThan(10)
  })

  it('says nothing extra on a successful result', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => replay([{ type: 'result', subtype: 'success', session_id: 's', result: 'Done.' }]),
    })
    const events = await collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'go',
      cwd: '/tmp',
      turn: 1,
    }))
    expect(events.map(event => event.type)).toEqual(['session-established', 'finish'])
  })

  it('injects the host-resolved spawn env (proxy) into the SDK options', async () => {
    const captured: ClaudeCodeQueryOptions[] = []
    const connector = createClaudeCodeConnector({
      resolveSpawnEnv: () => ({ PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:7890' }),
      queryFn: params => {
        captured.push(params.options)
        return replay([{ type: 'result', subtype: 'success', session_id: 's1' }])
      },
    })
    await collect(connector.streamTurn({ localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1 }))
    expect(captured[0].env).toEqual({ PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:7890' })

    // Without a resolver the option is omitted so the SDK inherits process env.
    const bare = createClaudeCodeConnector({
      queryFn: params => {
        captured.push(params.options)
        return replay([{ type: 'result', subtype: 'success', session_id: 's2' }])
      },
    })
    await collect(bare.streamTurn({ localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1 }))
    expect('env' in captured[1]).toBe(false)
  })

  it('synthesizes a diff metadata event for Edit/Write calls so the app renders the diff UI', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => replay([
        initMessage,
        {
          type: 'assistant',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'toolu_edit',
              name: 'Edit',
              input: {
                file_path: '/tmp/a.swift',
                old_string: 'let a = 1',
                new_string: 'let a = 2',
              },
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'claude-session-1' },
      ]),
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 's', prompt: 'edit it', cwd: '/tmp', turn: 1,
    }))
    const metadata = events.find(event => event.type === 'tool-metadata')
    expect(metadata).toMatchObject({
      toolCall: { id: 'toolu_edit', externallyExecuted: true },
      update: {
        metadata: {
          path: '/tmp/a.swift',
          additions: 1,
          deletions: 1,
        },
      },
    })
    const diff = (metadata as unknown as { update: { metadata: { diff: string } } }).update.metadata.diff
    expect(diff).toContain('-let a = 1')
    expect(diff).toContain('+let a = 2')

    // Bash calls stay diff-free.
    const bash = createClaudeCodeConnector({
      queryFn: () => replay([
        initMessage,
        {
          type: 'assistant',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'ls' } }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'claude-session-1' },
      ]),
    })
    const bashEvents = await collect(bash.streamTurn({
      localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1,
    }))
    expect(bashEvents.some(event => event.type === 'tool-metadata')).toBe(false)
  })

  it('maps thinking/effort onto SDK options with claude family semantics', async () => {
    const captured: ClaudeCodeQueryOptions[] = []
    const connector = createClaudeCodeConnector({
      queryFn: params => {
        captured.push(params.options)
        return replay([{ type: 'result', subtype: 'success', session_id: 's' }])
      },
    })
    const run = (input: { model?: string; thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }) =>
      collect(connector.streamTurn({
        localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1, ...input,
      }))

    await run({ thinking: 'enabled', reasoningEffort: 'xhigh', model: 'claude-fable-5' })
    expect(captured.at(-1)).toMatchObject({ effort: 'xhigh' })
    expect(captured.at(-1)?.thinking).toBeUndefined()

    // minimal collapses to the CLI's lowest tier.
    await run({ thinking: 'enabled', reasoningEffort: 'minimal' })
    expect(captured.at(-1)).toMatchObject({ effort: 'low' })

    // Explicit off is only sent to families that accept the param.
    await run({ thinking: 'disabled', model: 'claude-sonnet-5' })
    expect(captured.at(-1)?.thinking).toEqual({ type: 'disabled' })

    await run({ thinking: 'disabled', model: 'claude-fable-5' })
    expect(captured.at(-1)?.thinking).toBeUndefined()

    // Unknown model = the CLI default (adaptive family), NOT "skip the
    // override": the pseudo-model path erases the model, so bailing out here
    // would make the Off setting unswitchable.
    await run({ thinking: 'disabled' })
    expect(captured.at(-1)?.thinking).toEqual({ type: 'disabled' })
    expect(captured.at(-1)?.effort).toBeUndefined()
  })

  it('asks for summarized thinking so the panel gets prose instead of redacted deltas', async () => {
    const captured: ClaudeCodeQueryOptions[] = []
    const connector = createClaudeCodeConnector({
      queryFn: params => {
        captured.push(params.options)
        return replay([{ type: 'result', subtype: 'success', session_id: 's' }])
      },
    })
    const run = (input: { model?: string; thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'low' | 'high' }) =>
      collect(connector.streamTurn({
        localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1, ...input,
      }))

    // Adaptive family: display carries the thinking text, effort rides along.
    await run({ thinking: 'enabled', reasoningEffort: 'high', model: 'claude-sonnet-5' })
    expect(captured.at(-1)?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(captured.at(-1)?.effort).toBe('high')

    // Unknown model (CLI default) is adaptive too — the common path.
    await run({ thinking: 'enabled' })
    expect(captured.at(-1)?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })

    // Pre-4.6 family has no adaptive dialect: no thinking param at all.
    await run({ thinking: 'enabled', model: 'claude-opus-4-1' })
    expect(captured.at(-1)?.thinking).toBeUndefined()
  })

  it('resumes with the persisted external session id and aborts via interrupt', async () => {
    const captured: ClaudeCodeQueryOptions[] = []
    const connector = createClaudeCodeConnector({
      queryFn: params => {
        captured.push(params.options)
        return replay([{ type: 'result', subtype: 'success', session_id: 'claude-session-9' }])
      },
    })

    const iteration = collect(connector.streamTurn({
      localSessionId: 'session-1',
      prompt: 'continue',
      cwd: '/tmp/project',
      turn: 1,
      resume: {
        localSessionId: 'session-1',
        connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
        externalSessionId: 'claude-session-9',
        cwd: '/tmp/project',
        createdAt: 1,
        lastUsedAt: 2,
      },
    }))
    await iteration
    expect(captured[0].resume).toBe('claude-session-9')

    // interrupt aborts the per-session controller passed to the SDK.
    const abortSeen = vi.fn()
    const slow = createClaudeCodeConnector({
      queryFn: params => {
        params.options.abortController?.signal.addEventListener('abort', abortSeen)
        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's' } as ClaudeCodeSdkMessage
          await new Promise(resolve => setTimeout(resolve, 5))
          yield { type: 'result', subtype: 'success' } as ClaudeCodeSdkMessage
        })()
      },
    })
    const run = collect(slow.streamTurn({ localSessionId: 'session-2', prompt: 'x', cwd: '/tmp', turn: 1 }))
    await slow.interrupt('session-2')
    await run
    expect(abortSeen).toHaveBeenCalled()
  })
})

/**
 * **后台子代理的审批通道**(2026-08-11 真机事故)。
 *
 * 症状:SDK 会话里后台子代理在主回合收工后调用需审批的工具,全部以
 * `Tool permission request failed: AbortError: Stream closed` 被拒。
 *
 * 根因不在审批逻辑,在**输入形状**:prompt 传字符串时 SDK 把这一轮标成
 * `isSingleUserTurn`,`Query.readMessages` 于是在第一条 `result` 到达时就
 * `transport.endInput()` —— 而 stdin 正是 `canUseTool` 的控制通道。后台子代理
 * (`Agent` 工具的 `run_in_background`,SDK 默认为 true)恰恰在主 result **之后**
 * 才碰工具,所以它的每一次审批都必然撞上一条已经关掉的通道。
 *
 * 这一组用例锁的是**通道的寿命**,不是审批的判断:
 *  - 有后台任务 → 主 result 之后输入仍开着,审批回调照样被调用;
 *  - 零后台 → result 当场收口,一毫秒都不多等(普通回合零退化);
 *  - 判据失灵 → 墙钟防呆兜底,如实说话再收口,绝不挂起。
 */
describe('ClaudeCodeConnector 后台子代理生命周期', () => {
  const AGENT_CALL = 'toolu_agent_1'

  /** 读输入迭代器,并记下它是在**第几条**下行消息之后被放开的。 */
  function watchInput(
    prompt: AsyncIterable<unknown>,
    yieldedSoFar: () => number,
    state: { closedAfter: number | null },
  ): Promise<void> {
    const iterator = prompt[Symbol.asyncIterator]()
    return (async () => {
      await iterator.next() // 唯一一条用户消息
      await iterator.next() // 挂起,直到连接器 close()
      state.closedAfter = yieldedSoFar()
    })()
  }

  const tick = () => new Promise(resolve => setTimeout(resolve, 0))

  it('主 result 之后仍持有输入:后台子代理的审批照常打到宿主,归零后才收口', async () => {
    const asks: ExternalAgentPermissionAsk[] = []
    const state: { closedAfter: number | null } = { closedAfter: null }
    let yielded = 0
    let inputWatch: Promise<void> | undefined
    /** 主 result 到达那一刻,输入是否已经被关掉。这就是事故的判据。 */
    let inputClosedAtMainResult: boolean | null = null

    const connector = createClaudeCodeConnector({
      permissionHandler: async ask => {
        asks.push(ask)
        return { behavior: 'allow' as const }
      },
      queryFn: params => {
        inputWatch = watchInput(params.prompt, () => yielded, state)
        const emit = async function* (): AsyncGenerator<ClaudeCodeSdkMessage, void, void> {
          const send = async function* (message: ClaudeCodeSdkMessage) {
            yielded += 1
            yield message
            await tick()
          }

          yield* send(initMessage)
          // 主回合:派一个后台子代理,拿到「已启动」的即时回执,然后收工。
          yield* send({
            type: 'assistant',
            session_id: 's',
            message: {
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: AGENT_CALL,
                name: 'Agent',
                input: { description: 'edit file', run_in_background: true },
              }],
            },
          })
          yield* send({
            type: 'user',
            session_id: 's',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: AGENT_CALL, content: 'Async agent launched successfully.' }],
            },
          })
          yield* send({
            type: 'system',
            subtype: 'background_tasks_changed',
            session_id: 's',
            tasks: [{ task_id: 'task-1', task_type: 'local_agent', description: 'edit file' }],
          })
          yield* send({
            type: 'stream_event',
            session_id: 's',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DISPATCHED' } },
          })
          yield* send({ type: 'result', subtype: 'success', session_id: 's', result: 'DISPATCHED' })

          // ——— 事故现场:此刻通道必须还活着 ———
          await tick()
          inputClosedAtMainResult = state.closedAfter !== null

          // 后台子代理开始干活,需要审批。SDK 在流还活着时调 canUseTool。
          const decision = await params.options.canUseTool?.(
            'Edit',
            { file_path: '/tmp/project/target.txt', old_string: 'a', new_string: 'b' },
            { signal: new AbortController().signal, toolUseID: 'toolu_edit_1' },
          )
          yielded += 1
          yield {
            type: 'assistant',
            session_id: 's',
            parent_tool_use_id: AGENT_CALL,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `decision=${decision?.behavior}` }],
            },
          }
          await tick()

          // 后台归零 → 收尾轮 → 真正的 result。
          yield* send({ type: 'system', subtype: 'background_tasks_changed', session_id: 's', tasks: [] })
          yield* send({
            type: 'stream_event',
            session_id: 's',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '后台子代理已完成。' } },
          })
          yield* send({
            type: 'result',
            subtype: 'success',
            session_id: 's',
            result: '后台子代理已完成。',
            total_cost_usd: 0.5,
            usage: { input_tokens: 10, output_tokens: 5 },
          })
        }
        return emit()
      },
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 'session-bg',
      messageId: 'msg-bg',
      prompt: '派个后台的去改文件',
      cwd: '/tmp/project',
      turn: 1,
    }))
    await inputWatch

    // 1) 主 result 时通道仍开着 —— 事故的直接反面。
    expect(inputClosedAtMainResult).toBe(false)

    // 2) 后台子代理的审批**真的**打到了宿主(此前它被 Stream closed 就地拒掉)。
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      toolName: 'Edit',
      toolCallId: 'toolu_edit_1',
      localSessionId: 'session-bg',
      messageId: 'msg-bg',
    })

    // 3) 后台归零之后才收口,而不是在主 result 就收。
    expect(state.closedAfter).toBe(yielded)

    // 4) 只有一条终点信号,且成本只记一次(每条 result 都记 = 重复计费)。
    const finishes = events.filter(e => e.type === 'finish' && e.finishReason !== 'tool_calls')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ finishReason: 'stop' })
    expect(events.filter(e => e.type === 'provider-data')).toHaveLength(1)

    // 5) 主回合的工具卡照常产出;嵌在子代理下的消息仍然不另起一张卡(既有约定)。
    const starts = events.filter(e => e.type === 'tool-call-start')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ toolCallId: AGENT_CALL, toolName: 'Agent' })

    // 6) 收尾正文开在**新的一轮**,不黏在 DISPATCHED 尾巴上。
    const texts = events.filter(e => e.type === 'text-delta')
    expect(texts.map(e => (e as { delta: string }).delta)).toEqual(['DISPATCHED', '后台子代理已完成。'])
    const boundaries = events.flatMap((event, index) => (
      event.type === 'finish' && event.finishReason === 'tool_calls' ? [index] : []
    ))
    const lastBoundary = boundaries[boundaries.length - 1] ?? -1
    expect(lastBoundary).toBeGreaterThan(events.indexOf(texts[0]))
    expect(lastBoundary).toBeLessThan(events.indexOf(texts[1]))
  })

  it('零后台的普通回合:result 当场收口,不多等一毫秒', async () => {
    const state: { closedAfter: number | null } = { closedAfter: null }
    let yielded = 0
    let inputWatch: Promise<void> | undefined

    const connector = createClaudeCodeConnector({
      queryFn: params => {
        inputWatch = watchInput(params.prompt, () => yielded, state)
        return (async function* () {
          yielded += 1
          yield initMessage
          await tick()
          yielded += 1
          yield { type: 'result', subtype: 'success', session_id: 's', result: 'PONG' } as ClaudeCodeSdkMessage
          await tick()
        })()
      },
    })

    await collect(connector.streamTurn({
      localSessionId: 'session-plain', prompt: 'ping', cwd: '/tmp', turn: 1,
    }))
    await inputWatch

    // result 是第 2 条消息,收口就发生在它身上 —— 没有任何额外等待。
    expect(state.closedAfter).toBe(2)
  })

  it('判据失灵时墙钟兜底:如实说一句再收口,绝不把回合挂死', async () => {
    const state: { closedAfter: number | null } = { closedAfter: null }
    let inputWatch: Promise<void> | undefined

    const connector = createClaudeCodeConnector({
      backgroundTaskTimeoutMs: 10,
      queryFn: params => {
        inputWatch = watchInput(params.prompt, () => 0, state)
        return (async function* () {
          yield initMessage
          yield {
            type: 'system',
            subtype: 'background_tasks_changed',
            session_id: 's',
            tasks: [{ task_id: 'stuck-1', task_type: 'local_agent', description: '永不收工' }],
          } as ClaudeCodeSdkMessage
          yield {
            type: 'stream_event',
            session_id: 's',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DISPATCHED' } },
          } as ClaudeCodeSdkMessage
          yield { type: 'result', subtype: 'success', session_id: 's', result: 'DISPATCHED' } as ClaudeCodeSdkMessage
          // 归零那条永远不来:CLI 只有在 stdin 关掉之后才退出。
          await inputWatch
        })()
      },
    })

    const events = await collect(connector.streamTurn({
      localSessionId: 'session-stuck', prompt: 'x', cwd: '/tmp', turn: 1,
    }))

    // 挂起被防呆解开了,而且用户看得到为什么。
    expect(state.closedAfter).not.toBeNull()
    const notice = events.find(
      e => e.type === 'text-delta' && (e as { delta: string }).delta.includes('后台子代理已运行超过'),
    )
    expect(notice).toBeDefined()
    expect((notice as { delta: string }).delta).toContain('还有 1 个未决任务')
    // 终点信号照发 —— 静默停住的回合是比失败更坏的收场。
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('abort 放开输入迭代器:不留挂着的 promise,也不留不肯退出的 CLI', async () => {
    const state: { closedAfter: number | null } = { closedAfter: null }
    let inputWatch: Promise<void> | undefined
    const abortController = new AbortController()

    const connector = createClaudeCodeConnector({
      queryFn: params => {
        inputWatch = watchInput(params.prompt, () => 0, state)
        return (async function* () {
          yield initMessage
          yield {
            type: 'system',
            subtype: 'background_tasks_changed',
            session_id: 's',
            tasks: [{ task_id: 'task-1' }],
          } as ClaudeCodeSdkMessage
          yield { type: 'result', subtype: 'success', session_id: 's' } as ClaudeCodeSdkMessage
          abortController.abort()
          await inputWatch
        })()
      },
    })

    await collect(connector.streamTurn({
      localSessionId: 'session-abort',
      prompt: 'x',
      cwd: '/tmp',
      turn: 1,
      abortSignal: abortController.signal,
    }))
    await inputWatch
    expect(state.closedAfter).not.toBeNull()
  })
})

/**
 * **提问期间的通道寿命**(2026-08-12 真机事故)。
 *
 * 症状:SDK 会话里模型调 `AskUserQuestion`,卡片弹出、用户十几秒后作答,答案送回
 * 时工具以 `Tool permission request failed: AbortError: Stream closed` 收场。
 *
 * CLI 那一侧的判据只有一条(2.1.228 反编译原文):
 *
 * ```js
 * async sendRequest(e, t, r, n = randomUUID(), o) {
 *   let i = { type: 'control_request', request_id: n, request: e }
 *   if (jEo(n), this.inputClosed) throw new dT('Stream closed')
 * ```
 *
 * 所以这句话**只**说明:CLI 要发这条 `can_use_tool` 的时候 stdin 已经 EOF 了。
 * stdin 只由我们关(SDK 的 `Query.streamInput` 在输入迭代器结束后 `endInput()`)。
 * 下面三条钉的就是「什么时候不许关、以及关的时候必须一起做什么」。
 */
describe('ClaudeCodeConnector 提问/审批期间的通道寿命', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))

  function watchInput(
    prompt: AsyncIterable<unknown>,
    state: { closed: boolean },
  ): Promise<void> {
    const iterator = prompt[Symbol.asyncIterator]()
    return (async () => {
      await iterator.next()
      await iterator.next()
      state.closed = true
    })()
  }

  it('还欠 CLI 一条答复时,result 不是终点:等答案落地才收口', async () => {
    const state = { closed: false }
    let inputWatch: Promise<void> | undefined
    /** 卡片挂在人眼前的那段时间。 */
    let releaseAnswer: (() => void) | undefined
    const answered = new Promise<void>(resolve => { releaseAnswer = resolve })
    /** result 到达、且我们还欠答复的那一刻,输入关了没有 —— 事故的判据。 */
    let closedWhileAsking: boolean | null = null
    let decisionBehavior: string | undefined

    const connector = createClaudeCodeConnector({
      interactionHandler: async ({ questions }) => {
        await answered
        return {
          id: 'ask-1',
          outcome: 'answered',
          answers: { [questions[0]!.id]: { selected: ['火锅'] } },
        }
      },
      queryFn: params => {
        inputWatch = watchInput(params.prompt, state)
        return (async function* () {
          yield initMessage
          await tick()
          // 模型问了一句,CLI 把 can_use_tool 发过来 —— 我们**先不答**。
          const pending = params.options.canUseTool?.(
            'AskUserQuestion',
            { questions: [{ question: '今晚吃什么?', header: '晚餐', options: [{ label: '火锅' }] }] },
            { signal: new AbortController().signal, toolUseID: 'toolu_ask_1' },
          )
          await tick()
          // 卡片还挂着,CLI 却把这一轮收了(park:问题留着,回合先落地)。
          yield { type: 'result', subtype: 'success', session_id: 's', result: '' } as ClaudeCodeSdkMessage
          await tick()
          await tick()
          closedWhileAsking = state.closed

          releaseAnswer?.()
          decisionBehavior = (await pending)?.behavior
          await tick()
          yield {
            type: 'assistant',
            session_id: 's',
            message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] },
          } as ClaudeCodeSdkMessage
          await tick()
        })()
      },
    })

    await collect(connector.streamTurn({
      localSessionId: 'session-ask', messageId: 'msg-ask', prompt: '问我一个问题', cwd: '/tmp', turn: 1,
    }))
    await inputWatch

    // 1) 事故的直接反面:答案还没回来,通道必须还开着。
    expect(closedWhileAsking).toBe(false)
    // 2) 答案真的送回去了(收口早一步的话这里是 Stream closed,不是 allow)。
    expect(decisionBehavior).toBe('allow')
  })

  it('审批同理:未决的 canUseTool 一样按住那条 result', async () => {
    const state = { closed: false }
    let inputWatch: Promise<void> | undefined
    let release: (() => void) | undefined
    const held = new Promise<void>(resolve => { release = resolve })
    let closedWhileAsking: boolean | null = null

    const connector = createClaudeCodeConnector({
      permissionHandler: async () => {
        await held
        return { behavior: 'allow' as const }
      },
      queryFn: params => {
        inputWatch = watchInput(params.prompt, state)
        return (async function* () {
          yield initMessage
          await tick()
          const pending = params.options.canUseTool?.(
            'Edit',
            { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
            { signal: new AbortController().signal, toolUseID: 'toolu_edit_1' },
          )
          await tick()
          yield { type: 'result', subtype: 'success', session_id: 's', result: '' } as ClaudeCodeSdkMessage
          await tick()
          await tick()
          closedWhileAsking = state.closed
          release?.()
          await pending
          await tick()
        })()
      },
    })

    await collect(connector.streamTurn({
      localSessionId: 'session-perm', messageId: 'msg-perm', prompt: '改个文件', cwd: '/tmp', turn: 1,
    }))
    await inputWatch
    expect(closedWhileAsking).toBe(false)
  })

  it('下游把生成器丢了:收口的同时必须掐掉 CLI,不留一个 stdin 已断却还活着的进程', async () => {
    let sdkAbort: AbortSignal | undefined
    const connector = createClaudeCodeConnector({
      queryFn: params => {
        sdkAbort = (params.options as { abortController?: AbortController }).abortController?.signal
        return (async function* () {
          yield initMessage
          await tick()
          yield {
            type: 'assistant',
            session_id: 's',
            message: { role: 'assistant', content: [{ type: 'text', text: '一' }] },
          } as ClaudeCodeSdkMessage
          // 这里之后永远不再产出 —— 模拟一个还在跑的 CLI。
          await new Promise(() => {})
        })()
      },
    })

    const stream = connector.streamTurn({
      localSessionId: 'session-drop', messageId: 'msg-drop', prompt: 'hi', cwd: '/tmp', turn: 1,
    })
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    // 下游不要了(engine 换流 / 窗口关掉 / for-await 里 break)。
    await iterator.return?.()

    expect(sdkAbort?.aborted, '丢下生成器却不掐进程 = 一个关了输入还在跑的 CLI').toBe(true)
  })

  it('同一会话上再起一轮:先掐掉上一轮,且上一轮的清理不许缴掉新一轮的械', async () => {
    const aborts: string[] = []
    const firstBlocks = { release: undefined as (() => void) | undefined }
    const connector = createClaudeCodeConnector({
      queryFn: params => {
        const signal = (params.options as { abortController?: AbortController }).abortController?.signal
        const tag = params.promptText
        signal?.addEventListener('abort', () => aborts.push(tag), { once: true })
        return (async function* () {
          yield initMessage
          await new Promise<void>(resolve => {
            if (tag === 'first') firstBlocks.release = resolve
            else resolve()
          })
          yield { type: 'result', subtype: 'success', session_id: 's', result: '' } as ClaudeCodeSdkMessage
        })()
      },
    })

    const first = collect(connector.streamTurn({
      localSessionId: 'session-race', messageId: 'm1', prompt: 'first', cwd: '/tmp', turn: 1,
    })).catch(() => [])
    await tick()
    await tick()

    const second = collect(connector.streamTurn({
      localSessionId: 'session-race', messageId: 'm2', prompt: 'second', cwd: '/tmp', turn: 2,
    }))
    await tick()
    firstBlocks.release?.()
    await first
    await second

    // 1) 新一轮开跑前,旧的那一轮被掐了 —— 两个 CLI 不再同时挂在一条会话上。
    expect(aborts).toContain('first')
    // 2) 旧一轮的清理没有把新一轮的登记一起抹掉:新一轮结束后表才是空的,
    //    在它结束**之前**它必须仍然是可寻址的(否则 abort/steer 全变空操作)。
    expect(connector.steer?.('session-race', 'anything')).toBe('unavailable')
  })
})
