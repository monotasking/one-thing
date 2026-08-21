/**
 * The turn channel end to end (`docs/design/prompt-channels-2026-08.md`).
 *
 * Three things are pinned here, because each of them is a way the channel can
 * silently rot:
 *
 * 1. **Where a `turn` fragment lands.** It must reach the tail of the newest
 *    user message and must never appear in the system prefix — a prefix that
 *    varies per session is exactly the cache-invalidation bug this batch exists
 *    to remove.
 * 2. **Persist once, replay after.** The first build of a turn writes the delta
 *    onto the user message and rewrites that message in the request; every
 *    later build in the same turn (the tool loop rebuilds history repeatedly)
 *    must produce identical bytes. That equality IS the prompt cache.
 * 3. **A steering message gets its own diff.** It is a new user message, so it
 *    carries only what changed since the previous one — not a repeat of the
 *    whole board.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'

const mocks = vi.hoisted(() => ({
  settings: { general: {} },
  sessions: new Map<string, unknown>(),
  board: { text: '' },
}))

vi.mock('../../../agents/index.js', () => ({
  findAgent: () => ({ id: 'default', name: 'Default Agent', systemPrompt: '' }),
  defaultAgent: () => ({ id: 'default', name: 'Default Agent', systemPrompt: '' }),
  DEFAULT_AGENT_ID: 'default',
}))

vi.mock('../../../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  getSettings: () => mocks.settings,
}))

vi.mock('../../../variables/index.js', () => ({
  buildStateVariablesPromptText: async () => mocks.board.text,
}))

const { buildPrompt } = await import('../system-prompt.js')
const { SessionTurnContext } = await import('../session-turn-context.js')
const { buildMessageContent } = await import('../../stream/message-helpers.js')

const SESSION = 'sess-1'

function userMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'u1', role: 'user', content: 'hello', timestamp: 1, ...over } as ChatMessage
}

/** A store double that records what the attach wrote. */
function fakeStore(messages: ChatMessage[]) {
  return {
    messages,
    listMessages: () => messages,
    getSessionMeta: () => ({}),
    updateMessageTurnContext(
      _sessionId: string,
      messageId: string,
      turnContext: NonNullable<ChatMessage['turnContext']>,
    ) {
      const target = messages.find(message => message.id === messageId)
      if (!target) return false
      target.turnContext = turnContext
      return true
    },
  }
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.board.text = '<var name="datetime" state="true">2026-08-18 17:00</var>'
})

