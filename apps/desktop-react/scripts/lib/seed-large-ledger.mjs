/**
 * **真店规模的账本夹具**(2026-09-10)—— 一份参数化、可复现、**真编码**的
 * `events.jsonl` 生成器。
 *
 * ── 它为什么存在 ──────────────────────────────────────────────────────────
 * 「会话加载体验」这条线要打的靶在用户的真店里:那条「9月新需求」会话
 * `events.jsonl` **55,108,241 字节 / 404 条消息 / 953 张工具卡**,折出来
 * **37,470 个 DOM 节点、269,803px 文档高**,`sessions.get` 的应答 24.5MB、
 * `sessionEvents.listRaw` 53MB,`blobs/` 里 22 个文件。**门要量的每一笔钱都
 * 与这个量级成正比**,拿一份 1.7MB 的小账本量出来的读数说明不了任何事。
 *
 * 从前这份种子是 `gate-chat-layout.mjs` 自己身上的一段私货(190 轮 × 5 次工具,
 * 1.7MB),而 `gate-continuity.mjs` 走的是另一条路 —— 真的发消息、等假 provider
 * 回答。两条路两种量级、两套写法,谁都不是真店。现在只有这一份。
 *
 * ── 它给出的是**真编码**,不是「长得像」 ──────────────────────────────────
 * 每一行都按 `packages/core/session/events/types.ts` 的事件形写,能被
 * `packages/core/session/projection/` 的折叠器原样折出来:
 *
 *  · 一轮 = `user/message` → `run/start` → `request/start` → 若干
 *    `assistant/chunks`(**打包行**:一行装几条逻辑 delta,`dt` 与 `text` 等长,
 *    见 `chunk-codec.ts` 的解码器)+ `assistant/part-end` → 每次工具
 *    `assistant/chunks(tool-input)` + `part-end` + `tool/call` + `tool/result`
 *    → `request/end` → `run/end`。
 *  · **`request/end` 不是可选的**:`materializeContentParts` 有一道
 *    `requestSettled` 闸,没有它 `contentParts` 一格都出不来(`content` 照旧有
 *    —— 于是屏幕上文字在、块结构没了,是一份会骗过行数断言的假夹具)。
 *  · **64KB 那条线由编码规则说了算**,不由这里拍:超过
 *    `SESSION_EVENT_BLOB_THRESHOLD_BYTES` 的工具结果写进
 *    `sessions/<id>/blobs/<sha256 前 16 位>`,事件行里只留
 *    `result: { blob: {hash, bytes, mime} }` —— 与 `packages/backend/session/
 *    blob-store.ts` 的 `textOrBlobForEvent` / `hashSessionBlob` 同一条规矩。
 *    所以**blob 里的字节不进 `events.jsonl`**,想把账本撑到 50MB 只能靠行内。
 *  · 图片走 `assistant/part-end { kind:'image', blob }` —— 那一格是
 *    `partIsSettleExempt` 豁免的,不需要 `request/end` 也画得出来。
 *
 * ── 尺寸怎么解出来 ────────────────────────────────────────────────────────
 * 真店的形状是「**消息扛高度、工具结果扛字节**」:404 条消息 × 约 575px ≈
 * 232,000px,加上 953 张折叠的工具卡 × 约 40px ≈ 38,000px,正好 269,803px;
 * 而 55MB 里绝大部分是工具结果(55MB / 953 ≈ 58KB 一张,刚好压在 64KB 那条
 * 线下面 —— 输出预算截断的结果)。夹具照抄这个形状:
 *
 *  · 回复正文按 `replyChars` 给高度(缺省 1500 字 ≈ 一屏多一点);
 *  · 工具结果按 `toolResultBytes` 给字节,**缺省封顶 63KB**(压在 64KB 线下,
 *    像真店那样留在行内);
 *  · `toolCallsPerTurn` 缺省 2–3 随机 —— 但 200 轮 × 2.5 × 63KB 只有 31MB,
 *    够不到 50MB。所以缺省档下**目标字节是主、每轮次数是辅**:先按 2–3 定
 *    下限,再按 `targetBytes` 把它抬到解得出来的那个数(缺省解出来 ≈ 5/轮,
 *    与真店 953/202 ≈ 4.7 同量级),抬到多少**报出来**,不闷声改参数。
 *    调用方显式给 `toolCallsPerTurn: [2, 3]` 且 `targetBytes: 0` 就按字面办。
 *
 * 解法是**先造一轮量一量再外推**:每行的 JSON 开销是可算的,但算错一次就要
 * 重造 50MB。造第 0 轮拿到「一轮固定多少字节 / 一次结果多少字节」,解出每轮
 * 次数,再正式造一遍。两趟里第一趟只有一轮,代价可忽略。
 *
 * ── 复现性 ────────────────────────────────────────────────────────────────
 * 随机数是 mulberry32,种子在参数里(缺省 `20260910`)。**同参数逐字节可复现**
 * —— 时间戳也从参数里的 `startedAt` 推,不读 `Date.now()`。门的读数因此可以
 * 跨机器跨天对照;要换一份不同的账本就换 `seed`,不是等它自己变。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 * ```js
 * import { seedLargeLedger } from './lib/seed-large-ledger.mjs'
 * // core 停着的时候写(冷启一次全读,不碰「外来写手」那道闸)
 * const stats = seedLargeLedger(store, sessionId, { messages: 400 })
 * // → { bytes, messages, toolCalls, blobs, turns, toolCallsPerTurn, toolResultBytes }
 * ```
 * 纯函数半边是 `buildLargeLedger(sessionId, options)`,它一个字节都不落盘 ——
 * 单测与「算一下这份参数有多大」走它。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** 与 `@onething/core/session` 的 `SESSION_EVENT_BLOB_THRESHOLD_BYTES` 同一个数。 */
