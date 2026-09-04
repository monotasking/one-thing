#!/usr/bin/env bun
/**
 * 检索语料抽取(检索重建 S0,`docs/design/search-index-2026-09.md` §10 的 S0 行)。
 *
 *   bun scripts/search-corpus-extract.mjs [--store PATH] [--out DIR] [--limit N]
 *
 * 从**真库**抽一份脱敏语料进仓当夹具:S1 的分析器 / 流水线、S3 的索引、S7 的复述集
 * 都要拿真实中文对话来验 —— 手编的语料证明不了「全角混写」「中文双字词」「命令样
 * 查询别被吃掉」这些真机上真会出事的形。
 *
 * ## 三条硬规矩
 *
 * 1. **全程只读**。一个字节都不往 store 里写:不加锁、不修坏行、不建目录。坏掉的
 *    `events.jsonl` 就跳过那一个会话并计数,不修。
 * 2. **正文一律过 `scripts/lib/search-corpus-redact.mjs`**。那份纯函数是唯一产地,
 *    夹具自检(`packages/core/search/__tests__/fixtures.test.ts`)拿同一份再跑一遍,
 *    要求逐字相同。
 * 3. **id 一律哈希**。`sessionKey` = sessionId 的 sha256 前 12 位;消息 key =
 *    `${sessionKey}:${messageId 的 sha256 前 12 位}`。所以成品里没有一个真 id ——
 *    也顺带让整份文件躲开「32 位以上随机串」那条脱敏规则(裸 UUID 是 36 位)。
 *
 * ## 消息文本从哪来
 *
 * 走**产品自己那条路**:`events.jsonl` → `parseSessionLogEventLog` →
 * `projectChatMessages`(与 `scripts/session-hydration-contract.ts` 同一对函数),
 * 拿到的是**结算后的**消息,不是流式碎片。>64KB 的 blob 引用直接跳过
 * (`resolveBlob` 返回 `undefined`)—— 语料要的是对话正文,不是附件字节。
 *
 * ## 抽样
 *
 * 消息文档按会话**轮转**抽到 `--limit`(缺省 2000):每一轮从每个会话取一条,
 * 取完再下一轮。所以 2000 条覆盖的是尽可能多的会话,而不是最长那几个会话的前缀。
 * 会话标题文档**全给**(它们本来就少,且 `sessions` 那一类的召回要靠它们)。
 *
 * ## 产物
 *
 *   <out>/corpus.json          { generatedAt, store, counts, docs: [...] }
 *
 * `golden-queries.json` **不由本脚本生成** —— 它是手写的期望表,期望键用
 * `--golden` 模式从成品语料里算(见 `scripts/search-corpus-golden.mjs` 的说明:
 * 本批没有那个脚本,期望键由施工者在成品上一次性算出后写死)。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSessionLogEventLog, projectChatMessages } from '@onething/core/session'
import { redactText } from './lib/search-corpus-redact.mjs'

const DEFAULT_LIMIT = 2000
/** 一条消息文档的正文上限;超了截断并标 `truncated`。 */
const MAX_CONTENT_CHARS = 2000
/** 只收这三种角色 —— 工具结果不索引(拍点乙 a)。 */
const KEPT_ROLES = new Set(['user', 'assistant', 'system'])

function parseArgs(argv) {
  const args = { store: undefined, out: undefined, limit: DEFAULT_LIMIT }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--store') args.store = argv[++i]
    else if (flag === '--out') args.out = argv[++i]
    else if (flag === '--limit') args.limit = Number.parseInt(argv[++i], 10)
  }
  return args
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return undefined
  }
}