describe('turn channel wiring', () => {
  it('a turn block is produced by the build and never enters the system prefix', async () => {
    const result = await buildPrompt({
      sessionId: SESSION,
      hasTools: true,
      skills: [{
        name: 'demo', description: 'demo skill', source: 'builtin',
        path: '/skills/demo/SKILL.md', enabled: true,
      } as never],
      toolNames: ['read'],
      mcpToolNames: [],
      activeProject: { hasActive: false },
      knownProjects: { hasAny: false, entries: [] },
      providerId: 'openai',
      historyMessages: [{ role: 'user', content: 'hello' }],
    })

    const ids = (result.turn ?? []).map(block => block.id)
    expect(ids).toContain('variables')
    expect(ids).toContain('skills')
    expect(result.systemPrompt).not.toContain('# Skills')
    expect(result.systemPrompt).not.toContain('<var name="datetime"')
    // The build itself does not touch the request: attaching is the host's job.
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('attaches the blocks to the newest user message and persists the delta once', async () => {
    const store = fakeStore([userMessage()])
    const turnContext = new SessionTurnContext(store)
    const messages = [
      { role: 'system' as const, content: 'PREFIX' },
      { role: 'user' as const, content: 'hello' },
    ]

    const first = turnContext.attach(SESSION, messages, [
      { id: 'variables', content: '<var name="a" state="true">1</var>' },
      { id: 'todo', content: '# Todo' },
    ])

    expect(first[1].content).toBe(
      'hello\n\n<context-update>\n'
      + '<section name="variables">\n<var name="a" state="true">1</var>\n</section>\n'
      + '<section name="todo">\n# Todo\n</section>\n'
      + '</context-update>',
    )
    expect(store.messages[0].turnContext).toEqual({
      set: { variables: '<var name="a" state="true">1</var>', todo: '# Todo' },
    })
    // The prefix is untouched — that is the whole point.
    expect(first[0].content).toBe('PREFIX')
  })

  it('replays identical bytes across the tool loop: attach is a no-op after the first build', () => {
    const store = fakeStore([userMessage()])
    const turnContext = new SessionTurnContext(store)
    const blocks = [{ id: 'variables', content: 'BOARD' }]

    const first = turnContext.attach(SESSION, [{ role: 'user' as const, content: 'hello' }], blocks)
    const persisted = store.messages[0].turnContext

    // Second call in the same turn: nothing changes, nothing is rewritten twice.
    const second = turnContext.attach(SESSION, [{ role: 'user' as const, content: 'hello' }], blocks)
    expect(second[0].content).toBe('hello')
    expect(store.messages[0].turnContext).toBe(persisted)

    // …because the rebuild path renders the stored field instead, byte for byte.
    expect(buildMessageContent(store.messages[0])).toBe(first[0].content)
  })

  it('gives a steering message its own diff — only what changed since the last one', () => {
    const store = fakeStore([
      userMessage({ id: 'u1', turnContext: { set: { variables: 'BOARD', todo: '# Todo' } } }),
      { id: 'a1', role: 'assistant', content: 'ok', timestamp: 2 } as ChatMessage,
      userMessage({ id: 'u2', content: 'wait' }),
    ])
    const turnContext = new SessionTurnContext(store)

    const messages = turnContext.attach(SESSION, [{ role: 'user' as const, content: 'wait' }], [
      { id: 'variables', content: 'BOARD 2' },
      { id: 'todo', content: '# Todo' },
    ])

    // todo is unchanged and is NOT repeated; the board moved and travels alone.
    expect(store.messages[2].turnContext).toEqual({ set: { variables: 'BOARD 2' } })
    expect(messages[0].content).toBe(
      'wait\n\n<context-update>\n<section name="variables">\nBOARD 2\n</section>\n</context-update>',
    )
  })

  it('replays a legacy session byte-identically — an old block is not rewritten', () => {
    const legacy = userMessage({ contextUpdate: '- datetime: 10:00' })
    expect(buildMessageContent(legacy)).toBe(
      'hello\n\n<context-update>\n- datetime: 10:00\n</context-update>',
    )
    // And the attach leaves an already-delivered message alone.
    const store = fakeStore([legacy])
    const messages = new SessionTurnContext(store).attach(
      SESSION,
      [{ role: 'user' as const, content: 'hello' }],
      [{ id: 'variables', content: 'anything' }],
    )
    expect(messages[0].content).toBe('hello')
    expect(store.messages[0].turnContext).toBeUndefined()
  })

  /**
   * Review fix (2026-08-18): a multimodal message. The replay path appends the
   * block to `message.content` *before* the content parts are built, which
   * puts it in the FIRST text part (attachment path lines follow as their own
   * text part). The attach path works on the already-built parts and must land
   * in the same place — a "last text part" rule would put the block after the
   * path lines on the first build and before them on every later build.
   */
  it('lands in the same part as the replay for a message with attachments', () => {
    // A real file attachment: the parts builder emits the message text as the
    // first part and the `[附件] …` path line as a second text part.
    const attachments = [
      { id: 'f1', fileName: 'notes.txt', filePath: '/tmp/notes.txt', mimeType: 'text/plain', size: 10, base64Data: 'aGVsbG8=', mediaType: 'file' },
    ]
    const stored = userMessage({ content: 'see file', attachments } as unknown as Partial<ChatMessage>)
    const store = fakeStore([stored])
    const turnContext = new SessionTurnContext(store)

    // What the history builder hands buildPrompt for this message.
    const built = buildMessageContent(stored)
    expect(Array.isArray(built)).toBe(true)
    const attached = turnContext.attach(
      SESSION,
      [{ role: 'user' as const, content: built }],
      [{ id: 'todo', content: '# Todo' }],
    )
    // Next build: replay from the stored field must produce identical parts.
    expect(attached[0].content).toEqual(buildMessageContent(store.messages[0]))
    const parts = attached[0].content as Array<{ type: string; text?: string }>
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0].text).toContain('<section name="todo">')
    expect(parts[1].text).not.toContain('<section')
  })

  it('an attachment-only message (no text) gets the block as a new first text part — like the replay', () => {
    const attachments = [
      { id: 'f1', fileName: 'notes.txt', filePath: '/tmp/notes.txt', mimeType: 'text/plain', size: 10, base64Data: 'aGVsbG8=', mediaType: 'file' },
    ]
    const stored = userMessage({ content: '', attachments } as unknown as Partial<ChatMessage>)
    const store = fakeStore([stored])
    const built = buildMessageContent(stored)
    const attached = new SessionTurnContext(store).attach(
      SESSION,
      [{ role: 'user' as const, content: built }],
      [{ id: 'todo', content: '# Todo' }],
    )
    expect(attached[0].content).toEqual(buildMessageContent(store.messages[0]))
  })

  /**
   * Review fix (2026-08-18): a turn whose first build had nothing new must not
   * re-run the diff on later builds of the same turn — a board value moving
   * mid-turn (datetime crossing the hour) would otherwise rewrite the user
   * message halfway through the tool loop.
   */
  it('decides once per message: a first build with nothing new stays "nothing" for the rest of the turn', () => {
    const store = fakeStore([
      userMessage({ id: 'u1', turnContext: { set: { variables: 'BOARD' } } }),
      { id: 'a1', role: 'assistant', content: 'ok', timestamp: 2 } as ChatMessage,
      userMessage({ id: 'u2', content: 'next' }),
    ])
    const turnContext = new SessionTurnContext(store)
    const request = () => [{ role: 'user' as const, content: 'next' }]

    const first = turnContext.attach(SESSION, request(), [{ id: 'variables', content: 'BOARD' }])
    expect(first[0].content).toBe('next')
    expect(store.messages[2].turnContext).toBeUndefined()

    // The board moves mid-turn: same message, same turn → still nothing attached.
    const second = turnContext.attach(SESSION, request(), [{ id: 'variables', content: 'BOARD 2' }])
    expect(second[0].content).toBe('next')
    expect(store.messages[2].turnContext).toBeUndefined()

    // A new user message is a new decision.
    store.messages.push(userMessage({ id: 'u3', content: 'later' }))
    const third = turnContext.attach(SESSION, [{ role: 'user' as const, content: 'later' }], [{ id: 'variables', content: 'BOARD 2' }])
    expect(third[0].content).toContain('BOARD 2')
  })
})