export const BLOB_THRESHOLD_BYTES = 64 * 1024

/**
 * 行内结果的封顶,`toolResultBytes: 'auto'` 解到这里就不再往上。
 *
 * 它远在 64KB 线**下面**是有意的:真店 953 张卡只有 22 个越线走了 blob,夹具
 * 照抄这个形状,于是账本的字节真的落在 `events.jsonl` 里而不是被 blob 抽走。
 * (显式给 `toolResultBytes` 的调用方不受这个封顶管 —— 给一个越线的数就是在
 * 要求走 blob,那是编码规则该做的事,不该被夹具拦住。)
 *
 * 来历是真店的两个读数相除:`sessions.get` 应答 24.5MB,而工具结果在那份应答里
 * 大约占一份半(`step.result` 与 `step.toolCall.result` 各一份),953 张卡 ⇒
 * 一张约 18KB。解到 50KB 的那一版实测把 `sessions.get` 撑到 135MB —— 账本大小
 * 是对的,**但每一张卡要排的版是真店的三倍**,量出来的读数因此不成立。
 * 差的那些字节由 `recipeRoundsPerTurn` 补,它们不上屏。
 */
const REALISTIC_RESULT_CAP_BYTES = 20 * 1024

export const LEDGER_DEFAULTS = {
  /** 消息条数(一问一答两条)。真店那条 404。 */
  messages: 400,
  /** 每轮工具调用次数的**下限区间**;不够 `targetBytes` 时按解出来的数抬高。 */
  toolCallsPerTurn: [2, 3],
  /** 一次工具结果的正文字节;`'auto'` = 解出来(封顶 `REALISTIC_RESULT_CAP_BYTES`)。 */
  toolResultBytes: 'auto',
  /** `events.jsonl` 的目标字节。给 0 = 不解尺寸,`toolCallsPerTurn` 按字面办。 */
  targetBytes: 50 * 1024 * 1024,
  /**
   * 工具卡的目标张数(真店 953)。`toolCallsPerTurn` 那个区间只是**下限**,
   * 解尺寸时按这个数把每轮次数抬上去 —— 因为两件事要同时对得上真店:
   * 卡的**张数**决定折出多少节点、多少个折叠块;结果的**字节**决定账本多大。
   * 给 0 = 不抬,`toolCallsPerTurn` 按字面办。
   */
  targetToolCalls: 900,
  /**
   * 一条回复的正文字数。
   *
   * 缺省 1500 是**量出来挑的那一档**:它把折出来的 DOM 节点数落在真店的
   * 37,470 附近(实测 39,531),而这正是排版账真正计价的那个量。
   *
   * **它管不到文档高度,别拿它去追那个数**(09-10 实测):1500 → 3600 翻了一倍多,
   * 文档高只从 112,437px 动到 117,321px,节点数倒是从 39,531 涨到 43,230 ——
   * 因为①消息体是**夹住**的(超长正文不换来更高的行),②屏外的行走
   * `content-visibility: auto` 报的是**估高**不是真高。所以夹具与真店在
   * 「文档高」这一格上有一道口子(约 117k vs 269,803px),它由壳的夹高与估高
   * 规则决定,不由账本决定 —— 记在这儿,别用注水正文去凑。
   */
  replyChars: 1500,
  /** 一条回复切成几批 `assistant/chunks`(像真流式:一行装几条 delta)。 */
  assistantChunks: 32,
  /** 一批打包行里装几条逻辑 delta。 */
  deltasPerChunk: 4,
  /** 每隔几轮带一段思考;0 = 不带。 */
  reasoningEveryTurns: 3,
  /** 一段思考的字数。 */
  reasoningChars: 420,
  /** 越过 64KB 线、真的落 `blobs/` 的大结果**个数**(真店 22 个)。 */
  largeResults: 22,
  /** 一个大结果的正文字节(必须 > 64KB,否则它不会走 blob)。 */
  largeResultBytes: 800 * 1024,
  /** 图片消息条数(小 PNG,各自一个 blob)。 */
  images: 6,
  /**
   * **每一次请求的记账行**(`request/recipe`)。真的 agent loop 每发一次请求就写
   * 一条,里面是「这次发出去的是哪几条消息」的身份 + 指纹表 —— 一条会话跑到后面,
   * 每条配方都要把整段历史点一遍名,于是它随轮数**二次增长**,是真账本里最大的
   * 一笔「不上屏的字节」。夹具必须有它,否则 50MB 只能从工具结果里挤,而那会把
   * `sessions.get` 撑到真店的五倍(实测 135MB vs 24.5MB)——量出来的排版账就不对了。
   *
   * `'auto'` = 每轮 `1 + 这一轮的工具次数`(与真 loop 同形),不够 `targetBytes`
   * 时按解出来的数往上加。给 0 = 一条不写。
   */
  recipeRoundsPerTurn: 'auto',
  /** 随机种子:同参数同种子 = 逐字节同一份账本。 */
  seed: 20260910,
  /** 第一条事件的时刻;不读 `Date.now()`,复现性要求时间也是参数。 */
  startedAt: Date.UTC(2026, 8, 1, 9, 0, 0),
  /** 相邻两条事件之间的毫秒数(只影响时间戳的样子,不影响字节数)。 */
  msPerEvent: 40,
  /**
   * 消息 id 的前缀。缺省 `undefined` = 用 `sessionId` 的前八位 —— **两条会话的
   * 消息 id 必须互不相同**,否则「这一行是哪条会话的」在 DOM 上说不出来,而门
   * 判「内容上屏了吗」正是靠指名道姓地等某一行(`<前缀>-a-<末轮>`)。
   */
  idPrefix: undefined,
}

