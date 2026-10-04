/**
 * 主持人抽屉的记录流:把 DJ 那条会话翻成人话的行(正本
 * `apps/desktop-react/docs/music-panel-2026-09.md` §16.3)。
 *
 * ── 为什么翻译住这里,而不是壳里 ─────────────────────────────────────────────
 * 壳不认识 ncm-cli。DJ 会话里的工具调用是 `bash` 跑的一条条 `ncm-cli …`,「这一条是在搜歌」
 * 「那一条是在排节目单」是音乐后端自己的知识,所以动词表住在产品层的音乐目录里,壳只画
 * `label` / `detail`。
 *
 * ── 为什么这里的输入输出都是结构形状 ───────────────────────────────────────
 * 产品层不许依赖跨进程契约包(边界门按字面扫),所以消息、工具调用、行的形状都在这只文件里
 * 按**结构**写一遍 —— 它们与契约里那几只类型逐格同形,装配层把契约类型直接递进来、把这里的
 * 结果直接交出去,TypeScript 按结构判等。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 * 纯函数,零副作用;**怪输入不抛**:认不出的命令退成「跑了一条命令」,读不懂的结果就不写摘要。
 */

import { extractFirstJsonObject } from './music-cli-json.js'
import { parseLrcLyric } from './music-lyrics.js'

/** 主持人此刻在干哪一类活(与契约 `MusicHostDoingKind` 同形)。 */
export type HostDoingKind = 'thinking' | 'search' | 'lyric' | 'queue' | 'skip' | 'command' | 'speaking'

/** 状态牌上那一句(与契约 `MusicHostDoing` 同形)。 */
export interface HostDoing {
  kind: HostDoingKind
  label: string
}

/** 读得懂的那几格工具调用(契约 `ToolCall` 的子集)。 */
export interface HostLogToolCall {
  id?: string
  toolId?: string
  toolName?: string
  arguments?: unknown
  result?: unknown
  status?: string
  error?: string
  rejected?: boolean
}

/** 读得懂的那几格步骤(契约 `Step` 的子集)。老会话的工具调用有时只挂在 `steps` 上。 */
export interface HostLogStep {
  toolCallId?: string
  toolCall?: HostLogToolCall
  result?: string
  error?: string
  status?: string
}

/** 读得懂的那几格消息(契约 `ChatMessage` 的子集)。 */
export interface HostLogMessage {
  id: string
  role: string
  content?: unknown
  timestamp?: number
  source?: string
  origin?: { source?: string } | null
  toolCalls?: readonly HostLogToolCall[]
  steps?: readonly HostLogStep[]
  contentParts?: readonly unknown[]
}

/** 记录流的一行(与契约 `MusicHostLogRow` 同形)。 */
export type HostLogRow =
  | { kind: 'you'; id: string; at: number; text: string }
  | { kind: 'nudge'; id: string; at: number; text: string }
  | { kind: 'host'; id: string; at: number; text: string }
  | {
      kind: 'card'
      id: string
      at: number
      verb: HostDoingKind
      label: string
      detail?: string
      songs?: string[]
      failed?: boolean
    }

/** `hostLog` 读法交出的那一份(与契约 `MusicHostLog` 同形)。 */
export interface HostLog {
  rows: HostLogRow[]
  absent: boolean
  truncated: boolean
}

/** 一次工具调用翻成的那一句。 */
export interface HostCallDescription {
  verb: HostDoingKind
  label: string
  detail?: string
  songs?: string[]
  failed?: boolean
}

export const HOST_LOG_DEFAULT_LIMIT = 60

const LABEL_MAX = 60
const DETAIL_MAX = 80
const PROGRAMME_INBOX_FILE = 'programme-inbox.json'
const GENERIC_LABEL = '跑了一条命令'

/* ── 命令行 ────────────────────────────────────────────────────────────────── */

/** 一条命令里 `ncm-cli` 那一段:参数 token(引号已去)与原样的那一段字。 */
interface NcmInvocation {
  args: string[]
  raw: string
}

