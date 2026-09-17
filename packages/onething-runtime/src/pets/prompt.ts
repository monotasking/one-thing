/**
 * **时刻 → 提示词**与**回复 → 一句话**(宠物 P4,正本 `docs/design/pet-system-2026-09.md` §11.2)。
 * 两只纯函数:不碰时钟(本地时间由调用方算好递进来)、不碰模型、不碰文件。
 *
 * ── 为什么记忆交的是「人话摘要」而不是账本 JSON ────────────────────────────
 * 账本行是给机器折叠用的(id、毫秒时间戳、权重),原样塞给小模型只会让它去复述
 * 「utterance heidou-mf3k-2」这类东西。这里把最近 10 行各折成一句短话(「用户跳过了
 * 一首歌」「我说:……」),模型要的只是「刚才发生过什么、我说过什么」,好不重复自己。
 * 被挡掉的开口(`dropped`)与说完的回执(`hushed`)不进摘要:那是预算的账,不是经历。
 *
 * ── 为什么「深夜」不另立时刻 ────────────────────────────────────────────────
 * user 里带一行本地时间,模型自己会在凌晨两点说出「这么晚还在听」。另立一条「深夜」时刻
 * 就得有人在半夜发它,而那个人不知道此刻有没有值得说的事。
 *
 * ── 为什么要求回 JSON 而不是直接回那句话 ───────────────────────────────────
 * 「没什么值得说」必须能被说出来,而且不能和「一句话」混淆 —— 小模型直接回自由文本时,
 * 「(沉默)」「无」「null」都是它会写的东西。`{"say": null}` 是唯一的沉默写法,
 * `parseMomentReply` 只认这一个形。
 */

import type { PetLedgerLine } from './ledger.js'
import type { PetManifest } from './manifest.js'
import type { Moment } from './types.js'

/** 交给模型的记忆条数(§11.2「最近 10 条账本行」)。 */
export const PET_PROMPT_MEMORY_LINES = 10

/** 负载 JSON 最长交多少字符。歌单标题列表之类的负载可以很长,模型只需要看个大概。 */
const PAYLOAD_MAX_CHARS = 400

export interface MomentPromptInput {
  readonly pet: PetManifest
  readonly moment: Moment
  /** 这只宠物最近的账本行(旧的在前)。这里只取最后 10 行。 */
  readonly memory: readonly PetLedgerLine[]
  /** 本地时间的人话,调用方按自己的时钟与时区算好,如「2026-09-18 星期五 02:14」。 */
  readonly localTime: string
  /** 用什么语言开口,如 `zh-CN`。 */
  readonly locale: string
}

export interface MomentPrompt {
  readonly system: string
  readonly user: string
}

export function buildMomentPrompt(input: MomentPromptInput): MomentPrompt {
  const { pet, moment, memory, localTime, locale } = input
  const system = [
    pet.persona,
    '',
    '规矩:',
    '- 一次最多说两句,合起来不超过 60 个字。',
    '- 用「我」称呼自己。',
    '- 不要说「为您播放」这类客服腔。',
    '- 只说下面给出的事实里有的东西,不要编造歌名、时长、次数或任何没给出的细节。',
    '- 不要重复最近已经说过的话。',
    '- 没什么值得说的,就不说。',
    `- 用 ${locale} 这门语言说。`,
    '',
    '只回一个 JSON 对象,不要别的文字:{"say": "要说的话"};不说话就回 {"say": null}。',
  ].join('\n')

  const lines = memory.slice(-PET_PROMPT_MEMORY_LINES)
    .map(line => summarizeLedgerLine(line, pet.name))
    .filter((line): line is string => line !== null)

  const user = [
    `现在是 ${localTime}。`,
    '',
    `刚刚发生的事:${moment.gist}`,
    `细节:${compactPayload(moment.payload)}`,
    '',
    '最近发生过的事(旧的在前):',
    ...(lines.length > 0 ? lines.map(line => `- ${line}`) : ['- (没有)']),
  ].join('\n')

  return { system, user }
}

/** 一行账本 → 一句人话;不值得交给模型的行答 `null`(见文件头)。 */
function summarizeLedgerLine(line: PetLedgerLine, petName: string): string | null {
  switch (line.kind) {
    case 'moment': {
      // 负载里有标题就带上:「跳过了一首歌」与「跳过了《稻香》」对模型是两种记忆。
      const title = line.payload && typeof line.payload === 'object'
        ? (line.payload as Record<string, unknown>).title
        : undefined
      return typeof title === 'string' && title ? `${line.gist}(${title})` : line.gist
    }
    case 'utterance':
      return line.utterance.mode === 'speak'
        ? `我(${petName})说:${line.utterance.text}`
        : `我(${petName})嘀咕:${line.utterance.text}`
    default:
      return null
  }
}

/** 负载的精简 JSON:去掉空值,超长截断并注明。 */
function compactPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '(无)'
  let text: string
  try {
    text = JSON.stringify(payload, (_key, value: unknown) => (value === null ? undefined : value))
  } catch {
    return '(无)'
  }
  if (!text || text === '{}') return '(无)'
  return text.length > PAYLOAD_MAX_CHARS ? `${text.slice(0, PAYLOAD_MAX_CHARS)}…(截断)` : text
}

/**
 * 模型回复 → 那一句话,或者 `null`(不说)。
 *
 * 容忍:代码围栏、JSON 前后的废话、`say` 两边的空白。取不到 JSON、`say` 不是字符串、
 * 或者 trim 之后是空串 → `null`。**不**把一段不是 JSON 的自由文本当成那句话:
 * 小模型不守格式时写出来的多半是「好的,我来想想……」,念出来比沉默糟。
 */
export function parseMomentReply(text: string): string | null {
  if (typeof text !== 'string') return null
  for (const candidate of jsonCandidates(text)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (!Object.prototype.hasOwnProperty.call(value, 'say')) continue
    const say = (value as Record<string, unknown>).say
    if (typeof say !== 'string') return null
    const trimmed = say.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

/** 从一段回复里挑出可能是那个 JSON 对象的片段:整段、围栏里的、第一个 `{` 到与之配对的 `}`。 */
function jsonCandidates(text: string): string[] {
  const out: string[] = []
  const trimmed = text.trim()
  if (trimmed) out.push(trimmed)
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    if (match[1]?.trim()) out.push(match[1].trim())
  }
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start)
    if (end !== -1) out.push(text.slice(start, end + 1))
  }
  return out
}

/** 从 `start` 处的 `{` 找配对的 `}`,跳过字符串里的括号。找不到 = -1。 */
function matchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}
