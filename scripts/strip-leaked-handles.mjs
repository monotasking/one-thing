#!/usr/bin/env node
/**
 * 清掉已落库的句柄泄漏 —— docs/design/collab-handle-codec.md §4。
 *
 * 编解码闭合之后新消息不会再带句柄,但**落库即定型**:此前漏进 room 转录的
 * 那些 `名字#句柄` 不会自愈。这个脚本把它们剥干净。
 *
 * 纪律:
 *  - **默认 dry-run**,`--apply` 才写盘;
 *  - 只碰 `kind: 'room'` 的会话(工作会话与 agent-exec 是模型面,按设计保留句柄);
 *  - 只碰消息的 `content` 字段;
 *  - 只剥**能在目录里解析出身份**的句柄 —— 认不出的原样留着,看板短卡号
 *    `#a1b2c3d4` 更是一个字都不动;
 *  - 写盘前把原件留一份到 `sessions/legacy-backup/`(与既有迁移同一个惯例)。
 *
 * 用法:
 *   node scripts/strip-leaked-handles.mjs              # 只看会改什么
 *   node scripts/strip-leaked-handles.mjs --apply      # 真写
 *   ONETHING_STORE_PATH=/tmp/store node scripts/… # 指定库
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const APPLY = process.argv.includes('--apply')
const STORE = process.env.ONETHING_STORE_PATH || join(homedir(), '.onething')
const SESSIONS = join(STORE, 'sessions')

/** 与 `collab/collab-handle-format.ts` 同一条规则。这里是脚本,不进构建,故重述一次。 */
const HANDLE_CHARS = 8
const handleOf = (agentId) => {
  const key = String(agentId).trim().replace(/^agent-/, '')
  return key.length <= HANDLE_CHARS ? key : key.slice(0, HANDLE_CHARS)
}

function loadDirectory() {
  const directory = []
  // 用户:settings 里的档案(缺省「用户」/'user')。
  try {
    const settings = JSON.parse(readFileSync(join(STORE, 'settings.json'), 'utf8'))
    const profile = settings?.general?.userProfile ?? {}
    const handle = String(profile.handle ?? '').trim() || 'user'
    const label = String(profile.name ?? '').trim() || '用户'
    directory.push({ handle, names: [label, '用户', 'user'] })
  } catch {
    directory.push({ handle: 'user', names: ['用户', 'user'] })
  }
  // 全体 agent(含退休 —— 出站给了它们句柄,解码就得认得)。
  try {
    const agents = JSON.parse(readFileSync(join(STORE, 'agents.json'), 'utf8'))
    for (const agent of agents?.agents ?? agents ?? []) {
      if (!agent?.id) continue
      directory.push({ handle: handleOf(agent.id), names: [String(agent.name ?? '').trim()].filter(Boolean) })
    }
  } catch { /* 没有名册就只剥用户那一种 */ }
  return directory.filter(entry => entry.handle)
}

/** 与 `handles.ts` 的 `scanCollabHandleMentions` 同一套判据(§2.2)。 */
function stripHandles(text, directory) {
  if (typeof text !== 'string' || !text.includes('#')) return text
  const byHandle = new Map()
  for (const entry of directory) if (!byHandle.has(entry.handle)) byHandle.set(entry.handle, entry)

  let out = ''
  let cursor = 0
  let index = 0
  while (index < text.length) {
    const hash = text.indexOf('#', index)
    if (hash < 0) break
    let end = hash + 1
    while (end < text.length && /[0-9a-zA-Z-]/.test(text[end])) end += 1
    const entry = end > hash + 1 ? byHandle.get(text.slice(hash + 1, end)) : undefined
    if (!entry) { index = hash + 1; continue }

    // ① 同一个词里往回找 @(点名:句柄说了算)
    let at = -1
    for (let i = hash - 1; i >= 0; i -= 1) {
      const ch = text[i]
      if (ch === '@') { at = i; break }
      if (ch === '#' || /\s/.test(ch)) break
    }
    if (at >= 0) {
      out += text.slice(cursor, at)
      out += `@${text.slice(at + 1, hash).trim() || entry.names[0] || ''}`
      cursor = end
      index = end
      continue
    }

    // ② 裸形态:# 前必须正好接着这个身份认的名字
    const before = text.slice(0, hash)
    const matched = entry.names
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .find(name => before.endsWith(name) || before.toLowerCase().endsWith(name.toLowerCase()))
    if (matched) {
      const start = hash - matched.length
      out += text.slice(cursor, start) + before.slice(before.length - matched.length)
      cursor = end
    }
    index = end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

function main() {
  if (!existsSync(SESSIONS)) {
    console.error(`找不到会话目录:${SESSIONS}`)
    process.exit(1)
  }
  const directory = loadDirectory()
  console.log(`目录:${directory.length} 个身份 · 库:${STORE} · ${APPLY ? '写盘' : 'DRY-RUN(不写)'}\n`)

  let touchedFiles = 0
  let touchedLines = 0
  const samples = []

  for (const dir of readdirSync(SESSIONS)) {
    const metaPath = join(SESSIONS, dir, 'meta.json')
    const jsonlPath = join(SESSIONS, dir, 'messages.jsonl')
    if (!existsSync(metaPath) || !existsSync(jsonlPath)) continue
    let meta
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { continue }
    if (meta?.kind !== 'room') continue

    const original = readFileSync(jsonlPath, 'utf8')
    const lines = original.split('\n')
    let fileTouched = 0
    const next = lines.map(line => {
      if (!line.trim()) return line
      let record
      try { record = JSON.parse(line) } catch { return line }
      const message = record?.m
      if (!message || typeof message.content !== 'string') return line
      const cleaned = stripHandles(message.content, directory)
      if (cleaned === message.content) return line
      fileTouched += 1
      if (samples.length < 5) samples.push({ before: message.content.slice(0, 90), after: cleaned.slice(0, 90) })
      message.content = cleaned
      return JSON.stringify(record)
    })

    if (!fileTouched) continue
    touchedFiles += 1
    touchedLines += fileTouched
    console.log(`  ${dir}  ${fileTouched} 条`)
    if (!APPLY) continue

    const backupDir = join(SESSIONS, 'legacy-backup')
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(jsonlPath, join(backupDir, `${dir}.messages.jsonl.pre-handle-strip`))
    writeFileSync(jsonlPath, next.join('\n'), 'utf8')
  }

  console.log(`\n合计:${touchedFiles} 个会话 / ${touchedLines} 条消息`)
  for (const sample of samples) {
    console.log(`\n  改前: ${sample.before}\n  改后: ${sample.after}`)
  }
  if (!APPLY && touchedLines > 0) console.log('\n加 --apply 才真正写盘(原件会备份到 sessions/legacy-backup/)。')
}

main()