/** 读到这些 token 就是这一段命令结束了(管道 / 重定向 / 串接)。 */
const SEGMENT_END = new Set(['|', '||', '&&', ';', '>', '>>', '<', '2>', '2>&1', '&'])

/** 很朴素的 shell 分词:认单双引号,别的一概按空白切。够认 `--keyword "一荤一素 毛不易"`。 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < text.length) current += text[++index]
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

function findNcmInvocation(command: string): NcmInvocation | null {
  const match = /(^|[\s;&|(])((?:\S*\/)?ncm-cli)(?=\s|$)/.exec(command)
  if (!match) return null
  const start = match.index + match[1]!.length + match[2]!.length
  const tokens = tokenize(command.slice(start))
  const args: string[] = []
  for (const token of tokens) {
    if (SEGMENT_END.has(token)) break
    args.push(token)
  }
  const raw = command.slice(start).split(/\s(?:\|\|?|&&|;|>>?|2>)\s/)[0]?.split('\n')[0]?.trim() ?? ''
  return { args, raw }
}

/** `--keyword X` / `--keyword=X`。 */
function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === flag) return args[index + 1]
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
  }
  return undefined
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/* ── 工具结果 ──────────────────────────────────────────────────────────────── */

/** 工具结果的正文。字符串原样;结构化结果取 text 片段;读不懂 = 空串。 */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return ''
  const record = result as Record<string, unknown>
  if (Array.isArray(record.content)) {
    return record.content
      .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('')
  }
  if (typeof record.content === 'string') return record.content
  if (typeof record.output === 'string') return record.output
  const details = record.details
  if (details && typeof details === 'object' && typeof (details as { output?: unknown }).output === 'string') {
    return (details as { output: string }).output
  }
  return ''
}

/** bash 在正文尾巴上缀的 `<bash_metadata>` 块。退出码从这里读,摘要不带它。 */
const BASH_METADATA = /<bash_metadata>[\s\S]*?<\/bash_metadata>/g

function exitCodeOf(text: string): number | undefined {
  const match = /<bash_metadata>[\s\S]*?Exit code:\s*(-?\d+)[\s\S]*?<\/bash_metadata>/.exec(text)
  return match ? Number(match[1]) : undefined
}

/** ncm-cli 在 JSON 前面吐的杂行(新版本横幅 / orpheus 地址),摘要不该挑中它们。 */
function isNoiseLine(line: string): boolean {
  return /^[│╭╰┌└─]/.test(line) || line.startsWith('[orpheus]')
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.replace(BASH_METADATA, '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !isNoiseLine(trimmed)) return trimmed
  }
  return ''
}

/* ── 结果摘要 ──────────────────────────────────────────────────────────────── */

interface RawSearchRecord { name?: unknown; playFlag?: unknown }

/** 搜歌:搜到几首、第一首能放的是哪首。JSON 被 `head -c` 截断时退到正则。 */
function searchDetail(text: string): string | undefined {
  const parsed = extractFirstJsonObject<{ data?: { recordCount?: unknown; records?: unknown } }>(text)
  if (parsed?.data) {
    const records = Array.isArray(parsed.data.records) ? (parsed.data.records as RawSearchRecord[]) : []
    const count = typeof parsed.data.recordCount === 'number' ? parsed.data.recordCount : records.length
    if (count === 0) return '没搜到'
    const playable = records.find(record => record?.playFlag === true && typeof record.name === 'string')
    if (playable) return `${count} 首,选了「${String(playable.name)}」`
    if (records.length > 0 && records.every(record => record?.playFlag === false)) return `${count} 首,都放不了`
    return `${count} 首`
  }
  const countMatch = /"recordCount"\s*:\s*(\d+)/.exec(text)
  if (!countMatch) return undefined
  const count = Number(countMatch[1])
  if (count === 0) return '没搜到'
  const afterRecords = text.slice(text.indexOf('"records"') + 1)
  const name = text.includes('"records"') ? /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(afterRecords)?.[1] : undefined
  return name ? `${count} 首,第一首「${name}」` : `${count} 首`
}

