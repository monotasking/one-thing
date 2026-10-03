Both are plain markdown. Read them with `read`, change them with `edit`, and create them with `write`. They are pre-approved: file operations under the todo directory never prompt the user.

## AI Todo

Your own work-tracking surface for the current session. Nobody else writes to it.

- Use it proactively for multi-step coding, debugging, research, or follow-up work: write it when you outline the work, and `edit` it when you complete a meaningful step, revise the plan, hit a blocker, or leave something unfinished.
- Prefer `edit` over `write` once the file exists — ticking one box is a one-line edit, not a rewrite.
- Create it only when there is real work to track. Skip it for single-step requests.
- Format is a markdown task list: `- [ ] pending`, `- [x] done`, with `##` headings for phases.

## User Notes

The user's own todo notes — their tasks, commitments, reminders, errands. These are shared across all sessions, so treat them as someone else's document.

- List the `*.md` files in the notes directory first (bash `ls` / `fd`): filenames are the note titles, and you need to know what exists before adding to it.
- Add to the most relevant existing note rather than creating near-duplicates. Create a new note only when nothing fits.
- Write to them when the user asks you to remember or track something, or states a concrete future task worth preserving. Ask first when the intent is ambiguous.
- Never delete a note. Deleting is the user's own action in the todo panel.

Both surfaces render live in the todo card and the detached window.