/* ── 确定性随机 ──────────────────────────────────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const intBetween = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))

/* ── 正文:先造几块料,再按字节量裁 ───────────────────────────────────────
 *
 * 造 50MB 正文不能一个字一个字拼。这里先造八块各约 72KB 的料(散文 / 代码块 /
 * 表格三种味道轮着来),之后一切「给我 N 字节」都是在料上按确定性的偏移切一刀。
 * 排版的钱花在行盒与块盒上,料像不像不重要,**行数与块数像**才重要。
 */

const PROSE_SENTENCES = [
  '这一段是夹具正文,长度取一条正常回答的量级:它要在屏幕上真的占掉几行,这样整棵树的高度才与真店同量级。',
  '排版的开销记在行盒与块盒上,而不是记在字符本身,所以这里不追求内容像不像,只追求行数与块数像。',
  '真店那条会话有四百条消息、九百多张工具卡,折出来三万七千个节点、二十七万像素的文档高。',
  '门要量的是「一次排版要多少钱」,而这笔钱与树的总量成正比,夹具的职责就是把总量摆到位。',
  '工具结果通常是一大段被输出预算截断过的文本,压在六十四千字节那条线下面,于是它留在事件行里。',
  '越过那条线的少数几个走内容寻址的 blob,事件行里只留一个引用,这条规矩由编码器说了算。',
]

const CODE_LINES = [
  'export function collectLayoutCost(node: LayoutNode, budget: Budget): CostReport {',
  '  const rows = node.children.filter((child) => child.kind === "message-row")',
  '  let total = 0',
  '  for (const row of rows) {',
  '    total += measureRow(row, { intrinsicBlockSize: budget.intrinsic })',
  '  }',
  '  return { total, rows: rows.length, overBudget: total > budget.limit }',
  '}',
]

const TABLE_ROWS = [
  '| 动作 | 读数 | 预算 | 结论 |',
  '| --- | --- | --- | --- |',
  '| 点会话行首帧 | 12ms | 16ms | 绿 |',
  '| 池命中上屏 | 84ms | 100ms | 绿 |',
  '| 冷载首屏 | 271ms | 300ms | 绿 |',
  '| 来回切 | 43ms | 50ms | 绿 |',
]

