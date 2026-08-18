Summarize the conversation above into a structured context summary that lets an agent continue the work without re-reading the transcript.

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

Rules:
- Preserve the causal chain behind every decision, not only the conclusion.
- Preserve exact file paths, function names, and command lines verbatim.
- Preserve errors, failed attempts, and the reason each failed, so the agent does not repeat them.
- Never drop unfinished work: everything still pending belongs in In Progress, Blocked, or Next Steps.
- Keep every section, even when it is empty — write `- None` under a heading with nothing to report.
- Be concise, but prefer keeping an important specific over shortening.
