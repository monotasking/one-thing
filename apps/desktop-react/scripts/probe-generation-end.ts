/** Read-only reconstruction of a recorded run's terminal SSE payload. */
import { readFileSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { createSessionProjectionState, reduceSessionProjection, materializeChatMessages } from '../../../packages/core/session/index'
import { synthesizeCoreToolAnchors } from '../../../packages/core/session/render-anchors'
import { buildAgentLoopFinalMessageUpdate } from '../../../packages/core/engine/agent-loop-executor'
import { createSseDelivery, SSE_PENDING_BYTES_LIMIT } from '../../../packages/backend/server/sse-delivery'

const [directory, output] = process.argv.slice(2)
if (!directory || !output) throw new Error('Usage: bun probe-generation-end.ts SESSION_DIRECTORY OUTPUT_JSON')
const records = readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const end = records.findLast(record => record.type === 'run/end' && record.data.outcome === 'completed')
if (!end) throw new Error('No completed run')
const start = records.find(record => record.type === 'run/start' && record.data.runId === end.data.runId)
let state = createSessionProjectionState()
for (const record of records) {
  if (record.seq >= end.seq) break
  state = reduceSessionProjection(state, record)
}
const message = materializeChatMessages(state, {
  resolveBlob: ref => readFileSync(path.join(directory, 'blobs', ref.hash), 'utf8'),
}).messages.find(message => message.id === start.data.assistantMessageId)
if (!message) throw new Error('No terminal message')
const parts = synthesizeCoreToolAnchors(message.contentParts ?? [], message)
const updates = buildAgentLoopFinalMessageUpdate({ ...message, ...(parts ? { contentParts: parts } : {}) })
const envelope = { sessionId: path.basename(directory), sequence: 1, timestamp: end.time,
  event: { type: 'message:updated', messageId: message.id, updates } }
const wire: string[] = []
const response = Object.assign(new EventEmitter(), {
  destroyed: false, writableEnded: false,
  write(chunk: Buffer) { wire.push(chunk.toString()); return true },
  end() { this.writableEnded = true },
  destroy() { this.destroyed = true },
})
const delivery = createSseDelivery(response as unknown as ServerResponse, {
  overflowFrame: () => ({ event: 'transport:resync-required', payload: { reason: 'buffer-overflow' } }),
})
const snapshotAccepted = delivery.write('session:event', envelope, 1)
const terminalAccepted = delivery.write('session:event', { ...envelope, sequence: 2,
  event: { type: 'session:ledger-event', record: end } } as unknown, 2)
delivery.dispose()
const chunks = records.filter(record => record.type === 'assistant/chunks' && record.data.runId === end.data.runId)
const lastDeltaAt = Math.max(...chunks.map(record => record.data.time0 + Math.max(...record.data.dt)))
const result = {
  sessionId: path.basename(directory), runId: end.data.runId, messageId: message.id,
  lastDeltaAt, runEndAt: end.time, deltaToEndMs: end.time - lastDeltaAt,
  reconstructedUpdateBytes: Buffer.byteLength(JSON.stringify(envelope)),
  limitBytes: SSE_PENDING_BYTES_LIMIT, snapshotAccepted, terminalAccepted,
  resetSent: wire.join('').includes('transport:resync-required'), connectionEnded: response.writableEnded,
  nextLedgerAfterEndMs: records.find(record => record.seq > end.seq)?.time - end.time,
  caveat: 'Reconstructed pre-run/end payload from recorded ledger, not a packet capture of the original connection.',
}
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
