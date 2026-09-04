/**
 * 给 `gate:search-index` 造账本的**手写**工具:直接往 `<store>/sessions/<id>/` 写
 * `meta.json` + `events.jsonl`,再补一份 `sessions/index.json`。
 *
 * ## 为什么是手写 JSONL 而不是调 core 的编码器
 *
 * 门跑在**裸 node** 下(`node:sqlite` 只有它有,§13 留账),而 core 的编码器是 TS 源码
 * —— node 的类型剥离**不改写** `./x.js → ./x.ts`,而且提示词那条链上有 `?raw` 导入,
 * 整棵源码树在 node 下根本 import 不起来。所以这里照着账本**真实的行格式**写:
 *
 *     {"seq":N,"time":T,"type":"message/imported","data":{"message":{…}}}
 *
 * 这个形是从真库 `~/.onething/sessions/<id>/events.jsonl` 读出来核对过的,不是猜的;
 * `message/imported` 与 `user/message` 都在 `IndexProjector` 的「折进投影 → **立刻**
 * 产一份消息文档」那一行里(`projector.ts` 文件头那张表),所以种下去就是可搜的。
 *
 * **手写这件事本身有代价**:格式变了这里不会自动跟着变。挡住它的是门自己 ——
 * 种完之后第 ⑤ 条要求索引里真的出现了那些文档(`status().docs`),格式一旦对不上,
 * 文档数就上不去,门当场红。
 *
 * ## 超 64KB 的那几条
 *
 * 派工单要「10 条 > 64KB 走 blob」。**走不了 blob,而且不该走**:`blob-store.ts` 那条
 * 64KB 线管的是**工具结果与附件正文**(`SESSION_EVENT_BLOB_THRESHOLD_BYTES`),普通
 * 消息正文再长也是直接写进事件行的;而索引按拍点乙 (a) 只收正文 / 附件名 / 推理,
 * 工具结果根本不进索引 —— 让 10 条工具结果走 blob 对这道门是空转。所以这里种的是
 * **10 条 > 64KB 的正文**(内联,与产品里长消息的真实落法一致),它们要的效果 ——
 * 冷建时有几条特别重的折 —— 一模一样。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 一条事件行。 */
function eventLine(seq, time, type, data) {
  return `${JSON.stringify({ seq, time, type, data })}\n`
}

/** 一条消息事件的 `data`。 */
function messageData(id, role, content, timestamp) {
  return { message: { id, role, content, timestamp } }
}

/** 固定种子的 PRNG —— 同一条命令种出来的库逐字节相同。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 种 `sessions` 间会话,每间 `messagesPerSession` 条消息;正文从语料里随机取段。
 *
 * 返回 `{ sessions, messages, bytes, longMessages, marker }` —— `marker` 是种进**每
 * 一间**会话第一条消息里的记号,门可以拿它证「种下去的真的进了索引」。
 */
export function seedLedger(options) {
  const {
    storePath,
    sessions = 300,
    messagesPerSession = 30,
    corpus,
    longMessages = 10,
    seed = 0x5eed1e,
    marker = 'gateseedmarker',
  } = options

  const random = mulberry32(seed)
  const passages = (corpus.docs ?? [])
    .map(doc => (typeof doc.content === 'string' ? doc.content : ''))
    .filter(text => text.length > 20)
  if (passages.length === 0) throw new Error('语料里没有可用的正文段')

  const sessionsDir = path.join(storePath, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })

  // 超 64KB 的那几条:把语料段接起来接到过线为止(见文件头「超 64KB 的那几条」)。
  const longBody = (() => {
    const parts = []
    let size = 0
    while (size < 80 * 1024) {
      const passage = passages[Math.floor(random() * passages.length)] ?? ''
      parts.push(passage)
      size += Buffer.byteLength(passage, 'utf8') + 1
    }
    return parts.join('\n')
  })()

  const baseTime = Date.UTC(2026, 7, 1)
  const index = []
  let messages = 0
  let bytes = 0
  let longUsed = 0

  for (let s = 0; s < sessions; s += 1) {
    const sessionId = `seed-${String(s).padStart(4, '0')}`
    const dir = path.join(sessionsDir, sessionId)
    fs.mkdirSync(dir, { recursive: true })

    const lines = []
    let seq = 0
    for (let m = 0; m < messagesPerSession; m += 1) {
      seq += 1
      const time = baseTime + s * 60_000 + m * 1_000
      const role = m % 2 === 0 ? 'user' : 'assistant'
      // 每间会话第一条带记号,门用它证「种的进了索引」。
      const head = m === 0 ? `${marker} ` : ''
      // 每 30 间会话摊一条超 64KB 的,直到摊够 longMessages 条。
      const long = m === 1 && longUsed < longMessages && s % Math.max(1, Math.floor(sessions / longMessages)) === 0
      if (long) longUsed += 1
      const body = long ? longBody : (passages[Math.floor(random() * passages.length)] ?? '')
      const content = `${head}${body}`
      lines.push(eventLine(seq, time, 'message/imported',
        messageData(`${sessionId}-m${m}`, role, content, time)))
      messages += 1
    }
    const text = lines.join('')
    fs.writeFileSync(path.join(dir, 'events.jsonl'), text)
    bytes += Buffer.byteLength(text, 'utf8')

    const createdAt = baseTime + s * 60_000
    const updatedAt = createdAt + messagesPerSession * 1_000
    const name = `${marker} 会话 ${s}`
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id: sessionId,
      name,
      createdAt,
      updatedAt,
      agentId: 'default',
      formatVersion: 2,
      log: { messageCount: messagesPerSession, lastSeq: seq },
    }))
    index.push({ id: sessionId, name, createdAt, updatedAt, agentId: 'default', workspaceId: 'default' })
  }

  const indexPath = path.join(sessionsDir, 'index.json')
  const existing = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    : []
  fs.writeFileSync(indexPath, JSON.stringify([...(Array.isArray(existing) ? existing : []), ...index]))

  return { sessions, messages, bytes, longMessages: longUsed, marker }
}

