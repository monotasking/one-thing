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

# Logs
bun run log:tail           # pretty-print + follow <store>/log/app.jsonl ([--ns engine.*] [--level warn] [--session id])
bun run memory:report      # ask the live core for its memory table: per process + per holder ([--json] [--trim [soft]])
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

This is **onething**, an AI chat app with multi-provider support, tool calling, and an event-driven streaming engine. The product lives in packages; the apps are thin sockets. Three-layer mental model:

- **packages/core** — engine skeleton. Zero dependencies, zero Electron. Event bus, session, permission, tool-loop, storage primitives.
- **packages/onething-runtime/src** — the product itself (prompts, sessions, tools, providers, themes, …). Electron-free; bans `@shared/ipc` (checker-enforced); must not import the assembly tree. **The one exception is a `*.wiring.ts` file** (I3, P3'a-1): the role is in the filename, so a module that has to speak the cross-process vocabulary may import `@shared/ipc` / `@shared/events` — and nothing but another `*.wiring.ts` (or the assembly layer) may import it back. All other bans still apply to it.
- **packages/backend** — the assembly layer, a real workspace package (`@onething/backend`; it was `runtime/src/app` until P3'd, 2026-08-21). All migrated main-process glue. `@shared` IS allowed here. Exposes `createOnethingBackend`, the single assembly recipe. **Package root = the backend spine** (`backend.ts` / `store.ts` + engine/ server/ rpc/ stores/ session/ events/ channel/ features/ utils/ + `provider-binding/`); **`wiring/<domain>/` = the thin wiring** that only exists to plug a runtime domain into that spine (33 dirs: acp / agent-loop / agents / auth / collab / deeplink / engine / evals / external-agents / files / gateway / goals / headless / interaction / logging / markdown / music / permission / plugins / project-dirs / providers / scheduler / search / settings / skills / tasks / toc / todo-plan / toolkit / tools / usage / variables / voice; "thin" is aspirational — `collab` is 9.3k lines and `engine` 6.7k, and `logging` is a cross-cutting facility that happens to live in a wiring slot, fan-in 142). Since P3'c (2026-08-21) the root holds **no thick twin at all** — every domain has exactly one home. The path carries the role, so `backend/wiring/<d>` never collides with `runtime/<d>` (I1).
- **apps/\*** — thin sockets: the React desktop (`apps/desktop-react`, also the browser shell via `--mode web`), server (HTTP/SSE), CLI daemon (`apps/cli`). The Vue host / renderer / web build were deleted 2026-09-04 (runtime unification step ④; `checkVueHostStaysRetired` keeps them out).

```
apps/*  (thin sockets)
┌───────────────┬────────────────┬──────────────┬─────────────────────┐
│ desktop-react │ apps/server    │ desktop-react│ CLI daemon (apps/cli)│
│ (React shell) │ HTTP + SSE     │ --mode web   │ bin/onething.mjs →  │
│ own core+HTTP │ dynamic port   │ browser shell│ dist/cli/main.cjs   │
│ (Electron)    │                │ (dist/web)   │                     │
└──────┬────────┴───────┬────────┴──────┬───────┴──────────┬──────────┘
       │ createOnethingBackend(...)     │ /api → core      │
┌──────┴────────────────┴───────────────┴──────────────────┴──────────┐
│ packages/backend                        ASSEMBLY ('@onething/backend')│
│  spine at the package root: backend.ts (factory) + engine/ server/   │
│  rpc/ stores/ session/ events/ channel/ headless/ features/ …        │
│  wiring/<d>/ = thin wiring into runtime domains                      │
│  @shared allowed; hosts inject surfaces via configure*Host ports     │
│  (never imports electron/@main/@preload)                             │
├──────────────────────────────────────────────────────────────────────┤
│ packages/onething-runtime/src/*          PRODUCT ('@onething/runtime')│
│  prompts, sessions, agent-loop providers, tools, themes, …          │
│  Electron-free; no @shared/ipc; MUST NOT import @onething/backend    │
├──────────────────────────────────────────────────────────────────────┤
│ packages/core                            SKELETON ('@onething/core') │
│  engine, events, session, permission, tools, storage. Zero deps.     │
└──────────────────────────────────────────────────────────────────────┘
```

Dependency direction is one-way: product ← assembly ← hosts. Product code never imports `@onething/backend`.

### Monorepo Layout

```
packages/core/               # Bottom layer, zero deps. No src/ — files at package root:
                             # agent-loop/ (provider-agnostic loop), engine/ (CoreStreamEngine),
                             # events/, session/ (+storage/jsonl),
                             # permission/, tools/, plugins/, mcp/, storage/ primitives.
packages/onething-runtime/   # src/ = the product (prompts, sessions, agent-loop
                             # providers, tools, themes, voice, music, …). Electron-free.
packages/backend/            # Assembly layer ('@onething/backend'): createOnethingBackend
                             # + the backend spine at the package root, thin wiring under
                             # wiring/<domain>/. @shared allowed, electron never.
packages/gateway/            # WeChat/Telegram channel gateway. Depends on core only.
                             # Remote permission approval (reply 1/2/3), markdown-safe streaming.
packages/shared/             # Shared IPC/event contracts + defaults ('@shared'). Also
                             # backend/ (store-lock for CLI), cli/, defaults/, types/, voice/.
packages/client/             # core 的客户端 SDK ('@onething/client'): Transport (http = fetch +
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
apps/server/                 # Process shell only (main.ts + index.ts). The HTTP/SSE surface
                             # and the server runtime live in the assembly layer
                             # (packages/backend/server/), so the Electron
                             # desktop mounts the SAME code over its own backend.
```

### createOnethingBackend — the single assembly recipe

`packages/backend/backend.ts`. Every host boots through `OnethingBackend.assemble(options)` (`createOnethingBackend` is the alias every call site still uses); ordering constraints (variables before tools, engine before Permission) live here and nowhere else. **Importing `@onething/backend` modules performs no configuration** — enforced by `packages/backend/__tests__/import-side-effect-free.test.ts`; **the assembly itself is exercised end to end** by `packages/backend/__tests__/assembly-lifecycle.test.ts` (twelve assertions on a temp store: assemble → dispose → assemble, double-assembly rejection, mid-assembly failure rollback, latch re-registration, the `own()` ledger emptying, host-port restore, and `own()` after dispose running the disposer on the spot).

**`OnethingBackend` is a class, not a bag of globals** (组合根 A, `docs/design/backend-composition-root-2026-09.md`, landed 2026-09-02/03):

- The assembly products are **fields** — `eventBus` / `streamChannel` / `sessionManager` / `engine` / `runtime` / `options` — created by pure factories (`events/index.ts` `createEventSystem()`, `session/index.ts` `createSessionLayer(eventBus, streamChannel)`, `wiring/engine/index.ts` `createStreamEngineLayer({eventBus, streamChannel})`) and passed step to step. The old `initializeX` / `shutdownX` pairs are gone.
- **One process slot, `packages/backend/current.ts`** — the only module-level `let` the assembly layer keeps (`assembly:gate` exempts it). The 121 `getXxx()` accessors (`getEventBus`, `getStreamEngine`, `getSessionManager`, …) still exist but read the **current instance**; before assembly, or for a field not yet built, they throw `BackendNotAssembledError('<field>')`. Assembling while an instance is live throws `BackendAlreadyAssembledError` on the first line (it used to warn-and-return the first backend's engine). A failed assembly runs the disposers registered so far and clears the slot before rethrowing.
- **`own(disposer, label)` / `dispose()`** — whoever starts something that leaves a tail registers its teardown next to the start line; `dispose()` runs the list in reverse, each disposer in its own try/catch, then clears the list, the five assembly-product fields and the slot. It is idempotent. **`own()` after `dispose()` has started runs the disposer on the spot** (returning its promise, errors logged not thrown) instead of silently dropping it — the guard that keeps a `.then()`-deferred registration racing a fast quit from leaking, e.g. an already-spawned MCP stdio child. `shutdown()` survives as a deprecated alias. `ownedLabels()` is a read-only snapshot for tests. The rule reaches the hosts: everything a host starts after assembly (embedded HTTP surface, user scheduler, watchers, MCP/ACP, gateway) is `backend.own(...)`'d at its start site, so every host's shutdown is one `await backend.dispose()`.

Options (`OnethingBackendOptions`):

- `host: OnethingHostPorts` — **required**; the whole host-capability table in one object (see below)
- `toolRegistry?: 'full' | 'headless' | 'readonly'` — full = every builtin (desktop), headless = reduced set (default when omitted), readonly = zero-local-side-effect tools (server degradation)
- `promptVersion?` — stamp eval traces with live minimal-scene prompt output
- `sessionSkills?`, `collab?`, `mcpAcp?` — opt-in subsystems. **MCP and ACP are subsystem objects owned by the instance** (C1, `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2): `backend.mcp` / `backend.acp` (`wiring/mcp/subsystem.ts` `McpSubsystem`, `wiring/acp/subsystem.ts` `AcpSubsystem`; `start()` idempotent, `applySettings()`, `dispose()`, `state`) are constructed during assembly and `own()`'d **at construction**, so their teardown never depends on when — or whether — `start()` finished. `mcpAcp: true` (the CLI daemon) means assembly itself awaits `mcp.start()` / `acp.start()`; every other host calls `backend.mcp.start()` when it is ready (the React shell: post-window; the server runtime: after installing its own client factory). The settings domain routes `updateMCPSettings` / `updateACPSettings` through `applySettings`. `dispose()` waits for an in-flight `start()` and then `manager.shutdown()`, **bounded to 3s per subsystem** (`disposeTimeoutMs`): on timeout it logs `mcp shutdown timed out; continuing dispose` and returns, so the session flushes further down the dispose chain always run — a hung stdio handshake may then leave an orphan child, a deliberate trade (session data outranks an MCP child; the bound sits under the server's 5s SIGTERM deadline)
- `sender?: BindableStreamSender` — `engine.bind(sender)`; EventBus-observing hosts pass a noop (the engine drops commands silently with no sender bound)
- `hooks?: { afterSettings, afterEngine, afterTools }` — each is `(backend: OnethingBackend) => void | Promise<void>`: the instance is handed in **because `assemble` has not returned yet when hooks run**, and a hook that starts a watcher must `backend.own()` it

Boot order (unchanged): `configureAppRuntimeAdapters()` (idempotent) → `applyHostPorts(options.host)` → stores → settings → afterSettings → event system → session layer → StreamEngine → triggers → afterEngine → `Permission.initialize` → variable system → goal breakers → project dirs → tool registry by tier → RPC domains → afterTools → optional sessionSkills / collab / MCP+ACP / bind. Steps that hold state return a disposer that is `own()`'d on the spot (`registerBuiltinTriggers`, `bootstrapVariableSystem`, `bootstrapGoalStreamBreakers`, `bootstrapProjectDirs`, the RPC table, the ledger broadcaster, the permission/interaction recorders) — 24 registrations in all, of which **9 sit in two explicit reverse-order blocks** (engine/Permission/Interaction, and the six plugins/MCP/ACP/gateway-era rows) because registration order there cannot express today's shutdown order; the eleven `configureApp*` adapter bindings stay idempotent latches by contract.

Host call sites (four; the Vue desktop is retired as a product but still compiles and boots):

| Host | Call site | Config |
| --- | --- | --- |
| React shell (current desktop) | `apps/desktop-react/electron/main.ts` (`assembleOwnCore`; renderer talks HTTP/SSE, two IPC channels — `host:connection` + `host:native-view`) | `host: createShellHostPorts()` — auth / sandbox / storePath / **terminal** real plus `localTrust: { origin: 'desktop-embedded' }`, **eleven explicit `null`s** (the shell's capability gap is that list, not a silent omission); `terminal` moved out of that list in T0 (`dce6c15e`, 2026-09-12) — it is now `{ broadcaster: createEventBusTerminalBroadcaster() }`, which is what lifts `hasTerminalHost()` / `capabilities.terminal` and stops the seven `terminal` RPC verbs from structurally refusing; `toolRegistry: 'full'`, `promptVersion: true`, `collab: true`, `sessionSkills: true`, noop sender; post-window `own()`s the embedded HTTP surface + discovery file, the user scheduler, MCP, ACP (`backend.acp.start()` + `registerACPPermissionBridge()`, 2026-09-24 — before that the shell never started it and every ACP send died on `ACP agent "…" not found`) and (B2, `76d98911`) `installBrowserHost()`; before post-window services it awaits `electron/login-shell-env.ts` (restored 2026-09-24 from the retired Vue host) so a Dock-launched app spawns ACP adapters / MCP stdio / bash with the login shell's PATH; attaches to a live core from `run/http.json` instead of assembling when one exists |
| Headless server | `packages/backend/server/runtime.ts` (`createRealServerBackend` → `createOnethingServerRuntimeOverBackend`) | `host`: sandbox real, `storePath: {}`, fourteen `null`s; `toolRegistry: ONETHING_SERVER_TOOLS === 'readonly' ? 'readonly' : 'full'` (desktop parity by default), `sessionSkills: true`, noop sender (SSE observes the bus directly); its own MCP client factory is installed later by the server runtime per `processPorts`, not through the table |
| CLI daemon | `packages/backend/wiring/headless/backend.ts` (`HeadlessBackend`, used by `apps/cli/src/daemon-server.ts`) | same `host` shape as the server (fourteen `null`s); `toolRegistry: 'headless'`, `sessionSkills: true`, `mcpAcp: true`, `collab: true`, noop sender; shutdown = `backend.dispose()` (the hand-written list is gone) |

Note: `backend.ts` carries static `import './tools/builtin/{index,headless,readonly}.js'` edges purely so single-file bundlers order the tool barrels before the factory's top-level await (the registry itself dynamic-imports them for test mocks). Do not remove them.

**Host ports are one table, `OnethingHostPorts` (`packages/backend/host-ports.ts`)** — how hosts contribute Electron-only surfaces without the assembly layer importing electron. Every key is required (sixteen since B3); fourteen accept an explicit `null`, which means "this host has no such capability" and leaves the underlying port untouched (today's structured degrade or noop — `applyHostPorts` simply does not call that `configure*`). Omitting a key is a `tsc` error (`__tests__/host-ports.type.test.ts` pins it). The underlying single-slot `configure*` functions are unchanged; hosts just no longer call them one by one:

| Key | Underlying port | File |
| --- | --- | --- |
| `storePath` (non-null) | `configureStorePathHost` | `backend/stores/docs-paths.ts` |
| `sandbox` (non-null) | `configureSandboxHost` | `backend/wiring/tools/core/sandbox.ts` |
| `auth` | `configureAuthHost` | `runtime/src/auth/host-ports.ts` (product layer since P3'a-1 — zero spine deps) |
| `logging` | `configureAppLoggingHost` | `backend/wiring/logging/index.ts` |
| `shell` | `configureShellHost` | `runtime/src/shell/host-ports.ts` (打开路径 / 打开外链 / 在文件管理器里定位;未注入即结构化降级) |
| `voice` | `configureVoiceHost` | `runtime/src/voice/host-ports.wiring.ts` |
| `skillsEnvironment` | `configureSkillsEnvironmentHost` | `backend/wiring/skills/loader.ts` |
| `todoPlan` | `configureTodoPlanHost` | `backend/wiring/todo-plan/store.ts` |
| `scratchpad` | `configureScratchpadHost` | `runtime/src/scratchpad/service-bound.ts` |
| `plugins` | `configurePluginsHost` | `backend/wiring/plugins/host-ports.ts` (native file dialog + plugin-command subprocess runner; unset = structured degrade) |
| `gateway` | `configureGatewayHost` | `backend/wiring/gateway/host-ports.ts` |
| `settings` | `configureSettingsHost` | `backend/wiring/settings/host-ports.ts` |
| `evals` | `configureEvalsHost` | `backend/wiring/evals/host-ports.ts` |
| `mcp` | `configureMCPClientHost` (only when `clientFactory` is non-null — `null` keeps the built-in `MCPClient`) + `configureMCPClientIdentity` | `runtime/src/mcp/{manager,identity}.ts` |
| `terminal` | `configureTerminalBroadcaster` (the PTY output push; `hasTerminalHost()` is what the `terminal` RPC domain asks). **React shell injected = the output rides the `terminal:data` / `terminal:exit` global events out over SSE** (T0 `dce6c15e`, 2026-09-12: `createEventBusTerminalBroadcaster()` in `backend/wiring/terminal/bus-broadcaster.ts` calls `getEventBus().emitGlobal` at send time, and warns-and-drops before the event system exists rather than throwing up into `pty.onData`) — no hand-written push channel, because this shell has no room for one. Its restore `await killAllTerminals()` first, which is why `applyHostPorts`'s restore list became async and is awaited one by one | `runtime/src/terminal/service.wiring.ts` (B1, 2026-09-03) |
| `localTrust` | `configureHostLocalTrust` — `{ origin: 'desktop-embedded' }` on both desktop shells, `null` on server (it declares `loopback-server` itself at listen time) and daemon | `backend/server/host-trust.ts` (was `local-trust.ts`; B2/B3) |
| `dialog` | `configureDialogHost` — the native open dialog (pick a directory / file) behind the `dialog` RPC domain (`@shared/ipc/dialog.ts` → `rpc/domains/dialog.ts`). React shell injects `dialog.showOpenDialog` on the focused window; `null` answers `{ canceled: true, filePaths: [], unavailable: true }` and the renderer falls back to its path-input window (`content/files/open-dir-hub.ts` `requestDirectory` — the one "pick a directory" entry: composer workdir button, Files panel 「绑定…」, 「打开目录…」, terminal 「在目录…新建」, notes folders). Kept apart from `shell` on purpose: `shell` is a latch that flips `capabilities.shellTools` | `runtime/src/dialog/host-ports.ts` (2026-09-24) |

**Every one of the sixteen is restorable** (C0 R6): each module exports a `reset*` next to its `configure*`, and the restore function `applyHostPorts` returns undoes — in reverse — exactly the slots this assembly actually wrote. `assemble` `own()`s it as `hostPorts`, so `backend.dispose()` puts the process back to "no host has injected anything"; a second backend in the same process no longer inherits the first one's voice / plugins / sandbox ports. `localTrust` keeps its identity-guarded restore (`if (declaration === next)`) and, being registered last, is undone first.

**Deliberately outside the table**: `configureLogging` (the host calls it *before* assembly; it owns the log file and the janitor, which outlive the backend), the window-system ports (`configureGlobalWindowShortcuts` / `configureBrowserWindowProvider` / `configureDeepLinkService` / `configureVoiceTray` / `configurePluginAppVersion` / `configurePluginMarketIndex`), the eleven `configureApp*` internal adapter bindings, and the three `configureServer*Port` slots the server runtime fills itself.

### Guardrails

- `bun run boundary` — `scripts/headless-boundary-check.ts`, the heavy static checker. Key rule sets: core bans electron/`shared/ipc`/better-sqlite3/mcp+acp SDKs/zod/diff/uuid; `packages/onething-runtime` bans electron **and** `@shared/ipc` — except `*.wiring.ts` files, which may import `@shared/ipc`/`@shared/events` and which no non-wiring product file may import (`checkRuntimeWiringModulesStayAtTheEdge`); `packages/backend` gets a relaxed set — `@shared/ipc` allowed, but electron, `@onething/electron-host`, `@main/`, `@preload/` banned (hosts inject via configure*Host ports).
- `bun run boundary:gate` — `scripts/boundary-gate.mjs`, a **zero-baseline hard gate**: any `[boundary] failed:` line exits 1. The ratchet and `docs/audit/boundary-baseline-2026-08-07.txt` (13 known legacy reds) were retired 2026-08-21 by 结构债方案 P2 — 4 reds were fixed in source, the other 9 were stale/false-positive assertions and were fixed in the checker. Two anti-footgun guards survive: no `[boundary] complete:` marker (checker crashed mid-run) or no `[boundary] ok:` line at all (output shape changed) is red, not green.
- UI 组件与样式规则:通则见 `docs/design/ui-system.md`(浮层决策树、交互态配方、z-index 层级表、禁令清单),**React 壳自己的施工规范与判例在 `apps/desktop-react/CLAUDE.md`** —— 那是今天唯一的壳。`bun run ui:gate` / `ui:check` 与它们背后的 `scripts/ui-gate.mjs` / `scripts/ui-style-check.mjs` 及基线 `docs/audit/ui-baseline-2026-08-13.txt` **已随 Vue 宿主一起退役**(2026-09-04,`50ff9cbd`;根 `package.json` 里 `ui*` 脚本为零)——那 12 条规则扫的是 `.vue` 文件。今天的 UI 执法全部在 `apps/desktop-react` 下:静态棘轮 `npm run ui:consume`(基础件消费门,`scripts/ui-consume-gate.mjs` over `ui-consume-check.mjs`,基线 `docs/audit/ui-consume-baseline-2026-09-01.txt`;响应链三条 `keydown-outside-focus` / `focus-outside-focus` / `active-element-read` 是**零基线硬闸**)、`npm run squeeze-gate`(基线 `docs/audit/squeeze-baseline-2026-08-30.txt`)与 `npm run motion-gate`(基线 `docs/audit/motion-baseline-2026-08-31.txt`);真机门 `npm run gate:squeeze` / `gate:a11y` / `gate:motion` / `gate:focus`,四条都已进 `npm run verify`。**同名的门有两半就跑两半**——真机量重叠,棘轮抓源码违例。
- `bun run log:gate` — `scripts/log-gate.mjs` ratchet over `scripts/log-check.mjs`: counts `console.*` call sites in non-test source, baseline `docs/audit/log-gate-baseline-2026-08-20.txt` (854 at L1; **822** after the L2/L3 gateway + crash-log migration; L4 消掉其余). Whitelist: `scripts/` and the CLI's product-output helper `apps/cli/src/stdout.ts` (**给人/管道看的 = `stdout()`;给排障看的 = `getLogger(ns)`**). New code must not add a `console.*` — use `getLogger`.
- `bun run assembly:gate` — `scripts/assembly-gate.mjs` ratchet (组合根 A3, 2026-09-03): counts module-level `let` per non-test file under `packages/backend`, baseline `docs/audit/assembly-baseline-2026-09-02.txt` (99 across 63 files; `packages/backend/current.ts` is the one exempt slot). **Decrease-only**: a file above its baseline or a file not in the baseline is red. `bun run assembly:check` prints the full table; `--write-baseline` tightens it after a real drop. The intent is that new assembly-scoped state lives on the `OnethingBackend` instance and is `own()`'d, never in a fresh module slot.
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
  crash hook 一行都写不出)。修法是 `transformers-onnx.ts` 的 `PIPELINE_OPTIONS.session_options`
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
- `packages/core/__tests__/architecture-boundaries.test.ts`: core has no electron/host imports and sits at the bottom (no `@onething/runtime`/`@onething/gateway`); runtime is Electron/host/gateway-free; **the runtime product layer must not import `@onething/backend`** (dependency points one way: product ← assembly); **I1 — `packages/backend`'s root directory names must not shadow a `packages/onething-runtime/src` domain name** (`wiring/` excluded; the thick-twin allowlist is **empty** since P3'c, and the assertion stays as a ratchet against a new root directory growing back); **I2 — inside a shared domain name, `packages/core/<d>/x.ts` and `packages/onething-runtime/src/<d>/x.ts` must not both exist** (`index.ts` / `types.ts` / `__tests__/**` and a built-in plugin's `plugins/<id>.ts` — whose name is pinned to the plugin id — are structurally exempt; 4 shrink-only allowlist entries: `mcp/manager.ts`, `storage/{file-storage,paths}.ts`, `tools/diff-hunks.ts`); gateway depends on core only; apps/server is Electron-free (the Vue renderer / apps/web rules died with them on 2026-09-04).

Notes:

- **Logging** (L0–L3 landed 2026-08-20, `docs/design/logging-system-2026-08.md` §7;
  current-state audit: `docs/audit/logging-inventory-2026-08-19.md`). One facade, one
  record shape, one governor:
  - `packages/core/logging/` (zero deps, zero node imports) owns `Logger`
    (`trace/debug/info/warn/error/fatal/child(fields)`), `LogRecord
    {time, level, ns, msg, fields?, err?, src?}`, `LevelFilter`, `ConsoleSink(pretty|json)`,
    `MemoryRingSink`, `normalizeError`. The **mechanism** (JsonlFileSink /
    RollingFileLogger / LegacyConsoleSink / janitor / crash-hooks / legacy-debug-env)
    is Electron-free and lives in `packages/onething-runtime/src/logging/` next to the
    `getLogger` facade; `packages/backend/wiring/logging/`
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
  - **Renderer logs ride their own hub, not a console side-effect** (L3; the React shell's copy is
    `apps/desktop-react/src/services/log.ts`, the Vue original died 2026-09-04): `getLogger(ns)` over a `RendererLogHub`
    (memory ring 200, dev-only pretty echo, batched transport every 16ms / 50 records,
    `beforeunload` + `fatal` flush immediately). It reuses the **same** `packages/core/logging`
    kernel the main process does — that package is browser-safe. Transport is the generic
    RPC envelope, **not** a hand-written channel: `logs` is a router domain
    (`@shared/ipc/logs.ts` + `backend/rpc/domains/logs.ts` + `platform/logs-client.ts`), so
    desktop rides `rpc:invoke` and web rides `POST /api/rpc` behind the same Bearer gate,
    with zero shell edits. The receiving handler stamps the trust-level fields itself:
    `ns` prefixed `renderer.`, `src='renderer'`, caller from the dispatch context — a
    sender never gets to say who it is. `services/crash-log.ts` keeps its four capture
    points, its localStorage ring and `window.__onethingCrashLog.dump()`, but is now a
    *producer* on the hub: one structured record per entry, Vue warns deduped to **one**
    `warn` with `fields.stack`, and no console line at all.
    `window.__onethingLog.dump()` is the hub's own crash-scene口.
  - **The gateway takes a logger at construction** (L2): `startGateway({ getLogger })`
    (same signature as `@onething/backend/wiring/logging`'s `getLogger`) — the Electron host passes
    its own, so gateway records land in `app.jsonl` under `gateway.wechat` /
    `gateway.telegram` / `gateway.bridge` / `gateway.storage`. Classes take an explicit
    `logger?`; free functions read the process-level factory
    (`packages/gateway/src/core/logging.ts`). Nothing injected = a `LoggerRoot + ConsoleSink`
    fallback, so `packages/gateway/src` has **zero** `console.*`.
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
  driver: `packages/onething-runtime/src/sessions/storage-driver.ts`; pure jsonl
  codec/pager in `packages/core/session/storage/jsonl/`. See
  `docs/design/session-storage-jsonl.md`.
- **Cross-session search runs off a derived index, in a Worker** (检索重建 S3,
  `docs/design/search-index-2026-09.md`; the old line here said indexing belongs in
  apps/server and that the Electron main process must not add a database — that ruling
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
  `runtime/src/search/__tests__/golden-snapshot.test.ts` — the S0 corpus folded into a real
  `SqliteIndex`, and the **strict-tier hit set** of the 20 golden queries + 20 golden
  paraphrases frozen as JSON. What survives of the old path lives where it belongs:
  each capability owns its own matcher (`capabilities/{actions,prompts,files}.ts`), the
  notes capability (`capabilities/notes.ts`, 笔记 P2 2026-09-18 — it replaced `daily.ts` +
  `daily-notes.ts`: one `VaultFeed` per enabled note vault, facets `vault` / `path` / `time` /
  `daily`, the "today" shortcut and the `create-daily` / `create-note` page actions, all read
  off the notes domain below) and
  `capabilities/scan-adapter.ts` (was `legacy.ts`) is just the base that wraps a
  `(query, limit, filters) => SearchResult[]` matcher. `runtime/src/search/providers.ts`
  is now only the adapter interface (`getNoteVaults?` / `getPrimaryNoteVault?` are how the
  notes domain reaches it). The boundary rule
  `search has exactly one query path` is the coroner's table: those shapes and names may
  not grow back.
- **Semantic recall is a second retriever on the same index, and it is OFF by default**
  (检索重建 S7, 2026-09-05; `docs/design/search-index-2026-09.md` §15). The index base
  holds a **list** of retrievers, not a function: `[lexical, vector]` fused by RRF (k=60),
  and **which of them runs on a given call is data** — each capability declares
  `manifest.retrievers[<retrieverId>] = { when: 'relaxed' | 'explicit' | 'always' }`, so
  `packages/core/search` never names a retriever, a capability, or a surface. The vector
  half is `sqlite-vec`'s `vec0` virtual table inside the **same** `search.v1.sqlite`, one row
  per 512-token chunk, plus an `Embedder` registry (`runtime/search/embedding/`) whose real
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
  so `wiring/search/index.ts` swaps the Worker — **a finished download takes effect without the user
  touching the switch again**. "Downloaded in full" is judged by a manifest written *after* the
  download settles (`embedding/model-store.ts`), never by "the files are there": transformers'
  `FileCache.put` writes straight to the final path, so a killed process leaves a truncated `.onnx`
  that a file-existence check would happily call complete. Same reason the empty-vector-table case
  re-queues: a Worker that wrote the header and then turned itself off must not make the next one
  think the index is already embedded.
  **That switch is hot-applied** (2026-09-17): `wiring/search/index.ts` chains onto the
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
  `globalThis.fetch` for the **same** managed fetch providers use (bypass rules, dispatcher and
  SOCKS5 are one implementation, not two; changing the proxy swaps the Worker like changing the
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
  Route 1 of the three was taken: `transformers-wasm.ts` → **`transformers-onnx.ts`** with
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
  (`packages/core/session/projection/`) folds that stream into state, and
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
  (`backend/session/shadow.ts`, §14.3-B): at every run end the ledger's *file bytes* are
  re-folded and compared with the live projection — two store-independent paths — and any
  diff lands one summary line in `<store>/log/session-shadow.jsonl` and counts into
  `session-shadow-stats.json` (`refoldChecks` / `refoldMismatches`). The identity gate
  (projection vs in-memory store) was retired in c4 because the store is no longer any
  read's source of truth — "comparing yourself with yourself" would go green for the wrong
  reason. Both sides still go through the one judge in
  `packages/core/session/projection/canonical.ts` — extend that file, never add a local
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
  (`apps/server/src/main.ts` only refuses `owner !== 'server'`) — the foreign-writer guard
  catches that after the fact.
- **Trace = the read-only query surface over `events.jsonl`** (S3, §12 of the same doc).
  One pure assembler (`packages/core/session/trace/assemble.ts` → `Session → Run →
  Request → ToolCall`; timestamps only, no stored durations, no response body) feeds three
  outlets: `onething trace <sessionId> [--run <id>|--last] [--json] [--response <k>]`
  (reads the file directly, no daemon, never writes), the `sessionEvents` RPC domain's
  `getTrace` / `getResponseText` (desktop IPC and web/HTTP alike, the latter over the
  generic `POST /api/rpc` — there is deliberately **no** dedicated REST route; adding a
  domain must not add a hand-written channel), and the trajectory panel's run grouping.
  Response text is materialized on demand from the `assistant/chunks` fold, never carried
  on the tree. It reads the same ledger the product reads.
- **Notes are a domain, and Obsidian is one driver of it** (`docs/design/notes-obsidian-cli-2026-09.md`,
  P1–P4 landed 2026-09-18). `packages/onething-runtime/src/notes/` owns `NoteVault` (daily note /
  create / attachment path / link text / resolve-by-name / list / live search / open-in-app) and a
  `NoteSystemRegistry` of self-describing `NoteSystemDriver`s (first claim wins, `vaultFor` = longest
  prefix); `obsidian/` talks to the **official Obsidian CLI** (`ObsidianCli`: `vault=<id>` is argv[0],
  exit code is always 0 so errors are the first stdout line, stdout is always read to the end, 10s
  budget, and **liveness = connecting `~/.obsidian-cli.sock`** — no socket, no command, because a
  command sent while the app is closed launches it; `eval` scripts live in one file, `scripts.ts`;
  a per-vault snapshot under `<store>/notes/obsidian/` reproduces the three rules when the app is
  not running); `folder/` covers plain directories. Assembly: `backend.notes` is a subsystem
  (`wiring/notes/index.ts`: `registry` / `refresh` / `inventory` / `systemState` / `onRefreshed`;
  trust is judged per `refresh`, so `server:start` calls it after declaring loopback trust) and
  `noteRootsNow()` there is the **only** definition of "note roots" — sandbox roots, search scan
  and authorization roots, `@` file mentions, markdown attachments and skill roots all read it;
  connected directories are a permission surface, not note roots. Settings: `settings.notes =
  { systems: Record<driverId,{enabled?}>, vaults: Record<id,{enabled?,skills?}>, primaryVaultId?,
  folders, dailyFormat, attachmentDirectory?, migratedAt? }` (global, not per-space), seeded once
  from `obsidian.json` and the old `user_note_dir` / `work_note_dir` values by
  `wiring/notes/migration.ts`; those two variables, `general.dailyNotes`,
  `editor.markdownNoteAttachmentDirectory` and the `note-skills` plugin are **gone**; the AI reads
  the read-only `note_vaults` variable instead. The shell's settings page has a 「笔记」 section
  over the `notes` RPC domain (`list` / `refresh` / `openInApp` — the only call that may launch
  the app). Gate: `bun run gate:notes` (read-only, only open vaults, skipped when the socket is
  not there).
- **Process memory has one table** (2026-09-25, 起因:用户「程序跑起来接近 2G」). Mechanism
  `packages/core/memory/` (`MemoryRegistry` + `MemoryGovernor`, zero deps), assembly
  `packages/backend/wiring/memory/` → `backend.memory`. Whatever holds reconstructible memory
  describes itself as a `MemoryHolder` (`usage()` must be cheap; `trim('soft'|'hard')` may only drop
  what can be rebuilt, never the only copy, never a live run) and is registered **with one line** at
  its assembly site — today `events.replay-buffers` (`backend/events/memory.ts`; those per-session
  rings used to be freed only on session delete), `sessions.projections` + `sessions.cache`
  (`backend/session/memory.ts`; they are released together, because the LRU session object holds
  the messages materialized from the projection). Hosts add a `MemoryProcessProbe`: core registers
  its own RSS, the React shell adds `app.getAppMetrics()` (`electron/memory-probe.ts` — renderer /
  GPU / each built-in browser tab). The governor samples every 30s and trims over budget
  (`ONETHING_MEMORY_SOFT_MB` / `_HARD_MB`, default 1024 / 1536, 2 min cooldown, one `warn` line in
  `app.memory`). Read it with `bun run memory:report` (`memory` RPC domain: `report` for anyone,
  `trim` for locally trusted callers only; `--trim [soft]`). The table never names a holder:
  adding one = its own module + one `registerHolder` line.
- There is no memory subsystem. The soul-memory plugin (SOUL/MEMORY.md + daily notes,
  panel, settings tab, `/api/memory/*`) was retired 2026-08-06 — see
  `docs/audit/soul-memory-retirement-2026-08-06.md`. Nothing reads or writes those files;
  leftover data is archived via `scripts/archive-soul-memory.mjs`. `usage` still accepts
  `source: 'memory'` so historical ledger rows resolve.
- Plugin system (R0–R7 complete, 2026-08-07). The plugin's entire power is the injected
  `api` object.
  **Where the code lives (P3'c, 2026-08-21 — three homes, no fourth):**
  `packages/core/plugins/` = the **contract + kernel** (37 files: manifest/api shape,
  the `Core*` registries for lifecycle / input-intercept / tool-call-intercept /
  tool-result-intercept / status / sessions / storage, the policy + breaker tables,
  `ui-anchor.ts`, `file-pick.ts`, `canonical-order.ts` — zero deps);
  `packages/onething-runtime/src/plugins/` = the **product half** (the one
  built-in plugin `log-monitor` — `note-skills` was retired by 笔记 P3 on 2026-09-18, note
  vaults reach the skill loader through `wiring/notes/skill-roots.ts` instead — the config store + schema projection,
  npm-tarball reading, runtime health, the IPC-shape projections, and the
  process-singleton bindings of the core kernels — `status-bound.ts`,
  `input-intercept-bound.ts`, `tool-call-intercept-bound.ts`,
  `tool-result-intercept-bound.ts`, plus `lifecycle.wiring.ts` / `tarball.wiring.ts`
  which speak `@shared/ipc`);
  `packages/backend/wiring/plugins/` = the **assembly half** (20 files: `loader` /
  `manager` / `api` / `install` / `store` / `sessions` / `llm` / `skin` /
  `theme-overrides` / `webview` / `background` / `file-import` / `notify-sound` /
  `types` + `commands` (the one command-execution wiring the `plugins` RPC domain and the
  gateway command provider share) + `host-ports` (`configurePluginsHost`) + `events`
  (`configurePluginRequestProgressBroadcaster`) + `builtin/` 插座 — everything whose
  import closure hits the backend spine).
  A file's name says which half it is; nothing about plugins lives anywhere else.
  Current surface:
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
    the Vue renderer's `ui-anchor-registry` (deleted 2026-09-04 with the Vue host — the plugin UI-slot surface has **no React consumer yet**; the contract in `packages/core/plugins/ui-anchor.ts` stands).
    Render ctx carries `anchor` +
    `sessionId`, the host re-pulls on session switch. Renderer pieces:
    `components/plugins/{UiSlotHost,UiSlotBlock,PluginTriggerPopover}.vue` +
    `usePluginTriggerEntries.ts`),
    theme token overrides (`contributes.theme.overrides`, B 期/L2 — keys must be
    existing `CSS_VAR_MAP` token paths, values must pass a color-literal whitelist;
    illegal entries are dropped and shown in the catalog projection, never a load
    error; conflicts resolve by canonical order (pluginId lexicographic) last-wins;
    the resolved token table is passed as a **parameter** into `applyTheme` from
    `packages/backend/rpc/domains/themes.ts` (the `themes` RPC domain — since P4c
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
    earlier wording got wrong: apps/server is *not* a read-only mirror — `plugins.enable`
    / `.disable` / `.refresh` do write enable-flags to disk, and it scans a different tree
    (`owners/<uid>/<wid>/plugin-store/plugins`, not `<store>/plugins`), so toggling there
    changes a catalog the desktop never reads. The CLI daemon does not assemble the plugin
    system at all (it is not "UI-less" — it has no plugins).
    Since P4 终态批 C2 (2026-08-23) the whole domain rides the generic RPC channel
    (`pluginsRouter`, 19 invoke methods; `packages/backend/rpc/domains/plugins.ts`) — the
    six `/api/plugins*` REST routes and the parameterized 501 are gone. Since B1 (2026-09-03,
    `docs/design/backend-transport-forks-2026-09.md`) the domain no longer reads
    `context.transport` at all: every face is judged by **whether a plugin manager is assembled
    in this process** — manager present → the manager (IPC and HTTP alike, so the old
    read-mirror/write-desktop split-brain on the embedded face is gone); no manager → the 7 read
    faces fall back to `backend/server/plugin-catalog.ts`'s single-slot server-mirror port when the
    server runtime installed one, and the 11 write faces answer "desktop host only" (the React
    shell assembles no plugin manager today, so on it every plugins face degrades that way; a standalone `server:start` does not and
    returns the structured "desktop host only" answers verbatim). The renderer adds a
    second layer: capability bit `pluginsManage` (`platform/types.ts`) is `false` on web,
    so `platform/plugins-client.ts` never even sends the write faces. Two pushes stay on
    hand-written channels: `PLUGINS_NOTIFICATION` (a global bus event fanned out by
    IPCBridge) and `PLUGINS_REQUEST_PROGRESS` (targeted back at `RpcDispatchContext.callerId`
    via `configurePluginRequestProgressBroadcaster`). Two host capabilities are injected
    through `configurePluginsHost` (`backend/wiring/plugins/host-ports.ts`): the native
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
  assembly-layer code (`packages/backend/server/{http,runtime,discovery,embed}.ts`);
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
  shutdown (**only when the record's `pid` is its own** — `removeHttpDiscovery` never removes another live core's
  record, so a failed mount on a busy port cannot orphan the core that actually owns it), and answers on a **dynamic** port unless `ONETHING_SERVER_PORT` pins one (pinned
  and busy = explicit error, never a silent fallback). `server:start` reads that file first and
  **refuses to start** when a live record says `owner !== 'server'` (`--force` bypasses); alive
  means pid alive **and** the port connects. Token = `ONETHING_SERVER_TOKEN` or a fresh
  `randomBytes(24).base64url` per launch.
- apps/server is single-user: one server process assembles one backend and pins
  `ONETHING_STORE_PATH` before boot. Bearer auth via `ONETHING_SERVER_TOKEN` (warns when
  binding non-loopback without it; loopback launches mint their own token into the discovery
  file). Tools ship with desktop parity by default;
  `ONETHING_SERVER_TOOLS=readonly` degrades to zero-side-effect tools (read/time/web only).
  The server's HTTP session store is backed by the same `@onething/backend` store the engine
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
- Renderer code talks to core only through `@onething/client` (`createOnethingClient` over an http `Transport`); the React shell's data plane has no IPC at all — its two IPC channels are `host:connection` (the `{ baseUrl, token }` handshake) and, since B1-a (`72c998f8`, 2026-09-12), `host:native-view` (the window-system pipe for native views). `window.electronAPI` no longer exists anywhere.
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
  `desktopPromptComposer` (`backend/wiring/engine/prompt/system-prompt.ts`) = builtin + tools +
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
  against the visible history and `SessionTurnContext` (product layer since P3'e-A2b,
  `runtime/src/engine/session-turn-context.wiring.ts`, hooked into the `buildPrompt`
  wrapper in `backend/wiring/engine/stream/agent-loop-runtime.ts`) persists the delta on the message
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
`backend/server/host-trust.ts`, declared by the host table's `localTrust` key at assembly and again by the
embedded HTTP face when it mounts; a loopback `server:start` declares itself at listen). The shell is therefore
`desktop-embedded`-trusted: background jobs, whole-machine search, evals paths, MCP config reads and stdio
probes behave as on the old IPC desktop. `GET /api/capabilities` derives `localFileSystem` / `shellTools` /
`terminal` / `pluginsManage` / `collabRooms` from those same predicates, so a client's capability bits and
the backend's guards can no longer disagree. `bun run transport:gate` ratchets the per-file count of
`context.transport` reads under `packages/backend/rpc/**` (recursive since C0 — `rpc/sandbox.ts`, the sandbox helper seven
domains share, is in scope and asks `isHostLocallyTrusted()` too; baseline `docs/audit/transport-forks-baseline-2026-09-03.txt`:
5 reads in 5 files, decrease-only) and pins the React shell's `ipcMain` registrations at ≤ **2** (raised from 1 by B1-a `72c998f8`, 2026-09-12, with the reason written into the baseline file: `host:connection` is the data plane's one seam, `host:native-view` is the **window system's** pipe for native views — five verbs on one channel, `electron/browser/native-view-ipc.ts` being the only `ipcMain.on` for it, and its payload is parsed by the pure `parseNativeViewRequest` because a renderer frame is not trusted; the data plane gained nothing. The same commit made the gate's `ipcMain:` scan root **recursive** — otherwise a channel registered from a subdirectory walks past the ruler, the same hole C0 R2 closed for `forks:`).

**There is no second host.** The Vue three-process IPC host (`apps/electron` + `packages/renderer` + `apps/web`) was deleted on 2026-09-04 (runtime unification step ④, `docs/design/runtime-unification-2026-09.md`). Its `shell:invoke` window-system channel, `@main` / `@preload` / `@renderer` aliases, `electron-vite` build, `macos_panel` native module and the `?token=` query hole on `GET /api/events` went with it. Push to the desktop renderer rides the same SSE face every other client uses.

### Key Data Flows

**Chat Message Flow (both transports, same engine):**

```
renderer (React) → client.api(sessionCommandRouter).emit({ sessionId, command: { type: SESSION_COMMAND_TYPES.SEND_MESSAGE, … } })
→ generic RPC envelope `POST /api/rpc` (desktop over its embedded HTTP face, browser via the dev proxy / server; same domain,
  same handler — there is deliberately no hand-written session-command channel)
→ packages/backend/rpc/domains/session-command.ts → emitCoreSessionCommandForIpc
  (ipc: sanitizeRendererCommand stamps origin + amends the evals turn record;
   http: command:abort is handled locally and a channel-less permission respond
   adopts the pending ask's targetChannel — nothing else is destructured away)
→ EventBus (packages/backend/events/, per-session ring buffers)
→ ProductStreamEngine.handleSendMessage (packages/onething-runtime/src/engine/stream-engine.ts)
  → persist messages → emit events + stream chunks
→ desktop: IPCBridge → 'session:event' / 'session:stream' to WebContents
  web:     GET /api/events SSE (same event names; ?after= replays from ring buffers)
```

Both fan-outs share **`SessionStreamCoalescer`** (`packages/backend/events/stream-coalescer.ts`): text/reasoning/tool-input deltas batched on a 16ms ordered buffer, active stream's `messageId` stamped onto every chunk, and pending deltas flushed before any session event goes out. Consumers: `apps/electron/src/main/bridges/ipc-bridge.ts` and `packages/backend/server/http.ts` (per-SSE-connection instance).

That same `GET /api/events` also carries the **non-session** pushes (`packages/backend/server/global-event-delivery.ts`): `settings:changed`, and since 原子 K2a' every global event whose row in `@shared/events`'s `GLOBAL_EVENT_LEAVES_PROCESS` says it may leave the process (`resource:event` among them) — one frame per event, `event` name = the event's `type`. They do **not** enter the coalescer, carry no `id:`, and `?after=` never replays them: sequence numbers and ring buffers are per session, and a global event has no session.

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
| Handler lives in | `packages/backend/rpc/domains/` (assembly layer, electron banned) |
| Dispatch table | `packages/backend/rpc/registry.ts` |
| Client | `@onething/client` — `client.api(router)` over a `Transport` (generic: no per-domain client files) |
| Context | `RpcDispatchContext` (`transport` / `ownerUid` / `workspaceId` / `callerId` / `sandboxRoot`) |

(The Vue host's second channel `shell:invoke` — window-system handlers that had to touch Electron itself — died with it on 2026-09-04; the React shell keeps **two** IPC channels and neither is a data plane: `host:connection` hands the renderer `{ baseUrl, token }`, and `host:native-view` (B1-a `72c998f8`, 2026-09-12) is the window-system pipe for native views — five verbs, frames carry a `viewId` so a second kind of native view reuses the same channel, and `electron/native-view-protocol.ts` deliberately lives outside `electron/browser/` for that reason.) The envelope (`RpcRequest` / `RpcResponse`, `@shared/ipc/rpc.ts`), the contract style (`defineRouter`), the client factory (`createRouterClient`) and one rule about identity: **the host mints the context after its own auth ran; it is never read off the envelope.** A second rule since route B: **a handler may read `context.transport` only to pick the reply channel or to decide redaction for a payload that leaves the process** — "does this host have X" is a host-port question (`OnethingHostPorts`), "may this caller do X" is a local-trust question (`isHostLocallyTrusted()`), and `transport:gate` counts the reads per domain file, decrease-only.

**To add a data-plane domain** (2 steps): `defineRouter` in `@shared/ipc/<d>.ts` → register handlers in `packages/backend/rpc/domains/<d>.ts`. Clients call `client.api(<d>Router)` — no client file, no shell file changes.

**`packages/shared/ipc/channels.ts` is now the push side plus one residue**: `session:event` / `session:stream` / per-domain broadcasts, plus the one-way high-frequency `voice:audio-chunk`. **Terminal and browser no longer have any constant in this table** (2026-09-12): T0 (`dce6c15e`) deleted the two zero-import `TERMINAL_DATA` / `TERMINAL_EXIT` constants — terminal output rides the `terminal:data` / `terminal:exit` **global events** out over `GET /api/events`, and replay belongs to `attach`'s ring + seq + generation, not to SSE; B1-a (`72c998f8`) deleted `BROWSER_TABS_CHANGED` together with the whole orphaned `shared/ipc/browser.ts` (A1-b's 19-verb `browserRouter`, whose only host was the retired Vue shell, with zero imports left in the repo), and browser state today is a `browser:` resource whose reads/writes go through the generic `resources` RPC. Since A1-b (2026-08-23) the whole window system rode `shell:invoke` — browser's 19 request verbs (now deleted with that contract), and the four channels that were never in this table at all (`shell:open-path` / `shell:open-external` / `app:get-data-path` → the new `shellRouter`; `window:set-button-visibility` → `windowRouter`, because it acts on the **caller's own window**). `search:query` became the backend `search` RPC domain, forked on **local trust** (`isHostLocallyTrusted()`; it asked `context.transport` until B2). Locally trusted hosts get this process's own `SearchService`; an untrusted one goes through the `backend/server/search-providers.ts` single-slot port — the same closure the old `POST /api/search/query` route called, and the port exists for exactly that one branch. `bun run transport:gate` is a **numeric ratchet** over its constant count and the shell files (`server/http.ts`, `shared/ipc/channels.ts`) — a new hand-written channel turns it red.

Supporting files: **type definitions** `packages/shared/ipc/*.ts`; **event/command types** `packages/shared/events/*.ts`; **client** `packages/client/`.

### Alias Registry

Two mechanisms, and which one a package uses is a fact about that package, not a style choice.

**Every `@onething/*` is a real workspace package (node resolves them).** Root `package.json` declares `"workspaces": ["packages/core", "packages/gateway", "packages/onething-runtime", "packages/backend", "packages/client"]` — **listed one by one, never a `packages/*` / `apps/*` glob** (`apps/mobile` would drag in expo + react-native). `npm install` / `bun install` (hoisted) link them at `node_modules/@onething/{core,gateway,runtime,backend,client}`, so `@onething/core` / `@onething/gateway` / `@onething/runtime` (90 export keys) / `@onething/backend` (88: 85 explicit subpaths generated from the repo's actual import specifiers, `"."` → `./backend.ts`, plus the two fallbacks `"./*.js"` and `"./*"` → `./*.ts`) resolve through **their own `package.json` "exports"** in node, vite, vitest and tsc alike (`moduleResolution: bundler` in all three tsconfigs honours exports pointing straight at `.ts` sources). There is no alias entry and no tsconfig `paths` entry for them: **add a new subpath to that package's `package.json` "exports"**, and a missing one now fails at **typecheck**, not only at build/run. `@onething/*` must **never** appear in the root `package.json` `dependencies`/`devDependencies` (`workspaces` and `dependencies` are unrelated fields; the React main-process bundle inlines them via esbuild).

**Alias table.** There is none any more: `onething.aliases.ts` (the `@onething/electron-host/*` family) died with the Vue host on 2026-09-04. The only non-package alias left is `@shared` (= `packages/shared`), declared per-config (root `tsconfig.json` paths, `vitest.config.ts`, the React shell's vite/esbuild configs).

**Adding a new runtime or backend subpath:**

1. Add the key to that package's `package.json` `"exports"` (`packages/onething-runtime` or `packages/backend`). Prefer the family wildcard (`"./x/*": "./src/x/*.ts"`) that is usually already there — a whole new family needs the pair `"./x": "./src/x/index.ts"` + `"./x/*": "./src/x/*.ts"`, and a nested directory barrel (`src/x/y/index.ts`) needs its own exact key `"./x/y"` because `*` cannot express "directory index". Exact keys win over wildcards; keep them above their wildcard sibling anyway.
2. No alias edit, no tsconfig edit, no config edit — all four build/test configs and tsc go through the same exports map, and a missing key fails at **typecheck**.

Every `@onething/*` family is a workspace package, so a missing exports key fails at typecheck.

### Directory Structure

```
packages/core/                 # no src/ — files at the package root
│   ├── agent-loop/            # provider-agnostic loop: runner, stream, retry, scheduler
│   ├── engine/                # CoreStreamEngine, context-compact, history
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
│   ├── engine/                # ProductStreamEngine(路由/房间闸/插件旁路/agent 绑定)
│   │                          # + ports.ts(五个可选端口)/ turn-principal / message-sources
│   │                          # + P3'e-A2b:compact-file-lists / chat-logger-bound /
│   │                          # ipc-emitter.wiring / session-turn-context.wiring
│   ├── mcp/  acp/  external-agents/  files/  search/  usage/  evals/  headless/  …
│   └── stream-sender.ts       # 命令目标(sender)形状:产品层的公开类型
│
packages/backend/              # ASSEMBLY package ('@onething/backend'; @shared allowed)
│   ├── backend.ts  store.ts   # createOnethingBackend — the single assembly recipe
│   ├── events/                # event-bus, stream-channel, ring-buffer, stream-coalescer
│   ├── stores/                # sessions (repository wiring), settings cache, app-state, docs-paths
│   ├── session/               # sessionCommands / sessionReads / event-log / trace / freeze
│   ├── rpc/                   # router registry + domains/ (the only new-transport surface)
│   ├── server/                # the core HTTP/SSE surface: http.ts (routes/SSE), runtime.ts
│   │                          # (OnethingRuntimeFacade + session/settings/permission facades),
│   │                          # discovery.ts (<store>/run/http.json), embed.ts (host mounting)
│   ├── channel/               # gateway identity, session-router, outbound dispatch
│   ├── features/  utils/      # feature mounts (self-evolution, trajectory…); ripgrep/fuzzy/wildcard
│   ├── provider-binding/      # bound-fetch / request-dump / ai-settings-compose —— 把 runtime
│   │                          # provider 绑到设置缓存与日志的三件脊柱件(P3'b-B 从 providers/ 改名)
│   ├── wiring/engine/         # 引擎的宿主接线(P3'e-A2a/A2b):stream-engine-bound.ts(端口装配)、
│   │   │                      # stream-engine-runtime.ts(12 槽)、index.ts(单例与生命周期);
│   │   │                      # 余下 23 件每一件都吃脊柱(store/session/events/wiring/<d>),
│   │   │                      # 不吃的已进 runtime(见下),纯再导出门面已删
│   │   ├── stream/            # stream-executor, stream-processor, tool-execution,
│   │   │                      # tool-orchestrator, agent-loop-{executor,runtime}, message-helpers,
│   │   │                      # provider-helpers, resume-history, image-generation/stream,
│   │   │                      # history-shadow, session-event-recorder, codex-native-tools
│   │   ├── prompt/            # system-prompt(desktopPromptComposer)+ system-prompt-snapshot
│   │   └── triggers/          # post-chat triggers
│   └── wiring/<domain>/       # 薄接线:acp agent-loop agents auth collab deeplink external-agents
│                              # goals headless(HeadlessBackend) interaction
│                              # logging(configureLogging) markdown music permission
│                              # plugins(loader/manager/api/内置插件插座) project-dirs
│                              # providers scheduler search skills tasks toc
│                              # todo-plan toolkit tools usage variables voice
│
apps/cli/src/                  # CLI daemon + commands: index.ts (arg parsing) daemon-client.ts
│                              # daemon-server.ts (HeadlessBackend) ndjson.ts paths.ts stdout.ts
│                              # (the product-output口) plugin-command.ts trace-command.ts + __tests__/
apps/server/src/               # process shell only: main.ts (env, discovery-file refusal,
│                              # listen, SIGTERM flush) + index.ts (re-exports @onething/backend/server/*)
packages/client/               # '@onething/client' — transport/ (types, http, sse, memory) rpc/ events/ model/ client.ts node.ts
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

**StreamEngine** — the engine itself is product code: `ProductStreamEngine` in `packages/onething-runtime/src/engine/stream-engine.ts` (extends `CoreStreamEngine`), single owner of active stream lifecycle. Commands arrive via EventBus → engine handlers → persist → emit events → IPCBridge (desktop) or SSE (server). Handles send-message, edit-and-resend, retry-message, resume-after-confirm, steering, compact. Everything it needs from the assembly layer rides **five optional ports** (`runtime/src/engine/ports.ts`: `router` / `roomIngress` / `pluginIntercept` / `agentBinding` / `steeringDelivery`) — **an absent port means that capability does not exist** (no routing / no room refusal / no plugin post-reply / no agent binding / steering queues as before), never a substitute implementation. The assembly layer's whole share is `packages/backend/wiring/engine/stream-engine-bound.ts`: it fills all five ports from the backend spine (`channel/`, `wiring/collab`, `wiring/plugins`, `wiring/agents`, `wiring/external-agents`) and calls `new ProductStreamEngine(streamRuntime, ports)`; `wiring/engine/index.ts` owns the singleton. The 12-slot product runtime (`CoreStreamEngineRuntime`) is assembled next to it in `wiring/engine/stream-engine-runtime.ts`.

**EventBus** (`packages/backend/events/`): Central pub/sub with per-session ring buffers, sequence counters, typed and wildcard handlers; primitives in `packages/core/events/`.

**Providers**: registry wiring in `packages/backend/wiring/providers/`; the three binding pieces that tie a runtime provider to the settings cache and the logger (`bound-fetch` / `request-dump` / `ai-settings-compose`) are spine and live in `packages/backend/provider-binding/`; the `@shared/ipc`-shaped type/env/utility-model adapters are `packages/onething-runtime/src/providers/*.wiring.ts`; the hand-rolled fetch/SSE implementations live in `packages/onething-runtime/src/agent-loop/providers/` (Vercel AI SDK was removed). New providers implement `ProviderDefinition`.

**Tools — toolkit (2026-08-18 rebuild; the legacy tree was deleted in R4b, 2026-08-19)**: the tool system is `packages/core/toolkit/` (kernel: `ToolSpec` / `Tool { plan → apply }` / `Intent` / `Outcome` / `AbortScope` / `OutputBudget` / `Job` / `Catalog` / `Surface` / `ToolRunner` + effect policy table) + `packages/onething-runtime/src/toolkit/` (zod contract, family base classes, the builtin tools, `PluginTool`/`McpTool`, `resolveScene`) + `packages/backend/wiring/toolkit/` (ports that touch the spine: `PermissionAuthorizer` over `enforcePermissionPolicy`, `AuditProjector` → `events.jsonl` `tool/audit`, `BackgroundJobRegistry`, three-tier catalogs, `createAppToolRunner`, `wiring.ts`) + `packages/onething-runtime/src/toolkit/` 的投影半边(`prompt-source.ts` / `audit-observer.ts` / `plugin-tools.ts` / `guard-projection.ts` 与四个 `*.wiring.ts`:`catalog-projection` / `execution-types` / `ipc-observer` / `mcp-catalog`,P3'b-B). Every call runs `validate → intercept → plan → effect-based authorize → apply → budget`; permission looks only at `Intent.effects` (`EffectClass` table in `core/toolkit/effects.ts` — external agents ride the `external-agent` row, so ACP and the Claude Code SDK go through the same `Authorizer.decide` as a local tool; **`browser_navigate` was added by B1-a `72c998f8`, 2026-09-12** — `ask` / `barrier: false`, and the reason it is not `net_fetch` is written on the row: a navigation in the built-in browser is a request carrying the user's own cookies and identity, which is a different act from an anonymous fetch, and `net_fetch` is `silent`. The `browser:` provider assigns it per principal — the user's own clicks declare `[]`, everyone else's `open` / `navigate` / `reload` / `back` / `forward` declare `browser_navigate`, while `activate` / `close` are `ui_change` because they only move that person's own window; the two reads `page` / `screenshot` carry no effects at all, structurally — `ReadSpec` has no effects field). There is **no kill switch and no second path**: `Tool.define` / `ToolInfo` / `permissionGuard` / `autoExecute` are gone, and `permissionGuard?` survives only as a deprecated, derived field on the `@shared/ipc` contract (`runtime/src/toolkit/guard-projection.ts`). What is left in `packages/onething-runtime/src/tools/` is pure modules only (sandbox, bash executor/classifier, edit engine, replacers, diff hunks, file snapshot/mutation, output accumulation/truncation, sensitive files, background jobs, `builtin/time-runtime.ts`, `builtin/web-search/{page-fetch,providers}`) plus four dependency-injected IPC-shape projections; `packages/backend/wiring/tools/core/` keeps just two host-injection ports now — `configureSandboxHost` (`sandbox.ts`) and `enforcePermissionPolicy` (`permission-policy.ts`); the bash-executor and replacers facades were deleted (callers import `@onething/runtime/tools/*` directly) and background jobs moved to `runtime/src/tools/background-jobs-bound.ts` (P3'a-2). Design + per-phase records: `docs/design/tool-system-oop-2026-08.md` (§17 = the R4b deletion record). **Registration is a catalog, the per-turn surface is scene-resolved**: `runtime/src/toolkit/scene.ts` (`resolveScene`) plus each tool's own `visibleIn` decide what a turn actually sends the model — plain chat = bash/read/write/edit/variable/time/web_search/web_open/radio/practice/task/ask_user, plus `search` — the assistant reads the **same** cross-session index the palette does, on `surface: 'agent-tool'` (检索重建 S6, `docs/design/search-index-2026-09.md` §14), so it declares no `visibleIn` and is visible everywhere; `goal` only while the session goal is `active`; collab tools (`send_message`/`board`/`history`/`notebook`) only in their venue (`collab/tool-surface.ts` is the single table); `task` hidden inside task sessions; skill-scene tools only when that skill is enabled — today the self-evolution trio `feature_mount/unmount/inspect` rides the default-off builtin skill `resources/skills/onething-self-evolution` (frontmatter `default-enabled: false`), registered by the self-evolution feature itself (`backend/features/builtin/self-evolution.ts`), not by any tier catalog. Retired 2026-08-18: `find`/`grep`/`glob` (use bash rg/fd), `fart`, `bash_output`/`kill_bash` (bash `run_in_background` now reports the log path + pid; tail/kill via bash).

**Permission**: core `Permission` in `packages/core/permission/` (channel-affinity enforcement); assembly wiring in `packages/backend/wiring/permission/`.

**会话消息(P0,2026-08-19,`docs/design/session-commands-p0-2026-08.md`)**:唯一写面是
`sessionCommands`(`packages/backend/session/commands.ts`,12 条消息命令 +
`patchSession` 会话级补丁;纯 reducer 在 `packages/core/session/commands.ts`,负责 COW /
写计划 / lazy 档),唯一读面是 `sessionReads`(同目录 `reads.ts`,返回值一律 `readonly`)。
`session.messages` 只允许出现在白名单文件里(命令面 / 读面 / `sessions/storage-driver.ts` /
`sessions/session-dehydrate.ts` / `sessions/session-repository.ts`,理由逐条写在
`scripts/session-check.mjs`),对 `ChatMessage`/`Step`/`ToolCall` 的字段赋值只允许在 core 的
reducer 里;`bun run session:check` 打全表、`bun run session:gate` 是**硬闸**(基线
`docs/audit/session-gate-baseline-2026-08-19.txt` = 0,任何新命中直接红)。dev/vitest 下从
store 交出去的消息**深冻结**(`ONETHING_SESSION_FREEZE`,`backend/session/freeze.ts`),漏网的
就地改当场抛 TypeError。core 引擎仍然通过注入的 store 端口写(那些小接口的形状 P0 不动),
端口实现走命令面。**一个反复踩的坑**:命令是 COW 的 —— 先捕获 `session.messages`、再
`await`、再读那个变量会拿到旧数组;await 之后重读。

**MCP / ACP / Skills**: MCP is product-layer since P3'b-A (`packages/onething-runtime/src/mcp/` — client / manager / OAuth / identity, plus the `@shared/ipc`-speaking `bridge.wiring.ts` reachable through `index.wiring.ts`); ACP / skills assembly wiring in `packages/backend/wiring/{acp,skills}/`; themes are product-only now (`packages/onething-runtime/src/themes/`), as is the rest of the product logic.

**CLI daemon**: `bin/onething.mjs` → `dist/cli/main.cjs` (`scripts/build-cli.mjs`, esbuild with the React main process's recipe; source at `apps/cli/src/index.ts` since step ④a, 2026-09-03). NDJSON RPC over a unix socket at `<store>/run/daemon.sock`; `StoreLock.acquire('daemon')`; assembles via `HeadlessBackend`.

**Workspace panels / panel skeleton**: the Vue workbench (`RightWorkbenchPanel`, `PanelShell` & co.) died with the Vue host on 2026-09-04; the React shell's equivalents are its Dock / stage / viewer (see `apps/desktop-react/CLAUDE.md`).

**Terminal & built-in browser (2026-09-12, eight commits; 正本 `apps/desktop-react/docs/terminal-browser-2026-09.md`, §9.5 是施工账索引)**. Two different shapes, and the difference is the point: the terminal was a backend that had everything but its last mile, the browser was built from nothing.

- **Terminal** — the pipeline (node-pty spawn, 16ms batching, `seq`, a replay ring, generation-stamped ack flow control, the seven `terminalRouter` verbs `create` / `list` / `write` / `resize` / `kill` / `attach` / `ack`, the `capabilities.terminal` bit) already existed in `runtime/src/terminal/` + `backend/wiring/terminal/`; what was missing was that **no host had ever injected the output broadcaster**, so `hasTerminalHost()` was false in production and all seven verbs refused structurally. T0 (`dce6c15e`) filled the `terminal` host port (see the ports table above). T1 (`d6e31abb`) built the shell half: `apps/desktop-react/src/content/terminal/` — `screen.ts` is **the only file in the repo that imports `@xterm/*` at runtime** (the sole value import and the sole `xterm.css` import; `theme.ts` takes the `ITheme` **type** only, and says so on the line), `session.ts` is a five-state machine (attaching / live / detached / exited / dead) doing attach replay, `seq <= lastSeq` dedupe and byte-counted acks carrying the generation, `registry.ts` owns the id→session map, `key-courtesy.ts` is a pure table consumed by `FOCUS_SCOPES.terminal.keys` (mac's row is **empty**; Win/Linux yield five readline keys), plus the launcher tile, the `terminal` content kind and the factory key `primary+\``. Two real bugs fell out of the real machine and are recorded in the shell's CLAUDE.md: the keymap kernel treated ⌘ and Ctrl as one bit, and `service.wiring.ts` never sent the death notice for a terminal killed through the RPC (`exitSent` latch). T2 (`e6fd12ab`) added ⌘F inside the terminal (`@xterm/addon-search`; the find state lives on the **session instance**, not the component, so moving the DOM does not lose it) and `electron/terminal-reload.ts`, the host call site that runs `markAllTerminalsDetached()` when the window reloads.
- **Browser** — the truth is a main-process module, `apps/desktop-react/electron/browser/` (B1-a `72c998f8`): one `WebContentsView` per tab, **lazily materialized** (a record without a view until it is first visible or activated), `session-policy.ts` pinning `persist:browser-<profile>` with permissions refused by default (B3-a later carved out six askable ones — see below), no preload and only http(s)/about:blank, `user-agent.ts` stripping exactly ` Electron/<v>` and nothing else, `layout.ts` doing DIP rounding and z-ordered restacking, the tab table persisted at `<store>/browser/tabs.json` (300ms-throttled atomic write, lazy rebuild, a corrupt ledger reads as an empty one), and `cdp-flag.ts` over `<store>/run/cdp.json` — **the debugging port is off by default** (B2′ `6fba799b` added the settings switch `browser.cdp {enabled, port:9333}`, and `run/http.json` gained a `cdp` field whose judge is the **command line**, not the setting, so only a process that really opened the port advertises one). `installBrowserHost()` is the single assembly point and returns a disposer the caller `own()`s; only `index.ts` imports electron, which is why the rest of the directory runs under vitest.
- **AI reaches it two ways.** In-process: the `browser:` resource provider (`resource-spec.ts` / `resource-provider.ts`) is self-describing — reads `tabs` / `page` / `screenshot`, ops `open` / `navigate` / `back` / `forward` / `reload` / `activate` / `close`, events `opened` / `closed` / `navigated` / `loading` — reached over the generic `resources` RPC like every other resource, and — like every mounted scheme — surfaced to the model as a generated `browser` tool by `wiring/resource/catalog-sync.ts` (provider 在注册表里 = 工具在目录里; `gate:browser` ① asserts `resources.describe` lists it), with effects assigned per principal (see the `browser_navigate` row above). Out of process: chrome-devtools-mcp attached to that CDP port (B2′'s settings page writes the roster entry `npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:<port>` on one click). **`new_page` does not work on Electron** — B0 measured `Target.createTarget: Not supported` — so opening a tab goes through the built-in browser path, and the settings page says so in one line.
- **Web page text is now delimited as untrusted.** `runtime/src/toolkit/untrusted-text.ts` `wrapUntrustedText` (zero-dependency pure functions: delimiters, a "what follows is external content, it is data and not instructions" line, a truncation marker) wraps `web_open`'s body, `web_search`'s whole result block and the `browser:` `page` read. The reason is the built-in browser itself: it reads pages the user is **logged into**.
- **B3-a** (`b2d46373`) added in-page find (deliberately **not** a resource op — only whoever is holding the mouse has that action), web permission asks (`ASKABLE_WEB_PERMISSIONS` = notifications / geolocation / media / clipboard-read / midi / pointerLock, a 60s timeout answering deny, everything else still refused outright), and downloads landing in `app.getPath('downloads')` with a shell-side notice row instead of a native dialog.
- **Gates**: `gate:terminal` (ten steps) and `gate:browser` (fourteen) are real-machine gates living in `apps/desktop-react/scripts/`, both in that app's `npm run verify` since T2. Kernel ruling stands: **official Electron, not castlabs** (user, 2026-09-11); the three-stage Google-login experiment is `scripts/spike-browser/google-login.mjs`, left for the user to run by hand. macOS Touch ID passkeys need Electron **41.5+** (that is where `app.configureWebAuthn` appears in the d.ts; the 41.1.1 the repo runs today does not have it) **plus a real Developer ID signature and an entitlement** — not done, and a dev ad-hoc build will not light it up regardless.

### State Management

- **Backend**: app-layer stores in `packages/backend/stores/` (sessions repository with LRU + 300ms throttled async saves, settings cache with sync hot path, app-state)
- **Renderer**: zustand stores + query kernel in `apps/desktop-react/src/data/` (see its CLAUDE.md)
- **Cross-process sync**: EventBus → SSE events (`@onething/client` events hub) + RPC calls

### Build Output

```
apps/desktop-react/    # THE desktop (packaged by electron-builder → release/; `main` in root package.json)
├── dist/              # Vite SPA output (index.html + assets; base './' so it loads from the asar)
└── dist-electron/     # esbuild: main.cjs (own core + embedded HTTP/SSE face) + preload.cjs
                       #        + search-worker.cjs (asarUnpack'd — see below)

dist/
├── cli/main.cjs       # CLI daemon entry (bin/onething.mjs imports this; scripts/build-cli.mjs)
├── cli/search-worker.cjs
├── server/main.js     # apps/server single-file SSR bundle (inlineDynamicImports —
│                      # chunk-split + top-level await deadlocks module evaluation)
├── server/search-worker.cjs
└── web/               # React shell browser build (`web:build`, `--mode web`)
```

**`search-worker.cjs` — three copies, one recipe** (检索重建 S3b): the search index worker
(`packages/onething-runtime/src/search/index/worker.ts`) is a **second/third entry point in
each host's own build recipe**, and its product always lands **beside that host's entry** —
that adjacency is the contract the assembly reads (`packages/backend/wiring/search/worker.ts`
resolves `search-worker.cjs` next to `import.meta.url`; no host passes a path, so adding a
fourth host means adding a build entry, not a wiring line). React desktop:
`apps/desktop-react/scripts/build-electron.mjs`, third esbuild call. CLI:
`scripts/build-cli.mjs`, second call. Server: `scripts/build-server.mjs` runs the vite SSR
build **and then a second esbuild** — `apps/server/vite.config.ts` pins
`inlineDynamicImports`, and rollup rejects multiple inputs with it. It is `asarUnpack`'d
because `worker_threads` loads through Node's own module resolution, not Electron's asar
patch; `gate:packaged` proves that (`search.status.mode === 'owner'` on the packaged .app).

### Tech Stack

| Layer | Technology |
| ------- | ----------- |
| Desktop | Electron |
| Frontend | React + TypeScript (zustand) — `apps/desktop-react`, desktop and browser |
| AI SDK | Hand-rolled fetch/SSE per provider (`packages/onething-runtime/src/agent-loop/providers/`) |
| Storage | File-based (JSON + per-session JSONL) |
| Build | Vite (renderer) + esbuild (main / preload / CLI, `apps/desktop-react/scripts/build-electron.mjs` recipe); vite SSR for apps/server |
| Test | Vitest |
| Virtual Scroll | None — the React message list is a plain list with block-level memo (R 线, `apps/desktop-react/docs/stream-render-2026-09.md`). |