/**
 * 一块料 ≈ 72KB,八块轮着用。造一次,之后只切不造。
 *
 * 味道三七开(散文 / 代码 / 表格轮着来)与**一句一段**都是量出来定的,不是随手写的:
 * 折出来的 DOM 节点数是排版真正计价的那个量,而它对「一段多长」极敏感 ——
 * 一句一段落 **39,531** 个节点(真店 37,470),改成五句一段就掉到 **28,182**,
 * 文档高却几乎不动(夹高 + 估高,见 `replyChars` 的注)。所以这里保留短段。
 */
function buildStockBlocks(rng) {
  const blocks = []
  for (let index = 0; index < 8; index += 1) {
    const flavour = index % 3
    const parts = []
    let bytes = 0
    let cursor = intBetween(rng, 0, 5)
    while (bytes < 72 * 1024) {
      let piece
      if (flavour === 0) {
        piece = `${PROSE_SENTENCES[cursor % PROSE_SENTENCES.length]}\n\n`
      } else if (flavour === 1) {
        piece = `${CODE_LINES[cursor % CODE_LINES.length]}\n`
      } else {
        piece = `${TABLE_ROWS[cursor % TABLE_ROWS.length]}\n`
      }
      parts.push(piece)
      bytes += Buffer.byteLength(piece, 'utf8')
      cursor += 1
    }
    blocks.push(parts.join(''))
  }
  return blocks
}

/**
 * 从料里裁一段 ≈ `bytes` 字节的正文。
 *
 * 按字节裁会把一个多字节字符劈成两半 —— JSON 里那是个替换字符,读回来就不是
 * 原文了。所以按**字符**逼近:料是三字节一字的中文与一字节的 ASCII 混着,
 * 先按平均字节宽度估个字符数,再逐步逼近,最后必然落在 [bytes, bytes+8] 里。
 */
function sliceBytes(block, offset, bytes) {
  const start = offset % Math.max(1, block.length - 1)
  let take = Math.max(1, Math.round(bytes / 2))
  let out = ''
  for (let round = 0; round < 24; round += 1) {
    out = block.slice(start, start + take)
    if (out.length < take) out += block.slice(0, take - out.length)
    const got = Buffer.byteLength(out, 'utf8')
    if (got >= bytes && got <= bytes + 8) return out
    if (got === 0) break
    const next = Math.max(1, Math.round((take * bytes) / got))
    if (next === take) {
      take += got < bytes ? 1 : -1
      if (take < 1) break
      continue
    }
    take = next
  }
  return out
}

/* ── 一张小 PNG(确定性、每张不同) ───────────────────────────────────────
 *
 * 真的 PNG:8 字节签名 + IHDR + 一段 zlib「储存」块包住的像素 + IEND,CRC 都算对。
 * 之所以要真的:图片 part 的正文由 `readSessionBlobBase64` 读回来交给 <img>,
 * 一段假字节在屏幕上是个碎图标 —— 那是另一种高度,量出来的账就不对。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** 一张 `size`×`size` 的纯色 PNG;`tint` 决定颜色,所以每张内容不同 = 每张一个 blob。 */
function makeSmallPng(size, tint) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3
      raw[at] = (tint * 37 + x * 3) & 0xff
      raw[at + 1] = (tint * 71 + y * 3) & 0xff
      raw[at + 2] = (tint * 113) & 0xff
    }
  }
  // zlib 的「储存」块:头 0x78 0x01,每块 5 字节头 + 原文,尾巴一个 adler32。
  const blocks = []
  for (let at = 0; at < raw.length; at += 0xffff) {
    const slice = raw.subarray(at, Math.min(at + 0xffff, raw.length))
    const header = Buffer.alloc(5)
    header[0] = at + 0xffff >= raw.length ? 1 : 0
    header.writeUInt16LE(slice.length, 1)
    header.writeUInt16LE(~slice.length & 0xffff, 3)
    blocks.push(header, slice)
  }
  let a = 1
  let b = 0
  for (let i = 0; i < raw.length; i += 1) {
    a = (a + raw[i]) % 65521
    b = (b + a) % 65521
  }
  const adler = Buffer.alloc(4)
  adler.writeUInt32BE(((b << 16) | a) >>> 0, 0)
  const zlib = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adler])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 目录表(`request/tools` 那一份)。整条会话只写一次 —— 形要对,量不重要。
 */