/**
 * 往一间会话的账本尾巴上**追加**一条 `user/message`。
 *
 * 门用它扮「另一个进程」(第 ⑦ 条):这个函数由一个 `node` 子进程调用,进程内的
 * append 观察者对它一无所知,能把它折进索引的只有 Worker 里的目录监视(§5.2 / §5.6)。
 * `seq` 从文件尾读 —— 与 `LedgerFeed.fingerprint` 认的是同一个数。
 */
export function appendUserMessage(storePath, sessionId, content, messageId) {
  const logPath = path.join(storePath, 'sessions', sessionId, 'events.jsonl')
  const text = fs.readFileSync(logPath, 'utf-8')
  let lastSeq = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const record = JSON.parse(line)
      if (typeof record?.seq === 'number' && record.seq > lastSeq) lastSeq = record.seq
    } catch {
      // 半行不算数。
    }
  }
  const time = Date.now()
  fs.appendFileSync(logPath, eventLine(lastSeq + 1, time, 'user/message',
    messageData(messageId, 'user', content, time)))
  return lastSeq + 1
}

/**
 * 往**头 `count` 间已种会话**各追加一条,每 `longEvery` 条来一条 > 64KB 的。
 *
 * 为什么要有「一次追很多」这个形:门的 ⑤c 量的是「只有折的时候主线程闲不闲」,
 * 而一次 spawn 一个 node 大约要 0.8s —— 追 40 条就是 32 秒,其中 90% 的时间主线程
 * 什么也没干。那样的窗口里 p99 被稀释,折就算真的卡了 30ms 也照样绿。**一个子进程
 * 追完全部**,折就挤成一小段真正的突发,窗口里量到的才是折本身。
 */
export function appendManySessions(storePath, count, marker, longEvery = 5) {
  const longBody = 'x'.repeat(70 * 1024)
  let written = 0
  for (let i = 0; i < count; i += 1) {
    const sessionId = `seed-${String(i).padStart(4, '0')}`
    const body = i % longEvery === 0 ? `${marker} ${longBody}` : `${marker} 第 ${i} 条`
    appendUserMessage(storePath, sessionId, body, `${marker}-${i}`)
    written += 1
  }
  return written
}

/*
 * 子进程入口:
 *   node scripts/lib/gate-seed-ledger.mjs append      <store> <sessionId> <text> <messageId>
 *   node scripts/lib/gate-seed-ledger.mjs append-many <store> <count> <marker> [longEvery]
 */
if (process.argv[2] === 'append') {
  const [, , , storePath, sessionId, content, messageId] = process.argv
  const seq = appendUserMessage(storePath, sessionId, content, messageId)
  process.stdout.write(`${seq}\n`)
} else if (process.argv[2] === 'append-many') {
  const [, , , storePath, count, marker, longEvery] = process.argv
  const written = appendManySessions(storePath, Number(count), marker,
    longEvery === undefined ? undefined : Number(longEvery))
  process.stdout.write(`${written}\n`)
}
