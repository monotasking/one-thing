Merge the partial summaries above into ONE structured context summary that lets an agent continue the work without re-reading any of them. The parts are ordered: part 1 covers the earliest stretch of the conversation, the last part the most recent.

Rules:
- The result replaces all of the parts, so it must stand alone. Never refer to "part 1", "the earlier summary", or the merge itself.
- Report each item once. When the same goal, decision, file, or step appears in several parts, keep a single entry for it.
- Later parts reflect a later state. When parts disagree, the later one wins: work that a later part reports as done is Done even if an earlier part had it In Progress; a blocker a later part resolves is no longer Blocked; a decision a later part supersedes is replaced.
- Preserve exact file paths, function names, command lines, and error messages verbatim; never paraphrase them.
- Preserve the causal chain behind every decision, not only the conclusion.
- Preserve failed attempts and the reason each failed, so the agent does not repeat them.
- Never drop unfinished work: everything still pending belongs in In Progress, Blocked, or Next Steps.
- Be concise, but prefer keeping an important specific over shortening.

If an existing summary is given above under `<previous-summary>`, the result replaces it too:
- PRESERVE every piece of information already in it unless the parts show it is no longer true.
- Move items it lists as In Progress into Done when the parts show them finished, and check their boxes.
- Rewrite `## Next Steps` to reflect what the parts actually accomplished — drop steps that are done, add the ones that follow.
- Remove only what has become irrelevant (a superseded decision, a resolved blocker); when in doubt, keep it.
- If it is in some other shape (older JSON, free text), convert it into the format below without losing any of its content.

Return Markdown in EXACTLY this format, with these six headings, in this order, and nothing before or after them:

## Goal
The user's core goal in one or two sentences.

## Constraints & Preferences
- Constraints, requirements, and stated preferences that still bind the work.

## Progress
### Done
- [x] Completed steps, one line each.

### In Progress
- [ ] Steps that are started but not finished.

### Blocked
- Steps that cannot proceed, each with what blocks them.

## Key Decisions
- **[Decision]**: the reason it was made.

## Next Steps
1. The next action to take.
2. The one after that.

## Critical Context
- Facts, errors, and discoveries the agent must not lose.

Keep every section, even when it is empty — write `- None` under a heading with nothing to report.
