Update the existing summary above with everything new from the conversation above it. The result replaces the existing summary, so it must stand alone.

Rules:
- PRESERVE every piece of information already in the existing summary unless the conversation shows it is no longer true.
- Move items that the conversation shows are now finished from `### In Progress` into `### Done`, and check their boxes.
- Add newly started work to `### In Progress`, and newly blocked work to `### Blocked` with what blocks it.
- Rewrite `## Next Steps` to reflect what the conversation actually accomplished — drop steps that are done, add the ones that follow.
- Keep exact file paths, function names, error messages, and command lines verbatim; never paraphrase them.
- Remove only what has become irrelevant (a superseded decision, a resolved blocker); when in doubt, keep it.
- If the existing summary is in some other shape (older JSON, free text), convert it into the format below without losing any of its content.

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
