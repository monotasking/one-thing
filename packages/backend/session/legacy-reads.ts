import fs from 'node:fs'
import path from 'node:path'
import { scanJsonlLog } from '@onething/core/session'
import type { ChatMessage } from '@shared/ipc.js'

/** Read-only compatibility until ensureWritable imports the historical source. */
export function readLegacySessionMessages(sessionsDir: string, sessionId: string): ChatMessage[] | undefined {
  if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId === '..') return undefined
  const directory = path.join(sessionsDir, sessionId)
  // An existing ledger is authoritative even when it contains zero visible
  // messages. Never resurrect an old transcript after clear or deletion.
  if (fs.existsSync(path.join(directory, 'events.jsonl'))) return undefined
  const transcript = path.join(directory, 'messages.jsonl')
  if (fs.existsSync(transcript)) return scanJsonlLog<ChatMessage>(fs.readFileSync(transcript)).entries.map(entry => entry.message)
  const legacy = path.join(sessionsDir, `${sessionId}.json`)
  if (!fs.existsSync(legacy)) return undefined
  const source = JSON.parse(fs.readFileSync(legacy, 'utf8')) as { messages?: ChatMessage[] }
  return Array.isArray(source.messages) ? source.messages : undefined
}
