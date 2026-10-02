/**
 * Prompt text for the TOC turn call. Content lives in ./content/*.md so the
 * wording can be edited without touching code (see the repo's prompt/content
 * separation convention).
 */
import tocTurnRaw from './content/toc-turn.md?raw'

export function renderTocTurnSystemPrompt(): string {
  return tocTurnRaw.trim()
}