/** 歌词署名行(作词 / 作曲 …)不是歌词。 */
const LYRIC_CREDIT = /^(作词|作曲|编曲|制作人|制作|演唱|原唱|词|曲|混音|录音|母带|和声|吉他|贝斯|鼓|键盘|监制|出品|OP|SP)\s*[::]/i

function lyricDetail(text: string): string | undefined {
  const parsed = extractFirstJsonObject<{ data?: { lyric?: unknown; noLyric?: unknown } }>(text)
  if (parsed?.data) {
    if (parsed.data.noLyric === true) return '没有歌词'
    if (typeof parsed.data.lyric !== 'string') return undefined
    const line = parseLrcLyric(parsed.data.lyric).find(entry => entry.text.trim() && !LYRIC_CREDIT.test(entry.text.trim()))
    return line ? truncate(`「${line.text.trim()}」`, DETAIL_MAX) : undefined
  }
  return undefined
}

/** 收件箱那份 JSON 里的歌名。`title` 是「歌名 - 歌手」,摆出来只要歌名。 */
function inboxSongs(text: string): string[] | undefined {
  const parsed = extractFirstJsonObject<{ entries?: unknown }>(text)
  if (!parsed || !Array.isArray(parsed.entries)) return undefined
  const songs: string[] = []
  for (const entry of parsed.entries) {
    const title = entry && typeof entry === 'object' ? (entry as { title?: unknown }).title : undefined
    if (typeof title !== 'string' || !title.trim()) continue
    songs.push(title.split(' - ')[0]!.trim() || title.trim())
  }
  return songs
}

function songsDetail(songs: readonly string[] | undefined): string | undefined {
  if (!songs || songs.length === 0) return undefined
  const head = songs.slice(0, 3).join('、')
  return truncate(songs.length > 3 ? `${head} 等 ${songs.length} 首` : head, DETAIL_MAX)
}

/* ── 动词表 ────────────────────────────────────────────────────────────────── */

/** 一条调用在动词表眼里的样子:bash 的命令行,或写文件工具的路径 + 正文。 */
interface CallShape {
  command: string
  ncm: NcmInvocation | null
  /** 写文件类工具(write / edit)写到哪、写了什么。 */
  writePath?: string
  writeContent?: string
}

/**
 * 动词表,一行一动词,从上往下第一行认领。加一个动词 = 加一行,别处一个字不动。
 *  · `label`:卡片上那一句(过去时的名词短语);
 *  · `doing`:状态牌上那一句(现在时);
 *  · `detail`:从工具结果里读的摘要,读不懂就不写;
 *  · `songs`:这张卡涉及的歌(不看结果,看它写了什么)。
 */
interface VerbRow {
  verb: HostDoingKind
  claims(shape: CallShape): boolean
  label(shape: CallShape): string
  doing(shape: CallShape, songs: string[] | undefined): string
  detail?(text: string, shape: CallShape, songs: string[] | undefined): string | undefined
  songs?(shape: CallShape): string[] | undefined
}

function writesInbox(shape: CallShape): boolean {
  if (shape.writePath) return shape.writePath.endsWith(PROGRAMME_INBOX_FILE)
  // bash 里的 heredoc / echo 重定向进收件箱(`cat > …/programme-inbox.json <<'EOF'`、`tee`)。
  return new RegExp(`(>|\\btee\\b)[^\\n]*${PROGRAMME_INBOX_FILE.replace('.', '\\.')}`).test(shape.command)
}

