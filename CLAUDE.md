# CLAUDE.md
组件化而不是创建新的组件。
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Development
bun run dev                # unified dev: electron + web + server (scripts/dev-unified.mjs)
bun run dev:electron       # managed lane: electron only (can run alongside dev:web)
bun run dev:web            # managed lane: web frontend :5174 + headless server :8787
bun run electron:dev       # electron only (dev-with-logging.mjs → electron-vite dev; dev.log keeps runner+stderr only — the main process writes app.jsonl itself)
bun run web:dev            # bare vite for apps/web (no server, no cleanup)
bun run server:start       # node dist/server/main.js (run server:build first; dynamic port
                           # unless ONETHING_SERVER_PORT; refuses if the desktop already
                           # serves this store — `--force` bypasses)

# Production build
bun run build              # electron build (native mac panel + electron-vite → out/)
bun run web:build          # web build (→ dist/web)
bun run server:build       # headless server build (→ dist/server/main.js)
bun run build:check        # typecheck + build
bun run build:unpack       # build + electron-builder --dir
bun run build:mac          # build + electron-builder --mac
bun run build:win          # build + electron-builder --win
bun run build:linux        # build + electron-builder --linux
bun run build:native:mac   # macOS panel native module only (scripts/build-macos-panel.mjs)
bun run sign:dev:mac       # sign dev binaries

# Linting & Testing
bun run lint               # ESLint with auto-fix
bun run lint:ci            # eslint . --max-warnings 200
bun run test               # vitest run (rebuilds better-sqlite3 for Node ABI first)
bun run test:watch         # vitest (watch mode)
bun run typecheck          # typecheck:node + typecheck:web

# Guardrails
bun run boundary           # full static boundary checker (scripts/headless-boundary-check.ts)
bun run boundary:gate      # ratchet gate: diffs checker output vs baseline, fails only on NEW reds
bun run log:gate           # console.* ratchet (baseline docs/audit/log-gate-baseline-2026-08-20.txt)
bun run log:check          # the full console.* call-site list behind that gate

# Logs
bun run log:tail           # pretty-print + follow <store>/log/app.jsonl ([--ns engine.*] [--level warn] [--session id])
bun run log:smoke          # real-machine gate: boots dist/server on a temp store, asserts server.jsonl

# Evals
bun run evals              # bun evals/run.mjs
bun run evals:diagnose     # scripts/diagnose-weekly.mjs
```

Dev ports: Electron renderer dev server **5173**, web frontend **5174**. The core HTTP/SSE port is **dynamic** since A 期 (`docs/design/one-core-2026-08.md`): whoever serves the store writes `<store>/run/http.json`, and apps/web's dev `/api` proxy (`apps/web/dev-api-proxy.ts`, a plugin — vite's built-in proxy pins its target at creation) re-reads that file per request and injects the Bearer token, falling back to `ONETHING_API_URL` || `http://127.0.0.1:8787`. `bun run dev` with the electron lane does NOT start a second server process — the desktop is the core.

## Architecture Overview

This is **onething**, an AI chat app with multi-provider support, tool calling, and an event-driven streaming engine. The product lives in packages; the apps are thin sockets. Three-layer mental model:

- **packages/core** — engine skeleton. Zero dependencies, zero Electron. Event bus, session, permission, tool-loop, storage primitives.
- **packages/onething-runtime/src** — the product itself (prompts, sessions, tools, providers, themes, …). Electron-free; bans `@shared/ipc` (checker-enforced); must not import the assembly tree.
- **packages/onething-runtime/src/app** — the assembly layer (`@onething/app`). All migrated main-process glue (engine, events, stores, tool/provider/permission wiring). `@shared` IS allowed here. Exposes `createOnethingBackend`, the single assembly recipe.
- **apps/\*** — thin sockets: Electron (window/IPC/native panel), server (HTTP/SSE), web (browser build of the renderer), CLI daemon.

```
apps/*  (thin sockets)
┌───────────────┬────────────────┬──────────────┬─────────────────────┐
│ apps/electron │ apps/server    │ apps/web     │ CLI daemon          │
│ window/IPC/   │ HTTP + SSE     │ browser      │ bin/onething.mjs →  │
│ native panel  │ :8787          │ build        │ out/main/cli.js     │
└──────┬────────┴───────┬────────┴──────┬───────┴──────────┬──────────┘
       │ createOnethingBackend(...)     │ /api → server    │
┌──────┴────────────────┴───────────────┴──────────────────┴──────────┐
│ packages/onething-runtime/src/app        ASSEMBLY ('@onething/app') │
│  backend.ts (factory) + engine/ events/ stores/ tools/ providers/   │
│  permission/ mcp/ …  — @shared allowed; hosts inject surfaces via   │
│  configure*Host ports (never imports electron/@main/@preload)       │
├──────────────────────────────────────────────────────────────────────┤
│ packages/onething-runtime/src/*          PRODUCT ('@onething/runtime')│
│  prompts, sessions, agent-loop providers, tools, themes, …          │
│  Electron-free; no @shared/ipc; MUST NOT import @onething/app        │
├──────────────────────────────────────────────────────────────────────┤
│ packages/core                            SKELETON ('@onething/core') │
│  engine, events, session, permission, tools, storage. Zero deps.     │
└──────────────────────────────────────────────────────────────────────┘
```

Dependency direction is one-way: product ← assembly ← hosts. Product code never imports `@onething/app`.

### Monorepo Layout

```
packages/core/               # Bottom layer, zero deps. No src/ — files at package root:
                             # agent-loop/ (provider-agnostic loop), engine/ (CoreStreamEngine,
                             # HeadlessStreamEngine), events/, session/ (+storage/jsonl),
                             # permission/, tools/, plugins/, mcp/, storage/ primitives.
packages/onething-runtime/   # src/ = the product (prompts, sessions, agent-loop
                             # providers, tools, themes, voice, music, …). Electron-free.
                             # src/app/ = assembly layer: createOnethingBackend + all
                             # migrated main-process glue ('@onething/app').
packages/gateway/            # WeChat/Telegram channel gateway. Depends on core only.
                             # Remote permission approval (reply 1/2/3), markdown-safe streaming.
packages/shared/             # Shared IPC/event contracts + defaults ('@shared'). Also
                             # backend/ (store-lock for CLI), cli/, defaults/, types/, voice/.
packages/renderer/           # Shared Vue 3 renderer UI ('@' / '@renderer'), consumed by
                             # the Electron renderer build and apps/web.
apps/electron/               # Electron host. src/main ('@main') = ipc/bridges/cli only;
                             # the rest of src/* (window, app, voice, menu, search, …) is
                             # the '@onething/electron-host/*' alias family.
apps/server/                 # Process shell only (main.ts + index.ts). The HTTP/SSE surface
                             # and the server runtime live in the assembly layer
                             # (packages/onething-runtime/src/app/server/), so the Electron
                             # desktop mounts the SAME code over its own backend.
apps/web/                    # Browser build of packages/renderer; talks to whatever core
                             # serves this store (desktop or server:start) via /api.
```

### createOnethingBackend — the single assembly recipe

