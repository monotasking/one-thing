/**
 * Rendering for the radio: the DJ agent's factory persona and the two turn
 * prompts (opening batch, follow-up batch). Same conventions as goals/render:
 * content lives in content/*.md, user-supplied text is escaped and wrapped in
 * an <untrusted_*> tag.
 */
import radioDjAgentRaw from './content/radio-dj-agent.md?raw'
import radioOpenRaw from './content/radio-open.md?raw'
import radioCurateRaw from './content/radio-curate.md?raw'
import radioTalkRaw from './content/radio-talk.md?raw'
import type { OnethingRadioBrief, OnethingRadioSpin } from './radio-store.js'

export const RADIO_DJ_AGENT_ID = 'radio-dj'
export const RADIO_DJ_AGENT_NAME = '电台 DJ'

/**
 * The DJ's discipline is "bash runs bare ncm-cli commands, nothing else" —
 * so its sessions only ever need the bash tool. Everything else is dead
 * weight on every per-song turn (26 tools ≈ 8.6k tokens before this list).
 */
export const RADIO_DJ_TOOL_ALLOWLIST = ['bash']

/**
 * The factory persona carries a version fingerprint so installed agents can
 * follow factory upgrades. The old policy was "created once, never touched" —
 * which quietly froze every user's DJ on day-one discipline: the mandatory
 * rules (playability checks, inbox-only writes) only reached the automated
 * wake prompts, and a free-form chat with the stale DJ shipped six
 * rights-restricted songs into the programme (2026-07-17). Mandatory rules
 * now live HERE; deleting the fingerprint line opts an agent out of upgrades.
 */
// v5: 口播每首必写(留白被听众否决 2026-07-19) — 普通歌也要短报一句。
export const RADIO_DJ_FACTORY_VERSION = 5

const RADIO_DJ_FACTORY_MARK = /<!--\s*radio-dj-factory\s+v(\d+)/

/** Factory persona for the radio-dj agent. */
export function renderRadioDjAgentPrompt(options: {
  inboxPath: string
  /**
   * The active provider's command cheatsheet (provider.prose.cliCheatsheet).
   * Empty for ncm — its command prose still lives in the persona body; a
   * second provider ships its commands here instead of editing the persona.
   */
  cliCheatsheet?: string
}): string {
  const body = fill(radioDjAgentRaw, { inbox_path: options.inboxPath })
  const cheatsheet = options.cliCheatsheet?.trim()
  const withCheatsheet = cheatsheet ? `${body}\n\n## 你的 CLI 速查\n\n${cheatsheet}` : body
  return `${withCheatsheet}\n\n<!-- radio-dj-factory v${RADIO_DJ_FACTORY_VERSION} · 出厂人设指纹:保留此行,人设会随应用升级自动更新;想自定义人设请删除此行 -->`
}

/** The installed prompt's factory version; null = no fingerprint (pre-v2 factory, or user-authored). */
export function radioDjFactoryPromptVersion(prompt: string): number | null {
  const match = RADIO_DJ_FACTORY_MARK.exec(prompt)
  return match ? Number(match[1]) : null
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function spinList(spins: OnethingRadioSpin[], limit: number): string {
  if (spins.length === 0) return '(无)'
  return spins
    .slice(-limit)
    .map(spin => `- ${spin.title}`)
    .join('\n')
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match).trim()
}

/**
 * The prompt's intent line. A usable intent is at least two meaningful
 * characters — every one-character "intent" seen in the wild was debris (the
 * 'x' test fixture that leaked through a broken mock, 2026-07-17), and a DJ
 * prompted with debris stalls: it asked the unattended session for direction
 * and dead-aired the station. Debris degrades to an explicit self-direct
 * instruction instead of being quoted as the listener's words.
 */
function intentLine(rawIntent: string): string {
  const intent = rawIntent.trim()
  if (intent.length >= 2) {
    return `<untrusted_intent>${escapeXmlText(intent)}</untrusted_intent>`
  }
  return '(听众没有给出可用的方向。不要提问——这个会话无人值守;按当地时间和最近播放/红心的气质自主定调,照常编排。)'
}

export interface RenderRadioPromptOptions {
  brief: OnethingRadioBrief
  /** Where the DJ drops new batches. The DJ never touches the programme itself. */
  inboxPath: string
  /** Titles still queued in the programme, for the curation prompt's context. */
  programmeRemaining?: string[]
  /**
   * The listener's life right now — a formatted snapshot of the variable
   * registry (notes, goals, whatever providers exist), for the OPENING patter
   * only. This is what turns "报时+意图" into a personal morning show: the
   * host can mention the thing actually on the listener's desk. Opening-only
   * by design; transitions run on time + listening feedback.
   */
  lifeContext?: string
  /** Test seam; defaults to a human-readable local timestamp. */
  localTime?: string
}

function defaultLocalTime(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

export function renderRadioOpenPrompt(options: RenderRadioPromptOptions): string {
  return fill(radioOpenRaw, {
    intent_line: intentLine(options.brief.intent),
    local_time: options.localTime ?? defaultLocalTime(),
    life_context: options.lifeContext?.trim() || '(无)',
    inbox_path: options.inboxPath,
  })
}

/**
 * 听众说的一句话(正本 `apps/desktop-react/docs/music-panel-2026-09.md` §7.1)。
 *
 * 与那两条自动化的唤醒提示是**同一族**,写在同一处:一条 wake 的所有前置(意图行的
 * 碎屑降级、时间、还剩哪些)在这里照旧成立,多的只有听众那句话本身 —— 它与开台意图
 * 逐字同一档待遇:转义 + `<untrusted_*>` 包起来,因为它是人打进来的字。
 *
 * 收尾那条指令(「最后那句话就是你要对他说的」)不是礼貌,是**契约**:装配层取的正是
 * 这一轮最后一条 assistant 文本当作他的回话(§7.1「回话怎么拿到」那一格),所以这句话
 * 与那段代码必须说同一件事。
 */
export function renderRadioTalkPrompt(
  options: RenderRadioPromptOptions & { message: string },
): string {
  const remaining = options.programmeRemaining ?? []
  return fill(radioTalkRaw, {
    message: escapeXmlText(options.message.trim()),
    intent_line: intentLine(options.brief.intent),
    local_time: options.localTime ?? defaultLocalTime(),
    inbox_path: options.inboxPath,
    programme_remaining:
      remaining.length === 0 ? '(空)' : remaining.map(title => `- ${title}`).join('\n'),
  })
}

export function renderRadioCurationPrompt(options: RenderRadioPromptOptions): string {
  const remaining = options.programmeRemaining ?? []
  return fill(radioCurateRaw, {
    intent_line: intentLine(options.brief.intent),
    local_time: options.localTime ?? defaultLocalTime(),
    inbox_path: options.inboxPath,
    programme_remaining:
      remaining.length === 0 ? '(空)' : remaining.map(title => `- ${title}`).join('\n'),
    played: spinList(options.brief.played, 30),
    skipped: spinList(options.brief.skipped, 10),
    loved: spinList(options.brief.loved, 10),
  })
}
