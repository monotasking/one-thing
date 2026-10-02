export interface PromptReferenceSnapshotLike {
  type?: 'prompt-ref'
  promptId: string
  title?: string
  content?: string
  description?: string
  bodyHash?: string
}

export interface SkillReferenceSnapshotLike {
  type?: 'skill-ref'
  skillId: string
  name?: string
  description?: string
  source?: string
  content?: string
  bodyHash?: string
}

export const PROMPT_REF_PATTERN = /\{\{prompt:([^}]+)\}\}/g
export const SKILL_REF_PATTERN = /\{\{skill:([^}]+)\}\}/g
/**
 * A file picked with `@`. The token holds the position in the draft while the
 * composer shows the file as a docked chip; it expands back to `@<path>` — in
 * place — when the message is sent, so it never reaches a provider.
 */
export const FILE_REF_PATTERN = /\{\{file:([^}]+)\}\}/g
export const COMPOSER_REF_PATTERN = /\{\{(prompt|skill):([^}]+)\}\}/g

export function createPromptToken(promptId: string): string {
  return `{{prompt:${promptId}}}`
}

export function createSkillToken(skillId: string): string {
  return `{{skill:${skillId}}}`
}

export function createFileToken(filePath: string): string {
  return `{{file:${filePath}}}`
}

/** Expands docked file chips back into the `@<path>` text the model reads. */
export function expandFileTokens(text: string): string {
  return text.replace(FILE_REF_PATTERN, (_match, filePath: string) => `@${filePath}`)
}

/**
 * An embedded-browser page picked with `@`. The token pins the tab id while
 * the draft is edited (the chip label tracks the live tab); the composer
 * resolves it against the browser mirror at SEND time, so the message carries
 * whatever the tab shows then — see materializePageReferences in the renderer.
 */
export const PAGE_REF_PATTERN = /\{\{page:([^}]+)\}\}/g

export function createPageToken(tabId: string): string {
  return `{{page:${tabId}}}`
}

export interface ResolvedPageReference {
  tabId: string
  url: string
  title: string
}

/**
 * Collects `{{page:<tabId>}}` tokens through the caller's tab lookup and
 * strips them from the text (one adjacent trailing space leaves with the
 * token, matching what insertion added). The page travels ONLY as a zero-byte
 * provenance attachment — never as inline URL text — so the user's message
 * bubble stays clean and page-controlled URL text never enters the draft.
 * Live tokens are reported once per tab; dead ones (tab closed) just vanish.
 */
export function extractPageTokens(
  text: string,
  resolve: (tabId: string) => { url: string; title: string } | null,
): { text: string; pages: ResolvedPageReference[] } {
  const pages: ResolvedPageReference[] = []
  const stripped = text.replace(/\{\{page:([^}]+)\}\} ?/g, (_match, tabId: string) => {
    const tab = resolve(tabId)
    if (tab?.url && !pages.some(page => page.tabId === tabId)) {
      pages.push({ tabId, url: tab.url, title: tab.title })
    }
    return ''
  })
  return { text: stripped, pages }
}

/**
 * A collab room member picked with `@` (W14a, docs/design/multi-agent-collab-im.md
 * §4.5). Same trick as the page token: the draft keeps the AGENT ID at the exact
 * spot the user picked it (the composer paints it as `@名字`), and send time
 * materializes it. Unlike the page token it materializes back INTO the text —
 * a mention is something the room reads — while the id leaves separately as
 * `mentions[]` on the command.
 */
export const MEMBER_REF_PATTERN = /\{\{member:([^}]+)\}\}/g

export function createMemberToken(agentId: string): string {
  return `{{member:${agentId}}}`
}

export interface ResolvedMemberReference {
  agentId: string
  label: string
}

/**
 * Send-time resolution of `{{member:<agentId>}}`: each live token becomes the
 * plain text `@<名字>` in place (the room, the model and the bubble all read an
 * ordinary mention — nothing about the transcript looks machine-made), and the
 * id travels beside it in `mentions`, deduped per agent.
 *
 * A DEAD token (the agent was deleted while the draft sat there) has no name to
 * paint, so it leaves with one adjacent trailing space, exactly like a dead page
 * token — the alternative is emitting a literal `{{member:…}}` into the room.
 */
export function extractMemberTokens(
  text: string,
  resolve: (agentId: string) => { name: string } | null,
): { text: string; mentions: ResolvedMemberReference[] } {
  const mentions: ResolvedMemberReference[] = []
  const expanded = text.replace(/\{\{member:([^}]+)\}\}( ?)/g, (_match, agentId: string, trailing: string) => {
    const member = resolve(agentId)
    const name = member?.name?.trim()
    if (!name) return ''
    if (!mentions.some(mention => mention.agentId === agentId)) {
      mentions.push({ agentId, label: name })
    }
    return `@${name}${trailing}`
  })
  return { text: expanded, mentions }
}

export function getPromptIdFromToken(token: string): string | null {
  const match = token.match(/^\{\{prompt:([^}]+)\}\}$/)
  return match ? match[1] : null
}

export function getSkillIdFromToken(token: string): string | null {
  const match = token.match(/^\{\{skill:([^}]+)\}\}$/)
  return match ? match[1] : null
}

export function formatPromptForModel(title: string, body: string): string {
  return `<user_prompt name="${title.replace(/"/g, '&quot;')}">\n${body}\n</user_prompt>`
}

export interface SkillModelPaths {
  path?: string
  directoryPath?: string
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function formatSkillForModel(
  name: string,
  _source: string,
  _description: string,
  body: string,
  paths: SkillModelPaths = {},
): string {
  const location = paths.path || paths.directoryPath || ''
  const referenceBase = paths.directoryPath || location || '.'

  return `<skill name="${escapeAttr(name)}" location="${escapeAttr(location)}">\nReferences are relative to ${referenceBase}.\n\n${body}\n</skill>`
}

export function displayTextFromPromptParts(
  content: string,
  contentParts?: Array<
    { type: string; content?: string; title?: string; name?: string }
    | PromptReferenceSnapshotLike
    | SkillReferenceSnapshotLike
  >,
): string {
  if (!contentParts || contentParts.length === 0) return content
  return contentParts
    .map(part => {
      if ('type' in part && part.type === 'text') return part.content || ''
      if ('type' in part && part.type === 'prompt-ref') return `[Prompt: ${part.title || 'Untitled'}]`
      if ('type' in part && part.type === 'skill-ref') return `[Skill: ${part.name || 'Untitled'}]`
      return ''
    })
    .join('')
}

export function rawTextFromPromptParts(
  content: string,
  contentParts?: Array<{ type: string; content?: string; promptId?: string; skillId?: string }>,
): string {
  if (!contentParts || contentParts.length === 0) return content
  return contentParts
    .map(part => {
      if (part.type === 'text') return part.content || ''
      if (part.type === 'prompt-ref' && part.promptId) return createPromptToken(part.promptId)
      if (part.type === 'skill-ref' && part.skillId) return createSkillToken(part.skillId)
      return ''
    })
    .join('')
}