`packages/onething-runtime/src/app/backend.ts`. Every host boots through this function; ordering constraints (variables before tools, engine before Permission) live here and nowhere else. **Importing `@onething/app` modules performs no configuration** — enforced by `packages/onething-runtime/src/app/__tests__/import-side-effect-free.test.ts`.

Options (`OnethingBackendOptions`):

- `sandboxHost?: { getPath?(name) }` — downloads/home surface
- `toolRegistry?: 'full' | 'headless' | 'readonly'` — full = every builtin (desktop), headless = reduced set (default when omitted), readonly = zero-local-side-effect tools (server degradation)
- `promptVersion?` — stamp eval traces with live minimal-scene prompt output
- `sessionSkills?`, `mcpAcp?` — opt-in subsystems (hosts may instead init MCP/ACP post-window)
- `sender?: BindableStreamSender` — `engine.bind(sender)`; EventBus-observing hosts pass a noop (the engine drops commands silently with no sender bound)
- `hooks?: { afterSettings, afterEngine, afterTools }` — host-specific steps injected into the sequence

Boot order: `configureAppRuntimeAdapters()` (idempotent) → stores → settings → afterSettings → event system → session layer → StreamEngine → triggers → afterEngine → `Permission.initialize` → variable system → goal breakers → project dirs → tool registry by tier → afterTools → optional sessionSkills / MCP+ACP / bind. Returns `{ engine, eventBus, streamChannel, shutdown() }`.

Host call sites:

| Host | Call site | Config |
| --- | --- | --- |
| Electron desktop | `apps/electron/src/app/main-process.ts` | `toolRegistry: 'full'`, `promptVersion: true`, hooks: shortcuts+proxy / `initializeIPC()`+todo watcher; engine binds to window later via `getStreamEngine().bind(webContents)`. **Also mounts the HTTP/SSE surface** over that same backend post-window (`startEmbeddedOnethingHttpServer`, non-blocking) |
| Headless server | `packages/onething-runtime/src/app/server/runtime.ts` (`createRealServerBackend` → `createOnethingServerRuntimeOverBackend`) | `toolRegistry: ONETHING_SERVER_TOOLS === 'readonly' ? 'readonly' : 'full'` (desktop parity by default), `sessionSkills: true`, noop sender (SSE observes the bus directly) |
| CLI daemon | `packages/onething-runtime/src/app/headless/backend.ts` (`HeadlessBackend`, used by `apps/electron/src/main/cli/daemon-server.ts`) | `toolRegistry: 'headless'`, `sessionSkills: true`, `mcpAcp: true`, noop sender |

Note: `backend.ts` carries static `import './tools/builtin/{index,headless,readonly}.js'` edges purely so single-file bundlers order the tool barrels before the factory's top-level await (the registry itself dynamic-imports them for test mocks). Do not remove them.

**Host injection ports** (`configure*Host`, all in `src/app`, late-bound and consulted per call — how hosts contribute Electron-only surfaces without the assembly layer importing electron):

| Port | File |
| --- | --- |
| `configureStorePathHost` | `app/stores/paths.ts` |
| `configureSandboxHost` | `app/tools/core/sandbox.ts` |
| `configureAuthHost` | `app/auth/host-ports.ts` |
| `configureVoiceHost` | `app/voice/host-ports.ts` |
| `configureAppLoggingHost` | `app/logging/index.ts` |
| `configureSkillsEnvironmentHost` | `app/skills/loader.ts` |
| `configureTodoPlanHost` | `app/todo-plan/store.ts` |

### Guardrails

- `bun run boundary` — `scripts/headless-boundary-check.ts`, the heavy static checker. Key rule sets: core bans electron/`shared/ipc`/better-sqlite3/mcp+acp SDKs/zod/diff/uuid; runtime outside `src/app` bans electron **and** `@shared/ipc`; `src/app` gets a relaxed set — `@shared/ipc` allowed, but electron, `@onething/electron-host`, `@main/`, `@preload/` banned (hosts inject via configure*Host ports).
- `bun run boundary:gate` — `scripts/boundary-gate.mjs` ratchet: diffs `[boundary] failed:` lines against `docs/audit/boundary-baseline-2026-08-07.txt` (13 known legacy reds). Exits 1 only on NEW failures; prints healed ones so the baseline can be re-tightened.
- UI 组件与样式规则见 `docs/design/ui-system.md`(浮层决策树、交互态配方、z-index 层级表、禁令清单),新代码须过 `bun run ui:gate` — `scripts/ui-gate.mjs` ratchet over `scripts/ui-style-check.mjs`'s 12 line-level rules (z-literal / z-fallback / raw-teleport / native-select / native-confirm / title-attr / ui-hex-fallback / transition-literal / shadow-literal-floating / focus-bare / overscroll-contain-chat / surface-literal), baseline `docs/audit/ui-baseline-2026-08-13.txt` (81 条 = 5 条逐条确认过的语义保留 + 76 条 `surface-literal` 区域面迁移待办)。`bun run ui:check` prints the full list.
- `bun run log:gate` — `scripts/log-gate.mjs` ratchet over `scripts/log-check.mjs`: counts `console.*` call sites in non-test source, baseline `docs/audit/log-gate-baseline-2026-08-20.txt` (854, the pre-migration stock; L4 消它). Whitelist: `scripts/` and the CLI's product-output helper `apps/electron/src/main/cli/stdout.ts` (**给人/管道看的 = `stdout()`;给排障看的 = `getLogger(ns)`**). New code must not add a `console.*` — use `getLogger`.
- `packages/core/__tests__/architecture-boundaries.test.ts`: core has no electron/host imports and sits at the bottom (no `@onething/runtime`/`@onething/gateway`); runtime is Electron/host/gateway-free; **the runtime product layer must not import `@onething/app`** (dependency points one way: product ← assembly); gateway depends on core only; renderer never touches `window.electronAPI` outside `packages/renderer/platform/`; apps/web and apps/server are Electron-free.

Notes:

