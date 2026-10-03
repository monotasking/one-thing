/**
 * Building the model input for one TOC turn, under a hard token budget.
 *
 * The cost story lives here (docs/design/session-toc.md §6). Two rules do most
 * of the work:
 *
 * 1. **Reasoning is usually not sent at all.** A long user message already
 *    states the intent; only a terse one ("continue", "that's wrong") needs
 *    the model's thinking to recover what it referred to.
 * 2. **When it is sent, it is the lowest priority and gets cut first.** That
 *    is what keeps a model with a 50k-token chain of thought from blowing the
 *    budget: the input ceiling does not move, no matter how long it thinks.
 *
 * Reasoning is head-and-tail sampled rather than truncated, because thinking
 * runs "understand the request → explore → conclude" and the middle is the
 * least useful part.
 */
import type { SessionSegment } from './types.js'

/** Rough chars-per-token. Deliberately conservative — overshooting the budget costs money. */
const CHARS_PER_TOKEN = 3.5

/** Hard ceiling on the whole prompt. Does not grow with session length. */
export const DEFAULT_TOC_INPUT_TOKEN_BUDGET = 3000

/**
 * A user message at least this long is taken to state its own intent, so the
 * assistant's reasoning is not sent for it at all.
 *
 * Tuned against English, where a one-line instruction runs 60–90 chars. CJK
 * packs far more meaning per character, so short-but-clear Chinese requests
 * fall under the bar and pay for reasoning they did not need. That is the
 * safe direction to err: the hard budget caps the damage, whereas withholding
 * context from a genuinely ambiguous turn produces a wrong segment.
 */
export const DEFAULT_SELF_EXPLANATORY_USER_CHARS = 80

export const REASONING_HEAD_SHARE = 0.7

export interface TocTurnInput {
  userMessage: string
  assistantReply?: string
  reasoning?: string
  files: string[]
  currentSegment?: Pick<SessionSegment, 'title' | 'detail' | 'kind'> & {
    /** Files the open segment has touched, used for the disjoint-work signal. */
    files?: string[]
  }
  /** Minutes the user was away before this turn; omitted when not meaningful. */
  awayMinutes?: number
}

export interface BuildTocPromptOptions {
  tokenBudget?: number
  selfExplanatoryUserChars?: number
}

export interface BuiltTocPrompt {
  text: string
  /** False when the reasoning was withheld or dropped — useful for observability. */
  includedReasoning: boolean
  estimatedTokens: number
}

/** True only when both sides touched files and share none. */
function touchesNoCommonFile(current: string[] | undefined, incoming: string[]): boolean {
  if (!current?.length || incoming.length === 0) return false
  const seen = new Set(current)
  return !incoming.some(file => seen.has(file))
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function budgetToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN))
}

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

/** Keeps the tail, which is where a reply states its conclusion. */
function clipTail(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `…${trimmed.slice(trimmed.length - Math.max(0, maxChars - 1)).trimStart()}`
}

/**
 * Head and tail with the middle elided. The elision is marked so the model
 * knows the text is discontinuous rather than assuming it read the whole chain.
 */
export function sampleHeadAndTail(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (maxChars <= 0) return ''
  if (trimmed.length <= maxChars) return trimmed

  const marker = (omitted: number) => `\n\n…[${omitted} chars omitted]…\n\n`
  const sampleBudget = Math.max(0, maxChars - marker(trimmed.length).length)
  const headChars = Math.floor(sampleBudget * REASONING_HEAD_SHARE)
  const tailChars = sampleBudget - headChars
  if (headChars <= 0 || tailChars <= 0) return clip(trimmed, maxChars)

  const head = trimmed.slice(0, headChars).trimEnd()
  const tail = trimmed.slice(trimmed.length - tailChars).trimStart()
  return `${head}${marker(trimmed.length - headChars - tailChars)}${tail}`
}

/**
 * Whether this turn's reasoning is worth spending budget on. A short user
 * message is the signal that the intent lives somewhere other than what they
 * typed.
 */
export function shouldIncludeReasoning(
  userMessage: string,
  reasoning: string | undefined,
  selfExplanatoryChars: number = DEFAULT_SELF_EXPLANATORY_USER_CHARS,
): boolean {
  if (!reasoning?.trim()) return false
  return userMessage.trim().length < selfExplanatoryChars
}

const SECTION_SEPARATOR = '\n\n'

function section(label: string, body: string): string {
  return `<${label}>\n${body}\n</${label}>`
}

/**
 * Fills the budget in priority order, stopping when it runs out. Everything
 * above reasoning is small and near-fixed; reasoning absorbs whatever is left,
 * which is what makes the ceiling hold.
 */
export function buildTocPrompt(
  input: TocTurnInput,
  options: BuildTocPromptOptions = {},
): BuiltTocPrompt {
  const budgetChars = budgetToChars(options.tokenBudget ?? DEFAULT_TOC_INPUT_TOKEN_BUDGET)
  const parts: string[] = []
  let used = 0

  // Sections are joined with a blank line; counting that here keeps the
  // accounting honest — omitting it let the final text overshoot the ceiling.
  const push = (label: string, body: string): boolean => {
    if (!body) return false
    const rendered = section(label, body)
    const cost = rendered.length + (parts.length > 0 ? SECTION_SEPARATOR.length : 0)
    if (used + cost > budgetChars) return false
    parts.push(rendered)
    used += cost
    return true
  }

  // 1 — the most direct statement of intent.
  push('user_message', clip(input.userMessage, Math.floor(budgetChars * 0.35)))

  // 2 — fact, and tiny.
  if (input.files.length > 0) {
    push('files_touched', input.files.slice(0, 40).join('\n'))
  }

  // 3 — needed to decide update vs new; also tiny.
  if (input.currentSegment) {
    push(
      'current_segment',
      `kind: ${input.currentSegment.kind}\ntitle: ${input.currentSegment.title}\ndetail: ${input.currentSegment.detail}`,
    )

    // A fact worth handing over rather than leaving the model to infer: two
    // stretches of work with no file in common are almost never the same job.
    // Models lean heavily toward `update`, and this is the cheapest evidence
    // against that when it is wrong.
    if (touchesNoCommonFile(input.currentSegment.files, input.files)) {
      push(
        'file_overlap',
        'none — this turn touched no file the current segment had touched',
      )
    }
  }

  if (typeof input.awayMinutes === 'number' && input.awayMinutes > 0) {
    push('user_away_minutes', String(Math.round(input.awayMinutes)))
  }

  // 4 — the reply's conclusion.
  if (input.assistantReply) {
    push('assistant_reply_tail', clipTail(input.assistantReply, Math.floor(budgetChars * 0.25)))
  }

  // 5 — reasoning, last and first to be cut.
  let includedReasoning = false
  if (shouldIncludeReasoning(input.userMessage, input.reasoning, options.selfExplanatoryUserChars)) {
    const overhead =
      section('assistant_reasoning', '').length + SECTION_SEPARATOR.length
    const remaining = budgetChars - used - overhead
    if (remaining > 200) {
      includedReasoning = push('assistant_reasoning', sampleHeadAndTail(input.reasoning!, remaining))
    }
  }

  const text = parts.join(SECTION_SEPARATOR)
  return { text, includedReasoning, estimatedTokens: estimateTokens(text) }
}