const SEED_TOOL_SCHEMAS = [
  { name: 'read', description: '读一个文件。', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] } },
  { name: 'write', description: '写一个文件。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit', description: '就地改一个文件。', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'] } },
  { name: 'bash', description: '跑一条命令。', parameters: { type: 'object', properties: { command: { type: 'string' }, run_in_background: { type: 'boolean' }, timeout: { type: 'number' } }, required: ['command'] } },
  { name: 'search', description: '跨会话检索。', parameters: { type: 'object', properties: { query: { type: 'string' }, tier: { type: 'string', enum: ['strict', 'relaxed', 'all'] } }, required: ['query'] } },
]

/** 配方里那一列指纹(16 位十六进制),轮着用 —— 形要对,值不必真。 */
const RECIPE_HASHES = Array.from({ length: 16 }, (_, i) => (0x51ed0000 + i * 0x9e37).toString(16).padStart(16, '0'))

/** 文件名 = sha256 前 16 位(与 `blob-store.ts` 的 `hashSessionBlob` 同一条)。 */
export function hashLedgerBlob(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

/* ── 造一轮 ──────────────────────────────────────────────────────────────── */

/**
 * 一轮的全部事件。造第 0 轮是为了量尺寸,造第 n 轮是为了写盘 —— 同一个函数,
 * 所以量到的与写下的必然是同一种行。
 *
 * @returns {{lines: string[], toolCalls: number, blobs: Array<{hash: string, data: Buffer}>}}
 */
function buildTurn(context, turn) {
  const {
    idPrefix, blocks, options, toolCallsFor, recipeRoundsFor, largeAtTurn, imageAtTurn,
  } = context
  const lines = []
  const blobs = []
  const push = (type, data) => {
    context.seq += 1
    context.time += options.msPerEvent
    lines.push(JSON.stringify({ seq: context.seq, time: context.time, type, data }))
  }
  const userId = `${idPrefix}-u-${turn}`
  const runId = `${idPrefix}-r-${turn}`
  const assistantId = `${idPrefix}-a-${turn}`
  const requestIndex = 1

  push('user/message', {
    message: {
      id: userId,
      role: 'user',
      content: `第 ${turn + 1} 问 —— ${sliceBytes(blocks[turn % blocks.length], turn * 97, 180)}`,
      timestamp: context.time,
    },
  })
  push('run/start', {
    runId,
    kind: 'send',
    assistantMessageId: assistantId,
    triggerMessageId: userId,
    provider: 'deepseek',
    model: 'deepseek-chat',
    timestamp: context.time,
  })
  push('request/start', { requestIndex, messageId: assistantId, runId })

  /*
   * 目录只在**变了**的时候写(`maybeWriteTools` 按 hash 去重),所以整条会话
   * 只有第一轮那一份 —— 夹具照办,别把 40KB 的目录抄两百遍。
   */
  if (turn === 0) {
    push('request/tools', {
      requestIndex,
      toolsHash: 'seed-tools-0000',
      tools: SEED_TOOL_SCHEMAS,
      runId,
    })
    push('request/header', {
      requestIndex,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPromptHash: 'seed-sys-000000',
      toolsHash: 'seed-tools-0000',
      reason: 'initial',
      runId,
    })
  }

  let partIndex = 0
  /** 一段正文 → 若干打包行 + 一条 part-end(与编码器的批一模一样)。 */
  const emitStreamedPart = (kind, text, extra = {}) => {
    const index = partIndex
    partIndex += 1
    const batches = Math.max(1, options.assistantChunks)
    const perBatch = Math.max(1, options.deltasPerChunk)
    const deltaCount = batches * perBatch
    const step = Math.ceil(text.length / deltaCount)
    let at = 0
    for (let batch = 0; batch < batches && at < text.length; batch += 1) {
      const texts = []
      const dt = []
      for (let d = 0; d < perBatch && at < text.length; d += 1) {
        texts.push(text.slice(at, at + step))
        dt.push(batch * perBatch * 12 + d * 12)
        at += step
      }
      if (texts.length === 0) break
      push('assistant/chunks', {
        runId,
        requestIndex,
        messageId: assistantId,
        partIndex: index,
        kind,
        time0: context.time,
        dt,
        text: texts,
        turnIndex: 1,
        ...extra,
      })
    }
    push('assistant/part-end', {
      runId,
      requestIndex,
      messageId: assistantId,
      partIndex: index,
      kind,
      len: text.length,
      ...extra,
    })
    return index
  }

  if (options.reasoningEveryTurns > 0 && turn % options.reasoningEveryTurns === 0) {
    emitStreamedPart('reasoning', sliceBytes(blocks[(turn + 5) % blocks.length], turn * 311, options.reasoningChars * 2))
  }
  emitStreamedPart('text', sliceBytes(blocks[turn % blocks.length], turn * 613, options.replyChars * 2))

  const toolCalls = toolCallsFor(turn)
  for (let tool = 0; tool < toolCalls; tool += 1) {
    const callId = `${idPrefix}-c-${turn}-${tool}`
    const args = JSON.stringify({ path: `/seed/turn-${turn}/file-${tool}.md`, offset: tool * 40 })
    emitStreamedPart('tool-input', args, { toolCallId: callId, toolName: 'read' })
    push('tool/call', {
      callId,
      name: 'read',
      argumentsRaw: args,
      messageId: assistantId,
      runId,
      turnIndex: 1,
    })

    const goesToBlob = largeAtTurn.get(turn)?.includes(tool) ?? false
    const bytes = goesToBlob ? options.largeResultBytes : context.toolResultBytes
    const body = sliceBytes(blocks[(turn * 3 + tool) % blocks.length], turn * 7919 + tool * 131, bytes)
    let result
    if (Buffer.byteLength(body, 'utf8') > BLOB_THRESHOLD_BYTES) {
      // 编码规则:越线就落 blob,行里只留引用(`textOrBlobForEvent` 同一条)。
      const data = Buffer.from(body, 'utf8')
      const hash = hashLedgerBlob(data)
      blobs.push({ hash, data })
      result = { blob: { hash, bytes: data.byteLength, mime: 'text/plain' } }
    } else {
      result = { text: body }
    }
    push('tool/result', {
      callId,
      isError: false,
      resultPreview: body.slice(0, 500),
      result,
    })
  }

  const image = imageAtTurn.get(turn)
  if (image !== undefined) {
    const data = makeSmallPng(24, image)
    const hash = hashLedgerBlob(data)
    blobs.push({ hash, data })
    push('assistant/part-end', {
      runId,
      requestIndex,
      messageId: assistantId,
      partIndex: partIndex++,
      kind: 'image',
      len: 0,
      blob: { hash, bytes: data.byteLength, mime: 'image/png' },
    })
  }

  /*
   * 这一轮的记账行。真 loop 每发一次请求写一条,每条把**当时的整段历史**点一遍
   * 名 —— 所以第 200 轮那条有四百个条目。它一个像素都不上屏,却是真账本里最大的
   * 一笔字节;夹具的 `targetBytes` 主要靠它填。
   */
  const rounds = recipeRoundsFor(turn, toolCalls)
  for (let round = 0; round < rounds; round += 1) {
    const historyLength = turn * 2 + 1
    const messages = []
    for (let m = 0; m < historyLength; m += 1) {
      messages.push({
        messageId: m % 2 === 0 ? `${idPrefix}-u-${m >> 1}` : `${idPrefix}-a-${m >> 1}`,
        contentHash: RECIPE_HASHES[(m + turn + round) % RECIPE_HASHES.length],
      })
    }
    push('request/recipe', {
      runId,
      requestIndex: round + 1,
      systemPromptHash: 'seed-sys-000000',
      toolsHash: 'seed-tools-0000',
      messages,
      params: { temperature: 0.6, stream: true },
    })
    push('request/response', {
      requestIndex: round + 1,
      runId,
      usage: { inputTokens: 1200 + turn * 4, outputTokens: 640 + round, totalTokens: 1840 + turn * 4 },
    })
  }

  push('request/end', {
    requestIndex,
    stopReason: 'stop',
    usage: { inputTokens: 1200 + turn, outputTokens: 900 + turn, totalTokens: 2100 + turn * 2 },
    runId,
  })
  push('run/end', { runId, outcome: 'completed' })

  return { lines, toolCalls, blobs }
}

/* ── 纯函数入口 ──────────────────────────────────────────────────────────── */

/**
 * 造一份账本,**一个字节都不落盘**。
 *
 * @param {string} sessionId
 * @param {Partial<typeof LEDGER_DEFAULTS> & {startSeq?: number}} overrides
 * @returns {{text: string, blobs: Array<{hash: string, data: Buffer}>, stats: object}}
 */
export function buildLargeLedger(sessionId, overrides = {}) {
  const options = { ...LEDGER_DEFAULTS, ...overrides }
  const turns = Math.max(1, Math.ceil(options.messages / 2))
  const [minCalls, maxCalls] = Array.isArray(options.toolCallsPerTurn)
    ? options.toolCallsPerTurn
    : [options.toolCallsPerTurn, options.toolCallsPerTurn]

  const rng = mulberry32(options.seed)
  const blocks = buildStockBlocks(rng)

  // 每轮的**下限**次数先抽定(抽一次,两趟共用 —— 复现性)。
  const baseCalls = []
  for (let turn = 0; turn < turns; turn += 1) baseCalls.push(intBetween(rng, minCalls, maxCalls))

  // 哪几轮的哪一次是「越线的大结果」:均匀铺开,确定性。
  const largeAtTurn = new Map()
  for (let n = 0; n < options.largeResults; n += 1) {
    const turn = Math.floor(((n + 0.5) * turns) / Math.max(1, options.largeResults))
    const list = largeAtTurn.get(turn) ?? []
    list.push(0)
    largeAtTurn.set(turn, list)
  }
  const imageAtTurn = new Map()
  for (let n = 0; n < options.images; n += 1) {
    imageAtTurn.set(Math.floor(((n + 0.5) * turns) / Math.max(1, options.images)), n + 1)
  }

  const autoBytes = options.toolResultBytes === 'auto'
  const autoRecipe = options.recipeRoundsPerTurn === 'auto'

  /*
   * 补的那几次工具调用**按整份账本分摊**,不是每轮加一个整数 —— 每轮一次就是
   * 一档 12MB 的台阶,50MB 的目标会被抬到 65MB(实测)。分摊法:总共补 N 次,
   * 第 k 轮拿 `floor((k+1)N/turns) − floor(kN/turns)` 次,于是粒度是「一次」
   * 而不是「一轮一次」,落点贴着目标。
   */
  const idPrefix = options.idPrefix ?? sessionId.slice(0, 8)
  const makeContext = (toolResultBytes, extraTotal, extraRecipeRounds) => ({
    sessionId,
    idPrefix,
    blocks,
    rng,
    options,
    toolResultBytes,
    largeAtTurn,
    imageAtTurn,
    seq: options.startSeq ?? 0,
    time: options.startedAt,
    toolCallsFor: (turn) =>
      baseCalls[turn]
      + Math.floor(((turn + 1) * extraTotal) / turns)
      - Math.floor((turn * extraTotal) / turns),
    recipeRoundsFor: (turn, toolCalls) => {
      if (!autoRecipe) return Math.max(0, options.recipeRoundsPerTurn)
      void turn
      return 1 + toolCalls + extraRecipeRounds
    },
  })

  /*
   * ── 解尺寸:三个目标,三把旋钮,按「上不上屏」排先后 ──────────────────
   *
   *  ① **张数** ← `targetToolCalls`:抬每轮次数(分摊到各轮)。它决定折出多少
   *     折叠块、多少节点 —— 直接对着真店的 953。
   *  ② **每张多少字节** ← `toolResultBytes`,封顶 `REALISTIC_RESULT_CAP_BYTES`。
   *     它同时决定 `sessions.get` 有多大(结果在那份应答里出现约一份半),
   *     所以**不许拿它去填账本**:解到 50KB 那一版账本大小是对的,`sessions.get`
   *     却是真店的五倍。
   *  ③ **剩下的字节** ← `recipeRoundsPerTurn`:配方行不上屏、不进 `sessions.get`
   *     的消息树,正是真账本里那笔「大而不显」的钱。差多少由它补。
   *
   * 三步都是**造→量→改**而不是纸上外推:每行的 JSON 开销算错一次就要重造 50MB,
   * 而量一遍只要一秒。
   */
  const sumBase = baseCalls.reduce((a, b) => a + b, 0)
  let extraTotal = options.targetToolCalls > 0 ? Math.max(0, options.targetToolCalls - sumBase) : 0
  let resultBytes = autoBytes ? REALISTIC_RESULT_CAP_BYTES : Math.max(1, options.toolResultBytes)
  let extraRecipeRounds = 0

  let text = ''
  let lines = []
  let blobs = new Map()
  let toolCalls = 0
  let lastSeq = options.startSeq ?? 0
  let solveRounds = 0
  let recipeRows = 0
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const context = makeContext(resultBytes, extraTotal, extraRecipeRounds)
    lines = []
    blobs = new Map()
    toolCalls = 0
    for (let turn = 0; turn < turns; turn += 1) {
      const built = buildTurn(context, turn)
      lines.push(...built.lines)
      toolCalls += built.toolCalls
      for (const blob of built.blobs) blobs.set(blob.hash, blob.data)
    }
    text = `${lines.join('\n')}\n`
    lastSeq = context.seq
    solveRounds = attempt + 1
    recipeRows = lines.reduce((n, line) => (line.startsWith('{"seq"') && line.includes('"type":"request/recipe"') ? n + 1 : n), 0)

    const got = Buffer.byteLength(text, 'utf8')
    if (options.targetBytes <= 0) break
    // 命中区间:够到目标,又没超过 6% —— 再逼近一步的收益不值一次重造。
    if (got >= options.targetBytes && got <= options.targetBytes * 1.06) break
    if (got >= options.targetBytes) break

    // ② 先把结果填到写实封顶(它同时是排版的量,不能超)。
    const inline = Math.max(1, toolCalls - options.largeResults)
    if (autoBytes && resultBytes < REALISTIC_RESULT_CAP_BYTES) {
      resultBytes = Math.min(
        REALISTIC_RESULT_CAP_BYTES,
        Math.max(512, resultBytes + Math.round((options.targetBytes - got) / inline)),
      )
      continue
    }
    // ③ 剩下的交给配方行:一轮多一条,整份多 `turns × 一条的字节`。
    if (!autoRecipe) break
    const perRoundBytes = Math.max(1, Math.round((got * 0.5) / Math.max(1, recipeRows)))
    extraRecipeRounds += Math.max(1, Math.ceil((options.targetBytes - got) / (perRoundBytes * turns)))
  }

  return {
    text,
    blobs: [...blobs].map(([hash, data]) => ({ hash, data })),
    stats: {
      bytes: Buffer.byteLength(text, 'utf8'),
      messages: turns * 2,
      turns,
      toolCalls,
      blobs: blobs.size,
      events: lines.length,
      lastSeq,
      /** 解出来的每轮次数(下限区间 + 为够 `targetBytes` 抬高的那几次)。 */
      toolCallsPerTurn: Number((toolCalls / turns).toFixed(2)),
      toolResultBytes: resultBytes,
      /** `request/recipe` 行数(不上屏的那笔字节)。 */
      recipeRows,
      /** 解了几趟(造→量→改)。1 = 一次命中。 */
      solveRounds,
      idPrefix,
      /** 第一条 / 最后一条消息的 DOM id —— 门等的就是它们。 */
      firstMessageId: `${idPrefix}-u-0`,
      lastMessageId: `${idPrefix}-a-${turns - 1}`,
      largeResults: options.largeResults,
      images: options.images,
    },
  }
}