- **Logging** (L0/L1 landed 2026-08-20, `docs/design/logging-system-2026-08.md` §7;
  current-state audit: `docs/audit/logging-inventory-2026-08-19.md`). One facade, one
  record shape, one governor:
  - `packages/core/logging/` (zero deps, zero node imports) owns `Logger`
    (`trace/debug/info/warn/error/fatal/child(fields)`), `LogRecord
    {time, level, ns, msg, fields?, err?, src?}`, `LevelFilter`, `ConsoleSink(pretty|json)`,
    `MemoryRingSink`, `normalizeError`. `packages/onething-runtime/src/app/logging/`
    assembles it: **`configureLogging()` is the single wiring point** (idempotent — the
    desktop's embedded HTTP face never double-configures), and product code only ever
    calls `getLogger('engine.stream')`. `msg` is a fixed short sentence; variables go in
    `fields` (`log.info('stream finished', { sessionId, ms })`), errors go in `err`.
  - **Files are JSONL**: `<store>/log/app.jsonl` (desktop + CLI) / `server.jsonl`
    (standalone server), one `LogRecord` per line, rotated + gzipped by `JsonlFileSink`
    (same `ONETHING_LOG_MAX_SIZE_MB` / `MAX_ARCHIVES` / `RETENTION_DAYS` / `COMPRESS`
    env group). Read them with `bun run log:tail` (pretty, follows, `--ns/--level/--session`).
    `dev.log` no longer mirrors main-process stdout — it keeps runner + stderr only.
  - **Level switch**: `ONETHING_LOG='<default>[,<ns-glob>=<level>]*'`, e.g.
    `ONETHING_LOG=info,engine.*=debug,providers.deepseek=trace` (most specific glob wins).
    Read at configure time; `setLogLevelSpec()` re-points it at runtime.
  - **诊断模式** = settings `diagnostics.enabled` (default false, General → Diagnostics):
    one switch =全域 `debug` + provider request dump ON. Applied in `createOnethingBackend`
    right after settings load and re-applied on every `saveSettings*` — turning it off
    returns to the env spec, not to a hardcoded `info`.
  - **Provider request dumps are OFF by default** (真机上默认开曾写出 1.1G):
    `ONETHING_DUMP_PROVIDER_REQUESTS=1` or 诊断模式, and they land in
    `log/dumps/provider-requests/` (7 days / 100MiB, janitor-governed).
  - **`log/` has exactly one governor**: `LogDirJanitor` + `LOG_DIR_POLICY` (per-family
    archives/retention, the dumps dir, a 512MiB directory cap), running at start and every
    5 min. It only ever deletes **archives and dumps** — never a live ledger, never a file
    it does not recognize. Event ledgers (`sessions/<id>/events.jsonl`, `usage/*.jsonl`,
    scheduler logs) are product data in their owners' directories and are **not** logs:
    the janitor never touches them.
  - Process safety: `installProcessCrashHooks` logs `unhandledRejection` /
    `uncaughtException` as `fatal` and `flushSync`s — via `uncaughtExceptionMonitor` by
    default, so Node's own crash behaviour is unchanged.
  - Migration-era leftovers: `LegacyConsoleSink` still captures raw `console.*` +
    stdout/stderr as `ns='console'`, `fields.legacy=true`, `fields.callsite` (that stream
    *is* the L4 to-do list); the Electron `console-message` renderer capture is a
    **fallback** only — warn+, structured fields, multi-line Vue warns collapsed into one
    record with `fields.stack`.

- Session persistence is file-based: new sessions use per-session JSONL dirs
  (`sessions/<id>/meta.json` + `messages.jsonl`, append/suffix writes during streaming);
  legacy whole-file `sessions/<id>.json` is still readable and lazily migrated
  (originals kept in `sessions/legacy-backup/`). Toggle via
  `settings.storage.sessionFormat` ('jsonl' default | 'legacy-json' to roll back).
  Hybrid driver: `packages/onething-runtime/src/sessions/storage-driver.ts`; pure jsonl
  codec/pager in `packages/core/session/storage/jsonl/`. See
  `docs/design/session-storage-jsonl.md`; conversion: `scripts/convert-sessions.mjs`.
  Cross-session search/indexing belongs in apps/server — do not add a database to the
  Electron main process.
- **Session event sourcing is in shadow mode** (S1, `docs/design/session-event-sourcing-2026-08.md`).
  Every session also writes `sessions/<id>/events.jsonl` — a v2 event log (`session/created`,
  `user/message`, `run/start|end`, `request/*`, `assistant/chunks|part-end`, `tool/*`,
  `permission/*`, `session/compacted`, …) plus a content-addressed `sessions/<id>/blobs/`
  for anything over 64KB. **`messages.jsonl` is still the only truth**; the event log is a
  shadow that proves itself: at every `run/end` the projection of that run
  (`projectChatMessages`) is deep-compared against the real messages, and before every
  provider request the projected model history (`projectModelHistory`) is hash-compared
  against what `buildHistoryMessages` actually sends. Both sides go through the one judge
  in `packages/core/session/projection/canonical.ts` — extend that file, never add a
  local exemption. Mismatches land one summary line each in
  `<store>/log/session-shadow.jsonl` and count into `session-shadow-stats.json`;
  `bun run sessions:shadow-report` is the gate (runs ≥ 200 ∧ mismatches = 0 ∧
  appendFailures = 0), `sessions:shadow-reset` zeroes it, `sessions:shadow-overhead`
  measures the cost. `ONETHING_SESSION_SHADOW=0` turns the comparison off (events keep
  being written); it is **on by default**. S2 is what flips the read path over to the
  projection — until then, nothing reads `events.jsonl` for product behavior.
- There is no memory subsystem. The soul-memory plugin (SOUL/MEMORY.md + daily notes,
  panel, settings tab, `/api/memory/*`) was retired 2026-08-06 — see
  `docs/audit/soul-memory-retirement-2026-08-06.md`. Nothing reads or writes those files;
  leftover data is archived via `scripts/archive-soul-memory.mjs`. `usage` still accepts
  `source: 'memory'` so historical ledger rows resolve.
- Plugin system (R0–R7 complete, 2026-08-07). The plugin's entire power is the injected
  `api` object. Current surface:
  - **AI capabilities**: tools, slash commands, events (+ plugin-namespaced custom events),
    prompt-context providers, skill roots, lifecycle hooks, scheduler.
    A registered tool may declare `executionMode: 'parallel' | 'sequential'` (N3,
    2026-08-10 — `docs/design/pi-benchmark-adoption-2026-08.md` §8): it flows through
    to `AgentTool.executionMode`, whose **single** reader is the agent-loop runner
    (`packages/core/agent-loop/runner.ts:397` → `ToolExecutionScheduler` barrier).
    Undeclared = barrier = unchanged behavior; an illegal literal rejects that one
    tool at registration (no silent degrade, no breaker count).
  - **Cross-session messenger + session peek** (N1, 2026-08-10 —
    `docs/design/pi-benchmark-adoption-2026-08.md` §6): `api.sendMessage(sessionId,
    content, {triggerTurn} | {deliverAs})` is a three-state matrix, not a boolean —
    idle target starts a turn, busy target degrades to steer (reported honestly in
    `delivered`), `triggerTurn:false` only posts. It maps onto the existing
    command:send-message / steering / follow-up paths; `deliverAs:'nextTurn'` is
    honestly mapped to follow-up (there is no third queue). `api.sessions.peek/list`
    + `api.isIdle` are compressed read-only snapshots computed from live memory (zero
    new bookkeeping; preview hard-capped at 120 chars). Gated by manifest
    `permissions: sessions:post / sessions:trigger / sessions:peek` (undeclared =
    structured rejection, no breaker). Loop brakes: hop ≤ 8 (conservative upper bound —
    the caller's own session is not knowable, so it is not asked for) and 10
    deliveries/min per (plugin, session). Injected messages carry
    `origin.source='plugin:<id>'` + `origin.plugin={id,hop}` and count as
    system-internal (router bypass + 120s permission degradation).
  - **Its own product surface**: declarative workspace panels (`contributes.panels` +
    `api.registerWorkspacePanel`, pure-data description tree — the UI never executes
    plugin code), declarative UI-slot blocks on host-named anchors
    (`contributes.uiSlots` + `api.registerUiSlot`, R5.x — **five** host-named anchors,
    each carrying a **kind** decided by the host table, never by the plugin
    (`packages/core/plugins/ui-anchor.ts`): three always-on *blocks* —
    `composer.above` above the composer, `chat.status-bar` below the message list,
    `message.footer` per assistant message (the first message-level anchor, its
    render ctx additionally carries `messageId`) — and two *triggers* (D 期,
    2026-08-09) where the host draws only an entry and pulls the tree **on click**
    into a popover that is destroyed on close: `message.actions` in each assistant
    message's ⋯ menu (ctx carries `messageId`) and `composer.actions` on the
    composer toolbar, before the attach button. Trigger adds **no protocol**: same
    `ui:render:*` / `ui:action:*` channel, same `ui:<anchor>:<id>` surface folding;
    a degraded entry is **greyed, not removed**. `composer.above` additionally opens a
    **drawer capability** (F 期, 2026-08-09 — a `block` capability, not a new kind):
    a slot declaring `drawer: true` gets host-drawn toggles and three host-owned states
    (expanded 240px / peek 32px / collapsed to one chip in the S status band); the plugin
    only sees `ctx.drawerState` (`'expanded' | 'peek'`) and the state machine lives in
    `packages/renderer/workspace/ui-anchor-registry.ts` (localStorage, per window).
    Render ctx carries `anchor` +
    `sessionId`, the host re-pulls on session switch. Renderer pieces:
    `components/plugins/{UiSlotHost,UiSlotBlock,PluginTriggerPopover}.vue` +
    `usePluginTriggerEntries.ts`),
    theme token overrides (`contributes.theme.overrides`, B 期/L2 — keys must be
    existing `CSS_VAR_MAP` token paths, values must pass a color-literal whitelist;
    illegal entries are dropped and shown in the catalog projection, never a load
    error; conflicts resolve by canonical order (pluginId lexicographic) last-wins;
    the resolved token table is passed as a **parameter** into `applyTheme` from
    `apps/electron/src/main/ipc/themes.ts` (desktop only) and lands *inside* the
    theme computation — before `resolveThemeUI` / `generateCSSVariables`, so the
    `--ui-*` layer, `-rgb` variants and the primary color scale all re-derive from
    the override. Never spread it onto the finished `cssVariables`: that only covers
    the raw vars and leaves the derived layers on the old colors),
    its own settings schema (`contributes.settings.schema`, JSON Schema
    subset, host renders and validates it — the subset **is** the renderable
    control set: boolean/string/number/integer/string-enum/string-array plus
    `{"type":"string","format":"file-import","accept"?,"maxBytes"?}`, added
    2026-08-10 after a user correctly objected that a wallpaper picker had been
    built as a workspace panel. **Placement precedent: configuration-shaped
    interactions belong in Settings; panels are for live content** — when the
    host lacks a control, add the control, don't move the config into a panel.
    `accept`/`maxBytes` semantics and their validator are literally the same
    ones the `file-pick` descriptor node uses
    (`core/plugins/file-pick.ts` → `describePluginFileImportDeclarationProblem`);
    unknown `format` values are ignored per JSON Schema, an illegal declaration
    marks the whole config area unsupported without blocking the load),
    a unified request channel
    (`api.registerRequestHandler`; requestId is in use, while abort/progress are wired
    end-to-end but have no consumer yet — no renderer caller, no built-in producer), a
    per-plugin data directory
    (`api.storage`) plus the legacy KV store, in-stream status lines (`api.status`), and
    `ui.notify`.
  - **Storage taxonomy** (`docs/design/plugin-message-state-2026-08.md`): a
    scope × lifetime × owner table, not one facility per feature. App-level KV
    (`kv.json`) and host-written settings (`config.json`) are P1; **message-level state**
    is `api.storage.message(sessionId, messageId)` → one JSON blob per message at
    `plugins/<id>/message-state/<sid>/<mid>.json`. The host owns the coordinate system
    (placement, hydration on load, cascade on `message:deleted` / `session:deleted`,
    a 5MB-per-plugin quota that throws `quota`, corrupt-record quarantine, archive on
    uninstall); the plugin owns the content (opaque — the host never interprets it).
    Persistence is gated by declaration: a plugin gets disk only if some
    `contributes.uiSlots[].lifetime === 'persistent'` (default `ephemeral` = memory only,
    lost on restart; unknown future values degrade to non-persistent). The install confirm page discloses the
    persistent slot. Session-level persistent state is a deliberate empty cell — the
    layout leaves room, but nothing is built until a real plugin needs it.
  - **One opened host registry**: `api.registerIMConnector` (pilot; ids are namespaced
    `plugin:<id>:<name>`). **No production traffic flows through it yet** — no built-in
    plugin registers a connector and inbound is not wired, so the pilot validates the
    contract and teardown semantics, not the delivery path. Which registries are
    deliberately *not* open, and why, is in `PLUGIN_DEFERRED_REGISTRIES`
    (`packages/core/plugins/policy.ts`) — read it before opening another.
  - **Isolation**: timeout budgets, per-`pluginId+scope` failure breaker, and a severity
    policy table (`policy.ts`) deciding disable-plugin vs degrade-one-surface. Teardown is
    two-sided (code registries + data footprint) and guarded by a CI teardown test.
  - **Distribution (npm form, P1–P3 complete, 2026-08-08)**: plugins install as zero-runtime-dep
    npm tarballs from the market repo's GitHub Releases (`monotasking/plugin`,
    index `raw.githubusercontent.com/monotasking/plugin/main/index.json`). The ledger is
    `~/.onething/plugins/package.json` dependencies; code lives in `plugins/node_modules/`
    (a pure code zone — no data ever); each plugin's data lives in its home dir
    `plugins/<id>/` (`config.json`, `kv.json`, `storage/`). Lifecycle commands
    (install/update/uninstall/check-updates) run through npm with `--ignore-scripts`
    (lifecycle scripts never execute), SRI-vs-lockfile verification, and rollback on any
    failed gate (runtime deps / integrity / package-name mismatch / built-in id collision).
    Settings page has an Install form (file: dev channel) and a **Plugin Market** section
    (search, manifest-first confirm page, offline cache with stale notice). **The npm ledger is
    the only way in** — legacy directory-form plugins were retired 2026-08-09 (stock had already
    reached zero): a directory under `plugins/` carrying a `plugin.json` but absent from the
    ledger is simply not loaded (no error, and the orphan sweep leaves it alone — it is neither
    a plugin nor host-owned data). With it went the `needsInstall` probe and the whole
    first-load `npm install` machine (packages ship fully bundled). `plugin-data/` is archive-only:
    no read path points there anymore, orphaned leftovers are swept into
    `plugin-data/legacy-backup/`. Author guide: `docs/guides/plugin-authoring.md`;
    distribution design: `docs/design/plugin-distribution-npm-2026-08.md`;
    retirement record: `docs/design/plugin-legacy-retirement-plan-2026-08.md`.
  - **Plugins execute on the Electron desktop host only** (plan A). Two caveats the
    earlier wording got wrong: apps/server is *not* a read-only mirror — its
    `/api/plugins/{enable,disable,refresh}` routes do write enable-flags to disk, and it
    scans a different tree (`owners/<uid>/<wid>/plugin-store/plugins`, not
    `<store>/plugins`), so toggling there changes a catalog the desktop never reads. The
    CLI daemon does not assemble the plugin system at all (it is not "UI-less" — it has
    no plugins).
  Design doc: `docs/design/plugin-system-redesign-2026-08.md` (§5.x carries the per-phase
  rulings and errata; §6 the multi-host decision).
  `docs/design/plugin-system-capabilities-and-evolution.md` is the pre-R0 survey — useful
  for history, superseded for current capabilities.
  UI slots & descriptor-tree v2 (R5.x): `docs/design/plugin-ui/` (anchor audit, anchor
  design, expression layers, rollout). **Anchor taxonomy v2** — the five-axis model
  (address / kind / cardinality / context / expression), the full address map (what is
  open, what is deferred, what is *never*), the trigger protocol and the append-only
  governance rule (a new anchor = one row in §9.2 + five code sites) live in
  `plugin-ui-anchors-2026-08.md` §9; the D-phase landing record and its deviations are
  in `plugin-ui-rollout-2026-08.md` §6.4. The one-liner for plugin authors:
  **you may put things next to the composer, never inside it** — and the expression
  decision table: data lists / forms / status → L1 descriptor tree; progress / badges /
  tabs → L1 v2 nodes; brand theming → L2 token overrides (phase 2); charts / editors /
  drag & drop → L3 webview (H line, not built); taking over the composer or the message
  list → **never**.
- **One core per store** (A 期, `docs/design/one-core-2026-08.md`). The HTTP/SSE surface is
  assembly-layer code (`packages/onething-runtime/src/app/server/{http,runtime,discovery,embed}.ts`);
  `apps/server/src/main.ts` is a process shell around it and the Electron desktop mounts the
  **same** code over its own backend, so a browser at :5174 subscribes to the desktop's event
  stream rather than a second engine's. The seam is
  `createOnethingServerRuntimeOverBackend(backend, { ownsBackend, processPorts })`:
  `ownsBackend: false` keeps `shutdown()` off the host's engine, and `processPorts: 'host'`
  stops the server runtime from clobbering the process-level single-slot ports the host
  already owns (MCP client host/identity/capabilities, permission-grant storage) — todo-plan
  and scratchpad broadcast are **chained** onto the host's port instead (IPC *and* SSE), and
  restored on shutdown. Whoever serves the store writes
  `<store>/run/http.json = {port, host, token, pid, startedAt, owner:'desktop'|'server'}`
  (0600, next to `daemon.sock`/`backend.lock`; run dir = `getOnethingRunDir()`), deletes it on
  shutdown, and answers on a **dynamic** port unless `ONETHING_SERVER_PORT` pins one (pinned
  and busy = explicit error, never a silent fallback). `server:start` reads that file first and
  **refuses to start** when a live record says `owner !== 'server'` (`--force` bypasses); alive
  means pid alive **and** the port connects. Token = `ONETHING_SERVER_TOKEN` or a fresh
  `randomBytes(24).base64url` per launch.
- apps/server is single-user: one server process assembles one backend and pins
  `ONETHING_STORE_PATH` before boot. Bearer auth via `ONETHING_SERVER_TOKEN` (warns when
  binding non-loopback without it; loopback launches mint their own token into the discovery
  file). Tools ship with desktop parity by default;
  `ONETHING_SERVER_TOOLS=readonly` degrades to zero-side-effect tools (read/time/web only).
  The server's HTTP session store is backed by the same `@onething/app` store the engine
  uses in-process — a second repository over the same files would fork the in-memory truth.
- Store isolation: the store root resolves `ONETHING_STORE_PATH` → `~/.onething`
  (`packages/onething-runtime/src/storage/paths.ts`). All app-layer paths must resolve
  through `getOnethingStorePath()` / its `getOnething*Path` helpers — never hardcode.
  Single-instance safety via `StoreLock` (`acquire('desktop')` / `'daemon'`). The
  `'server'` owner exists in the type but `apps/server` deliberately does **not** take the
  lock (2026-08-19 ruling: desktop + dev server share `~/.onething` in `bun run dev`; the
  two-writer risk — two LRUs + two throttled write queues over the same files — is accepted
  for now and must be revisited before the session event log becomes the single source of
  truth).
- Permission channel affinity gotcha: a permission ask records
  `targetChannel = engine.getChannel(sessionId)` (default `'ipc'`), and core rejects a
  respond whose channel doesn't match. When answering from another transport, adopt the
  ask's targetChannel (the server HTTP respond does this — owner is already authenticated
  at the HTTP boundary; affinity guards against cross-channel spoofing on the bus).
