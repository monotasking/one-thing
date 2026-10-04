# CLAUDE.md
组件化而不是创建新的组件。
**加功能不许改骨架**(09-02 立法,起因:检索方案 v2 被用户拿 symbol 能力一问就露出 feed 与 Target 两个枚举点):任何架构方案交卷前必须做「陌生能力演练」——拿一个设计时没想过的能力列出要改的文件,答案不是「能力自己的模块 + 它的壳渲染模块 + 各一行注册」就是骨架没抽到位,打回。手段只有一个:凡「按能力枚举」的地方改成「能力自述、别人读表」(manifest + 注册表),core 里不出现任何能力的名字。
**原生模块只许 N-API,且不许靠注释证明 ABI**(09-02 立法,起因:electron-builder.yml 写着「better-sqlite3 已按 Electron ABI 编好」,实测它按 Node 22 v127 编、在 castlabs Electron 41 v145 下加载失败,这句假话活了两个月没人发现;而 node-pty / sherpa-onnx / macos_panel 三个 N-API 插件一块二进制同时服务 Node 与 Electron 两个运行时,从没出过事):同一份 node_modules 要同时喂桌面(Electron)与 server / CLI / vitest(Node),两个运行时 ABI 不同,V8 ABI 专属的 `.node` 在结构上就不可能两边都对;所以①新原生依赖必须是 N-API(或 SQLite 这类内建/纯 C 扩展),②`.node` 能不能在两个运行时下加载要由门跑出来,不许写在注释里。
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Development
bun run dev                # unified dev: React desktop + web + server (scripts/dev-unified.mjs)
bun run dev:electron       # managed lane: React desktop only (can run alongside dev:web)
bun run dev:web            # managed lane: web frontend :5174 + headless server :8787
bun run electron:dev       # React desktop only (apps/desktop-react/scripts/dev-app.mjs: vite :5175 + Electron on dist-electron/main.cjs; the main process writes app.jsonl itself)
bun run web:dev            # THE browser shell: React shell in web mode (`--mode web` → :5174 + the
                           # dynamic /api proxy, apps/desktop-react/vite/dev-api-proxy.ts)
bun run server:start       # node dist/server/main.js (run server:build first; dynamic port
                           # unless ONETHING_SERVER_PORT; refuses if the desktop already
                           # serves this store — `--force` bypasses)

# Production build
bun run build              # desktop build (scripts/build-desktop.mjs: dist/cli/main.cjs → apps/desktop-react/{dist,dist-electron})
bun run build:cli          # CLI only → dist/cli/main.cjs (esbuild, same recipe as the React main process)
bun run web:build          # React shell web build (`--mode web` → dist/web)
bun run gate:web-shell:react  # real-machine gate for the React browser shell: server:build 产物 +
                           # web:dev:react + headless Chromium → 流式回复上屏,且 token 不进 URL
bun run server:build       # headless server build (scripts/build-server.mjs: vite SSR → dist/server/main.js,
                           # then esbuild → dist/server/search-worker.cjs)
bun run build:check        # typecheck + build
bun run build:unpack       # build + electron-builder --dir (React shell; `main` = apps/desktop-react/dist-electron/main.cjs)
bun run gate:packaged      # the packaging gate: build:unpack → launch the .app on a temp store → run/http.json → /api → CDP window → clean exit
bun run build:mac          # build + electron-builder --mac
bun run build:win          # build + electron-builder --win
bun run build:linux        # build + electron-builder --linux
bun run build:native:mac   # macOS panel native module only (scripts/build-macos-panel.mjs)
bun run sign:dev:mac       # sign dev binaries

# Linting & Testing
bun run lint               # ESLint with auto-fix
bun run lint:ci            # eslint . --max-warnings 200
bun run test               # vitest run (no native rebuild — every native module here is N-API)
bun run test:watch         # vitest (watch mode)
bun run typecheck          # typecheck:node + typecheck:web

# Guardrails
bun run boundary           # full static boundary checker (scripts/headless-boundary-check.ts)
bun run boundary:gate      # zero-baseline hard gate: any `[boundary] failed:` line exits 1
bun run log:gate           # console.* ratchet (baseline docs/audit/log-gate-baseline-2026-08-20.txt)
bun run log:check          # the full console.* call-site list behind that gate
bun run gate:native        # every native .node loads under BOTH Node and Electron (N-API law)
bun run gate:embed-runtime # the embedder finishes 40 variable-length batches under BOTH runtimes
                           # (Electron peak RSS ≤ 800MB); skipped when the model is not downloaded
bun run gate:search-index  # real-machine gate (12 steps + 1 opt-in): boots dist/server on temp stores
                           # behind a fake provider — index worker is owner, a just-sent message is
                           # searchable, rename/archive/delete land through the feed, main-thread loop
                           # delay stays under budget, ⑧ semantic recall end to end with a deterministic
                           # fake embedder (no 130MB download), ⑩ the switch hot-applies, ⑪ the model
                           # download rides the app proxy while the Worker's log lines reach the host
                           # jsonl, ⑬ the model is its own thing (switch on + model absent sends ZERO
                           # network requests; download shows real progress; cancel; delete is refused
                           # while in use) against a local fake HF station, and ⑫ (skipped unless
                           # ONETHING_GATE_REAL_EMBEDDER=1 plus HTTPS_PROXY or HF_ENDPOINT) the REAL
                           # embedder downloads, auto-applies and a zero-word-overlap paraphrase ranks
                           # its own message first. node only — bun has no node:sqlite
bun run gate:acp           # real-machine gate (A0 ①–④): dist/server on a temp store + a fake ACP agent (fixture
                           # fake-agent.mjs) — handshake caps, session/new cwd, unbound-dir refusal, text/reasoning/
                           # tool stream + a rogue method answered -32601, commands pushed outside a prompt. node only
                           # ㉒ (opt-in ONETHING_GATE_REAL_ACP=1, else one `skipped` line): the REAL claude-agent-acp from the
                           # seed roster, ≤ 6 one-line prompts on your own Claude login — the A6 parity list (A6-a)

# Logs
bun run log:tail           # pretty-print + follow <store>/log/app.jsonl ([--ns engine.*] [--level warn] [--session id])
bun run memory:report      # memory usage of the running core, per process and per cache ([--json] [--trim [soft]])
bun run log:smoke          # real-machine gate: boots dist/server on a temp store, asserts server.jsonl