const VERB_TABLE: readonly VerbRow[] = [
  {
    verb: 'queue',
    claims: writesInbox,
    label: () => '排进节目单',
    doing: (_shape, songs) => (songs && songs.length > 0 ? `排进了 ${songs.length} 首` : '在排节目单'),
    songs: shape => inboxSongs(shape.writeContent ?? shape.command),
    detail: (_text, _shape, songs) => songsDetail(songs),
  },
  {
    verb: 'search',
    claims: shape => shape.ncm?.args[0] === 'search' && shape.ncm.args[1] === 'song',
    label: shape => {
      const keyword = shape.ncm ? flagValue(shape.ncm.args, '--keyword') : undefined
      return keyword ? truncate(`搜「${keyword}」`, LABEL_MAX) : '搜歌'
    },
    doing: shape => {
      const keyword = shape.ncm ? flagValue(shape.ncm.args, '--keyword') : undefined
      return keyword ? truncate(`在搜「${keyword}」`, LABEL_MAX) : '在搜歌'
    },
    detail: text => searchDetail(text),
  },
  {
    verb: 'lyric',
    claims: shape => shape.ncm?.args[0] === 'song' && shape.ncm.args[1] === 'lyric',
    label: () => '翻歌词',
    doing: () => '在翻歌词',
    detail: text => lyricDetail(text),
  },
  {
    verb: 'command',
    claims: shape => shape.ncm !== null,
    label: shape => truncate(shape.ncm?.raw || shape.ncm?.args.join(' ') || 'ncm-cli', LABEL_MAX),
    doing: () => '在跑命令',
  },
]

const GENERIC_ROW: VerbRow = {
  verb: 'command',
  claims: () => true,
  label: () => GENERIC_LABEL,
  doing: () => '在跑命令',
}

function rowFor(shape: CallShape): VerbRow {
  return VERB_TABLE.find(row => row.claims(shape)) ?? GENERIC_ROW
}

function stringArg(args: unknown, ...keys: string[]): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function shapeOfCall(call: HostLogToolCall): CallShape {
  const name = (call.toolName || call.toolId || '').toLowerCase()
  const args = call.arguments
  if (name === 'write' || name === 'edit') {
    return {
      command: '',
      ncm: null,
      writePath: stringArg(args, 'path', 'file_path', 'filePath') ?? '',
      writeContent: stringArg(args, 'content', 'newText', 'new_string', 'newString'),
    }
  }
  const command = name === 'bash' || name === '' ? stringArg(args, 'command', 'cmd') ?? '' : ''
  return { command, ncm: command ? findNcmInvocation(command) : null }
}

function shapeOfCommand(command: string): CallShape {
  const text = typeof command === 'string' ? command : ''
  return { command: text, ncm: text ? findNcmInvocation(text) : null }
}

function describeShape(shape: CallShape, text: string | undefined, failure: string | undefined): HostCallDescription {
  const row = rowFor(shape)
  let songs: string[] | undefined
  try {
    songs = row.songs?.(shape)
  } catch {
    songs = undefined
  }
  const description: HostCallDescription = { verb: row.verb, label: row.label(shape) }
  if (songs && songs.length > 0) description.songs = songs
  if (failure !== undefined) {
    description.failed = true
    const line = firstMeaningfulLine(failure)
    if (line) description.detail = truncate(line, DETAIL_MAX)
    return description
  }
  if (text !== undefined && row.detail) {
    try {
      const detail = row.detail(text, shape, songs)
      if (detail) description.detail = detail
    } catch {
      /* 读不懂的结果就不写摘要 */
    }
  }
  return description
}

/**
 * 一条还没有结果的命令行(状态牌用,或在飞的 bash)。认不出的退成「跑了一条命令」。
 */
export function describeCommandLine(command: string): HostCallDescription {
  try {
    return describeShape(shapeOfCommand(command), undefined, undefined)
  } catch {
    return { verb: 'command', label: GENERIC_LABEL }
  }
}

/** 这次调用失败了吗;失败时交出那句原话(没有原话 = 空串)。 */
function failureOf(call: HostLogToolCall, text: string): string | undefined {
  const status = (call.status ?? '').toLowerCase()
  if (typeof call.error === 'string' && call.error.trim()) return call.error
  if (status === 'failed' || status === 'error') return text
  if (call.rejected) return '被拒了'
  const head = firstMeaningfulLine(text)
  if (/^error:/i.test(head) || head.startsWith('[错误]')) return head
  const exitCode = exitCodeOf(text)
  if (exitCode !== undefined && exitCode !== 0) return text.replace(BASH_METADATA, '').trim() || `exit ${exitCode}`
  return undefined
}

/**
 * 一次工具调用 → 卡片上那一句。结果缺席 = 还在飞,不写摘要。**不抛**。
 */