- Renderer code accesses the host through `platformApi` (`packages/renderer/platform/`),
  never `window.electronAPI` directly. `platformApi` resolves per access: electronAPI
  present → Electron bridge, else the web implementation over `fetch('/api/…')` + SSE.
- System prompt assembly is a single "directory at top, copy below" builder in
  `packages/onething-runtime/src/prompts/builder.ts`, composed by a **`PromptComposer`
  over `PromptSource`s** (2026-08-18, `docs/design/prompt-composition-2026-08.md`).
  One shape (`CorePromptFragment`, `packages/core/engine/prompt-fragments.ts`: `slot`
  guidelines / workspace-rules / section, `source`, `order`, `requiresTools` /
  `requiresAnyTools` / `when`, `content`); one interface (`PromptSource.collect(ctx)`,
  `prompts/composer.ts`); sources: `builtinPromptSource` (the section table),
  `OnethingToolRegistry` itself (the `ToolInfo.prompt` of the tools **on the turn's
  surface** — declared next to the tool, so enable/disable/scene/allowlist/unregister
  all just work; `edit`/`write`/`variable` own the former `tool-guidelines.md` /
  `tool-workspace-rules.md` / `context-variables-intro.md` text), `PromptFragmentRegistry`
  (`promptFragments` / `registerPromptFragment` with a disposer, for runtime features /
  hosts) and `PluginPromptContextSource` (`api.registerPromptContextProvider`; plugin
  tools carry `prompt` like builtins). Hosts assemble their own composer:
  `desktopPromptComposer` (`app/engine/prompt/system-prompt.ts`) = builtin + tools +
  registry + plugins-with-breaker; `defaultOnethingPromptComposer` has no tool source
  (evals / prompt version / tests add a `StaticPromptSource`). The composer only
  filters → sorts → renders; `disabledSections` matches fragment ids plus the composite
  blocks `tool-guidelines` / `tool-workspace-rules`. Nothing in the composer or the
  builtin table names a tool except through `requires*`.
  **Two channels** (2026-08-18, `docs/design/prompt-channels-2026-08.md`): a fragment
  declares `channel: 'system'` (default, the static prefix — byte-identical across every
  session of one agent) or `'turn'` (delivered in the `<context-update>` tail of the
  newest user message). Anything session- or turn-level is `turn` — voice, projects,
  skills, todo, AGENTS.md, plugin providers, the variable board (`VariableBoardSource`);
  the `Current date:` line and the `# Work Directory` section are gone (the `datetime`
  and `workdir` variables carry them). `TurnContextLedger` (core, pure) dedupes per block
  against the visible history and `SessionTurnContext` (app, hooked into the `buildPrompt`
  wrapper in `app/engine/stream/agent-loop-runtime.ts`) persists the delta on the message
  as `ChatMessage.turnContext`, so a rebuild replays identical bytes.
