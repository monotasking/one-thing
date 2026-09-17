/** Read-only replay: compare the live overlay with cold history after an abort. */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createSessionProjectionState, reduceSessionProjection, materializeChatMessages } from '../../../packages/core/session/index'
import { materializeChatMessagesCached } from '../src/data/chat-materialize'
import { StreamWater } from '../src/data/stream-water'
import { anchorMessage } from '../src/content/assemble/anchor'
import type { ProjectedMessage } from '../src/data/chat-fold'

const [directory, output, runId] = process.argv.slice(2)
if (!directory || !output) throw new Error('Usage: bun probe-aborted-content.ts SESSION_DIRECTORY OUTPUT_JSON')
const records = readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const end = records.findLast(record => record.type === 'run/end' && record.data.outcome === 'aborted' && (!runId || record.data.runId === runId))
if (!end) throw new Error('No aborted run')
const start = records.find(record => record.type === 'run/start' && record.data.runId === end.data.runId)
const options = { resolveBlob: (ref: { hash: string }) => readFileSync(path.join(directory, 'blobs', ref.hash), 'utf8') }
let state = createSessionProjectionState()
const water = new StreamWater()
const snapshots: unknown[] = []
for (const record of records) {
  if (record.seq > end.seq) break
  state = reduceSessionProjection(state, record)
  if (record.seq < end.seq - 6) continue
  const cold = materializeChatMessages(state, options).messages.find(message => message.id === start.data.assistantMessageId)
  const live = materializeChatMessagesCached(state, options, 0, water).messages.find(message => message.id === start.data.assistantMessageId)
  if (!cold || !live) continue
  const drawn = (message: ProjectedMessage) => anchorMessage(message).flatMap(node => node.node === 'text' ? [node.text] : []).join('')
  snapshots.push({ seq: record.seq, event: record.type, ledgerChars: cold.content.length,
    coldDrawnChars: drawn(cold as ProjectedMessage).length, liveDrawnChars: drawn(live).length,
    coldMatchesLedger: drawn(cold as ProjectedMessage) === cold.content,
    liveMatchesLedger: drawn(live) === cold.content })
}
const result = { sessionId: path.basename(directory), messageId: start.data.assistantMessageId, snapshots,
  caveat: 'Production projection and renderer anchoring replay; not a capture of the original UI event order.' }
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
