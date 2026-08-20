/**
 * 只读回放:拿真机 events.jsonl 投影,与 messages.jsonl 逐字段比,打完整 diff。
 * 不写任何东西到 ~/.onething。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { projectChatMessages } from '/Users/yitiansong/data/code/start-electron/packages/core/session/projection/chat-messages.js'
import { canonicalChatMessage } from '/Users/yitiansong/data/code/start-electron/packages/core/session/projection/canonical.js'
import { rehydrateSessionFromStorage } from '/Users/yitiansong/data/code/start-electron/packages/onething-runtime/src/sessions/session-dehydrate.js'

const sessionId = process.argv[2] ?? '5e4d2cea-eb27-4c49-9aaa-fa7cfa3fa270'
const dir = join(homedir(), '.onething', 'sessions', sessionId)
const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
const msgRecs = readFileSync(join(dir, 'messages.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((r: any) => r.t === 'm')
const storedMessages = msgRecs.map((r: any) => r.m ?? r)
rehydrateSessionFromStorage({ messages: storedMessages } as any)
const actualById = new Map<string, any>(storedMessages.map((m: any) => [m.id, m]))

const projected = projectChatMessages(events as any)

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 400) return
  if (a === b) return
  const isObj = (v: unknown) => v !== null && typeof v === 'object'
  if (isObj(a) && isObj(b)) {
    if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path} A:${typeof a} B:${typeof b}`); return }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) out.push(`${path}.length A:${a.length} B:${(b as unknown[]).length}`)
      const n = Math.max(a.length, (b as unknown[]).length)
      for (let i = 0; i < n; i++) diff(a[i], (b as unknown[])[i], `${path}.${i}`, out)
      return
    }
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
    for (const k of [...keys].sort()) diff((a as any)[k], (b as any)[k], `${path}.${k}`, out)
    return
  }
  const clip = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s === undefined) return '(absent)'
    return s.length > 120 ? `${s.slice(0, 120)}…[${s.length}]` : s
  }
  out.push(`${path} A:${clip(a)} B:${clip(b)}`)
}

const wanted = process.argv.slice(3)
for (const p of projected.messages) {
  if (p.role !== 'assistant') continue
  const a = actualById.get(p.id)
  if (!a) { console.log(`## ${p.id} MISSING in messages.jsonl`); continue }
  if (wanted.length && !wanted.some(w => p.id.startsWith(w))) continue
  const out: string[] = []
  diff(canonicalChatMessage(a as any), canonicalChatMessage(p as any), '', out)
  console.log(`\n## ${p.id.slice(0, 8)} run=${(p as any).runId ?? '-'} diffs=${out.length}`)
  for (const line of out) console.log('   ' + line)
}