- Media library: drag-and-drop ingest and export run over `media:ingest-files` /
  `media:save-as` (`packages/shared/ipc/channels.ts` → `apps/electron/src/main/ipc/media.ts`
  → `mediaLibraryService.ingestLocalFiles`). The `media://` protocol
  (`apps/electron/src/media/protocol.ts`) serves **two** directories — images/ first,
  files/ on miss (non-image assets landed with ingest) — and re-resolves every name against
  the root prefix, since the name comes from the renderer and `../` would otherwise read
  any file. `MediaAsset.source` (`ai-generated` / `user-upload` / `external`) now has real
  producers on every facet, so filtering by it no longer lies.

### Three-Process Model (Electron host)

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer Process (Vue 3 + Pinia)                               │
│  packages/renderer/                                             │
│  - UI components, stores, composables                           │
│  - Calls platformApi.* (wraps electronAPI) for IPC              │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Electron IPC
┌─────────────────────┴───────────────────────────────────────────┐
│  Preload Script                                                 │
│  apps/electron/src/preload.ts → preload/bridge.ts               │
│  - installOnethingPreloadBridge(): contextBridge exposes        │
│    electronAPI (create-api.ts only generates router wrappers)   │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────────────┐
│  Main Process (Node.js)                                         │
│  apps/electron/src/main/ ('@main': ipc/ bridges/ cli/ only)     │
│  - boots createOnethingBackend (engine/events live in           │
│    packages/onething-runtime/src/app/)                          │
│  - IPCBridge: single unified IPC exit point                     │
└─────────────────────────────────────────────────────────────────┘
```

Desktop boot: `apps/electron/src/main.ts` → `startOnethingElectronMain()` in `apps/electron/src/app/main-process.ts` — wires configure*Host ports, acquires the desktop `StoreLock`, calls `createOnethingBackend`, then post-window services (plugins, scheduler, MCP, ACP, gateway, skills) non-blocking.

### Key Data Flows

**Chat Message Flow (both transports, same engine):**

```
renderer chatStore → platformApi.emitCommand(sessionId, { type: 'command:send-message', … })
  desktop: preload bridge → ipcRenderer.invoke('session:command')
           → apps/electron/src/main/ipc/handlers.ts → emitCoreSessionCommandForIpc
  web:     POST /api/sessions/:id/commands → server forwards the command WHOLE
           (only command:abort is handled locally; no field is destructured away)
