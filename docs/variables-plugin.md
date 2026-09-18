# Variables — Plugin Author Guide

The variable subsystem aggregates context variables from one or more
**providers** and surfaces them to the model (system prompt), the AI
tool layer (`variable` tool), and the UI (Inspector → Context tab). A
plugin is a class implementing the `VariableProvider` interface,
registered with the runtime registry.

This guide shows how to write and register one.

---

## When to write a provider

Use a provider when you want a named value the model can read (and
optionally write) inside a chat session. Examples:

- Time/date (`now`, `today`)
- Git context (`git_branch`, `git_repo`)
- Selected env vars (`node_version`, `python_version`)
- A side-store of "remembered" project hints

If you only need to render something into the prompt once, a provider
is overkill — patch the prompt builder directly.

---

## The interface

```ts
interface VariableProvider {
  readonly id: string             // Unique. Throws on duplicate.
  readonly priority?: number      // Lower = tried first for write routing.

  list(ctx: { sessionId }): Promise<ContextVariable[]> | ContextVariable[]
  claims(name: string): boolean   // Does this provider own `name`?

  // Optional capabilities. Omit for read-only providers — registry
  // surfaces `READONLY` when a writer tries to touch a claimed name.
  set?(ctx, input: { name, value, description? }): Promise<ContextVariable>
  delete?(ctx, name: string): Promise<void>

  // Optional. Forward external state changes (e.g. a watched file)
  // through the registry's change-broadcast pipeline.
  onExternalChange?(emit: (ctx?) => void): () => void
}

interface ContextVariable {
  name: string
  value: string
  description?: string
  level: 'system' | 'session'
  readonly?: boolean
  updatedAt?: number
}
```

`ctx` carries `sessionId` today; treat it as opaque for forward
compatibility.

---

## Built-in priorities (so you can pick a slot)

| Provider           | Priority | Notes                                  |
|--------------------|---------:|----------------------------------------|
| `core`             | 10       | `workdir`                              |
| `note-vaults`      | 35       | `note_vaults`(只读;改库走设置 → 笔记) |
| `session-store`    | 1000     | catch-all for custom names             |

External providers typically pick a value between 50 and 999 — well
clear of the built-in slots, before the catch-all.

Pick a value that documents your intent. Conflicts only matter when two
providers `claims()` the same name — then the lower priority wins.

---

## Reserved names

`workdir`, `cwd`, `home` are reserved.

(`ai_note_dir` was retired 2026-08-12 — long-term memory belongs to the
memory-wiki plugin's `memory_write` / `memory_document`. `user_note_dir` /
`work_note_dir` were retired 2026-09-18 with the notes domain — where notes
live is now the vault table in Settings → Notes, projected read-only into the
prompt as `note_vaults`. None of the three is registered, reserved, or
persisted any more.)

Project directories are managed by their own subsystem (see
`docs/project-dirs.md`); the `project_dirs` name is no longer
claimed by the variables subsystem. The
session-store provider rejects writes to these (the registry's reserved
check is name-agnostic; reservation is enforced at the provider that
takes user writes). Don't redefine them; if you need a similar
abstraction, pick a distinct name.

---

## Validation rules (free, automatic)

The registry validates `name` and `value` *before* dispatch:

- **Name** — `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`, case-sensitive.
- **Value** — string, ≤ 4 KB UTF-8.
- Errors surface as `VariableError` with stable codes:
  `INVALID_NAME`, `INVALID_VALUE`, `READONLY`, `NOT_FOUND`, `RESERVED`,
  `LIMIT_EXCEEDED`, `WORKDIR_NOT_FOUND`, `NO_PROVIDER`,
  `PROVIDER_CONFLICT`.

Throw `VariableError` from your provider for any rule the registry
can't see (e.g. value-shape constraints specific to your domain).

---

## Minimal example: `git` provider

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VariableProvider, ContextVariable, VariableContext } from './types.js'

const exec = promisify(execFile)

export class GitProvider implements VariableProvider {
  readonly id = 'git'
  readonly priority = 60

  constructor(private readonly cwdFor: (sessionId: string) => string) {}

  async list(ctx: VariableContext): Promise<ContextVariable[]> {
    const cwd = this.cwdFor(ctx.sessionId)
    if (!cwd) return []

    try {
      const { stdout: branch } = await exec(
        'git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd },
      )
      return [{
        name: 'git_branch',
        value: branch.trim(),
        description: 'Current git branch (HEAD).',
        level: 'system',
        readonly: true,
      }]
    } catch {
      return []   // Not a git repo, or git missing — silent.
    }
  }

  claims(name: string): boolean {
    return name === 'git_branch'
  }
}
```

Register it after bootstrap:

```ts
import { bootstrapVariableSystem, registerVariableProvider } from '../variables/index.js'
import { GitProvider } from './git-provider.js'

bootstrapVariableSystem()
registerVariableProvider(new GitProvider(
  (sessionId) => store.getSession(sessionId)?.workingDirectory ?? '',
))
```

The provider is now visible to:
- the system prompt (next outbound LLM call),
- the `variable` tool (`action: 'list'`),
- the Inspector → Context tab (live via `session:variables-updated`).

---

## Live-update hook (optional)

If your data source changes asynchronously and you want the renderer
inspector to reflect it without waiting for the next LLM call:

```ts
onExternalChange(emit) {
  const watcher = watchSomething((sessionId) => emit({ sessionId }))
  return () => watcher.close()   // teardown for registry.reset()
}
```

`emit({ sessionId })` triggers a session-scoped re-list and broadcasts
`session:variables-updated` on the EventBus. `emit()` with no args
broadcasts a "something changed globally" hint — listeners that care
must re-list themselves.

---

## Testing

Providers are pure classes — pass fake gateways/dependencies via the
constructor instead of mocking globals. The registry can be exercised
in isolation with `new VariableRegistry()` — no EventBus or store
needed. See `src/main/variables/__tests__/core-provider.test.ts` for a
provider that uses an in-memory gateway, and `registry.test.ts` for
how to compose multiple providers under test.

---

## Lifecycle summary

```
app boot
  ├─ initializeEventSystem()
  ├─ bootstrapVariableSystem()       ← VariablesStore.initialize() runs first
  │                                    (loads variables.json, applies migrations),
  │                                    then built-in providers register
  ├─ registerVariableProvider(...)   ← your plugin goes here
  └─ initializeToolRegistry()        ← variable tool now sees you
```

Tear-down: `shutdownVariableSystem()` resets the registry and
unsubscribes external-change hooks. Generally only needed in tests.

---

## Persistence layout

Global scalar variables (note dirs and `global_variables`) live in
`~/.onething/variables.json` (schema lives in
`src/main/variables/store/schema.ts`). Project directories are stored
by the separate project-dirs subsystem under
`~/.onething/project-dirs/`. Per-session variables (workdir,
session-scoped custom variables) live inside the owning
`~/.onething/sessions/<id>.json` since their lifecycle is tied to the
session.

Plugins that need their own persistence are free to bring their own
storage backend (a flat JSON file, sqlite, etc.) — the registry never
touches disk on a provider's behalf. If you want to ride along in
`variables.json`, expose your data through `getVariablesStore()` and
extend the schema in `store/schema.ts` with a new optional field.