export function describeToolCall(call: HostLogToolCall | null | undefined): HostCallDescription {
  try {
    if (!call || typeof call !== 'object') return { verb: 'command', label: GENERIC_LABEL }
    const hasResult = call.result !== undefined && call.result !== null
    const text = hasResult ? resultText(call.result) : undefined
    return describeShape(shapeOfCall(call), text, failureOf(call, text ?? ''))
  } catch {
    return { verb: 'command', label: GENERIC_LABEL }
  }
}

/**
 * 状态牌那一句:这条调用正在跑时,他「在干什么」。参数还没流完(读不出命令)= 在想。
 */
export function describeHostDoing(call: HostLogToolCall | null | undefined): HostDoing {
  try {
    if (!call || typeof call !== 'object') return { kind: 'thinking', label: '在想' }
    const shape = shapeOfCall(call)
    if (!shape.command && !shape.writePath) return { kind: 'thinking', label: '在想' }
    const row = rowFor(shape)
    let songs: string[] | undefined
    try {
      songs = row.songs?.(shape)
    } catch {
      songs = undefined
    }
    return { kind: row.verb, label: row.doing(shape, songs) }
  } catch {
    return { kind: 'thinking', label: '在想' }
  }
}

/* ── 唤醒提示词 ────────────────────────────────────────────────────────────── */

function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function taggedText(content: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(content)
  return match ? unescapeXmlText(match[1]!).trim() : undefined
}

/**
 * 三条电台提示词的认法:模板的第一句(`content/radio-*.md`,它们是电台自己写的字,不是人话)。
 * 单测拿真的渲染函数钉着这张表,模板改了开头这里会红。
 *  · 跟他说话 = 听众自己的一句话,取 `<untrusted_listener_message>` 里那句原话;
 *  · 开台 = 叫他干活,带上方向;
 *  · 补歌单 = 叫他干活。
 */
const RADIO_PROMPTS: ReadonlyArray<{
  prefix: string
  row(content: string): { kind: 'you' | 'nudge'; text: string } | null
}> = [
  {
    prefix: '听众在跟你说话',
    row: content => {
      const message = taggedText(content, 'untrusted_listener_message')
      return message ? { kind: 'you', text: message } : null
    },
  },
  {
    prefix: '开台',
    row: content => {
      const intent = taggedText(content, 'untrusted_intent')
      return { kind: 'nudge', text: intent ? `换了方向:${intent}` : '叫他开台' }
    },
  },
  { prefix: '节目单快见底了', row: () => ({ kind: 'nudge', text: '叫他补歌单' }) },
]

function isRadioOrigin(message: HostLogMessage): boolean {
  return message.origin?.source === 'radio' || message.source === 'radio'
}

function userRow(message: HostLogMessage, at: number): HostLogRow | null {
  const content = typeof message.content === 'string' ? message.content.trim() : ''
  if (isRadioOrigin(message)) {
    for (const prompt of RADIO_PROMPTS) {
      if (!content.startsWith(prompt.prefix)) continue
      const row = prompt.row(content)
      if (row) return { kind: row.kind, id: message.id, at, text: row.text }
    }
    return { kind: 'nudge', id: message.id, at, text: '叫他干活' }
  }
  return content ? { kind: 'you', id: message.id, at, text: content } : null
}

/* ── 投影 ──────────────────────────────────────────────────────────────────── */

function toolCallsOf(message: HostLogMessage): Map<string, HostLogToolCall> {
  const calls = new Map<string, HostLogToolCall>()
  const steps = Array.isArray(message.steps) ? message.steps : []
  for (const step of steps) {
    if (!step || typeof step !== 'object' || !step.toolCall) continue
    const id = step.toolCall.id ?? step.toolCallId
    if (!id) continue
    // 步骤上的结果是那次调用落定时抄下的;调用自己没带结果时拿它补。
    calls.set(id, {
      ...step.toolCall,
      ...(step.toolCall.result === undefined && step.result !== undefined ? { result: step.result } : {}),
      ...(step.toolCall.error === undefined && step.error !== undefined ? { error: step.error } : {}),
      ...(step.toolCall.status === undefined && step.status !== undefined ? { status: step.status } : {}),
    })
  }
  const direct = Array.isArray(message.toolCalls) ? message.toolCalls : []
  for (const call of direct) {
    if (!call || typeof call !== 'object' || !call.id) continue
    const fromStep = calls.get(call.id)
    calls.delete(call.id) // 重新插入,让 `toolCalls` 的顺序说了算
    calls.set(call.id, fromStep ? { ...fromStep, ...definedFields(call) } : call)
  }
  return calls
}