/**
 * `ChatMessage.content` 有两形:字符串,或 parts 数组(多模态)。只取文本部分 ——
 * 图片 / 音频在语料里没有意义,而它们的 base64 会把文件撑爆。
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const pieces = []
  for (const part of content) {
    if (typeof part === 'string') pieces.push(part)
    else if (part && typeof part === 'object' && typeof part.text === 'string') pieces.push(part.text)
  }
  return pieces.join('\n')
}

function normalizeWhitespace(text) {
  // 折掉行尾空白与三连以上空行:夹具里那些是噪音,不是信号。
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 一个会话:标题文档 + 它全部可用的消息文档(抽样在上层做)。 */
function collectSession(sessionsDir, sessionId) {
  const dir = path.join(sessionsDir, sessionId)
  const eventsText = readTextIfExists(path.join(dir, 'events.jsonl'))
  if (!eventsText) return undefined

  const metaText = readTextIfExists(path.join(dir, 'meta.json'))
  let rawTitle = ''
  let metaTime = 0
  if (metaText) {
    try {
      const meta = JSON.parse(metaText)
      // 会话标题在 `meta.json` 里叫 **`name`**(不是 `title`)—— 真库上逐个数过的,
      // 473 个会话没有一个带 `title` 这一格。
      rawTitle = typeof meta.name === 'string' ? meta.name : ''
      metaTime = Number(meta.updatedAt ?? meta.createdAt ?? 0) || 0
    } catch {
      // meta 坏了不影响消息 —— 标题当空处理。
    }
  }

  let messages = []
  try {
    const events = parseSessionLogEventLog(eventsText)
    // >64KB 的正文住在 `blobs/` 里,语料不要它们:回 `undefined` = 那一段留空。
    messages = projectChatMessages(events, { resolveBlob: () => undefined }).messages
  } catch {
    return { broken: true }
  }

  const sessionKey = shortHash(sessionId)
  const title = normalizeWhitespace(redactText(rawTitle))

  const docs = []
  for (const message of messages) {
    if (!KEPT_ROLES.has(message.role)) continue
    const raw = normalizeWhitespace(textOf(message.content))
    if (raw.length === 0) continue
    const redacted = redactText(raw)
    const truncated = redacted.length > MAX_CONTENT_CHARS
    docs.push({
      capability: 'messages',
      key: `${sessionKey}:${shortHash(message.id)}`,
      sessionKey,
      role: message.role,
      time: Number(message.timestamp ?? 0) || 0,
      ...(title ? { title } : {}),
      content: truncated ? redacted.slice(0, MAX_CONTENT_CHARS) : redacted,
      ...(truncated ? { truncated: true } : {}),
    })
  }

  const sessionDoc = title
    ? {
        capability: 'sessions',
        key: sessionKey,
        sessionKey,
        time: metaTime,
        title,
        // `sessions` 那一类可搜的就是标题本身,所以 `content` 与 `title` 同源 ——
        // 不是冗余,是「这一类的正文字段是什么」的诚实回答。
        content: title,
      }
    : undefined

  return { sessionDoc, messageDocs: docs }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const store = args.store ?? process.env.ONETHING_STORE_PATH ?? path.join(os.homedir(), '.onething')
  const out = args.out ?? path.join(process.cwd(), 'packages/core/search/__tests__/fixtures')
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : DEFAULT_LIMIT

  const sessionsDir = path.join(store, 'sessions')
  if (!fs.existsSync(sessionsDir)) {
    console.error(`[corpus] no sessions directory at ${sessionsDir}`)
    process.exitCode = 1
    return
  }

  const sessionIds = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'legacy-backup')
    .map(entry => entry.name)
    .sort()

  const sessionDocs = []
  /** 每个会话一条队列;轮转抽样从这些队列上逐轮取。 */
  const queues = []
  let broken = 0
  let scanned = 0
  let totalMessages = 0

  for (const sessionId of sessionIds) {
    const collected = collectSession(sessionsDir, sessionId)
    if (!collected) continue
    scanned += 1
    if (collected.broken) {
      broken += 1
      continue
    }
    if (collected.sessionDoc) sessionDocs.push(collected.sessionDoc)
    if (collected.messageDocs.length > 0) {
      totalMessages += collected.messageDocs.length
      queues.push(collected.messageDocs)
    }
  }

  const messageDocs = []
  let round = 0
  while (messageDocs.length < limit) {
    let took = 0
    for (const queue of queues) {
      if (round >= queue.length) continue
      messageDocs.push(queue[round])
      took += 1
      if (messageDocs.length >= limit) break
    }
    if (took === 0) break
    round += 1
  }

  const docs = [...sessionDocs, ...messageDocs]
  const payload = {
    generatedAt: new Date().toISOString(),
    // 只记「哪个 store」的形状,不记路径 —— 路径本身就是 PII(见脱敏规则 1)。
    store: shortHash(store),
    counts: {
      sessionsScanned: scanned,
      sessionsBroken: broken,
      sessionDocs: sessionDocs.length,
      messageDocs: messageDocs.length,
      messageDocsAvailable: totalMessages,
      truncated: messageDocs.filter(doc => doc.truncated).length,
    },
    docs,
  }

  fs.mkdirSync(out, { recursive: true })
  const file = path.join(out, 'corpus.json')
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 1)}\n`, 'utf-8')
  console.log(`[corpus] ${file}`)
  console.log(`[corpus] ${JSON.stringify(payload.counts)}`)
  console.log(`[corpus] bytes ${fs.statSync(file).size}`)
}

main()
