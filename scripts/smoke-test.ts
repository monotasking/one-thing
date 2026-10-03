import { AgentEngine } from '../packages/backend/agent/agent-engine.ts'
import { SessionManager } from '../packages/backend/session/index.ts'

const sessionId = `smoke-${Date.now()}`
const engine = new AgentEngine()
const sessionManager = new SessionManager(engine.eventBus, engine.streamChannel)

engine.streamChannel.subscribe(sessionId, (chunk) => {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.text)
  }
})

engine.eventBus.onAnySession('stream:complete', (envelope) => {
  const usage = envelope.event.data.usage
  console.log(`\n\n[smoke] stream complete: ${usage?.totalTokens ?? 0} estimated tokens`)
}, 'smoke-test')

console.log('[smoke] starting headless core conversation')
console.log('user> Say hello from the headless core.')
process.stdout.write('assistant> ')

try {
  const result = await engine.sendMessage({
    sessionId,
    content: 'Say hello from the headless core.',
  })
  const state = sessionManager.get(sessionId)?.state

  console.log(`[smoke] assistant message id: ${result.messageId}`)
  console.log(`[smoke] accumulated chars: ${state?.accumulatedContent.length ?? 0}`)
  console.log('[smoke] ok')
} finally {
  sessionManager.shutdown()
  engine.shutdown()
}