# Evals
bun run evals              # bun evals/run.mjs
bun run evals:diagnose     # scripts/diagnose-weekly.mjs
```

**两份锁文件,各有权威**:`package-lock.json` 是打包的权威——package.json scripts 全走 npm、
electron-builder 的 node-module-collector 按锁文件探测包管理器(07-29 "bun collector 打包缺依赖"的变通);
`bun.lock` 只服务日常 dev/test 执行。两份都提交,不是误跑残留。
**bun 必须用提升式布局**(`bunfig.toml` 钉 `linker = "hoisted"`,09-03 立):bun 1.3 对带 workspaces 的仓缺省走隔离式(pnpm 式 `node_modules/.bun`),根目录不放 `@onething/*`,而 apps/desktop-react 与 apps/web 不是 workspace 成员、靠向上解析,隔离式下 esbuild 直接报 `Could not resolve @onething/backend/...`。别删 bunfig.toml。
(2026-09-03:第三条理由「`npm rebuild better-sqlite3` 是 test/postinstall 硬依赖」随 better-sqlite3
退役一起没了 —— 今天的 `postinstall` 只剩 `fix:node-pty-perms`,`test` 直接 `vitest run`。)

**Node 版本**:`.nvmrc` = `24`(Electron 41 内嵌的就是 Node 24.14 / ABI 145,开发机与桌面运行时同一个大版本);
`engines.node` = `>=22.13 <26`,地板 22.13 是 `node:sqlite` 免 `--experimental` 标志的第一个版本。

**换过 Electron 二进制之后,第一次起桌面必须是「人手起、并在钥匙串弹框上点允许」**
(2026-09-03 换核时实测挖出来的,不是理论):`safeStorage` 是 Keychain 的门面,**绑 app 的代码签名身份**。
`sign:dev:mac` 给 Electron.app 打的是 ad-hoc 签名,换一份二进制就是换一个身份,于是同一条
「onething Safe Storage」钥匙串条目的 ACL 不再匹配 → macOS 弹授权框。**脚本起的进程没人点那个框,
于是 `safeStorage.isEncryptionAvailable()` 永不返回**:表现是 `createOnethingBackend` 停在
`migrateProviderConfigToDefaultSpace()`,进程 0% CPU、不报错、`<store>/log/*.jsonl` 一行都没有、窗口不开。
任何自己装配 backend 的门(React 壳的 `gate:connect` 路径一、`bun run electron:dev`)都会这样挂住。
点过一次「始终允许」之后 ACL 收下新身份,后续脚本启动才正常。
**这不是回归,是 macOS 的凭证隔离在按设计工作** —— 也正是 `apps/desktop-react/electron/main.ts` 文件头
「子进程是另一个 app 身份,safeStorage 的密文它解不开」那条判例的同一个机制。

Dev ports: React desktop renderer dev server **5175** (`app:dev`), browser shell **5174** (`web:dev`). The core HTTP/SSE port is **dynamic** since A 期 (`docs/design/one-core-2026-08.md`): whoever serves the store writes `<store>/run/http.json`, and the web lane's dev `/api` proxy (`apps/desktop-react/vite/dev-api-proxy.ts` for the React browser shell, `apps/web/dev-api-proxy.ts` for the retiring Vue one — a plugin, because vite's built-in proxy pins its target at creation) re-reads that file per request and injects the Bearer token, falling back to `ONETHING_API_URL` || `http://127.0.0.1:8787`. `bun run dev` with the electron lane does NOT start a second server process — the desktop is the core.

## Architecture Overview

This is **onething**, an AI chat app with multi-provider support, tool calling, and an event-driven streaming engine. The product lives in packages; the apps are thin sockets. **One server package, one contract tree, one client SDK** since the server / client split (`docs/design/server-client-split-2026-10.md`): `@onething/backend` (`packages/backend`) is the **one server package**; `packages/shared` (`@shared`) holds only the server ↔ client contract plus the pure logic both sides must compute identically, and imports nothing but itself (no node, no `@onething/*`); `packages/backend-client` (`@onething/backend-client`) is the client SDK, the one way a UI talks to the backend; the headless process shell is `apps/backend-server` (`@onething/backend-server`) — both renamed on 2026-10-04 from `packages/client` (`@onething/client`) and `apps/server` (`@onething/server-host`), decision D120 (N7: a name says what the thing is; the build output `dist/server/` and the `server:*` script names did not change). Client code (`apps/desktop-react/src`, `apps/mobile`, `packages/backend-client`) imports only `@shared/*` and `@onething/backend-client` — both enforced by zero-baseline boundary gates.

**Inside the server package there are no layers** (user rulings 2026-10-02/03, `docs/design/server-client-split-2026-10.md` §4). `packages/backend` is two things:

- **the package root** — the backend's entry points and faces: `backend.ts` (`createOnethingBackend`, the single assembly recipe) / `backend-assemble-engine.ts` / `backend-current.ts` / `backend-host-ports.ts` / `backend-shutdown.ts` (the shutdown phases and resource registry; `lifecycle.ts` until 6a, renamed so it no longer sits beside the feature directory `lifecycle/`) / `backend-types.d.ts` + `http-server/` (the HTTP server the UI connects to — routes, SSE, discovery file, caller identity and local trust, request abort, lifecycle, desktop embedding, the server runtime and `http-server-runtime-facade.ts` (the `OnethingRuntimeFacade` contract every host face serves), and the **client-api roster** `http-server-client-api-roster.ts` + dispatch table `http-server-dispatch-table.ts`; entry `http-server/http-server.ts`, exports key `./http-server`; 包根归位 A 2026-10-04, decisions D63–D75) / `__tests__/` (cross-cutting tests, including `architecture-boundaries.test.ts`) — **and nothing else** since 包根归位 B (2026-10-04, decisions D76–D88): `channel/` went to gateway (`gateway/gateway-channel-*.ts`, `gateway-outbound-reply-dispatcher.ts`; the message-origin helpers to agent-loop's entry, the IM connector registry to plugins' entry), `features/` became the feature `feature-registry/` (the mount base, L2) with self-evolution as `toolkit/toolkit-client-api-self-evolution.ts` and trajectory folded into the sessions-events roster row (id still `trajectory`), `utils/` went to its users (`deep-freeze` → sessions, the ripgrep app-fetch step → files, `fuzzy` / `wildcard` deleted — zero callers), and the compatibility barrel `store.ts` is deleted: code imports the sessions / settings entries, and the 59 whole-block `vi.mock('…/store.js')` doubles now target those entries with `importOriginal` spread.
- **`<feature>/`** — **one feature, one directory, flat**, directly under `packages/backend/` (the `runtime/` layer was removed by 6a, 2026-10-04; directory names are singular nouns, N5): prompt, session, tool, provider, plugin, engine, agent-loop, gateway, … — every top-level directory except `__tests__/` and `http-server/` is a feature (`NON_FEATURE_DIRS` in `scripts/lib/backend-structure.mjs`). Everything a feature has — what used to be its engine skeleton (`core/`), its product logic and its assembly wiring (`wiring/`) — sits side by side; same-name files were renamed by what they do (tables in the design doc §6), and a fake for a test is a function parameter, not a separate layer. A domain-only kernel may sit in `<d>/kernel/`, an ordinary subdirectory. There are no `*.wiring.ts` files any more: the suffix stopped granting anything with the flatten and was dropped from all 31 files on 2026-10-03 (colliding names renamed by content, e.g. `practice/practice-service-slot.ts`, `mcp/mcp-index-with-bridge.ts`; table in the design doc §6).

How it got here: step ② (2026-10-02) merged the former `@onething/core`, `@onething/runtime` and `@onething/gateway` packages verbatim as subtrees `core/`, `runtime/`, `gateway/`; step ③ folded every domain into one `runtime/<d>/` and deleted `wiring/`; 去 core 批 1–3 (2026-10-03) dissolved `core/` into `runtime/<d>/` (events → `runtime/event-bus`, which 收尾整理 2 then merged with the package root's `events/` into `runtime/events/`; agent → `runtime/agents`, session → `runtime/sessions`, the rest same-name; its big barrel `core/index.ts` was deleted, every import now names the feature directory) and moved `gateway/` to `runtime/gateway/`; 机械改名 6a (2026-10-04, route item 6) then removed the `runtime/` layer itself — every feature directory now sits directly under `packages/backend/` — and renamed the plural feature directories to the singular (N5: `sessions` → `session`, `providers` → `provider`, `plugins` → `plugin`, …; table in `docs/design/server-client-split-2026-10.md` §6). Why: the "zero-dependency skeleton" existed so the UI side could reuse it, and since step ① the UI may only import `@shared` and `@onething/backend-client`; the "wiring" layer existed to put one product into several hosts, and the hosts converged.

What is still enforced: the client → shared ← server boundary; no backend file imports electron / `@main` / `@preload` / renderer aliases (and the feature directories no cordis, except `feature-registry/`); the non-test relative imports of the feature directories stay inside the feature directories (point at the package root's files and `http-server/` with a package specifier); the internal session modules (`scripts/lib/backend-public-boundary.mjs` `privateSessionFiles`: the command door, the read door, the ledger write door and the caches behind them) have no exports key and may be imported only by non-test files inside `session/` — everyone else goes through the sessions entry; I1 — no package-root file or non-feature directory shares a feature's name (6a renamed `lifecycle.ts` → `backend-shutdown.ts` for this); and content rules (kernels name no concrete feature or capability, provider-agnostic code names no vendor). What was withdrawn, with reasons, is listed in the design doc §4.

- **apps/\*** — thin sockets: the React desktop (`apps/desktop-react`, also the browser shell via `--mode web`), server (HTTP/SSE), CLI daemon (`apps/cli`). The Vue host / renderer / web build were deleted 2026-09-04 (runtime unification step ④; `checkVueHostStaysRetired` keeps them out).

```
apps/*  (thin sockets)
┌───────────────┬────────────────┬──────────────┬─────────────────────┐
│ desktop-react │ backend-server │ desktop-react│ CLI daemon apps/cli │
│ (React shell) │ HTTP + SSE     │ --mode web   │ bin/onething.mjs →  │
│ own core+HTTP │ dynamic port   │ browser shell│ dist/cli/main.cjs   │
│ (Electron)    │                │ (dist/web)   │                     │
└──────┬────────┴───────┬────────┴──────┬───────┴──────────┬──────────┘
       │ createOnethingBackend(...)     │ /api → core      │
┌──────┴────────────────┴───────────────┴──────────────────┴──────────┐
│ packages/backend                              ('@onething/backend') │
│  package root: backend.ts (factory) + backend-assemble-engine.ts    │
│  + backend-current.ts / backend-host-ports.ts / backend-shutdown.ts │
│  + http-server/                                                     │
│  hosts inject surfaces via configure*Host ports                     │
│  (no backend file imports electron/@main/@preload)                  │
├─────────────────────────────────────────────────────────────────────┤
│ packages/backend/<feature>/          ('@onething/backend/<feature>')│
│  one feature, one flat directory: prompt, session, engine,          │
│  agent-loop, tool, provider, plugin, gateway, …                     │
└─────────────────────────────────────────────────────────────────────┘
```

(The diagram's "core" in `/api → core` means the running backend process — "one core per store" — not a directory.)

### Monorepo Layout

```
packages/backend/            # THE server package ('@onething/backend'): createOnethingBackend
                             # + the package root (backend.ts, backend-assemble-engine.ts, backend-current.ts, backend-host-ports.ts,
                             # backend-shutdown.ts, http-server/). @shared allowed, electron never.
  <feature>/                 #   one feature, one flat directory directly under the package root (prompt, session,
                             #   engine, agent-loop, tool, provider, plugin, gateway, voice, music, …). core/ (the old
                             #   engine skeleton), wiring/ and gateway/ were folded in on 2026-10-02/03; the runtime/
                             #   layer that held them was removed by 6a on 2026-10-04.
  gateway/                   #   WeChat/Telegram channel gateway: hub/ (Gateway registry, bridge, session
                             #   table, permission coordinator, storage, middleware), channels/, the
                             #   conversation-runtime contract and the lifecycle port. Remote permission
                             #   approval (reply 1/2/3), markdown-safe streaming (was packages/gateway/src).
packages/shared/             # The server ↔ client contract ('@shared'): IPC/RPC router contracts,
                             # event vocabulary, the discovery-file record shape, plus the pure
                             # logic both sides must agree on (session projection, references,
                             # resource refs, effect table, text edit, slash commands, …).
                             # Imports nothing but itself — no node, no @onething/*.
packages/backend-client/     # core 的客户端 SDK ('@onething/backend-client'): Transport (http = fetch +
                             # fetch-stream SSE, Bearer header) + client.api(router) + events hub +
                             # pure model helpers. Node & browser; zero React/Vue/Electron.
apps/desktop-react/          # THE desktop (React) AND the browser shell (`--mode web` → dist/web,
                             # /api dev proxy in vite/dev-api-proxy.ts). electron/main.ts assembles
                             # its own core (createOnethingBackend + createShellHostPorts()) when no
                             # live core serves the store, mounts the HTTP/SSE face (owner 'shell');
                             # the renderer's data plane is HTTP/SSE only (`host:connection` +
                             # `host:native-view` are its two IPC channels, neither a data plane).
                             # electron/browser/ = the built-in browser's main-process half (B1-a).
                             # Not a workspace member (resolves @onething/* upward — bun must stay
                             # hoisted). Has its own CLAUDE.md.
apps/cli/                    # THE CLI daemon (src/ = index/daemon-{client,server}/ndjson/paths/
                             # stdout/plugin-command/trace-command + __tests__). Eats only
                             # @onething/backend + @shared — zero Vue-host edges, which is why it
                             # survives step ④b. Built by scripts/build-cli.mjs → dist/cli/main.cjs.
apps/backend-server/         # Process shell only (main.ts + index.ts). The HTTP/SSE surface
                             # and the server runtime live in the server package
                             # (packages/backend/http-server/), so the Electron
                             # desktop mounts the SAME code over its own backend.
```

### createOnethingBackend — the single assembly recipe

`packages/backend/backend.ts`. Every host boots through `OnethingBackend.assemble(options)` (`createOnethingBackend` is the alias every call site still uses); ordering constraints (variables before tools, engine before Permission) live here and nowhere else. **Importing `@onething/backend` modules performs no configuration** — enforced by `packages/backend/__tests__/import-side-effect-free.test.ts`; since 包根归位 B (2026-10-03) it also **reads no settings and builds no repository**: the session table (`session/session-store.ts`) and the settings store (`settings/settings-store.ts`) build their repository / storage driver / logger on first use behind a `const` holder, and the same test counts those constructors after importing the sessions entry (a module that needs state at load builds it lazily the same way, never in a module-level `let`); **the assembly itself is exercised end to end** by `packages/backend/__tests__/assembly-lifecycle.test.ts` (twelve assertions on a temp store: assemble → dispose → assemble, double-assembly rejection, mid-assembly failure rollback, latch re-registration, the `own()` ledger emptying, host-port restore, and `own()` after dispose running the disposer on the spot).

**`OnethingBackend` is a class, not a bag of globals** (组合根 A, `docs/design/backend-composition-root-2026-09.md`, landed 2026-09-02/03):

- The assembly products are **fields** — `eventBus` / `streamChannel` / `sessionManager` / `engine` / `runtime` / `options` — created by pure factories (`event/event.ts` `createEventSystem()`, `session/session-layer.ts` `createSessionLayer(eventBus, streamChannel)`, the package-root assembly file `backend-assemble-engine.ts` `createStreamEngineLayer({eventBus, streamChannel})`) and passed step to step. The old `initializeX` / `shutdownX` pairs are gone.
- **One process slot, `packages/backend/backend-current.ts`** — the only module-level `let` the assembly layer keeps (`assembly:gate` exempts it). The 121 `getXxx()` accessors (`getEventBus`, `getStreamEngine`, `getSessionManager`, …) still exist but read the **current instance** (`getStreamEngine()` / `getStreamEngineSafe()` live in `backend-current.ts` itself since the engine batch, 2026-10, D57 — whoever needs "the engine right now" reads the slot and never imports the file that builds it); before assembly, or for a field not yet built, they throw `BackendNotAssembledError('<field>')`. Assembling while an instance is live throws `BackendAlreadyAssembledError` on the first line (it used to warn-and-return the first backend's engine). A failed assembly runs the disposers registered so far and clears the slot before rethrowing.
- **`own(disposer, label)` / `dispose()`** — whoever starts something that leaves a tail registers its teardown next to the start line; `dispose()` runs the list in reverse, each disposer in its own try/catch, then clears the list, the five assembly-product fields and the slot. It is idempotent. **`own()` after `dispose()` has started runs the disposer on the spot** (returning its promise, errors logged not thrown) instead of silently dropping it — the guard that keeps a `.then()`-deferred registration racing a fast quit from leaking, e.g. an already-spawned MCP stdio child. `shutdown()` survives as a deprecated alias. `ownedLabels()` is a read-only snapshot for tests. The rule reaches the hosts: everything a host starts after assembly (embedded HTTP surface, user scheduler, watchers, MCP/ACP, gateway) is `backend.own(...)`'d at its start site, so every host's shutdown is one `await backend.dispose()`.

Options (`OnethingBackendOptions`):

- `host: OnethingHostPorts` — **required**; the whole host-capability table in one object (see below)
- `toolRegistry?: 'full' | 'headless' | 'readonly'` — full = every builtin (desktop), headless = reduced set (default when omitted), readonly = zero-local-side-effect tools (server degradation)
- `promptVersion?` — stamp eval traces with live minimal-scene prompt output
- `sessionSkills?`, `collab?`, `mcpAcp?` — opt-in subsystems. **MCP and ACP are subsystem objects owned by the instance** (C1, `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2): `backend.mcp` / `backend.acp` (`mcp/mcp-subsystem.ts` `McpSubsystem`, `acp/acp-subsystem.ts` `AcpSubsystem`; `start()` idempotent, `applySettings()`, `dispose()`, `state`) are constructed during assembly and `own()`'d **at construction**, so their teardown never depends on when — or whether — `start()` finished. `mcpAcp: true` (the CLI daemon) means assembly itself awaits `mcp.start()` / `acp.start()`; every other host calls `backend.mcp.start()` when it is ready (the React shell: post-window; the server runtime: after installing its own client factory). The settings domain routes `updateMCPSettings` / `updateACPSettings` through `applySettings`. `dispose()` waits for an in-flight `start()` and then `manager.shutdown()`, **bounded to 3s per subsystem** (`disposeTimeoutMs`): on timeout it logs `mcp shutdown timed out; continuing dispose` and returns, so the session flushes further down the dispose chain always run — a hung stdio handshake may then leave an orphan child, a deliberate trade (session data outranks an MCP child; the bound sits under the server's 5s SIGTERM deadline)
- `sender?: BindableStreamSender` — `engine.bind(sender)`; EventBus-observing hosts pass a noop (the engine drops commands silently with no sender bound)
- `hooks?: { afterSettings, afterEngine, afterTools }` — each is `(backend: OnethingBackend) => void | Promise<void>`: the instance is handed in **because `assemble` has not returned yet when hooks run**, and a hook that starts a watcher must `backend.own()` it

Boot order (unchanged): `configureAppRuntimeAdapters()` (idempotent) → `applyHostPorts(options.host)` → stores → settings → afterSettings → event system → session layer → StreamEngine (`createStreamEngineLayer`) → triggers (`registerBuiltinTriggers`; both from `backend-assemble-engine.ts`) → afterEngine → `Permission.initialize` → variable system → goal breakers → project dirs → tool registry by tier → RPC domains → afterTools → optional sessionSkills / collab / MCP+ACP / bind. Steps that hold state return a disposer that is `own()`'d on the spot (`registerBuiltinTriggers`, `bootstrapVariableSystem`, `bootstrapGoalStreamBreakers`, `bootstrapProjectDirs`, the RPC table, the ledger broadcaster, the permission/interaction recorders) — 24 registrations in all, of which **9 sit in two explicit reverse-order blocks** (engine/Permission/Interaction, and the six plugins/MCP/ACP/gateway-era rows) because registration order there cannot express today's shutdown order; the eleven `configureApp*` adapter bindings stay idempotent latches by contract — and since providers 归位 (2026-10-04, D24) `configureAppRuntimeAdapters()` also hands the credentials feature's two answers to their users there, as idempotent latches rather than `own()`'d steps (so the owned-labels snapshot is unchanged): `configureProcessAuthTokenStore(createOnethingSpaceTokenStore())` (the process auth service's token store = the space credential pool; first one wins) and `configureModelCatalogCredentials(…)` (which key the model-catalog refresh sends to a custom provider's `/models`).

Host call sites (four; the Vue desktop is retired as a product but still compiles and boots):

| Host | Call site | Config |
| --- | --- | --- |
| React shell (current desktop) | `apps/desktop-react/electron/main.ts` (`assembleOwnCore`; renderer talks HTTP/SSE, two IPC channels — `host:connection` + `host:native-view`) | `host: createShellHostPorts()` — auth / sandbox / storePath / **terminal** / **shell** / settings / dialog / speechOutput real plus `localTrust: { origin: 'desktop-embedded' }`, **nine explicit `null`s** (logging / voice / skillsEnvironment / todoPlan / scratchpad / plugins / gateway / evals / mcp — the shell's capability gap is that list, not a silent omission); `shell` moved out of that list in provider-settings 批 1 (2026-09-26): Electron's `shell.openExternal` (http(s)/mailto only) / `openPath` / `showItemInFolder`, which lifts `hasShellHost()` / `capabilities.shellTools` and backs the `shell` RPC domain the renderer's one link helper `src/platform/open-external.ts` calls; `terminal` moved out of that list in T0 (`dce6c15e`, 2026-09-12) — it is now `{ broadcaster: createEventBusTerminalBroadcaster() }`, which is what lifts `hasTerminalHost()` / `capabilities.terminal` and stops the seven `terminal` RPC verbs from structurally refusing; `toolRegistry: 'full'`, `promptVersion: true`, `collab: true`, `sessionSkills: true`, noop sender; post-window `own()`s the embedded HTTP surface + discovery file, the user scheduler, MCP, ACP (`backend.acp.start()` + `registerACPPermissionBridge()`, 2026-09-24 — before that the shell never started it and every ACP send died on `ACP agent "…" not found`) and (B2, `76d98911`) `installBrowserHost()`; before post-window services it awaits `electron/login-shell-env.ts` (restored 2026-09-24 from the retired Vue host) so a Dock-launched app spawns ACP adapters / MCP stdio / bash with the login shell's PATH; attaches to a live core from `run/http.json` instead of assembling when one exists |
| Headless server | `packages/backend/http-server/http-server-runtime.ts` (`createRealServerBackend` → `createOnethingServerRuntimeOverBackend`) | `host`: sandbox real, `storePath: {}`, fourteen `null`s; `toolRegistry: ONETHING_SERVER_TOOLS === 'readonly' ? 'readonly' : 'full'` (desktop parity by default), `sessionSkills: true`, noop sender (SSE observes the bus directly); its own MCP client factory is installed later by the server runtime per `processPorts`, not through the table |
| CLI daemon | `packages/backend/headless/headless-backend.ts` (`HeadlessBackend`, used by `apps/cli/src/daemon-server.ts`) | same `host` shape as the server (fourteen `null`s); `toolRegistry: 'headless'`, `sessionSkills: true`, `mcpAcp: true`, `collab: true`, noop sender; shutdown = `backend.dispose()` (the hand-written list is gone) |

Note: `backend.ts` carries static `import './tools/builtin/{index,headless,readonly}.js'` edges purely so single-file bundlers order the tool barrels before the factory's top-level await (the registry itself dynamic-imports them for test mocks). Do not remove them.

**Host ports are one table, `OnethingHostPorts` (`packages/backend/backend-host-ports.ts`)** — how hosts contribute Electron-only surfaces without the assembly layer importing electron. Every key is required (sixteen since B3); fourteen accept an explicit `null`, which means "this host has no such capability" and leaves the underlying port untouched (today's structured degrade or noop — `applyHostPorts` simply does not call that `configure*`). Omitting a key is a `tsc` error (`__tests__/backend-host-ports.type.test.ts` pins it). The underlying single-slot `configure*` functions are unchanged; hosts just no longer call them one by one:

| Key | Underlying port | File |
| --- | --- | --- |
| `storePath` (non-null) | `configureStorePathHost` | `backend/storage/storage-docs-paths.ts` |
| `sandbox` (non-null) | `configureSandboxHost` | `backend/tool/access-control/tool-access-control-sandbox.ts` |
| `auth` | `configureAuthHost` | `auth/auth-host-ports.ts` (product layer since P3'a-1 — zero spine deps) |
| `logging` | `configureAppLoggingHost` | `backend/logging/logging-configure.ts` |
| `shell` | `configureShellHost` — also backs the `shell` RPC domain (`@shared/ipc/shell.ts` → `shell/shell-client-api.ts`, 2026-09-26: `openExternal` http(s)/mailto only, `openPath`, `getDataPath`; locally trusted callers only). React shell injects Electron `shell`; server / daemon `null` | `shell/shell-host-ports.ts` (打开路径 / 打开外链 / 在文件管理器里定位;未注入即结构化降级) |
| `voice` | `configureVoiceHost` | `voice/voice-host-ports.ts` |
| `skillsEnvironment` | `configureSkillsEnvironmentHost` | `backend/skill/skill-sources.ts` |
| `todoPlan` | `configureTodoPlanHost` | `backend/todo-plan/todo-plan-service.ts` |
| `scratchpad` | `configureScratchpadHost` | `scratchpad/scratchpad-service-bound.ts` |
| `plugins` | `configurePluginsHost` | `backend/plugin/plugin-host-ports.ts` (native file dialog + plugin-command subprocess runner; unset = structured degrade) |
| `gateway` | `configureGatewayHost` | `backend/gateway/gateway-lifecycle-port.ts` |
| `settings` | `configureSettingsHost` | `backend/settings/settings-host-ports.ts` |
| `evals` | `configureEvalsHost` | `backend/eval/eval-host-ports.ts` |
| `mcp` | `configureMCPClientHost` (only when `clientFactory` is non-null — `null` keeps the built-in `MCPClient`) + `configureMCPClientIdentity` | `mcp/mcp-{manager,identity}.ts` |
| `terminal` | `configureTerminalBroadcaster` (the PTY output push; `hasTerminalHost()` is what the `terminal` RPC domain asks). **React shell injected = the output rides the `terminal:data` / `terminal:exit` global events out over SSE** (T0 `dce6c15e`, 2026-09-12: `createEventBusTerminalBroadcaster()` in `backend/terminal/terminal-bus-broadcaster.ts` calls `getEventBus().emitGlobal` at send time, and warns-and-drops before the event system exists rather than throwing up into `pty.onData`) — no hand-written push channel, because this shell has no room for one. Its restore `await killAllTerminals()` first, which is why `applyHostPorts`'s restore list became async and is awaited one by one | `terminal/terminal-service.ts` (B1, 2026-09-03) |
| `localTrust` | `configureHostLocalTrust` — `{ origin: 'desktop-embedded' }` on both desktop shells, `null` on server (it declares `loopback-server` itself at listen time) and daemon | `backend/http-server/http-server-host-trust.ts` (was `local-trust.ts`; B2/B3) |
| `dialog` | `configureDialogHost` — the native open dialog (pick a directory / file) behind the `dialog` RPC domain (`@shared/ipc/dialog.ts` → `dialog/dialog-client-api.ts`). React shell injects `dialog.showOpenDialog` on the focused window; `null` answers `{ canceled: true, filePaths: [], unavailable: true }` and the renderer falls back to its path-input window (`content/files/open-dir-hub.ts` `requestDirectory` — the one "pick a directory" entry: composer workdir button, Files panel 「绑定…」, 「打开目录…」, terminal 「在目录…新建」, notes folders). Kept apart from `shell` on purpose: `shell` is a latch that flips `capabilities.shellTools` | `dialog/dialog-host-ports.ts` (2026-09-24) |

**Every one of the sixteen is restorable** (C0 R6): each module exports a `reset*` next to its `configure*`, and the restore function `applyHostPorts` returns undoes — in reverse — exactly the slots this assembly actually wrote. `assemble` `own()`s it as `hostPorts`, so `backend.dispose()` puts the process back to "no host has injected anything"; a second backend in the same process no longer inherits the first one's voice / plugins / sandbox ports. `localTrust` keeps its identity-guarded restore (`if (declaration === next)`) and, being registered last, is undone first.

**Deliberately outside the table**: `configureLogging` (the host calls it *before* assembly; it owns the log file and the janitor, which outlive the backend), the window-system ports (`configureGlobalWindowShortcuts` / `configureBrowserWindowProvider` / `configureDeepLinkService` / `configureVoiceTray` / `configurePluginAppVersion` / `configurePluginMarketIndex`), the eleven `configureApp*` internal adapter bindings (plus the two credentials latches beside them, see Boot order), and the three `configureServer*Port` slots the server runtime fills itself.

### Guardrails

- `bun run boundary` — `scripts/headless-boundary-check.ts`, the heavy static checker. Key rule sets: the feature directories `packages/backend/<feature>/` ban electron / `@main` / `@preload` / renderer aliases / cordis (`feature-registry/` may use cordis), the package root (its files, `http-server/`, `__tests__/`) the same minus cordis (hosts inject via configure*Host ports); `@shared/ipc` is allowed everywhere in the backend. Retired, with reasons in the design doc §4: the runtime `@shared/ipc` ban and the `*.wiring.ts` exception (2026-10-02 flatten; the suffix itself was dropped from all 31 files on 2026-10-03, colliding names renamed by content — table in the design doc §6); everything that treated core or gateway as a layer — core's own bans (`shared/ipc` / better-sqlite3 / mcp+acp SDKs / zod / diff / uuid), the `runtime/*/kernel` import closure, core's third-party allowlist, "core's barrel must export X", "gateway depends on core + `@shared` only", the "no `packages/backend/{core,gateway}` in a specifier" rules (去 core 批 1–3, 2026-10-03). `packages/shared` imports only itself (`checkSharedImportsOnlyShared`, no exemptions) and the client side imports only `@shared/*` / `@onething/backend-client` / itself (`checkClientImportsOnlySharedAndBackendClient`).
- `bun run boundary:gate` — `scripts/boundary-gate.mjs`, a **zero-baseline hard gate**: any `[boundary] failed:` line exits 1. The ratchet and `docs/audit/boundary-baseline-2026-08-07.txt` (13 known legacy reds) were retired 2026-08-21 by 结构债方案 P2 — 4 reds were fixed in source, the other 9 were stale/false-positive assertions and were fixed in the checker. Two anti-footgun guards survive: no `[boundary] complete:` marker (checker crashed mid-run) or no `[boundary] ok:` line at all (output shape changed) is red, not green.
- UI 组件与样式规则:通则见 `docs/design/ui-system.md`(浮层决策树、交互态配方、z-index 层级表、禁令清单),**React 壳自己的施工规范与判例在 `apps/desktop-react/CLAUDE.md`** —— 那是今天唯一的壳。`bun run ui:gate` / `ui:check` 与它们背后的 `scripts/ui-gate.mjs` / `scripts/ui-style-check.mjs` 及基线 `docs/audit/ui-baseline-2026-08-13.txt` **已随 Vue 宿主一起退役**(2026-09-04,`50ff9cbd`;根 `package.json` 里 `ui*` 脚本为零)——那 12 条规则扫的是 `.vue` 文件。今天的 UI 执法全部在 `apps/desktop-react` 下:静态棘轮 `npm run ui:consume`(基础件消费门,`scripts/ui-consume-gate.mjs` over `ui-consume-check.mjs`,基线 `docs/audit/ui-consume-baseline-2026-09-01.txt`;响应链三条 `keydown-outside-focus` / `focus-outside-focus` / `active-element-read` 是**零基线硬闸**)、`npm run squeeze-gate`(基线 `docs/audit/squeeze-baseline-2026-08-30.txt`)与 `npm run motion-gate`(基线 `docs/audit/motion-baseline-2026-08-31.txt`);真机门 `npm run gate:squeeze` / `gate:a11y` / `gate:motion` / `gate:focus`,四条都已进 `npm run verify`。**同名的门有两半就跑两半**——真机量重叠,棘轮抓源码违例。
- `bun run log:gate` — `scripts/log-gate.mjs` ratchet over `scripts/log-check.mjs`: counts `console.*` call sites in non-test source, baseline `docs/audit/log-gate-baseline-2026-08-20.txt` (854 at L1; **822** after the L2/L3 gateway + crash-log migration; L4 消掉其余). Whitelist: `scripts/` and the CLI's product-output helper `apps/cli/src/stdout.ts` (**给人/管道看的 = `stdout()`;给排障看的 = `getLogger(ns)`**). New code must not add a `console.*` — use `getLogger`.
- `bun run provider:gate` — `scripts/provider-vendor-gate.mjs` ratchet (服务商自述试点 P0): counts (vendor, file) pairs where a builtin vendor's id appears — as a string literal, object key or inside an identifier, parsed with the TypeScript parser so comments never count — outside its own `provider/vendors/<id>/`. Exempt: the two rosters, the shell's i18n / icon files, `provider/model-families/`, protocol names (`openai-chat`, `gemini-generateContent`, …), model-id regex literals, model paths (`openai/gpt-4o`), HTTP header names. Baseline `docs/audit/provider-vendor-baseline-2026-10.txt` (111 pairs; what is left and why: the design doc §4b). **Decrease-only**; `bun run provider:check` lists them. `bun run provider:drill` adds a fictional vendor in a throwaway worktree and asserts the only files touched outside its folder are the two rosters and the shell's two i18n files.
- `bun run client-api:gate` — `scripts/client-api-gate.mjs`, zero-baseline hard gate (D26 / D68, 2026-10-04): a feature's second entry `<f>/<f>-client-api[-<aspect>].ts` (its UI-facing roster rows, plus projections / deliveries only the HTTP server uses) may be imported only by `packages/backend/http-server/`, the same feature's other client-api files, and tests — the exception table is empty since 包根归位 B (trajectory became a sessions roster row; ACP's adopt / fork now uses `session/session-caller-ops.ts` from the sessions entry instead of importing the sessions client-api). A file in a feature directory whose name contains `-client-api` but does not match that shape is red (until 6b renames files, a singularized directory also accepts its old plural prefix, e.g. `session/session-client-api.ts` — `LEGACY_FILE_PREFIX` in `scripts/lib/backend-structure.mjs`); fewer than 40 client-api files is red (anti-false-green). `--list` prints each file's importers, `--self-test` checks the ruler.
- `bun run assembly:gate` — `scripts/assembly-gate.mjs` ratchet (组合根 A3, 2026-09-03): counts module-level `let` per non-test file under all of `packages/backend` — the package root and every `<feature>/`, kernel subdirectories included (until 去 core 批 3 it skipped `core/`, `gateway/` and `runtime/<d>/kernel/`; every file that entered the ruler since was recorded at its value then — 去 core 批 1 / 2 / 3: 3 / 2 / 3 files, 5 / 2 / 5 `let`s), baseline `docs/audit/assembly-baseline-2026-09-02.txt` (99 across 63 files at A3; `packages/backend/backend-current.ts` is the one exempt slot). **Decrease-only**: a file above its baseline or a file not in the baseline is red. `bun run assembly:check` prints the full table; `--write-baseline` tightens it after a real drop. The intent is that new assembly-scoped state lives on the `OnethingBackend` instance and is `own()`'d, never in a fresh module slot.
- **功能入口**(用户拍板 2026-10-03,`docs/design/server-client-split-2026-10.md` §4):每个功能只通过自己的入口 `packages/backend/<功能>/<功能>.ts`(命名规范 N3,6b 之前叫 `index.ts`;说明符 `@onething/backend/<功能>`)对外交出能力;功能目录里其余文件是内部实现,功能目录之外(包根、别的功能、apps、scripts、evals)不许直接引用,目录里的文件互相按相对路径 import。读一个功能,先看它的入口就知道它对外给了什么。棘轮是 `bun run entry:gate`(`scripts/feature-entry-gate.mjs`):逐功能数「从功能目录之外引用入口以外文件」的 import 处(`import` / `export … from` / 动态与类型位置的 `import()` / `require` / `vi.mock` 一族都算,用 TypeScript 解析器取,包说明符先按 exports 精确键解析到文件再判);从前引用总桶 `runtime/index.ts` 单记一行 `(总桶)`,总桶 2026-10-04(6a)删掉后这一行撤了;基线 `docs/audit/feature-entry-baseline-2026-10.txt`,**只许降**,`bun run entry:check` 打全表(加 `--verbose` 或功能名打逐处引用)。立尺时全仓 2693 处,search 收口后 2685;search 是第一个收口的功能(剩 2 处,都是构建 / 门脚本:`scripts/gate-embed-runtime/entry.ts` 引嵌入运行时、`scripts/lib/search-corpus-redact.mjs` 引脱敏规则表,理由见正本 §6);sessions 第二个(2598,剩 1 处:索引 Worker 里的 `search/index/search-index-ledger-feed.ts` 直取 `session/events/session-events-codec.ts`,免得 Worker 背上整个会话入口)。
- **入口无环**(决策 D19,`docs/design/backend-structure-decisions-2026-10.md`):`bun run cycle:gate`(`scripts/feature-cycle-gate.mjs`)是**零基线硬闸** —— 在运行期值引用图上(只引类型的名字、`import type`、动态 `import()`、测试文件都不成边;口径在 `scripts/lib/backend-structure.mjs` 文件头,与 Fable 的模拟器逐边一致)算强连通分量,任何一个含功能入口 `<功能>/<功能>.ts`(命名规范 N3;2026-10-04 机械改名 6b 之前叫 `index.ts`,过渡期两种形状并认的判法 D31 随 6b 删掉)的分量即红,并打出经过该入口的最短环。理由是 10-04 providers 的崩溃:入口卷进加载期的环,`class extends` 在加载期读到 undefined,继承没法惰性化。不经入口的深层环只打大小不判红(立门时 17 / 5 / 3 / 2);`bun run cycle:check` 另打它们的成员。
- **层次**(决策 D23):`bun run layer:gate`(`scripts/feature-layer-gate.mjs`)读层次表 `docs/audit/feature-layers-2026-10.json`(L0 基础件 / L1 领域事实 / L2 能力 / L3 编排 / L4 对外接口;每个功能一行 `{feature, layer, why}`,包根与 shared 按路径分进槽位行),判同一张值引用图上「低层引高层」的边。基线 `docs/audit/layer-violation-baseline-2026-10.txt` 按「从功能 → 到功能」成对计数,**只许降**(立门时 139 条 / 61 对;providers 归位后 97 条 / 53 对);**层次表里没登记的功能直接红** —— 新功能先登记一行定层次,再写代码。`bun run layer:check` 打每一对与其中的边。同一张表生成 R4 的功能地图 `docs/architecture/feature-map.md`(`bun run feature-map`;`bun run feature-map:check` 判它与代码一致,不一致 = 红,在 CI 里)。
- **文件名唯一**(命名规范 N1,决策 D22):`bun run name:gate`(`scripts/file-name-gate.mjs`)扫 `packages/backend` 下非测试 `.ts` 文件,四条一起判:文件名重复(N1)、任何 `index.ts`(N3:入口叫 `<功能>.ts`,功能子目录叫 `<功能>-<子目录>.ts`)、泛名单独作文件名(N4:index / types / utils / helpers / service / manager / runtime / registry / store / core / common / misc)。立门时是只减不增的棘轮(132 个重复名,`index.ts` 98、`types.ts` 36 ……);2026-10-04 机械改名 6b 清到 0 之后**改成零基线硬闸**,基线文件 `docs/audit/file-name-baseline-2026-10.txt` 删掉 —— 任何一处命中直接红。第四条(2026-10-04 机械改名 6c 加,决策 D112–D119)是 N2 **功能名打头**:文件名恰好是、或以「<词>-」开头,<词> 由 `scripts/lib/backend-structure.mjs` 的 `fileNameOwners` 给 —— 功能目录(含子目录)里是功能名,包根散文件是 `backend`,`http-server/` 里是 `http-server`,集合目录 `provider/vendors/` / `gateway/channels/` / `music/providers/` 的条目里另外认条目名(`claude-dialect.ts`);没有豁免表。新文件按 N2 起 `<功能>-<做什么>.ts`(测试跟着被测文件叫 `<被测文件名>.test.ts`,N6)。`bun run name:check` 打全表与路径。
- `bun run gate:native` — `scripts/gate-native-abi.mjs`, the running half of the **原生模块只许 N-API** law
  at the top of this file. It enumerates every native binary this repo actually ships — **seven targets**
  today (the line said six until 2026-09-17; `fsevents`, the optional macOS workspace-watch dependency,
  joined in `0d722b38c` and the count here was never updated): `fsevents`, `node-pty`,
  `sherpa-onnx-node` + its platform package,
  the `sqlite-vec` platform package (`vec0.dylib`, semantic recall), and the two natives
  `@huggingface/transformers` drags in (`onnxruntime-node`, `@img/sharp-<platform>-<arch>`) —
  since 2026-09-17 **the Worker really loads `onnxruntime-node` whenever semantic recall is on**
  (the embedder pins `device: 'cpu'`; see the semantic-recall note below), `sharp` is still never
  loaded, **and the law judges what is actually installed/shipped, not what is used**, so both stay
  on the table either way. For each binary:
  (a) `require`s it under the **system Node**
  and again under **`ELECTRON_RUN_AS_NODE=1` Electron** — a `NODE_MODULE_VERSION` mismatch prints the
  runtime's own words and turns the gate red — and (b) on macOS runs `nm -u` over it: any undefined
  `_v8…` / `node::…` / `_ZN2v8…` symbol is a V8-ABI-private binding and is red on the spot (the static
  half; on non-macOS it is skipped with a printed reason). **A SQLite loadable extension gets a different
  ruler on both halves**: the dynamic one is `new DatabaseSync(':memory:', { allowExtension: true })
  .loadExtension(path)` plus a real `select vec_version()` (loading is not enough, it has to work), and
  the static one allows only `sqlite3_*` and libc symbols — an extension talks to its host through the
  `sqlite3_api` struct, so it imports no `napi_*` at all (`vec0.dylib` reads: 21 undefined symbols, all
  libc). `--json` prints the machine-readable table.
  Adding a native dependency means passing this gate — the ABI claim never lives in a comment again.
- `bun run gate:embed-runtime` — `scripts/gate-embed-runtime.mjs`, the same law one step further in:
  `gate:native` proves a `.node` **loads** under both runtimes, this one proves the embedder still
  **finishes a real workload** under both. 起因 2026-09-18:桌面一天崩四次,根因是 ORT 的 CPU 内存池
  (`BFCArena`)扩容翻倍且从不归还,变长批次几批之内就要 `posix_memalign(2GiB)` — 系统 Node 的
  malloc 照给,Electron 的 PartitionAlloc 在那一档直接 SIGTRAP 掐进程(exit 133,原生 trap,JS 的
  crash hook 一行都写不出)。修法是 `search-embedding-transformers-onnx.ts` 的 `PIPELINE_OPTIONS.session_options`
  里那一格 `enableCpuMemArena: false`,而这道门就是它的活口。它用产品主进程同一份 esbuild 配方
  (`shellEsbuildOptions`,原生相关 external)把 `scripts/gate-embed-runtime/entry.ts` 打成一份临时
  单文件产物 —— **入口只 import 产品自己的 `createTransformersOnnxEmbedder`,不抄一份 pipeline 选项**,
  抄一份就守不住那一格 —— 然后在系统 Node 与 `ELECTRON_RUN_AS_NODE=1` 的 Electron 下各跑 40 批
  ×32 条变长中文文本(定种 LCG,两个运行时逐字同输入)。两条判据:任一运行时非零退出即红(SIGTRAP /
  133 被点名),**且 Electron 下峰值 RSS 超过 800MB 即红** —— 后者是提前量,没修那一版在翻到 2GiB
  之前就已经一路涨过 1.2GB,而修好之后实测 ≈300MB。模型只读 `<store>/models/embeddings/
  multilingual-e5-small`(`ONETHING_GATE_EMBED_MODEL_DIR` 可覆盖),不下载、不联网、不写盘;目录
  不在或 `node_modules/electron` 不可用就 **skipped + exit 0**,口径同 `gate:native` 跳过静态半边
  与 `gate:search-index` ⑫ 的 opt-in,跳过那一行打得很显眼。
- `packages/backend/__tests__/architecture-boundaries.test.ts`: the feature directories are Electron/host-free; **the feature directories' non-test relative imports stay inside the feature directories** (the directory form of the old package boundary; the one carve-out is → the internal session modules, which by rule have no exports key); **I1 — no package-root file or non-feature directory shares a feature directory's name** (before 6a, 2026-10-04: no root directory shadowed a `runtime/` domain; the thick-twin allowlist has been **empty** since P3'c, and the assertion stays as a ratchet); the provider-agnostic layers (`{agent-loop,engine}/`) name no vendor; apps/backend-server is Electron-free. Retired (design doc §4): "core free of hosts" / "core at the bottom" / "kernel at the bottom" / I2 (core vs runtime same-name files) / "gateway depends on core + `@shared` only" / "runtime does not import gateway" (去 core 批 1–3, 2026-10-03) and "runtime must not import the spine" (2026-10-02 flatten); (the Vue renderer / apps/web rules died with them on 2026-09-04).

Notes:

- **Logging** (L0–L3 landed 2026-08-20, `docs/design/logging-system-2026-08.md` §7;
  current-state audit: `docs/audit/logging-inventory-2026-08-19.md`). One facade, one
  record shape, one governor:
  - `packages/backend/logging/` holds all of it (core's half moved in on 2026-10-03).
    The kernel files (`types` / `level` / `error` / `compat` / `port` / `logger` / `sinks`, barrel
    `logging-logger-primitives.ts`; zero deps, zero node imports) own `Logger`
    (`trace/debug/info/warn/error/fatal/child(fields)`), `LogRecord
    {time, level, ns, msg, fields?, err?, src?}`, `LevelFilter`, `ConsoleSink(pretty|json)`,
    `MemoryRingSink`, `normalizeError`. The **mechanism** (JsonlFileSink /
    RollingFileLogger / LegacyConsoleSink / janitor / crash-hooks / legacy-debug-env)
    is Electron-free and sits in the same directory next to the `getLogger` facade
    (`logging.ts`); `logging-configure.ts` assembles it: **`configureLogging()` is the single wiring point** (idempotent — the
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
  - **Renderer logs ride their own hub, not a console side-effect** (L3; the React shell's copy is
    `apps/desktop-react/src/services/log.ts`, the Vue original died 2026-09-04): `getLogger(ns)` over a `RendererLogHub`
    (memory ring 200, dev-only pretty echo, batched transport every 16ms / 50 records,
    `beforeunload` + `fatal` flush immediately). The Vue original reused the main process's own logging
    kernel; the React shell's hub is a small zero-dependency module of its own (client code may only
    import `@shared` / `@onething/backend-client`), not the kernel files in `packages/backend/logging/`. Transport is the generic
    RPC envelope, **not** a hand-written channel: `logs` is a router domain
    (`@shared/ipc/logs.ts` + `backend/logging/logging-client-api.ts` + `platform/logs-client.ts`), so
    desktop rides `rpc:invoke` and web rides `POST /api/rpc` behind the same Bearer gate,
    with zero shell edits. The receiving handler stamps the trust-level fields itself:
    `ns` prefixed `renderer.`, `src='renderer'`, caller from the dispatch context — a
    sender never gets to say who it is. `services/crash-log.ts` keeps its four capture
    points, its localStorage ring and `window.__onethingCrashLog.dump()`, but is now a
    *producer* on the hub: one structured record per entry, Vue warns deduped to **one**
    `warn` with `fields.stack`, and no console line at all.
    `window.__onethingLog.dump()` is the hub's own crash-scene口.
  - **The gateway takes a logger at construction** (L2): `startGateway({ getLogger })`
    (same signature as `@onething/backend/logging/logging-configure`'s `getLogger`) — the Electron host passes
    its own, so gateway records land in `app.jsonl` under `gateway.wechat` /
    `gateway.telegram` / `gateway.bridge` / `gateway.storage`. Classes take an explicit
    `logger?`; free functions read the process-level factory
    (`packages/backend/gateway/hub/gateway-hub-logging.ts`). Nothing injected = a `LoggerRoot + ConsoleSink`
    fallback, so `packages/backend/gateway` has **zero** `console.*`.
  - **The CLI daemon writes `daemon.jsonl`** (L2): `runDaemonServer` calls
    `configureLogging({ fileBaseName: 'daemon', src: 'daemon' })` before anything else,
    so it gets the janitor and the crash hooks like every other host. `daemon.log` survives
    only as the fd the spawn redirects **stderr** to — the pre-configure crash catcher;
    stdout is no longer redirected (it would double-record). `onething daemon logs` prefers
    `daemon.jsonl` and falls back to `daemon.log`.
  - Migration-era leftovers: `LegacyConsoleSink` still captures raw `console.*` +
    stdout/stderr as `ns='console'`, `fields.legacy=true`, `fields.callsite` (that stream
    *is* the L4 to-do list); the Electron `console-message` renderer capture is a
    **fallback** only — warn+, structured fields, multi-line Vue warns collapsed into one
    record with `fields.stack`, and hub echoes dropped on sight (they carry a zero-width
    `RENDERER_LOG_ECHO_MARK`, so the fallback never double-records what the hub already sent).

- Session persistence is file-based, one directory per session:
  `sessions/<id>/meta.json` (session shell + log index — **the only file the repository
  still writes through the storage driver**), `sessions/<id>/events.jsonl` (**the ledger —
  the only persisted session history**), a content-addressed `sessions/<id>/blobs/` for
  anything over 64KB, and, for sessions born before 2026-08-26, a read-only
  `messages.jsonl` fossil (paging / user markers / the `history` tool / `verify #6` still
  read it; sessions born later have no such file and those readers return `undefined`).
  Legacy whole-file `sessions/<id>.json` is migrated **synchronously on first touch**
  straight into `events.jsonl` (`migrateLegacySessionNow`, one `message/imported` per
  message; originals kept in `sessions/legacy-backup/`). `settings.storage.sessionFormat`
  ('jsonl' default | 'legacy-json') only decides the format of *new* sessions. Hybrid
  driver: `packages/backend/session/session-storage-driver.ts`; pure jsonl
  codec/pager in `packages/backend/session/storage/jsonl/`. See
  `docs/design/session-storage-jsonl.md`.
- **Cross-session search runs off a derived index, in a Worker** (检索重建 S3,
  `docs/design/search-index-2026-09.md`; the old line here said indexing belongs in
  apps/backend-server and that the Electron main process must not add a database — that ruling
  was replaced on 2026-09-05, and the reason it stood was the ABI hazard, not the idea).
  The index is a **projection of the ledger**, never a source of truth: `<store>/index/
  search.v1.sqlite`, built by folding `sessions/<id>/events.jsonl` through
  `IndexProjector`. Delete the file and it rebuilds itself; nothing else reads it.
  Three facts make it legal where better-sqlite3 was not: the engine is the **built-in
  `node:sqlite`** (zero native dependencies, so the N-API law at the top of this file has
  nothing to bite on), the database handle lives **only inside a `worker_threads` worker**
  (`node:sqlite` is synchronous — on the main thread a cold build would freeze the desktop
  for seconds, exactly the 09-03 stream-freeze disease), and the main thread's whole share
  is one `postMessage` per changed session. Every host runs the same worker
  (`search-worker.cjs`, one per build recipe, always beside its host entry). `search.status`
  over `POST /api/rpc` reports `mode` / `pending`; `bun run gate:search-index` proves it on
  a real `dist/server`.
- **There is exactly one query path** (检索重建 S5, 2026-09-05): `search` RPC domain →
  the process slot's `SearchService` → capability registry → the capability. The old
  scanning path — `executeOnethingSearch`'s `switch(category)`, its `all`-tier quota table,
  the `ONETHING_SEARCH_CATEGORIES` literal list and the six scanners behind it — is
  **deleted**, and so are the two reconciliation gates that compared against it
  (`search:parity-A` / `search:parity-B`: their reference no longer exists, so they were
  not "still runnable gates" but a lie). What they guarded is now a snapshot test,
  `search/__tests__/golden-snapshot.test.ts` — the S0 corpus folded into a real
  `SqliteIndex`, and the **strict-tier hit set** of the 20 golden queries + 20 golden
  paraphrases frozen as JSON. What survives of the old path lives where it belongs:
  each capability owns its own matcher (`capabilities/search-capabilities-{actions,prompts,files}.ts`), the
  notes capability (`capabilities/search-capabilities-notes.ts`, 笔记 P2 2026-09-18 — it replaced `daily.ts` +
  `daily-notes.ts`: one `VaultFeed` per enabled note vault, facets `vault` / `path` / `time` /
  `daily`, the "today" shortcut and the `create-daily` / `create-note` page actions, all read
  off the notes domain below) and
  `capabilities/search-capabilities-scan-adapter.ts` (was `legacy.ts`) is just the base that wraps a
  `(query, limit, filters) => SearchResult[]` matcher. `search/search-providers.ts`
  is now only the adapter interface (`getNoteVaults?` / `getPrimaryNoteVault?` are how the
  notes domain reaches it). The boundary rule
  `search has exactly one query path` is the coroner's table: those shapes and names may
  not grow back.
- **Semantic recall is a second retriever on the same index, and it is OFF by default**
  (检索重建 S7, 2026-09-05; `docs/design/search-index-2026-09.md` §15). The index base
  holds a **list** of retrievers, not a function: `[lexical, vector]` fused by RRF (k=60),
  and **which of them runs on a given call is data** — each capability declares
  `manifest.retrievers[<retrieverId>] = { when: 'relaxed' | 'explicit' | 'always' }`, so
  `packages/backend/search/kernel` never names a retriever, a capability, or a surface. The vector
  half is `sqlite-vec`'s `vec0` virtual table inside the **same** `search.v1.sqlite`, one row
  per 512-token chunk, plus an `Embedder` registry (`search/embedding/`) whose real
  entry is `@huggingface/transformers` on the **onnxruntime-node (cpu)** backend, dynamically
  imported inside the worker.
  **The switch and the model download are two separate things** (2026-09-17, §15.8 — user: "把开关和
  下载模型拆开,另外下载模型要能够知道进度"). Turning the switch on no longer downloads anything:
  the embedder's `ready()` asks a manifest on disk first and throws `embedding model files are not
  downloaded` (reason code `'model'`) without so much as an `import()`, and then loads with
  `allowRemoteModels = false`. The model is a thing with its own state and its own three verbs —
  `search.semanticModel{Download,Cancel,Remove}` over the generic RPC, state and byte counters on
  `search.status.model` (`absent` / `downloading` / `ready` / `failed`). It downloads **inside the
  index Worker** (that thread already has the managed fetch and the log relay) through the library's
  own mechanism, cancels by way of `WorkerDownloadSignal` wrapping that thread's `globalThis.fetch`
  (transformers has no signal parameter), and when it lands the Worker posts an id-less notify frame
  so `search/search-service-setup.ts` swaps the Worker — **a finished download takes effect without the user
  touching the switch again**. "Downloaded in full" is judged by a manifest written *after* the
  download settles (`embedding/search-embedding-model-store.ts`), never by "the files are there": transformers'
  `FileCache.put` writes straight to the final path, so a killed process leaves a truncated `.onnx`
  that a file-existence check would happily call complete. Same reason the empty-vector-table case
  re-queues: a Worker that wrote the header and then turned itself off must not make the next one
  think the index is already embedded.
  **That switch is hot-applied** (2026-09-17): `search/search-service-setup.ts` chains onto the
  `settings:changed` broadcaster and calls `handle.applySemantic(settings)`, which replaces
  the index Worker when the effective value changed (same value = identity). The swap stops
  the old Worker before starting the new one — two Workers on one `search.v1.sqlite` are two
  writers — and requests arriving in the gap **queue instead of failing**
  (`IndexWorkerHost.restart()`); the lexical index file is untouched and `vec_docs` survives
  a switch-off. The shell surface is the settings page's 「搜索」 page
  (`apps/desktop-react/src/content/settings/SearchSettings.tsx`). `gate:search-index` ⑩
  proves it on a real `dist/server` (31ms to leave `'off'`, 29ms back).
  **The model download rides the app proxy, and the Worker's log lines reach the host file**
  (2026-09-17, §15.7 — 09-17 user incident: the switch was on, `network.proxy` was on, provider
  calls worked, and the model still downloaded zero bytes while the status line said "the reason
  is in the log" — a lie, because nothing in that Worker had ever reached a sink). Three fixes:
  `semantic.proxy` rides `workerData` and `installWorkerProxyFetch` swaps that thread's
  `globalThis.fetch` for the **same** managed fetch providers use (`network/network-managed-fetch.ts`,
  taken from the network entry; bypass rules, dispatcher and SOCKS5 are one implementation, not two; changing the proxy swaps the Worker like changing the
  switch does); `installWorkerLogging` posts every `LogRecord` to the host, which re-emits it under
  the same `ns` with one extra `fields.thread='search-worker'`; and `status.vectorError` carries the
  reason to the settings page. Two mechanics worth not re-discovering: `init.dispatcher` on Node's
  **global** fetch does not work with npm undici 8 (`invalid onRequestStart method`) — it has to be
  `undici.fetch`; and the answer must be re-wrapped into a **global** `Response`, because
  transformers gates its disk cache on `response instanceof Response`. `gate:search-index` ⑪ proves
  both halves on a real `dist/server` without downloading anything.
  **The embedder runs on `device: 'cpu'`, and that is a fact about the library, not a preference**
  (§15.7b/c, found by that same fix and closed the same evening): S7 pinned `device: 'wasm'`, but
  `@huggingface/transformers`'s **node** build binds ONNX to `onnxruntime-node`, whose macOS device
  list is `['cpu']` (3.8.1, `dist/transformers.node.mjs` lines 2934–2957) — so `wasm` had never been
  reachable on any host here, and S7's gates never caught it because they run the fake embedder.
  Route 1 of the three was taken: `transformers-wasm.ts` → **`search-embedding-transformers-onnx.ts`** with
  `device: 'cpu'` and `session_options.intraOpNumThreads = 1` (the wasm `numThreads` knob is dead on
  the node build). The registry id (= the settings `modelId`) is unchanged. **The packaged desktop is
  unaffected**: `electron-builder.yml` excludes transformers and both onnxruntime packages (拍点癸',
  route (c)), so it still answers `vector: 'off'` and degrades cleanly — semantic recall really runs
  on dev / server / CLI. `gate:search-index` ⑫ is the gate for it, opt-in because it downloads 130MB:
  cold 191.5s to `ready`, warm 1.0s, and two zero-word-overlap paraphrases each rank their own message
  first over HTTP. **That same session also decides how the embedder allocates, and that half has its
  own gate** (2026-09-18): `session_options.enableCpuMemArena = false` sits next to
  `intraOpNumThreads` because ORT's CPU arena doubles and never gives back — under Electron's
  PartitionAlloc its first `posix_memalign(2GiB)` is a SIGTRAP that takes the desktop with it (four
  crashes in one day). `bun run gate:embed-runtime` is what keeps that line honest: it runs **the
  product's own embedder** through 40 variable-length batches under both Node and Electron. See the
  Guardrails entry above. **Backend answers a reason code, never a sentence** (R12): `status.vectorErrorKind`
  (`network` / `runtime` / `model` / `unknown`) plus `status.vectorError` (the raw words, 200 chars);
  the shell looks the code up in its own dictionary and puts the raw words in brackets after it.
  Two rules carry over unchanged and are gate-enforced: **the lexical path is untouched**
  (S7 proved this with `search:parity-B`, retired in S5 together with the old scan path;
  the standing guard is the strict-tier hit-set snapshot) and **authorization is a query
  input** — the scope compiles into `docId IN (…)`, which vec0 pushes *into* the KNN scan
  (a SQL `JOIN` would post-filter and is provably wrong here). `search.status` gained
  `vector` / `vectorPending` / `vectorExtension`; `gate:packaged` asserts the default is
  `vector: 'off'` **and** `vectorExtension: 'loadable'`, which is the only proof that the
  `asarUnpack` line for `vec0.dylib` is still there. Three things are open and written down
  in §13 留账 — the desktop packaging of the embedding runtime (拍点癸': today
  `electron-builder.yml` excludes `@huggingface/transformers` and both onnxruntime
  packages — route (c) — so a packaged app answers `vector: 'off'` and degrades cleanly;
  semantic recall runs on dev / server / CLI) and the missing distance floor on KNN. The
  third one — the settings switch not being hot-applied, and having no UI at all — was
  closed on 2026-09-17 (see above).
- **Session event sourcing is the production write model, not a shadow** (F line landed
  F4-c, 2026-08-27; `docs/design/session-event-sourcing-2026-08.md` §17 系统宪法 is the
  three-law summary). Every fact — a user message, one streamed delta, a tool step,
  a permission decision — is one logical event on one stream; the projection reducer
  (`packages/shared/session/projection/reducer.ts` + `chat-messages.ts` — shared since step ① of the
  server / client split, because the shell folds the same ledger; model-history / canonical / checkpoint
  stay in `packages/backend/session/projection/`) folds that stream into state, and
  `session.messages` in memory is only the **materialized view** of it; the encoder packs
  the same stream into `events.jsonl` (`assistant/chunks` batching is storage compression,
  not semantics). **`events.jsonl` is the only truth on disk**: the `messages.jsonl` write
  half was deleted (S3w-3 批 6b), event/blob write failures **throw** into the command
  (never swallowed; a queued async failure latches and the *next* append throws
  `SessionEventWriteError`), a foreign writer detected by byte-size drift on the ledger
  also throws, and every product read path (`listMessages` / `getMessage` /
  `pageMessages` / cold-load hydration) is projection-only — the `ONETHING_SESSION_READ`
  / `_HYDRATE` / `_TRANSCRIPT` rollback levers were **burned**, rollback is `git revert`.
  What survives of the old shadow machinery is the **refold durability gate**
  (`backend/session/session-shadow.ts`, §14.3-B): at every run end the ledger's *file bytes* are
  re-folded and compared with the live projection — two store-independent paths — and any
  diff lands one summary line in `<store>/log/session-shadow.jsonl` and counts into
  `session-shadow-stats.json` (`refoldChecks` / `refoldMismatches`). The identity gate
  (projection vs in-memory store) was retired in c4 because the store is no longer any
  read's source of truth — "comparing yourself with yourself" would go green for the wrong
  reason. Both sides still go through the one judge in
  `packages/backend/session/projection/session-projection-canonical.ts` — extend that file, never add a local
  exemption. `ONETHING_SESSION_SHADOW=0` turns the refold bookkeeping off (events keep
  being written); it is **on by default**. Gates: `bun run sessions:shadow-report`
  (refold mismatches = 0 ∧ appendFailures = 0 over the real store),
  `bun run sessions:shadow-battery` (rebuilds `dist/server/main.js`, boots the real server on
  a throwaway store behind a seeded fake provider, drives the scenario matrix over HTTP,
  samples refold at every run end — red on any scenario failure or mismatch line),
  `sessions:hydration-contract` (projection hydration ≡ transcript hydration over every
  real session), `sessions:verify`, `sessions:events-selfcheck`. Two things the ledger
  does **not** yet guarantee (audit 2026-09-02, `docs/audit/backend-architecture-review-2026-09-02.md`
  §2.4): `events.jsonl` and `meta.json` ride two independent write queues with no shared
  failure handling, and two `server:start` processes on one store do not refuse each other
  (`apps/backend-server/src/main.ts` only refuses `owner !== 'server'`) — the foreign-writer guard
  catches that after the fact.
- **Trace = the read-only query surface over `events.jsonl`** (S3, §12 of the same doc).
  One pure assembler (`packages/backend/session/trace/session-trace-assemble.ts` → `Session → Run →
  Request → ToolCall`; timestamps only, no stored durations, no response body) feeds three
  outlets: `onething trace <sessionId> [--run <id>|--last] [--json] [--response <k>]`
  (reads the file directly, no daemon, never writes), the `sessionEvents` RPC domain's
  `getTrace` / `getResponseText` (desktop IPC and web/HTTP alike, the latter over the
  generic `POST /api/rpc` — there is deliberately **no** dedicated REST route; adding a
  domain must not add a hand-written channel), and the trajectory panel's run grouping.
  Response text is materialized on demand from the `assistant/chunks` fold, never carried
  on the tree. It reads the same ledger the product reads.
- **Notes are a domain, and Obsidian is one driver of it** (`docs/design/notes-obsidian-cli-2026-09.md`,
  P1–P4 landed 2026-09-18). `packages/backend/note/` owns `NoteVault` (daily note /
  create / attachment path / link text / resolve-by-name / list / live search / open-in-app) and a
  `NoteSystemRegistry` of self-describing `NoteSystemDriver`s (first claim wins, `vaultFor` = longest
  prefix); `obsidian/` talks to the **official Obsidian CLI** (`ObsidianCli`: `vault=<id>` is argv[0],
  exit code is always 0 so errors are the first stdout line, stdout is always read to the end, 10s
  budget, and **liveness = connecting `~/.obsidian-cli.sock`** — no socket, no command, because a
  command sent while the app is closed launches it; `eval` scripts live in one file, `scripts.ts`;
  a per-vault snapshot under `<store>/notes/obsidian/` reproduces the three rules when the app is
  not running); `folder/` covers plain directories. Assembly: `backend.notes` is a subsystem
  (`note/note-subsystem.ts`: `registry` / `refresh` / `inventory` / `systemState` / `onRefreshed`;
  trust is judged per `refresh`, so `server:start` calls it after declaring loopback trust) and
  `noteRootsNow()` there is the **only** definition of "note roots" — sandbox roots, search scan
  and authorization roots, `@` file mentions, markdown attachments and skill roots all read it;
  connected directories are a permission surface, not note roots. Settings: `settings.notes =
  { systems: Record<driverId,{enabled?}>, vaults: Record<id,{enabled?,skills?}>, primaryVaultId?,
  folders, dailyFormat, attachmentDirectory?, migratedAt? }` (global, not per-space), seeded once
  from `obsidian.json` and the old `user_note_dir` / `work_note_dir` values by
  `note/note-migration.ts`; those two variables, `general.dailyNotes`,
  `editor.markdownNoteAttachmentDirectory` and the `note-skills` plugin are **gone**; the AI reads
  the read-only `note_vaults` variable instead. The shell's settings page has a 「笔记」 section
  over the `notes` RPC domain (`list` / `refresh` / `openInApp` — the only call that may launch
  the app). Gate: `bun run gate:notes` (read-only, only open vaults, skipped when the socket is
  not there).
- **Process memory is managed in one place** (2026-09-25). Mechanism: `packages/backend/memory/memory-registry.ts`
  (`MemoryRegistry` + `MemoryGovernor`, zero deps); assembly: `packages/backend/memory/memory.ts`,
  exposed as `backend.memory`.
  - **Holders.** A module that keeps rebuildable data in memory implements `MemoryHolder` and is
    registered with one `registerHolder` line where it is assembled. `usage()` is called every
    sample, so it only reads existing counters. `trim('soft' | 'hard')` may only release data that
    can be rebuilt: never the only copy, never data used by a running task. The registry never
    names a holder. Current holders:
    - `events.replay-buffers` (会话更新缓冲, `backend/event/event-memory.ts`): per-session event
      replay buffers with no subscriber.
    - `sessions.projections` (会话内容缓存) and `sessions.cache` (最近打开的会话),
      `backend/session/session-memory.ts`. They are released together, because a cached session holds
      the messages built from its projection.
    - `browser.tabs` (内置浏览器网页, React shell only, `electron/browser/memory-holder.ts`):
      background tab release. A tab hidden for 10 min or more (soft) / 1 min or more (hard)
      that is not playing sound has its web page process closed (`BrowserService.hibernate`).
      The tab keeps its address and title; when it becomes visible again the page reloads.
      Scroll position, unsaved form input and back/forward history are lost. A tab covered by
      an overlay counts as visible.
  - **Process probes.** `MemoryProcessProbe` reports process memory. Every host reports its own
    RSS; the React shell also reports `app.getAppMetrics()` (`electron/memory-probe.ts`: UI,
    GPU, each browser tab; a cross-site iframe process is listed under its tab's name).
  - **Governor.** Samples every 30 s. Above the budget it asks all holders to trim
    (`ONETHING_MEMORY_SOFT_MB` / `ONETHING_MEMORY_HARD_MB`, default 1024 / 1536; at most once
    per 2 min; logs one `warn` in `app.memory`).
  - **Reading it.** `memory` RPC domain: `report` for any caller, `trim` only for locally
    trusted callers. CLI: `bun run memory:report [--json] [--trim [soft]]`. React shell: the
    内存 panel in the Dock.
- There is no memory subsystem. The soul-memory plugin (SOUL/MEMORY.md + daily notes,
  panel, settings tab, `/api/memory/*`) was retired 2026-08-06 — see
  `docs/audit/soul-memory-retirement-2026-08-06.md`. Nothing reads or writes those files;
  leftover data is archived via `scripts/archive-soul-memory.mjs`. `usage` still accepts
  `source: 'memory'` so historical ledger rows resolve.
- Plugin system (R0–R7 complete, 2026-08-07). The plugin's entire power is the injected
  `api` object.
  **Where the code lives (one directory since 去 core 批 2, 2026-10-03 — one feature, one directory):**
  `packages/backend/plugin/` holds it all, flat. The **contract + kernel** (37 files that were
  core's `plugins/` until 2026-10-03: manifest/api shape — barrel `plugin-contract.ts`, types
  `plugin-api-types.ts` —, the `Core*` registries for lifecycle / input-intercept / tool-call-intercept /
  tool-result-intercept / status / sessions / storage, the policy + breaker tables,
  `plugin-ui-anchor.ts`, `plugin-file-pick.ts`, `plugin-canonical-order.ts`, the unnamed log-monitor primitives
  `plugin-log-monitor-primitives.ts`; zero deps, and the only part of the directory a built-in plugin
  implementation may import) sits next to **everything else**: the one built-in plugin
  `log-monitor` (`note-skills` was retired by 笔记 P3 on 2026-09-18, note vaults reach the skill
  loader through `note/note-skill-roots.ts` instead), the config store + schema projection,
  npm-tarball reading, runtime health, the IPC-shape projections, the process-singleton bindings
  of the core kernels (`plugin-status-bound.ts`, `plugin-input-intercept-bound.ts`, `plugin-tool-call-intercept-bound.ts`,
  `plugin-tool-result-intercept-bound.ts`, `plugin-lifecycle-hooks.ts` / `tarball.ts`), and what used to
  be the separate assembly half: `disk-loader` / `plugin-manager` / `plugin-system` (the
  bootstrap entry) / `api` / `npm-process` / `data-home` / `session-messenger` / `llm-service` /
  `skin-table` / `theme-override-table` / `background-table` / `webview-root` / `file-import` /
  `notify-sound` / `resource-verbs` / `types` + `commands` (the one command-execution path the
  `plugins` RPC domain and the gateway command provider share) + `host-ports`
  (`configurePluginsHost`) + `events` (`configurePluginRequestProgressBroadcaster`) + `builtin/` 插座.
  Nothing about plugins lives anywhere else.
  Current surface:
  - **AI capabilities**: tools, slash commands, events (+ plugin-namespaced custom events),
    prompt-context providers, skill roots, lifecycle hooks, scheduler.
    A registered tool may declare `executionMode: 'parallel' | 'sequential'` (N3,
    2026-08-10 — `docs/design/pi-benchmark-adoption-2026-08.md` §8): it flows through
    to `AgentTool.executionMode`, whose **single** reader is the agent-loop runner
    (`packages/backend/agent-loop/agent-loop-runner.ts:397` → `ToolExecutionScheduler` barrier).
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
    (`packages/backend/plugin/plugin-ui-anchor.ts`): three always-on *blocks* —
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
    the Vue renderer's `ui-anchor-registry` (deleted 2026-09-04 with the Vue host — the plugin UI-slot surface has **no React consumer yet**; the contract in `packages/backend/plugin/plugin-ui-anchor.ts` stands).
    Render ctx carries `anchor` +
    `sessionId`, the host re-pulls on session switch. Renderer pieces:
    `components/plugins/{UiSlotHost,UiSlotBlock,PluginTriggerPopover}.vue` +
    `usePluginTriggerEntries.ts`),
    theme token overrides (`contributes.theme.overrides`, B 期/L2 — keys must be
    existing `CSS_VAR_MAP` token paths, values must pass a color-literal whitelist;
    illegal entries are dropped and shown in the catalog projection, never a load
    error; conflicts resolve by canonical order (pluginId lexicographic) last-wins;
    the resolved token table is passed as a **parameter** into `applyTheme` from
    `packages/backend/theme/theme-client-api.ts` (the `themes` RPC domain — since P4c
    第七批, 2026-08-22, **every** host that reaches the domain gets the composition,
    not desktop only) and lands *inside* the theme computation — before `resolveThemeUI` / `generateCSSVariables`, so the
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
    (`plugin/plugin-file-pick.ts` → `describePluginFileImportDeclarationProblem`);
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
    (`packages/backend/plugin/plugin-policy.ts`) — read it before opening another.
  - **Isolation**: timeout budgets, per-`pluginId+scope` failure breaker, and a severity
    policy table (`plugin-policy.ts`) deciding disable-plugin vs degrade-one-surface. Teardown is
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
    earlier wording got wrong: apps/backend-server is *not* a read-only mirror — `plugins.enable`
    / `.disable` / `.refresh` do write enable-flags to disk, and it scans a different tree
    (`owners/<uid>/<wid>/plugin-store/plugins`, not `<store>/plugins`), so toggling there
    changes a catalog the desktop never reads. The CLI daemon does not assemble the plugin
    system at all (it is not "UI-less" — it has no plugins).
    Since P4 终态批 C2 (2026-08-23) the whole domain rides the generic RPC channel
    (`pluginsRouter`, 19 invoke methods; `packages/backend/plugin/plugin-client-api.ts`) — the
    six `/api/plugins*` REST routes and the parameterized 501 are gone. Since B1 (2026-09-03,
    `docs/design/backend-transport-forks-2026-09.md`) the domain no longer reads
    `context.transport` at all: every face is judged by **whether a plugin manager is assembled
    in this process** — manager present → the manager (IPC and HTTP alike, so the old
    read-mirror/write-desktop split-brain on the embedded face is gone); no manager → the 7 read
    faces fall back to `backend/plugin/plugin-client-api-catalog.ts`'s single-slot server-mirror port when the
    server runtime installed one, and the 11 write faces answer "desktop host only" (the React
    shell assembles no plugin manager today, so on it every plugins face degrades that way; a standalone `server:start` does not and
    returns the structured "desktop host only" answers verbatim). The renderer adds a
    second layer: capability bit `pluginsManage` (`platform/types.ts`) is `false` on web,
    so `platform/plugins-client.ts` never even sends the write faces. Two pushes stay on
    hand-written channels: `PLUGINS_NOTIFICATION` (a global bus event fanned out by
    IPCBridge) and `PLUGINS_REQUEST_PROGRESS` (targeted back at `RpcDispatchContext.callerId`
    via `configurePluginRequestProgressBroadcaster`). Two host capabilities are injected
    through `configurePluginsHost` (`backend/plugin/plugin-host-ports.ts`): the native
    file dialog (`pickFile`) and the plugin-command subprocess runner (`execCommand`).
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
  server-package code (`packages/backend/http-server/http-server-{routes,runtime,discovery,embed}.ts`);
  `apps/backend-server/src/main.ts` is a process shell around it and the Electron desktop mounts the
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
  shutdown (**only when the record's `pid` is its own** — `removeHttpDiscovery` never removes another live core's
  record, so a failed mount on a busy port cannot orphan the core that actually owns it), and answers on a **dynamic** port unless `ONETHING_SERVER_PORT` pins one (pinned
  and busy = explicit error, never a silent fallback). `server:start` reads that file first and
  **refuses to start** when a live record says `owner !== 'server'` (`--force` bypasses); alive
  means pid alive **and** the port connects. Token = `ONETHING_SERVER_TOKEN` or a fresh
  `randomBytes(24).base64url` per launch.
- apps/backend-server is single-user: one server process assembles one backend and pins
  `ONETHING_STORE_PATH` before boot. Bearer auth via `ONETHING_SERVER_TOKEN` (warns when
  binding non-loopback without it; loopback launches mint their own token into the discovery
  file). Tools ship with desktop parity by default;
  `ONETHING_SERVER_TOOLS=readonly` degrades to zero-side-effect tools (read/time/web only).
  The server's HTTP session store is backed by the same `@onething/backend` store the engine
  uses in-process — a second repository over the same files would fork the in-memory truth.
- Store isolation: the store root resolves `ONETHING_STORE_PATH` → `~/.onething`
  (`packages/backend/storage/storage-paths.ts`). All app-layer paths must resolve
  through `getOnethingStorePath()` / its `getOnething*Path` helpers — never hardcode.
  Single-instance safety via `StoreLock` (`acquire('desktop')` / `'daemon'`). The
  `'server'` owner exists in the type but `apps/backend-server` deliberately does **not** take the
  lock (2026-08-19 ruling: desktop + dev server share `~/.onething` in `bun run dev`; the
  two-writer risk — two LRUs + two throttled write queues over the same files — is accepted
  for now and must be revisited before the session event log becomes the single source of
  truth).
- Permission channel affinity gotcha: a permission ask records
  `targetChannel = engine.getChannel(sessionId)` (default `'ipc'`), and core rejects a
  respond whose channel doesn't match. When answering from another transport, adopt the
  ask's targetChannel (the server HTTP respond does this — owner is already authenticated
  at the HTTP boundary; affinity guards against cross-channel spoofing on the bus).
- Renderer code talks to core only through `@onething/backend-client` (`createOnethingClient` over an http `Transport`); the React shell's data plane has no IPC at all — its two IPC channels are `host:connection` (the `{ baseUrl, token }` handshake) and, since B1-a (`72c998f8`, 2026-09-12), `host:native-view` (the window-system pipe for native views). `window.electronAPI` no longer exists anywhere.
- System prompt assembly is a single "directory at top, copy below" builder in
  `packages/backend/prompt/prompt-builder.ts`, composed by a **`PromptComposer`
  over `PromptSource`s** (2026-08-18, `docs/design/prompt-composition-2026-08.md`).
  One shape (`CorePromptFragment`, `packages/backend/agent-loop/agent-loop-prompt-fragments.ts`: `slot`
  guidelines / workspace-rules / section, `source`, `order`, `requiresTools` /
  `requiresAnyTools` / `when`, `content`); one interface (`PromptSource.collect(ctx)`,
  `prompt/prompt-composer.ts`); sources: `builtinPromptSource` (the section table),
  `OnethingToolRegistry` itself (the `ToolInfo.prompt` of the tools **on the turn's
  surface** — declared next to the tool, so enable/disable/scene/allowlist/unregister
  all just work; `edit`/`write`/`variable` own the former `tool-guidelines.md` /
  `tool-workspace-rules.md` / `context-variables-intro.md` text), `PromptFragmentRegistry`
  (`promptFragments` / `registerPromptFragment` with a disposer, for runtime features /
  hosts) and `PluginPromptContextSource` (`api.registerPromptContextProvider`; plugin
  tools carry `prompt` like builtins; it lives in the plugin feature,
  `plugin/plugin-prompt-context{,-breaker}.ts`, since 越层清零 C1 2026-10-04). Hosts assemble their own composer:
  `desktopPromptComposer` (`backend/engine/prompt/engine-system-prompt.ts`) = builtin + tools +
  registry + plugins-with-breaker; `defaultOnethingPromptComposer` = builtin + registry only — no tool source
  and, since C1, no plugin source (the prompt-version stamp in `backend.ts` adds
  `.with(new PluginPromptContextSource())` itself; tests add a `StaticPromptSource`). The composer only
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
  against the visible history and `SessionTurnContext` (product layer since P3'e-A2b,
  `engine/engine-session-turn-context.ts`, hooked into the `buildPrompt`
  wrapper in `backend/engine/stream/engine-agent-loop-stream-context.ts`) persists the delta on the message
  as `ChatMessage.turnContext`, so a rebuild replays identical bytes.
- Media library: drag-and-drop ingest and export run over `media:ingest-files` /
  `media:save-as` (`packages/shared/ipc/channels.ts` → `mediaLibraryService.ingestLocalFiles`; the Vue host's IPC adapter and its
  `media://` protocol handler died 2026-09-04 — the React shell has not re-wired media ingest yet). That protocol served **two** directories — images/ first,
  files/ on miss (non-image assets landed with ingest) — and re-resolves every name against
  the root prefix, since the name comes from the renderer and `../` would otherwise read
  any file. `MediaAsset.source` (`ai-generated` / `user-upload` / `external`) now has real
  producers on every facet, so filtering by it no longer lies.

### Process model

**The current desktop (React shell, `apps/desktop-react`) is a two-process HTTP client of its own core**, not the three-process IPC design below:

```
┌──────────────────────────────────────────────────────────────────┐
│  Renderer (React, apps/desktop-react/src)                        │
│  - talks ONLY HTTP/SSE: POST /api/rpc + GET /api/events          │
│  - its IPC is `host:connection` → { baseUrl, token }             │
│    (the discovery file is 0600; the renderer never reads disk)   │
│  - plus `host:native-view` (B1-a): the window system's pipe for  │
│    native views — bounds/visibility/z, keys, focus. Not data.    │
└─────────────────────┬────────────────────────────────────────────┘
                      │ HTTP / SSE (same face the browser shell and mobile use)
┌─────────────────────┴────────────────────────────────────────────┐
│  Main (apps/desktop-react/electron/main.ts)                      │
│  - if <store>/run/http.json names a live core → attach to it     │
│  - else: configureLogging → createOnethingBackend({ host:        │
│    createShellHostPorts(), … }) → window → mount the embedded     │
│    HTTP/SSE face (owner 'shell') + scheduler + MCP + the browser  │
│    host (installBrowserHost, B2), each own()'d                   │
│  - quit = await backend.dispose()                                │
└──────────────────────────────────────────────────────────────────┘
```

Because the shell rides the HTTP face, an RPC handler that judged by `context.transport === 'http'` would
treat the desktop as a remote client. Since route B (`docs/design/backend-transport-forks-2026-09.md`,
2026-09-03) `transport` answers exactly one question — **which bus channel replies** (`session-command` /
`interaction`) — plus the two redaction sites that ask whether the payload leaves the process over the network
(`mcp` / `settings`, `payloadLeavesProcess`). Everything else asks a host fact: **does this host have the
peripheral** (`hasVoiceHost()` / `hasTerminalHost()` / `hasShellHost()` / `getPluginManager()`, all read from
the `OnethingHostPorts` table) or **is the caller locally trusted** (`isHostLocallyTrusted()` from
`backend/http-server/http-server-host-trust.ts`, declared by the host table's `localTrust` key at assembly and again by the
embedded HTTP face when it mounts; a loopback `server:start` declares itself at listen). The shell is therefore
`desktop-embedded`-trusted: background jobs, whole-machine search, evals paths, MCP config reads and stdio
probes behave as on the old IPC desktop. `GET /api/capabilities` derives `localFileSystem` / `shellTools` /
`terminal` / `pluginsManage` / `collabRooms` from those same predicates, so a client's capability bits and
the backend's guards can no longer disagree. `bun run transport:gate` ratchets the per-file count of
`context.transport` reads in `packages/backend/http-server/**` plus every feature's `<feature>-client-api*.ts` (recursive since C0, re-scoped by 包根归位 A — `http-server/http-server-sandbox.ts`, the sandbox helper seven
domains share, is in scope and asks `isHostLocallyTrusted()` too; baseline `docs/audit/transport-forks-baseline-2026-09-03.txt`:
5 reads in 5 files, decrease-only) and pins the React shell's `ipcMain` registrations at ≤ **2** (raised from 1 by B1-a `72c998f8`, 2026-09-12, with the reason written into the baseline file: `host:connection` is the data plane's one seam, `host:native-view` is the **window system's** pipe for native views — five verbs on one channel, `electron/browser/native-view-ipc.ts` being the only `ipcMain.on` for it, and its payload is parsed by the pure `parseNativeViewRequest` because a renderer frame is not trusted; the data plane gained nothing. The same commit made the gate's `ipcMain:` scan root **recursive** — otherwise a channel registered from a subdirectory walks past the ruler, the same hole C0 R2 closed for `forks:`).

**There is no second host.** The Vue three-process IPC host (`apps/electron` + `packages/renderer` + `apps/web`) was deleted on 2026-09-04 (runtime unification step ④, `docs/design/runtime-unification-2026-09.md`). Its `shell:invoke` window-system channel, `@main` / `@preload` / `@renderer` aliases, `electron-vite` build, `macos_panel` native module and the `?token=` query hole on `GET /api/events` went with it. Push to the desktop renderer rides the same SSE face every other client uses.

### Key Data Flows

**Chat Message Flow (both transports, same engine):**

```
renderer (React) → client.api(sessionCommandRouter).emit({ sessionId, command: { type: SESSION_COMMAND_TYPES.SEND_MESSAGE, … } })
→ generic RPC envelope `POST /api/rpc` (desktop over its embedded HTTP face, browser via the dev proxy / server; same domain,
  same handler — there is deliberately no hand-written session-command channel)
→ packages/backend/session/session-client-api-commands.ts → emitCoreSessionCommandForIpc
  (ipc: sanitizeRendererCommand stamps origin + amends the evals turn record;
   http: command:abort is handled locally and a channel-less permission respond
   adopts the pending ask's targetChannel — nothing else is destructured away)
→ EventBus (packages/backend/event/, per-session ring buffers)
→ ProductStreamEngine.handleSendMessage (packages/backend/engine/engine-stream-dispatcher.ts)
  → persist messages → emit events + stream chunks
→ desktop: IPCBridge → 'session:event' / 'session:stream' to WebContents
  web:     GET /api/events SSE (same event names; ?after= replays from ring buffers)
```

Both fan-outs share **`SessionStreamCoalescer`** (`packages/backend/event/event-stream-coalescer.ts`): text/reasoning/tool-input deltas batched on a 16ms ordered buffer, active stream's `messageId` stamped onto every chunk, and pending deltas flushed before any session event goes out. Consumers: `apps/electron/src/main/bridges/ipc-bridge.ts` and `packages/backend/http-server/http-server-routes.ts` (per-SSE-connection instance).

That same `GET /api/events` also carries the **non-session** pushes (`packages/backend/http-server/http-server-global-events.ts`): `settings:changed`, and since 原子 K2a' every global event whose row in `@shared/events`'s `GLOBAL_EVENT_LEAVES_PROCESS` says it may leave the process (`resource:event` among them) — one frame per event, `event` name = the event's `type`. They do **not** enter the coalescer, carry no `id:`, and `?after=` never replays them: sequence numbers and ring buffers are per session, and a global event has no session.

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

**Request/response never gets a new channel. There is exactly one data-plane channel** — `POST /api/rpc` (the React desktop rides it too, over its embedded HTTP face):

| | `POST /api/rpc` |
| --- | --- |
| Handler lives in | the feature's own second entry `packages/backend/<feature>/<feature>-client-api[-<aspect>].ts` (electron banned) — it exports one roster row via `defineClientApi({ id: 'rpc:<domain>', router, handlers })` |
| Roster | `packages/backend/http-server/http-server-client-api-roster.ts` — one row per domain, order = mount order; the only http-server file that names features |
| Dispatch table | `packages/backend/http-server/http-server-dispatch-table.ts` |
| Client | `@onething/backend-client` — `client.api(router)` over a `Transport` (generic: no per-domain client files) |
| Context | `RpcDispatchContext` (`transport` / `ownerUid` / `workspaceId` / `callerId` / `sandboxRoot`) |

(The Vue host's second channel `shell:invoke` — window-system handlers that had to touch Electron itself — died with it on 2026-09-04; the React shell keeps **two** IPC channels and neither is a data plane: `host:connection` hands the renderer `{ baseUrl, token }`, and `host:native-view` (B1-a `72c998f8`, 2026-09-12) is the window-system pipe for native views — five verbs, frames carry a `viewId` so a second kind of native view reuses the same channel, and `electron/native-view-protocol.ts` deliberately lives outside `electron/browser/` for that reason.) The envelope (`RpcRequest` / `RpcResponse`, `@shared/ipc/rpc.ts`), the contract style (`defineRouter`), the client factory (`createRouterClient`) and one rule about identity: **the host mints the context after its own auth ran; it is never read off the envelope.** A second rule since route B: **a handler may read `context.transport` only to pick the reply channel or to decide redaction for a payload that leaves the process** — "does this host have X" is a host-port question (`OnethingHostPorts`), "may this caller do X" is a local-trust question (`isHostLocallyTrusted()`), and `transport:gate` counts the reads per domain file, decrease-only.

**To add a data-plane domain** (3 small steps): `defineRouter` in `@shared/ipc/<d>.ts` → handlers + `export const <D>_CLIENT_API = defineClientApi({ id: 'rpc:<d>', router, handlers })` in the owning feature's `<feature>/<feature>-client-api[-<aspect>].ts` → one row in `http-server/http-server-client-api-roster.ts`. Clients call `client.api(<d>Router)` — no client file, no shell file changes. **The client-api file is the feature's second entry (D26)**: only `http-server/` and the same feature's other client-api files may import it (plus tests; no exceptions) — `bun run client-api:gate` (`scripts/client-api-gate.mjs`, zero-baseline, in CI); it may import any feature's main entry, and no main entry may import it, so features with UI operations never turn back into hubs. `entry:gate` does not count imports of it as deep; `layer:gate` files it under the L4 slot `(开给界面的操作)`.

**`packages/shared/ipc/channels.ts` is now the push side plus one residue**: `session:event` / `session:stream` / per-domain broadcasts, plus the one-way high-frequency `voice:audio-chunk`. **Terminal and browser no longer have any constant in this table** (2026-09-12): T0 (`dce6c15e`) deleted the two zero-import `TERMINAL_DATA` / `TERMINAL_EXIT` constants — terminal output rides the `terminal:data` / `terminal:exit` **global events** out over `GET /api/events`, and replay belongs to `attach`'s ring + seq + generation, not to SSE; B1-a (`72c998f8`) deleted `BROWSER_TABS_CHANGED` together with the whole orphaned `shared/ipc/browser.ts` (A1-b's 19-verb `browserRouter`, whose only host was the retired Vue shell, with zero imports left in the repo), and browser state today is a `browser:` resource whose reads/writes go through the generic `resources` RPC. Since A1-b (2026-08-23) the whole window system rode `shell:invoke` — browser's 19 request verbs (now deleted with that contract), and the four channels that were never in this table at all (`shell:open-path` / `shell:open-external` / `app:get-data-path` → the new `shellRouter`; `window:set-button-visibility` → `windowRouter`, because it acts on the **caller's own window**). `search:query` became the backend `search` RPC domain, forked on **local trust** (`isHostLocallyTrusted()`; it asked `context.transport` until B2). Locally trusted hosts get this process's own `SearchService`; an untrusted one goes through the `backend/search/search-client-api-providers.ts` single-slot port — the same closure the old `POST /api/search/query` route called, and the port exists for exactly that one branch. `bun run transport:gate` is a **numeric ratchet** over its constant count and the shell files (`http-server/http-server-routes.ts`, `shared/ipc/channels.ts`) — a new hand-written channel turns it red.

Supporting files: **type definitions** `packages/shared/ipc/*.ts`; **event/command types** `packages/shared/events/*.ts`; **client** `packages/backend-client/`.

### Alias Registry

Two mechanisms, and which one a package uses is a fact about that package, not a style choice.

**Every `@onething/*` is a real workspace package (node resolves them).** Root `package.json` declares `"workspaces": ["packages/backend", "packages/backend-client"]` — **listed one by one, never a `packages/*` / `apps/*` glob** (`apps/mobile` would drag in expo + react-native). `npm install` / `bun install` (hoisted) link them at `node_modules/@onething/{backend,client}`. `@onething/backend` resolves through **its own `package.json` "exports"** in node, vite, vitest and tsc alike (`moduleResolution: bundler` honours exports pointing straight at `.ts` sources): **exact keys only, no wildcard fallback** — one key per import specifier that actually appears in the repo (406 keys after 6a, 2026-10-04: the package root's own `./x.js` keys plus one or more per feature, e.g. `"./provider"` → `./provider/index.ts`, `"./eval"` → `./eval/index.ts`; until 6a every feature key carried a `./runtime/` prefix). `@onething/backend-client` uses the family wildcard (`"./*.js"` / `"./*"` → `./*.ts`) plus an explicit `./node`. Files inside `packages/backend` import other features by package specifier too (`@onething/backend/<feature>/…` — the package's self-reference resolves through the root `node_modules/@onething/backend` link). There is no alias entry and no tsconfig `paths` entry for them, and a missing key fails at **typecheck**, not only at build/run. `@onething/*` must **never** appear in the root `package.json` `dependencies`/`devDependencies` (`workspaces` and `dependencies` are unrelated fields; the React main-process bundle inlines them via esbuild).

**Alias table.** There is none any more: `onething.aliases.ts` (the `@onething/electron-host/*` family) died with the Vue host on 2026-09-04. The only non-package alias left is `@shared` (= `packages/shared`), declared per-config (root `tsconfig.json` paths, `vitest.config.ts`, the React shell's vite/esbuild configs).

**Adding a new backend subpath** (package root or a feature alike): a feature `<d>/` gets **one** key, its entry (`"./<d>": "./<d>/<d>.ts"`) — what outsiders need goes into that entry, not into a deep key (功能入口, see Guardrails; search has only `./search`). Otherwise add one exact key to `packages/backend/package.json` `"exports"` (`"./x/y": "./x/y.ts"`; a sub-directory's entry file keeps its directory key, e.g. `"./search/kernel": "./search/kernel/search-kernel.ts"`; since 6b no backend file is called `index.ts`). (Until 6a, 2026-10-04, every feature key carried a `./runtime/` prefix and `./runtime` itself was the big barrel; both are gone.) No alias edit, no tsconfig edit, no config edit — all build/test configs and tsc go through the same exports map, and a missing key fails at **typecheck**.

### Directory Structure

```
packages/backend/<feature>/    # one feature, one flat directory, directly under the package root (was
│                              # packages/onething-runtime/src; core/, wiring/ and gateway/ folded in 2026-10-02/03;
│                              # the runtime/ layer removed and plural names made singular by 6a, 2026-10-04 —
│                              # see the design doc §6)
│   ├── prompt/                # system prompt builder + content/*.md
│   ├── session/               # session-repository, storage-driver (jsonl/legacy hybrid) + since 批 2 core's
│   │                          # session kernel: Session / manager / commands.ts (pure reducer), projection/,
│   │                          # trace/session-trace-assemble.ts, storage/jsonl (codec + pager); one entry session.ts (the old
│   │                          # kernel barrel session-primitives.ts was merged into it, 2026-10-03); and since
│   │                          # 包根归位第 1 笔 (2026-10-03) the former package-root session/ + stores/sessions.ts:
│   │                          # sessionCommands (session-commands.ts) / sessionReads (reads.ts) / access /
│   │                          # event-log + writer + blobs + checkpoint + refold/shadow / session-trace-reads.ts /
│   │                          # freeze / createSessionLayer (session-layer.ts) / the session table
│   │                          # (session-store.ts: LRU + 300ms throttled saves) / ipc-repository/ / testing/
│   ├── provider/              # one vendor, one folder (vendors/<id>/) + rosters + registry wiring, and since
│   │                          # 包根归位 3 第 2 笔 (2026-10-03) the former agent-loop/providers/: the hand-rolled
│   │                          # fetch/SSE wire protocols (wires/), dialect base classes (base/), dialect recipes
│   │                          # (dialects/), thinking wires (thinking/), the pure factory.ts / openai-compatible /
│   │                          # thinking-options / provider-data (the old barrel agent-providers.ts is gone), the dumper
│   │                          # contract provider-request-dumper.ts. Since providers 归位 (2026-10-04, D24) it holds only the
│   │                          # vendors' facts and pure logic; the files that *use* a vendor live in engine/ (chat
│   │                          # facade, process factory), settings/ (model catalog service), credentials/, sessions/
│   ├── credentials/           # 凭证 (D25, 2026-10-04): per-space pool + rules, which key this session uses, rotation,
│   │                          # plugin credential strategies, subscription routing, per-key usage, OAuth token write-back,
│   │                          # legacy migration; entry credentials.ts (the first N3-shaped entry)
│   ├── media/  scheduler/  agent/  auth/  settings/  storage/ (paths, store-lock)
│   ├── toolkit/               # the tool system: kernel (ToolSpec/Tool/Intent/Outcome/Catalog/Surface/Runner,
│   │                          # barrel toolkit-tool-protocol.ts) + families, builtin tools, contract, scene
│   ├── event/                 # event bus: generic primitives + session-typed bus, stream-coalescer, ui-stream
│   │                          # (core's events/ + the package root's events/, merged 2026-10-03)
│   ├── tool/  skill/  plugin/  theme/  variable/  goal/  voice/  music/
│   │                          # (tool/ = pure modules only since R4b: sandbox, bash, edit engine, …)
│   ├── agent-loop/            # the turn kernel ("how one turn runs"): provider-agnostic runner, stream, retry, tool
│   │                          # scheduler, wire format (barrel agent-loop-primitives.ts),
│   │                          # + since the engine batch (2026-10, D27/D51) the former core/engine kernel, all named
│   │                          # agent-loop-*.ts: CoreStreamEngine (agent-loop-stream-engine), executor/runtime/selection,
│   │                          # tool orchestration, context compact, history, turn context, prompt fragments, ids,
│   │                          # message sources, turn principal, stream sender, the engine ports and the trigger table,
│   │                          # plus the executor table (agent-loop-external-agent-providers.ts: local / acp descriptors +
│   │                          # registered execution facts; merged in from agent/executor/ by 越层清零 C2, 2026-10-04).
│   │                          # Its entry agent-loop.ts IS the old engine-primitives barrel (D52). Depends on shared/logging/tools only.
│   ├── engine/                # orchestration (L3): ProductStreamEngine(路由/房间闸/插件旁路/agent 绑定), the 12-slot
│   │                          # runtime (stream-engine-runtime), stream/ (executors, recorder, provider helpers), prompt/,
│   │                          # triggers/turn-evaluation, the "use a provider" facades (chat / title / utility turn /
│   │                          # AgentProvider factory), product-stream-runtime / stream-runtime-factory /
│   │                          # stream-processor-factory, engine-agent-loop-stream-{runtime,selection},
│   │                          # engine-event-only-emitter.ts (moved in from event/ by 越层清零 C4, 2026-10-04).
│   │                          # One entry, named exports only (engine.ts, D60); no deep exports keys.
│   └── mcp/  acp/  external-agent/  file/  search/  usage/  eval/  headless/  …
│                              # (the big barrel runtime/index.ts was deleted by 6a: its last users — the evals
│                              #  family — now import the eval / prompt entries directly)
│
packages/backend/gateway/ # IM gateway (was packages/gateway/src): hub/ + channels/ + gateway-conversation-runtime.ts
│
packages/backend/              # THE server package ('@onething/backend'); the package root below = entry points and faces
│   ├── backend.ts             # createOnethingBackend — the single assembly recipe (+ backend-current.ts / backend-host-ports.ts / backend-shutdown.ts)
│   ├── http-server/           # the HTTP server the UI connects to (包根归位 A, 2026-10-04): http-server.ts (entry),
│   │                          # -routes (routes/SSE), -runtime + -runtime-facade (server runtime, OnethingRuntimeFacade),
│   │                          # -discovery (<store>/run/http.json), -embed (desktop mounting), -identity / -host-trust,
│   │                          # -client-api-roster (one row per domain) + -dispatch-table (registry), -principal / -sandbox …
│   │                          # (every feature's UI operations live in <f>/<f>-client-api*.ts, its second entry)
│   (包根 channel/ / features/ / utils/ / store.ts 于包根归位 B(2026-10-04)归位:渠道 → gateway/,
│    feature 挂载基座 → feature-registry/,自进化 → toolkit/,轨迹 → sessions 那一行名册,
│    deep-freeze → session/,ripgrep 装配步 → file/,fuzzy / wildcard 零调用者删除,兼容桶 store.ts 删除)
│   (包根 provider-binding/ 于包根归位 3 第 1 笔(2026-10-03)删除:受管 fetch 与代理规则成了独立功能
│    network/,读设置的薄壳 settings-proxy-fetch.ts 与 settings-ai-compose.ts 进 settings/,
│    provider-request-dump-writer.ts 进 provider/)
│   ├── backend-assemble-engine.ts     # 装引擎(engine 归位,2026-10,D27):createStreamEngineLayer + createBoundStreamEngine
│   │                          # (端口接线)+ registerBuiltinTriggers —— 从前是 engine/ 的 engine-layer.ts /
│   │                          # stream-engine-bound.ts / trigger/trigger.ts。读当前引擎走 backend-current.ts,不走这里。
│
apps/cli/src/                  # CLI daemon + commands: index.ts (arg parsing) daemon-client.ts
│                              # daemon-server.ts (HeadlessBackend) ndjson.ts paths.ts stdout.ts
│                              # (the product-output口) plugin-command.ts trace-command.ts + __tests__/
apps/backend-server/src/       # process shell only: main.ts (env, discovery-file refusal,
│                              # listen, SIGTERM flush) + index.ts (re-exports @onething/backend/http-server)
packages/backend-client/       # '@onething/backend-client' — transport/ (types, http, sse, memory) rpc/ events/ model/ client.ts node.ts
│
apps/desktop-react/            # THE desktop + browser shell (React). Has its own CLAUDE.md.
│   ├── electron/              # main.ts (own core + embedded HTTP face) / preload.ts / host-ports.ts
│   ├── src/                   # renderer (React): data/ platform/ content/ ui/ search/ providers/ …
│   ├── vite/                  # dev-api-proxy.ts (web mode: /api → live core via run/http.json)
│   └── scripts/               # dev-app / build-electron / gate-* / verify
│
packages/shared/               # '@shared'
│   ├── ipc/                   # channels.ts + ~30 domain type files + router.ts
│   ├── events/                # session-commands, session-events, stream-chunks, envelope
│   └── backend/ (store-lock)  cli/  defaults/  types/  voice/
```

### Key Systems

**StreamEngine** — the engine itself is product code: `ProductStreamEngine` in `packages/backend/engine/engine-stream-dispatcher.ts` (extends `CoreStreamEngine`), single owner of active stream lifecycle. Commands arrive via EventBus → engine handlers → persist → emit events → IPCBridge (desktop) or SSE (server). Handles send-message, edit-and-resend, retry-message, resume-after-confirm, steering, compact. Everything it needs from the assembly layer rides **six optional ports** (`agent-loop/agent-loop-engine-ports.ts`: `router` / `roomIngress` / `pluginIntercept` / `agentBinding` / `steeringDelivery` / `collabDrive`) — **an absent port means that capability does not exist** (no routing / no room refusal / no plugin post-reply / no agent binding / steering queues as before / no collab drive is ever trusted when minting the turn principal), never a substitute implementation. The assembly layer's whole share is `createBoundStreamEngine` in the package-root file `packages/backend/backend-assemble-engine.ts`: it fills all six ports from the backend (`channel/`, `collab`, `plugin`, `agent`, `external-agent`) and calls `new ProductStreamEngine(streamRuntime, ports)`; the same file builds the engine layer (`createStreamEngineLayer`) and registers the built-in triggers, and `backend-current.ts` answers "which engine is live" (`getStreamEngine()`). The engine never imports that assembly file: the stream executor gets the engine's controller registry as a call argument (`streamControllers`, D56), and the post-turn trigger table is a kernel instance (`agent-loop/agent-loop-trigger-manager.ts`) whose triggers live with their owners (goal continuation → goals, session TOC → toc, skill review → skills, turn evaluation → engine). The 12-slot product runtime (`CoreStreamEngineRuntime`) is assembled in `engine/engine-main-stream-runtime.ts`; the turn kernel (`CoreStreamEngine`, the agent-loop executor/runtime, history, compaction, tool orchestration) lives in `agent-loop/`.

**EventBus** (`packages/backend/event/`): Central pub/sub with per-session ring buffers, sequence counters, typed and wildcard handlers. One directory since 收尾整理 2 (2026-10-03): the generic primitives (`event-bus.ts` / `event-ring-buffer.ts` / `event-stream-channel.ts` / `types.ts`, barrel `event-bus-primitives.ts`; core's `events/` until 去 core 批 1) and what used to be the package root's `events/` (`event.ts` = `createEventSystem` / `getEventBus`, the bus-message-typed `event-session-bus.ts` / `event-session-ring-buffer.ts` / `event-session-stream-channel.ts` / `event-session-bus-types.ts`, `event-stream-coalescer.ts`, `event-ui-stream.ts`, …) sit side by side.

**Providers**: **one vendor, one folder** (服务商自述试点 P0–P5, 2026-10-01, `docs/design/architecture-direction-2026-10.md` §3–§4b). Each builtin vendor lives in `packages/backend/provider/vendors/<id>/` — its `<id>-manifest.ts` (pure data, the shell's facts arrive via RPC: name, dialect, auth, models source, dials, env vars, model identity, catalog aliases, error descriptions, endpoint hooks, model-rule table, reasoning wires, default `seed`, `family.role`) and its behavior files (dialect, thinking wire, `<id>-runtime.ts` with `createProvider` / `quotaSources` / `oauth` / `createModelsFetcher` / `fallbackModels`). Two rosters register them, one row each: `vendors/provider-vendor-manifests.ts` (data, also `VENDOR_FAMILIES`) and `vendors/provider-vendor-runtimes.ts` (behavior). Generic code reads fields and never names a vendor; knowledge about a *model family* served by several vendors (claude-*, gemini-*, gpt/o-series) lives in `provider/model-families/`. Adding a vendor = its folder + one row per roster + the shell's i18n line (icon optional) — `bun run provider:drill` proves it; `bun run provider:gate` is the ratchet on vendor names leaking outside their folder. Registry wiring lives flat in `packages/backend/provider/` too since ③-收尾 B (`provider-table.ts`, …). **Since providers 归位 (2026-10-04, decisions D24 / D25, `docs/design/feature-layers-and-provider-placement-2026-10.md` §2–§3) providers holds the vendors' facts and pure logic only; the files that *use* a vendor live where their dependencies put them**: sending a turn / titles (`engine/engine-chat-facade.ts`), building this turn's `AgentProvider` with the process's host capabilities (`engine/engine-provider-factory.ts` / `engine-process-providers.ts` / `engine-agent-runtime.ts` / `engine-media-reader.ts` / `engine-openai-compatible-fetch.ts`), the utility-model turn (`engine/engine-utility-provider.ts`); the model-catalog service, manual models and custom-provider manifests (`settings/settings-model-registry-service.ts` — exported by the settings entry as the namespace `modelRegistry` — `settings-manual-model-store.ts`, `settings-custom-manifests.ts`); a session's space settings / default model (`session/session-space-{ai-settings,defaults}.ts`); **credentials are their own feature `packages/backend/credentials/`** (entry `credentials.ts`): the per-space pool `credentials-pool.ts` (was `spaces/credentials.ts`), the rules `credentials-provider-rules.ts` (was `spaces/provider-credentials.ts`), which key this session uses `credentials-resolution.ts`, rotation, plugin credential strategies (`CredentialStrategyService` now takes the usage-ledger reader as a constructor argument from `backend.ts`), the subscription candidate route, per-key usage `credentials-usage.ts`, the OAuth token write-back `credentials-token-store.ts` (was `auth/space-token-store.ts`) and the legacy migration `credentials-default-space-migration.ts`; auth no longer knows the pool — `getAuthService()` (`auth/auth-process-service.ts`, built on first use; the old `authService` constant is gone) gets its token store from the assembly; `oauth-token` / `jwt` moved to `network/`, the provider request dump to `logging/logging-provider-request-dump.ts`, `usage/pricing.ts` to `provider/provider-pricing.ts`, `external-agents/provider.ts` to `provider/provider-external-agent.ts`, the custom-probe analyst into providers' own client-api `provider/provider-client-api.ts` (D30 parked it beside its only user; 包根归位 A folded it in, D64), and the unused `providers/codex.ts` wrapper was deleted. the managed fetch (dispatcher choice by proxy settings, timeout / retry / abort forwarding) and the proxy rules are their own feature `packages/backend/network/` (`network-managed-fetch.ts` / `proxy.ts`, one entry — the index Worker uses it too, so that entry imports no settings), the thin shell that feeds it the user's proxy setting is `packages/backend/settings/settings-proxy-fetch.ts` (`createAppFetch` / `createRequiredAppFetch` / `createPolicyFetch` via the settings entry), the effective-AI-settings composition is `packages/backend/settings/settings-ai-compose.ts` (its only user is the settings cache), and the request-dump writer is `packages/backend/provider/provider-request-dump-writer.ts` (包根归位 3 第 1 笔, 2026-10-03 — the package-root `provider-binding/` is gone); the `@shared/ipc`-shaped type/env/utility-model adapters are `packages/backend/provider/provider-{ipc-types,ipc-env,utility-model}.ts`; the hand-rolled fetch/SSE implementations (wire protocols `wires/`, dialect base classes `base/`, recipes `dialects/`, thinking wires `thinking/`, the runtime factories) live in `packages/backend/provider/` too since 包根归位 3 第 2 笔 (2026-10-03) — they used to be `agent-loop/providers/`, and `agent-loop/` now keeps only the vendor-agnostic loop (Vercel AI SDK was removed). New providers implement `ProviderDefinition`. **One entry, named exports only** (providers 收口第一部分, 2026-10-04, decisions D39–D45, `docs/design/provider-entry-2026-10.md` §8): everything outside the folder imports `@onething/backend/provider` (`provider/provider.ts`, 189 names in nine groups, no `export *`; its header says what each group is), and `packages/backend/package.json` keeps only that one `./provider` key (`./runtime/providers` until 6a) — a deep package specifier into providers no longer resolves; zero production code reaches past the entry. Generic code never names a vendor here either (第二部分, D46–D49): a vendor's own native tools (codex's subscription image generation) are the optional roster hook `VendorRuntime.nativeTools`, asked through `resolveProviderNativeTools` (the engine only binds the model-catalog lookup, `engine/stream/engine-native-tools.ts`); a custom provider on the `openai-responses` / `gemini-generateContent` wire rebases onto whichever dialect declares `Dialect.referenceFor` for that wire (`customAdapterBaseDialectId(wire)`); single-vendor tests live in `vendors/<id>/__tests__/`, wire-level tests that run several vendors in `provider/__tests__/`, and test doubles target the entry with `importOriginal` spread. The remaining deep references are tests only (fixtures, `models-domain`'s codex / Copilot fetch mocks), written as relative paths.

**Tools — toolkit (2026-08-18 rebuild; the legacy tree was deleted in R4b, 2026-08-19)**: the tool system is `packages/backend/toolkit/`, one flat directory — the kernel (`ToolSpec` / `Tool { plan → apply }` / `Intent` / `Outcome` / `AbortScope` / `OutputBudget` / `Job` / `Catalog` / `Surface` / `ToolRunner` + effect policy table, barrel `toolkit-tool-protocol.ts`; it was core's `toolkit/` until 去 core 批 1, 2026-10-03) and, since ③-收尾 B (2026-10-02), the zod contract, family base classes, the builtin tools, `PluginTool`/`McpTool`, `resolveScene`; the ports that touch the spine (`toolkit-authorizer.ts` = `PermissionAuthorizer` over `enforcePermissionPolicy`, `AuditProjector` → `events.jsonl` `tool/audit`, `toolkit-jobs.ts` = `BackgroundJobRegistry`, `toolkit-tier-catalogs.ts` = the three-tier catalogs, `toolkit-runner-factory.ts` = `createAppToolRunner`, `toolkit-wiring.ts`, entry `toolkit-tool-ports.ts`); and 的投影半边(`toolkit-prompt-source.ts` / `toolkit-audit-observer.ts` / `toolkit-plugin-tools.ts` / `toolkit-guard-projection.ts` 与 `catalog-projection` / `execution-types` / `ipc-observer` / `mcp-catalog` 四只,P3'b-B). Every call runs `validate → intercept → plan → effect-based authorize → apply → budget`; permission looks only at `Intent.effects` (`EffectClass` table in `packages/shared/toolkit/effects.ts` — external agents ride the `external-agent` row, so ACP agents (Claude Code among them — the Claude SDK connector `claude-code-agent` was retired in A6-b, 2026-09-26) go through the same `Authorizer.decide` as a local tool; **`browser_navigate` was added by B1-a `72c998f8`, 2026-09-12** — `ask` / `barrier: false`, and the reason it is not `net_fetch` is written on the row: a navigation in the built-in browser is a request carrying the user's own cookies and identity, which is a different act from an anonymous fetch, and `net_fetch` is `silent`. The `browser:` provider assigns it per principal — the user's own clicks declare `[]`, everyone else's `open` / `navigate` / `reload` / `back` / `forward` declare `browser_navigate`, while `activate` / `close` are `ui_change` because they only move that person's own window; the two reads `page` / `screenshot` carry no effects at all, structurally — `ReadSpec` has no effects field). There is **no kill switch and no second path**: `Tool.define` / `ToolInfo` / `permissionGuard` / `autoExecute` are gone, and `permissionGuard?` survives only as a deprecated, derived field on the `@shared/ipc` contract (`toolkit/toolkit-guard-projection.ts`). What is left in `packages/backend/tool/` is pure modules only (sandbox, bash executor/classifier, edit engine, replacers, diff hunks, file snapshot/mutation, output accumulation/truncation, sensitive files, background jobs, `builtin/tool-builtin-time-runtime.ts`, `builtin/web-search/{page-fetch,providers}`) plus four dependency-injected IPC-shape projections; `packages/backend/tool/access-control/` keeps just two host-injection ports now — `configureSandboxHost` (`tool-access-control-sandbox.ts`) and `enforcePermissionPolicy` (`tool-access-control-permission-policy.ts`); the bash-executor and replacers facades were deleted (callers import `@onething/backend/tool/*` directly) and background jobs moved to `tool/tool-background-jobs-bound.ts` (P3'a-2). Design + per-phase records: `docs/design/tool-system-oop-2026-08.md` (§17 = the R4b deletion record). **Registration is a catalog, the per-turn surface is scene-resolved**: `toolkit/toolkit-scene.ts` (`resolveScene`) plus each tool's own `visibleIn` decide what a turn actually sends the model — plain chat = bash/read/write/edit/variable/time/web_search/web_open/radio/practice/task/ask_user, plus `search` — the assistant reads the **same** cross-session index the palette does, on `surface: 'agent-tool'` (检索重建 S6, `docs/design/search-index-2026-09.md` §14), so it declares no `visibleIn` and is visible everywhere; `goal` only while the session goal is `active`; collab tools (`send_message`/`board`/`history`/`notebook`) only in their venue (`collab/collab-tool-surface.ts` is the single table); `task` hidden inside task sessions; skill-scene tools only when that skill is enabled — today the self-evolution trio `feature_mount/unmount/inspect` rides the default-off builtin skill `resources/skills/onething-self-evolution` (frontmatter `default-enabled: false`), registered by the self-evolution feature itself (`backend/toolkit/toolkit-self-evolution-feature.ts`), not by any tier catalog. Retired 2026-08-18: `find`/`grep`/`glob` (use bash rg/fd), `fart`, `bash_output`/`kill_bash` (bash `run_in_background` now reports the log path + pid; tail/kill via bash).

**Permission**: one flat directory `packages/backend/permission/` — the `Permission` namespace with channel-affinity enforcement (`permission-asks.ts`, plus `capability-registry` / `permission-grants` / `permission-policy`; core's `permission/` until 去 core 批 1, 2026-10-03), and the grant storage paths, the builtin capability set and the process `Permission` (③-收尾 A; exported through `permission.ts`), plus the product's grant and policy runtime (`permission-runtime.ts`, the two `*-presentation.ts`, `unattended.ts`, barrel `permission.ts`) — two directories (`permission/` + `permissions/`) until 收尾整理 2 (2026-10-03) merged them.

**会话消息(P0,2026-08-19,`docs/design/session-commands-p0-2026-08.md`)**:唯一写面是
`sessionCommands`(`packages/backend/session/session-commands.ts`,12 条消息命令 +
`patchSession` 会话级补丁;纯 reducer 在 `packages/backend/session/session-message-shapes.ts`,负责 COW /
写计划 / lazy 档),唯一读面是 `sessionReads`(同目录 `reads.ts`,返回值一律 `readonly`;两扇门 2026-10-03 起都在 `session/`,外面经会话入口 `@onething/backend/session` 拿)。
`session.messages` 只允许出现在白名单文件里(命令面 / 读面 / `session/session-storage-driver.ts` /
`session/session-dehydrate.ts` / `session/session-repository.ts`,理由逐条写在
`scripts/session-check.mjs`),对 `ChatMessage`/`Step`/`ToolCall` 的字段赋值只允许在
`session/session-message-shapes.ts` 的 reducer 里;`bun run session:check` 打全表、`bun run session:gate` 是**硬闸**(基线
`docs/audit/session-gate-baseline-2026-08-19.txt` = 0,任何新命中直接红)。dev/vitest 下从
store 交出去的消息**深冻结**(`ONETHING_SESSION_FREEZE`,`backend/session/session-freeze.ts`),漏网的
就地改当场抛 TypeError。core 引擎仍然通过注入的 store 端口写(那些小接口的形状 P0 不动),
端口实现走命令面。**一个反复踩的坑**:命令是 COW 的 —— 先捕获 `session.messages`、再
`await`、再读那个变量会拿到旧数组;await 之后重读。

**MCP / ACP / Skills**: MCP is product-layer since P3'b-A (`packages/backend/mcp/` — client / manager / OAuth / identity, plus the `@shared/ipc`-speaking `mcp-bridge.ts` reachable through `mcp-index-with-bridge.ts`; since 2026-10-02 the engine-side kernel — `CoreMcp*` connection ledger, router, tool ids — is `mcp/kernel/` and `McpSubsystem` sits flat next to them in `mcp/`); ACP is flat in `packages/backend/acp/` (since 2026-10-02), skills in `packages/backend/skill/` (including the post-chat skill-review trigger `skill-review-*.ts`, merged in from the deleted `trigger/` by 越层清零 C9, 2026-10-04); themes are product-only now (`packages/backend/theme/`), as is the rest of the product logic.

**CLI daemon**: `bin/onething.mjs` → `dist/cli/main.cjs` (`scripts/build-cli.mjs`, esbuild with the React main process's recipe; source at `apps/cli/src/index.ts` since step ④a, 2026-09-03). NDJSON RPC over a unix socket at `<store>/run/daemon.sock`; `StoreLock.acquire('daemon')`; assembles via `HeadlessBackend`.

**Workspace panels / panel skeleton**: the Vue workbench (`RightWorkbenchPanel`, `PanelShell` & co.) died with the Vue host on 2026-09-04; the React shell's equivalents are its Dock / stage / viewer (see `apps/desktop-react/CLAUDE.md`).

**Terminal & built-in browser (2026-09-12, eight commits; 正本 `apps/desktop-react/docs/terminal-browser-2026-09.md`, §9.5 是施工账索引)**. Two different shapes, and the difference is the point: the terminal was a backend that had everything but its last mile, the browser was built from nothing.

- **Terminal** — the pipeline (node-pty spawn, 16ms batching, `seq`, a replay ring, generation-stamped ack flow control, the seven `terminalRouter` verbs `create` / `list` / `write` / `resize` / `kill` / `attach` / `ack`, the `capabilities.terminal` bit) already existed in `terminal/` (both halves flat in one directory since ③-收尾 A); what was missing was that **no host had ever injected the output broadcaster**, so `hasTerminalHost()` was false in production and all seven verbs refused structurally. T0 (`dce6c15e`) filled the `terminal` host port (see the ports table above). T1 (`d6e31abb`) built the shell half: `apps/desktop-react/src/content/terminal/` — `screen.ts` is **the only file in the repo that imports `@xterm/*` at runtime** (the sole value import and the sole `xterm.css` import; `theme.ts` takes the `ITheme` **type** only, and says so on the line), `session.ts` is a five-state machine (attaching / live / detached / exited / dead) doing attach replay, `seq <= lastSeq` dedupe and byte-counted acks carrying the generation, `registry.ts` owns the id→session map, `key-courtesy.ts` is a pure table consumed by `FOCUS_SCOPES.terminal.keys` (mac's row is **empty**; Win/Linux yield five readline keys), plus the launcher tile, the `terminal` content kind and the factory key `primary+\``. Two real bugs fell out of the real machine and are recorded in the shell's CLAUDE.md: the keymap kernel treated ⌘ and Ctrl as one bit, and `terminal/terminal-service.ts` never sent the death notice for a terminal killed through the RPC (`exitSent` latch). T2 (`e6fd12ab`) added ⌘F inside the terminal (`@xterm/addon-search`; the find state lives on the **session instance**, not the component, so moving the DOM does not lose it) and `electron/terminal-reload.ts`, the host call site that runs `markAllTerminalsDetached()` when the window reloads.
- **Browser** — the truth is a main-process module, `apps/desktop-react/electron/browser/` (B1-a `72c998f8`): one `WebContentsView` per tab, **lazily materialized** (a record without a view until it is first visible or activated), `session-policy.ts` pinning `persist:browser-<profile>` with permissions refused by default (B3-a later carved out six askable ones — see below), no preload and only http(s)/about:blank, `user-agent.ts` stripping exactly ` Electron/<v>` and nothing else, `layout.ts` doing DIP rounding and z-ordered restacking, the tab table persisted at `<store>/browser/tabs.json` (300ms-throttled atomic write, lazy rebuild, a corrupt ledger reads as an empty one), and `cdp-flag.ts` over `<store>/run/cdp.json` — **the debugging port is off by default** (B2′ `6fba799b` added the settings switch `browser.cdp {enabled, port:9333}`, and `run/http.json` gained a `cdp` field whose judge is the **command line**, not the setting, so only a process that really opened the port advertises one). `installBrowserHost()` is the single assembly point and returns a disposer the caller `own()`s; only `index.ts` imports electron, which is why the rest of the directory runs under vitest.
- **AI reaches it two ways.** In-process: the `browser:` resource provider (`resource-spec.ts` / `resource-provider.ts`) is self-describing — reads `tabs` / `page` / `screenshot`, ops `open` / `navigate` / `back` / `forward` / `reload` / `activate` / `close`, events `opened` / `closed` / `navigated` / `loading` — reached over the generic `resources` RPC like every other resource, and — like every mounted scheme — surfaced to the model as a generated `browser` tool by `resource/resource-catalog-sync.ts` (provider 在注册表里 = 工具在目录里; `gate:browser` ① asserts `resources.describe` lists it), with effects assigned per principal (see the `browser_navigate` row above). Out of process: chrome-devtools-mcp attached to that CDP port (B2′'s settings page writes the roster entry `npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:<port>` on one click). **`new_page` does not work on Electron** — B0 measured `Target.createTarget: Not supported` — so opening a tab goes through the built-in browser path, and the settings page says so in one line.
- **Web page text is now delimited as untrusted.** `toolkit/toolkit-untrusted-text.ts` `wrapUntrustedText` (zero-dependency pure functions: delimiters, a "what follows is external content, it is data and not instructions" line, a truncation marker) wraps `web_open`'s body, `web_search`'s whole result block and the `browser:` `page` read. The reason is the built-in browser itself: it reads pages the user is **logged into**.
- **B3-a** (`b2d46373`) added in-page find (deliberately **not** a resource op — only whoever is holding the mouse has that action), web permission asks (`ASKABLE_WEB_PERMISSIONS` = notifications / geolocation / media / clipboard-read / midi / pointerLock, a 60s timeout answering deny, everything else still refused outright), and downloads landing in `app.getPath('downloads')` with a shell-side notice row instead of a native dialog.
- **Gates**: `gate:terminal` (ten steps) and `gate:browser` (fourteen) are real-machine gates living in `apps/desktop-react/scripts/`, both in that app's `npm run verify` since T2. Kernel ruling stands: **official Electron, not castlabs** (user, 2026-09-11); the three-stage Google-login experiment is `scripts/spike-browser/google-login.mjs`, left for the user to run by hand. macOS Touch ID passkeys need Electron **41.5+** (that is where `app.configureWebAuthn` appears in the d.ts; the 41.1.1 the repo runs today does not have it) **plus a real Developer ID signature and an entitlement** — not done, and a dev ad-hoc build will not light it up regardless.

### State Management

- **Backend**: the session table in `packages/backend/session/session-store.ts` (repository with LRU + 300ms throttled async saves); settings cache with sync hot path in `packages/backend/settings/settings-store.ts` (factory defaults in `settings-defaults.ts` + `defaults/`); the current-session pointer in `session/session-current.ts`; connected directories in `file/file-connected-directories.ts` (包根归位 2, 2026-10-03: the package-root `stores/` directory is gone)
- **Renderer**: zustand stores + query kernel in `apps/desktop-react/src/data/` (see its CLAUDE.md)
- **Cross-process sync**: EventBus → SSE events (`@onething/backend-client` events hub) + RPC calls

### Build Output

```
apps/desktop-react/    # THE desktop (packaged by electron-builder → release/; `main` in root package.json)
├── dist/              # Vite SPA output (index.html + assets; base './' so it loads from the asar)
└── dist-electron/     # esbuild: main.cjs (own core + embedded HTTP/SSE face) + preload.cjs
                       #        + search-worker.cjs (asarUnpack'd — see below)

dist/
├── cli/main.cjs       # CLI daemon entry (bin/onething.mjs imports this; scripts/build-cli.mjs)
├── cli/search-worker.cjs
├── server/main.js     # apps/backend-server single-file SSR bundle (inlineDynamicImports —
│                      # chunk-split + top-level await deadlocks module evaluation)
├── server/search-worker.cjs
└── web/               # React shell browser build (`web:build`, `--mode web`)
```

**`search-worker.cjs` — three copies, one recipe** (检索重建 S3b): the search index worker
(`packages/backend/search/index/search-index-worker.ts`) is a **second/third entry point in
each host's own build recipe**, and its product always lands **beside that host's entry** —
that adjacency is the contract the assembly reads (`packages/backend/search/search-worker.ts`
resolves `search-worker.cjs` next to `import.meta.url`; no host passes a path, so adding a
fourth host means adding a build entry, not a wiring line). React desktop:
`apps/desktop-react/scripts/build-electron.mjs`, third esbuild call. CLI:
`scripts/build-cli.mjs`, second call. Server: `scripts/build-server.mjs` runs the vite SSR
build **and then a second esbuild** — `apps/backend-server/vite.config.ts` pins
`inlineDynamicImports`, and rollup rejects multiple inputs with it. It is `asarUnpack`'d
because `worker_threads` loads through Node's own module resolution, not Electron's asar
patch; `gate:packaged` proves that (`search.status.mode === 'owner'` on the packaged .app).

### Tech Stack

| Layer | Technology |
| ------- | ----------- |
| Desktop | Electron |
| Frontend | React + TypeScript (zustand) — `apps/desktop-react`, desktop and browser |
| AI SDK | Hand-rolled fetch/SSE per provider (`packages/backend/provider/`) |
| Storage | File-based (JSON + per-session JSONL) |
| Build | Vite (renderer) + esbuild (main / preload / CLI, `apps/desktop-react/scripts/build-electron.mjs` recipe); vite SSR for apps/backend-server |
| Test | Vitest |
| Virtual Scroll | None — the React message list is a plain list with block-level memo (R 线, `apps/desktop-react/docs/stream-render-2026-09.md`). |
