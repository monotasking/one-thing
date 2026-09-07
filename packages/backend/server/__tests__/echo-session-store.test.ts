import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createEchoServerSessionStore } from '../runtime.js'
import { getCurrentBackendSafe } from '../../current.js'

it('keeps an echo transcript readable after reopening without a production Backend or ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-transcript-'))
  const store = createEchoServerSessionStore(directory)
  try {
    expect(getCurrentBackendSafe()).toBeNull()
    store.createSession('echo-a', 'echo', { userId: 'local-user', workspaceId: 'default' })
    store.messages.appendMessage('echo-a', { message: { id: 'user', role: 'user', content: 'question', timestamp: 1 } })
    store.messages.appendMessage('echo-a', { message: { id: 'answer', role: 'assistant', content: '', timestamp: 2, isStreaming: true } })
    store.messages.patchMessage('echo-a', { messageId: 'answer', patch: { content: 'answer', isStreaming: false } })
    await store.flushAll()
    const reopened = createEchoServerSessionStore(directory)
    expect(reopened.getMessages('echo-a').map(message => message.content)).toEqual(['question', 'answer'])
    expect(JSON.parse(await readFile(join(directory, 'sessions', 'echo-a.json'), 'utf8')).messages).toHaveLength(2)
    await expect(access(join(directory, 'sessions', 'echo-a', 'events.jsonl'))).rejects.toThrow()
    expect(getCurrentBackendSafe()).toBeNull()
    await reopened.flushAll()
  } finally { await store.flushAll(); await rm(directory, { recursive: true, force: true }) }
})