/* ── 写盘口 ──────────────────────────────────────────────────────────────── */

/**
 * 把一份账本追进 `sessions/<id>/events.jsonl`,blob 落 `sessions/<id>/blobs/`。
 *
 * **必须趁 core 停着写**:活着的 core 会按字节大小认出「外来写手」并抛
 * `SessionEventWriteError`(§14 那道闸)。会话本身要先由 `sessions.create` 建出来
 * —— `meta.json` 因此是产品自己写的那一份,夹具不伪造它。
 *
 * @returns 生成器的读数表(`bytes / messages / toolCalls / blobs / …`)。
 */
export function seedLargeLedger(storePath, sessionId, overrides = {}) {
  const sessionDir = path.join(storePath, 'sessions', sessionId)
  const ledgerPath = path.join(sessionDir, 'events.jsonl')
  const built = buildLargeLedger(sessionId, { startSeq: lastSeqOfLedger(ledgerPath), ...overrides })

  if (built.blobs.length > 0) {
    const blobsDir = path.join(sessionDir, 'blobs')
    mkdirSync(blobsDir, { recursive: true })
    // 内容寻址:同名必同内容,已经在的不重写(与 `putSessionBlob` 同一条)。
    for (const { hash, data } of built.blobs) {
      const target = path.join(blobsDir, hash)
      if (!existsSync(target)) writeFileSync(target, data)
    }
  }

  mkdirSync(sessionDir, { recursive: true })
  if (existsSync(ledgerPath)) appendFileSync(ledgerPath, built.text)
  else writeFileSync(ledgerPath, built.text)

  return { ...built.stats, ledgerPath, ledgerBytes: readFileSync(ledgerPath).length }
}

/** 账本里最后一条的 seq —— 追加要从它往后接。文件不在 = 从 0 起。 */
export function lastSeqOfLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return 0
  const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const seq = JSON.parse(lines[i]).seq
      if (typeof seq === 'number') return seq
    } catch {
      /* 半行就往前找 */
    }
  }
  return 0
}