→ EventBus (packages/onething-runtime/src/app/events/, per-session ring buffers)
→ StreamEngine.handleSendMessage (packages/onething-runtime/src/app/engine/stream-engine.ts)
  → persist messages → emit events + stream chunks
→ desktop: IPCBridge → 'session:event' / 'session:stream' to WebContents
  web:     GET /api/events SSE (same event names; ?after= replays from ring buffers)
```

Both fan-outs share **`SessionStreamCoalescer`** (`packages/onething-runtime/src/app/events/stream-coalescer.ts`): text/reasoning/tool-input deltas batched on a 16ms ordered buffer, active stream's `messageId` stamped onto every chunk, and pending deltas flushed before any session event goes out. Consumers: `apps/electron/src/main/bridges/ipc-bridge.ts` and `packages/onething-runtime/src/app/server/http.ts` (per-SSE-connection instance).

**Tool Call + Permission Flow:**

```
AI tool_call → tool executor → core Permission.ask
  → targetChannel = channelResolver(sessionId) (wired to engine.getChannel; default 'ipc')
  → 'permission:request' event (carries targetChannel) → IPCBridge / SSE → UI
  → respond: 'command:permission-respond' — core enforces channel affinity
    (response channel must equal the ask's targetChannel)
  → tool executes → result back to AI → continue generation
```

`Permission.getPendingPrompts(sessionId)` (core) is the source of truth for pending asks on both desktop IPC and server HTTP (incl. actionable/queued promptState). On the real engine the server skips local grant persistence — core `Permission.respond()` persists itself.

### IPC Communication Pattern

1. **Channel definitions**: `packages/shared/ipc/channels.ts` — all channel constants (incl. the unified `SESSION_COMMAND: 'session:command'`)
2. **Type definitions**: `packages/shared/ipc/*.ts` — request/response types per domain
3. **Event/Command types**: `packages/shared/events/*.ts` — stream lifecycle types
4. **Main handlers**: `apps/electron/src/main/ipc/*.ts` — one handler file per domain + `handlers.ts` (`initializeIPC()`)
5. **Preload bridge**: `apps/electron/src/preload.ts` → `preload/bridge.ts` (`installOnethingPreloadBridge`, exposes typed `window.electronAPI`; `preload/create-api.ts` only generates invoke wrappers from `@onething/core/ipc` domain routers)

To add a new IPC channel:

1. Add channel name to `packages/shared/ipc/channels.ts`
2. Add types in corresponding `packages/shared/ipc/[domain].ts`
3. Implement handler in `apps/electron/src/main/ipc/[domain].ts`
4. Expose API in `apps/electron/src/preload/bridge.ts`
5. For web parity, implement the same surface over `/api` in `packages/renderer/platform/web.ts`

Note: `apps/electron/src/ipc/*` is a second, portable tree (`register*IpcHandler` factories + channel-shape interfaces) consumed by the `@main` handlers — don't confuse the two.

### Alias Registry

`onething.aliases.ts` (repo root) is the **single source of truth** for all `@onething/*` resolution, consumed by all four build/test configs: `electron.vite.config.ts`, `vitest.config.ts`, `apps/web/vite.config.ts`, `apps/server/vite.config.ts`. Families: `@onething/app` (ONE prefix entry — do not add per-file entries), `@onething/core` + explicit subpaths, `@onething/gateway`, `@onething/runtime` (~110 explicit subpaths), `@onething/electron-host/*` (per-file entries → `apps/electron/src/<domain>/<file>.ts`). `@shared`/`@main`/`@renderer`/`@`/`@preload` are declared per-config, not here. Package.json "exports" maps are dead (no npm workspaces).

**Adding a new runtime subpath:**

1. Add the entry in `onething.aliases.ts`, keeping longer prefixes above shorter siblings (string finds are prefix matchers, first match wins). That single edit propagates to all four configs.
2. tsconfig wildcards (`@onething/runtime/*` etc. in `tsconfig.json`) already accept any subpath — no tsconfig edit for a subpath. Only a brand-new top-level family needs a `paths` entry in `tsconfig.json` (and `tsconfig.web.json` if renderer-visible — it redeclares its own paths and has no `@onething/app`).

Failure mode: a missing aliases entry fails only at build/run time, never at typecheck (the wildcards accept everything).

### Directory Structure

```
packages/core/                 # no src/ — files at the package root
│   ├── agent-loop/            # provider-agnostic loop: runner, stream, retry, scheduler
│   ├── engine/                # CoreStreamEngine, HeadlessStreamEngine, context-compact, history
│   ├── events/                # event-bus, ring-buffer, stream-channel, stream-chunks
│   ├── session/               # Session class, manager, state, storage/ (jsonl codec+pager)
│   ├── permission/            # capability-registry, permission-grants, permission-policy
│   ├── toolkit/               # tool-system kernel: ToolSpec/Tool/Intent/Outcome/Catalog/Surface/Runner
│   ├── tools/                 # what survives beside it: effects, abort, diff-hunks, tool-result
│   ├── logging/               # Logger/LogRecord/LevelFilter/sinks — zero deps, zero node imports
│   ├── plugins/  mcp/  context/  storage/  providers/ (types)  http/
│   └── gateway-runtime.ts  runtime-facade.ts  slash-commands.ts
│
packages/onething-runtime/src/ # PRODUCT layer ('@onething/runtime')
│   ├── prompts/               # system prompt builder + content/*.md
│   ├── sessions/              # session-repository, storage-driver (jsonl/legacy hybrid)
│   ├── agent-loop/providers/  # hand-rolled fetch/SSE providers (claude/codex/deepseek/
│   │                          # gemini/openai-compatible/acp) + factory + thinking-options
│   ├── media/  scheduler/  agents/  auth/  settings/  storage/ (paths, store-lock)
│   ├── toolkit/               # the tool system's product half: families, builtin tools, contract, scene
│   ├── tools/  skills/  plugins/  providers/  themes/  variables/  goals/  voice/  music/
│   │                          # (tools/ = pure modules only since R4b: sandbox, bash, edit engine, …)
│   ├── mcp/  acp/  external-agents/  files/  search/  usage/  evals/  headless/  …
│   └── stream-engine.ts       # OnethingStreamEngine over CoreStreamEngine
│
packages/onething-runtime/src/app/  # ASSEMBLY layer ('@onething/app'; @shared allowed)
│   ├── backend.ts             # createOnethingBackend — the single assembly recipe
│   ├── engine/                # StreamEngine (extends OnethingStreamEngine) + stream/
│   │   ├── stream/            # stream-executor, stream-processor, tool-execution(+scheduler,
│   │   │                      # +order), tool-orchestrator, agent-loop-*, message-helpers,
│   │   │                      # provider-helpers, resume-history, image-generation/stream
│   │   ├── prompt/            # prompt building & management
│   │   └── triggers/          # post-chat triggers
│   ├── events/                # event-bus, stream-channel, ring-buffer, stream-coalescer
│   ├── stores/                # sessions (repository wiring), settings cache, app-state, paths
│   ├── toolkit/               # tool assembly: tier catalogs, ports, projections, wiring
│   ├── tools/core/            # host-injection ports only (sandbox, bash-executor, permission-policy)
│   ├── providers/  permission/  mcp/  acp/  skills/  plugins/  variables/  goals/
│   ├── media/  music/  voice/  search/  scheduler/  agents/  external-agents/
│   ├── server/                # the core HTTP/SSE surface: http.ts (routes/SSE), runtime.ts
│   │                          # (OnethingRuntimeFacade + session/settings/permission facades),
│   │                          # discovery.ts (<store>/run/http.json), embed.ts (host mounting)
│   ├── channel/               # gateway identity, session-router, outbound dispatch
│   ├── headless/backend.ts    # HeadlessBackend for the CLI daemon
│   └── logging/               # configureLogging + JsonlFileSink/LegacyConsoleSink/janitor/crash-hooks
│       auth/  session/  usage/  toc/  todo-plan/  practice/  …
│
apps/electron/src/
│   ├── main/                  # '@main' — ONLY: ipc/ (per-domain handlers + handlers.ts),
│   │                          # bridges/ (ipc-bridge), cli/ (daemon), __tests__/
│   ├── app/                   # boot: main-process.ts, ready.ts, bootstrap.ts, …
│   ├── window/                # main/settings/search/todo-plan windows, macos-panel, state
│   ├── preload.ts + preload/  # bridge.ts (electronAPI factory) + create-api.ts (routers)
│   ├── ipc/                   # portable typed host surface (register*IpcHandler factories)
│   └── voice/ music/ menu/ search/ gateway/ auth/ shell/ …   # '@onething/electron-host/*'
│
apps/server/src/               # process shell only: main.ts (env, discovery-file refusal,
│                              # listen, SIGTERM flush) + index.ts (re-exports @onething/app/server/*)
apps/web/                      # package.json + vite.config.ts + dev-api-proxy.ts (dynamic
│                              # /api proxy via the discovery file); builds packages/renderer
│
packages/renderer/             # Vue 3 frontend ('@' / '@renderer')
│   ├── stores/                # Pinia (workspace, chat, sessions, settings, themes, media, …)
│   ├── components/ composables/ services/ (ipc-hub) editor/ types/
│   │   ├── workbench/         # RightWorkbenchPanel — hosts BOTH tab domains (see below)
│   │   └── workspace/         # shared panel skeleton parts (PanelShell & co.)
│   ├── workspace/             # panel-registry: the single source of truth for which
│   │                          # workspace panels exist (builtin six + plugin panels)
│   └── platform/              # platformApi: electron.ts + web.ts (fetch/SSE) + index.ts proxy
│
packages/shared/               # '@shared'
│   ├── ipc/                   # channels.ts + ~30 domain type files + router.ts
│   ├── events/                # session-commands, session-events, stream-chunks, envelope
│   └── backend/ (store-lock)  cli/  defaults/  types/  voice/
```

### Key Systems

**StreamEngine** (`packages/onething-runtime/src/app/engine/stream-engine.ts`): Single owner of active stream lifecycle. Commands arrive via EventBus → engine handlers → persist → emit events → IPCBridge (desktop) or SSE (server). Handles send-message, edit-and-resend, retry-message, resume-after-confirm, steering, compact.

**EventBus** (`packages/onething-runtime/src/app/events/`): Central pub/sub with per-session ring buffers, sequence counters, typed and wildcard handlers; primitives in `packages/core/events/`.

**Providers**: registry wiring in `packages/onething-runtime/src/app/providers/`; the hand-rolled fetch/SSE implementations live in `packages/onething-runtime/src/agent-loop/providers/` (Vercel AI SDK was removed). New providers implement `ProviderDefinition`.

**Tools — toolkit (2026-08-18 rebuild; the legacy tree was deleted in R4b, 2026-08-19)**: the tool system is `packages/core/toolkit/` (kernel: `ToolSpec` / `Tool { plan → apply }` / `Intent` / `Outcome` / `AbortScope` / `OutputBudget` / `Job` / `Catalog` / `Surface` / `ToolRunner` + effect policy table) + `packages/onething-runtime/src/toolkit/` (zod contract, family base classes, the builtin tools, `PluginTool`/`McpTool`, `resolveScene`) + `packages/onething-runtime/src/app/toolkit/` (ports: `PermissionAuthorizer` over `enforcePermissionPolicy`, `IpcProjector`, `AuditProjector` → `events.jsonl` `tool/audit`, `BackgroundJobRegistry`, three-tier catalogs, `createAppToolRunner`, `prompt-source.ts`, `wiring.ts`). Every call runs `validate → intercept → plan → effect-based authorize → apply → budget`; permission looks only at `Intent.effects` (`EffectClass` table in `core/toolkit/effects.ts` — external agents ride the `external-agent` row, so ACP and the Claude Code SDK go through the same `Authorizer.decide` as a local tool). There is **no kill switch and no second path**: `Tool.define` / `ToolInfo` / `permissionGuard` / `autoExecute` are gone, and `permissionGuard?` survives only as a deprecated, derived field on the `@shared/ipc` contract (`app/toolkit/guard-projection.ts`). What is left in `packages/onething-runtime/src/tools/` is pure modules only (sandbox, bash executor/classifier, edit engine, replacers, diff hunks, file snapshot/mutation, output accumulation/truncation, sensitive files, background jobs, `builtin/time-runtime.ts`, `builtin/web-search/{page-fetch,providers}`) plus four dependency-injected IPC-shape projections; `packages/onething-runtime/src/app/tools/core/` keeps the host-injection ports (`configureSandboxHost`, bash executor, background jobs, `enforcePermissionPolicy`). Design + per-phase records: `docs/design/tool-system-oop-2026-08.md` (§17 = the R4b deletion record). **Registration is a catalog, the per-turn surface is scene-resolved**: `runtime/src/toolkit/scene.ts` (`resolveScene`) plus each tool's own `visibleIn` decide what a turn actually sends the model — plain chat = bash/read/write/edit/variable/time/web_search/web_open/radio/practice/task/ask_user; `goal` only while the session goal is `active`; collab tools (`send_message`/`board`/`history`/`notebook`) only in their venue (`collab/tool-surface.ts` is the single table); `task` hidden inside task sessions; skill-scene tools only when that skill is enabled — today the self-evolution trio `feature_mount/unmount/inspect` rides the default-off builtin skill `resources/skills/onething-self-evolution` (frontmatter `default-enabled: false`), registered by the self-evolution feature itself (`app/features/builtin/self-evolution.ts`), not by any tier catalog. Retired 2026-08-18: `find`/`grep`/`glob` (use bash rg/fd), `fart`, `bash_output`/`kill_bash` (bash `run_in_background` now reports the log path + pid; tail/kill via bash).

**Permission**: core `Permission` in `packages/core/permission/` (channel-affinity enforcement); app wiring in `packages/onething-runtime/src/app/permission/`.

**会话消息(P0,2026-08-19,`docs/design/session-commands-p0-2026-08.md`)**:唯一写面是
`sessionCommands`(`packages/onething-runtime/src/app/session/commands.ts`,12 条消息命令 +
`patchSession` 会话级补丁;纯 reducer 在 `packages/core/session/commands.ts`,负责 COW /
写计划 / lazy 档),唯一读面是 `sessionReads`(同目录 `reads.ts`,返回值一律 `readonly`)。
`session.messages` 只允许出现在白名单文件里(命令面 / 读面 / `sessions/storage-driver.ts` /
`sessions/session-dehydrate.ts` / `sessions/session-repository.ts`,理由逐条写在
`scripts/session-check.mjs`),对 `ChatMessage`/`Step`/`ToolCall` 的字段赋值只允许在 core 的
reducer 里;`bun run session:check` 打全表、`bun run session:gate` 是**硬闸**(基线
`docs/audit/session-gate-baseline-2026-08-19.txt` = 0,任何新命中直接红)。dev/vitest 下从
store 交出去的消息**深冻结**(`ONETHING_SESSION_FREEZE`,`app/session/freeze.ts`),漏网的
就地改当场抛 TypeError。core 引擎仍然通过注入的 store 端口写(那些小接口的形状 P0 不动),
端口实现走命令面。**一个反复踩的坑**:命令是 COW 的 —— 先捕获 `session.messages`、再
`await`、再读那个变量会拿到旧数组;await 之后重读。

**MCP / ACP / Skills / Themes**: app wiring under `packages/onething-runtime/src/app/{mcp,acp,skills,themes}/`, product logic under `packages/onething-runtime/src/`.

**CLI daemon**: `bin/onething.mjs` → `out/main/cli.js` (built from `apps/electron/src/main/cli/index.ts`). NDJSON RPC over a unix socket at `<store>/run/daemon.sock`; `StoreLock.acquire('daemon')`; assembles via `HeadlessBackend`.

**Workspace panels**: the six builtin panels (media / agents / tasks / music / practice / archive, declared once in `packages/renderer/workspace/panel-registry.ts`) and every plugin panel are **tabs in `RightWorkbenchPanel.vue`**, not a main-area container. Its tab bar carries two domains — 会话域 (left) | 工作区域 (right) — under three rules: a divider is drawn only when both domains are non-empty; a workspace tab shows its ✕ only while selected; new panels arrive through the `+` picker. Workspace tabs sit in the trailing segment (`insertTab` is the only place that maintains the boundary) and are **cross-session**: switching sessions no longer closes or resets them. Entry points — the sidebar `⋯` menu and the per-panel `windowEvent`s — all funnel into `openWorkspaceTab(panelId)`, which takes builtin ids and `plugin:<id>:<panel>` nav ids alike. `MediaPanel.vue`, the old fullscreen container that covered the chat, is retired; the media view itself is `components/MediaPanelContent.vue`. Plugin manifests may still declare `placements`, but both values now land in the same place (the `+` list); it survives only as the self-promotion gate for `api.ui.openWorkbench`.

**Panel skeleton**: workspace panels are all built on `PanelShell` — `packages/renderer/components/workspace/` holds `PanelShell`, `LedgerGroupHeader`, `PanelLedgerRow`, `PanelPrimaryAction`, `MusicPlayerBar`, `MusicEqualizerBars`, `MediaFileRow`, `SelectionMark`, `PanelSkeleton`; plus `components/common/SegmentedPill` and the global `.text-action` class (`styles/components.css`). Two rules: a workspace panel is always assembled on `PanelShell`, and a spinner may appear only in the status bar.

### State Management

- **Backend**: app-layer stores in `packages/onething-runtime/src/app/stores/` (sessions repository with LRU + 300ms throttled async saves, settings cache with sync hot path, app-state)
- **Renderer**: Pinia stores in `packages/renderer/stores/`
- **Cross-process sync**: EventBus → IPCBridge/SSE events + explicit IPC/HTTP fetch calls

### Build Output

```
out/                   # electron-vite output (packaged by electron-builder → release/)
├── main/index.js      # main process
├── main/cli.js        # CLI daemon entry (bin/onething.mjs imports this)
├── preload/index.js   # bundled preload (CommonJS)
└── renderer/          # Vite SPA output

dist/
├── server/main.js     # apps/server single-file SSR bundle (inlineDynamicImports —
│                      # chunk-split + top-level await deadlocks module evaluation)
└── web/               # apps/web browser build
```

### Tech Stack

| Layer | Technology |
| ------- | ----------- |
| Desktop | Electron |
| Frontend | Vue 3 + TypeScript + Pinia |
| AI SDK | Hand-rolled fetch/SSE per provider (`packages/onething-runtime/src/agent-loop/providers/`) |
| Storage | File-based (JSON + per-session JSONL) |
| Build | electron-vite (Vite renderer + Vite main + esbuild preload); vite SSR for apps/server |
| Test | Vitest |
| Virtual Scroll | Hand-rolled, tables only (`packages/renderer/components/common/virtual-table/useVirtualAxis.ts`). The message list is NOT virtualized — it is a plain `v-for` inside `Scrollbar`. |