function definedFields(call: HostLogToolCall): HostLogToolCall {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(call)) if (value !== undefined) out[key] = value
  return out as HostLogToolCall
}

function cardRow(messageId: string, at: number, call: HostLogToolCall, callId: string): HostLogRow {
  const described = describeToolCall(call)
  return {
    kind: 'card',
    id: `${messageId}:tool:${callId}`,
    at,
    verb: described.verb,
    label: described.label,
    ...(described.detail !== undefined ? { detail: described.detail } : {}),
    ...(described.songs ? { songs: described.songs } : {}),
    ...(described.failed ? { failed: true } : {}),
  }
}

/** 一条 assistant 消息 → 他说的话与找歌卡,按它们在这一轮里发生的先后。 */
function assistantRows(message: HostLogMessage, at: number): HostLogRow[] {
  const rows: HostLogRow[] = []
  const calls = toolCallsOf(message)
  const seen = new Set<string>()
  const parts = Array.isArray(message.contentParts) ? message.contentParts : []
  let textIndex = 0
  let pendingText = ''
  const flushText = (): void => {
    const text = pendingText.trim()
    pendingText = ''
    if (!text) return
    rows.push({ kind: 'host', id: `${message.id}:text:${textIndex}`, at, text })
    textIndex += 1
  }

  if (parts.length > 0) {
    let sawText = false
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const typed = part as { type?: unknown; content?: unknown; toolCalls?: unknown }
      if (typed.type === 'text' && typeof typed.content === 'string') {
        pendingText += typed.content
        sawText = true
        continue
      }
      if (typed.type !== 'tool-call' || !Array.isArray(typed.toolCalls)) continue
      flushText()
      for (const snapshot of typed.toolCalls as HostLogToolCall[]) {
        const id = snapshot?.id
        if (!id || seen.has(id)) continue
        seen.add(id)
        rows.push(cardRow(message.id, at, calls.get(id) ?? snapshot, id))
      }
    }
    // 片段里漏掉的调用(老会话、半截的流)排在这一轮末尾那段话之前。
    for (const [id, call] of calls) {
      if (seen.has(id)) continue
      seen.add(id)
      rows.push(cardRow(message.id, at, call, id))
    }
    if (!sawText && typeof message.content === 'string') pendingText = message.content
    flushText()
    return rows
  }

  for (const [id, call] of calls) rows.push(cardRow(message.id, at, call, id))
  pendingText = typeof message.content === 'string' ? message.content : ''
  flushText()
  return rows
}

/**
 * DJ 会话 → 记录流。最新在尾,只交尾部 `limit` 行(缺省 60),前面丢了行就 `truncated`。
 * 行 id 在重读之间稳定(消息 id + 工具调用 id)。**不抛**:一条读不懂的消息就少几行。
 */
export function projectHostLog(
  messages: readonly HostLogMessage[] | null | undefined,
  options: { limit?: number } = {},
): HostLog {
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : HOST_LOG_DEFAULT_LIMIT
  const rows: HostLogRow[] = []
  for (const message of Array.isArray(messages) ? messages : []) {
    try {
      if (!message || typeof message !== 'object' || typeof message.id !== 'string') continue
      const at = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp : 0
      if (message.role === 'user') {
        const row = userRow(message, at)
        if (row) rows.push(row)
      } else if (message.role === 'assistant') {
        rows.push(...assistantRows(message, at))
      }
    } catch {
      /* 一条读不懂的消息不该让整份记录读不出来 */
    }
  }
  const truncated = rows.length > limit
  return { rows: truncated ? rows.slice(rows.length - limit) : rows, absent: false, truncated }
}
