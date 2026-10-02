---
name: onething-verification
description: Use when verifying, testing, or diagnosing the onething project — running smoke tests, boundary checks, performance benchmarks, CLI integration tests, gateway tests, or evaluation triage. Covers all validation scripts under scripts/.
metadata:
  hermes:
    tags: [onething, testing, verification, smoke-test, boundary-check, benchmarking, triage]
---

# Onething Verification Scripts

This skill covers every validation and verification script under `scripts/`. Use it when the user asks to run tests, verify correctness, check boundaries, benchmark performance, or diagnose evaluation quality.

Answer in the user's language. Prefer the shortest path that matches the user's intent.

## Quick Reference

| Script | Purpose | Requires |
| --- | --- | --- |
| `bun run scripts/smoke-test.ts` | Headless core conversation smoke test | `@onething/backend/core` |
| `bun run scripts/smoke-test-real.ts` | Real-provider integration test (DeepSeek/Anthropic) | `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` |
| `bun run scripts/cli-test.ts` | CLI `--once --json` tool-call round-trip test | mock HTTP server (spawned inline) |
| `bun run scripts/agent-loop-core-test.ts` | Core agent-loop unit test with mock provider | `@onething/backend/core/agent-loop` |
| `bun run scripts/gateway-smoke-test.ts` | Gateway bridge integration test | `@onething/backend/gateway` |
| `bun test scripts/headless-boundary-check.ts` | Package boundary dependency checker | project source tree |
| `node scripts/ttft-test.mjs` | Time-to-first-token benchmark (raw fetch vs AI SDK) | Kimi API key in settings |
| `bun run scripts/diagnose-weekly.mjs` | Weekly evaluation triage report | `~/.onething/evals/online/records.jsonl` |

---

## Smoke Tests

### 1. Core headless smoke test (`smoke-test.ts`)

Tests a basic text conversation through `AgentEngine` without requiring real API keys. Verifies the engine → event bus → stream channel pipeline works end-to-end.

```bash
bun run scripts/smoke-test.ts
```

Expected output: `[smoke] ok` with a response from the mock/default provider.

Failure modes:

- `AgentEngine` or `SessionManager` failed to initialize → check package builds.
- Provider auth missing → ensure the fallback provider (if any) has valid keys.

### 2. Real provider smoke test (`smoke-test-real.ts`)

Tests the full tool-call loop with a real AI provider. Registers `get_current_time` tool and verifies the AI calls it, processes the result, and returns a final response in Chinese.

**Prerequisites**: Set one of:

- `DEEPSEEK_API_KEY` (also `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` optionally)
- `ANTHROPIC_API_KEY` (also `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` optionally)

```bash
bun run scripts/smoke-test-real.ts

# JSON mode (for CI / programmatic consumption)
bun run scripts/smoke-test-real.ts --json
```

JSON output schema:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "provider": { "id": "deepseek", "model": "deepseek-chat" },
  "toolCallCount": 1,
  "finalText": "现在是...",
  "assertions": { "toolCallReceived": true, "finalTextReceived": true }
}
```

Failure modes:

- `provider.id` is `null` → no API key detected. Set `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY`.
- `toolCallCount` is 0 → provider didn't invoke the tool. Check prompt, model capabilities.
- `finalText` is empty → stream completed without text deltas. Check provider stream compatibility.

---

## Integration Tests

### 3. CLI round-trip test (`cli-test.ts`)

Spawns a mock OpenAI-compatible SSE server, then runs `smoke-test-real.ts --once --json` against it. Validates the full CLI contract: `schemaVersion`, provider fields, tool-call events, and final text.

```bash
bun run scripts/cli-test.ts
```

Validates:

- CLI exits with code 0
- JSON output has `schemaVersion: 1`
- Exactly 2 HTTP requests (tool-call + tool-result round-trip)
- First request includes the tool definition
- Second request carries the tool result message
- All expected event types present: `tool_call`, `tool_result`, `final_text`

Failure modes:

- Mock server port conflict → test re-runs automatically (random port).
- Process timeout → the spawned smoke-test child is hanging. Check provider mock config.

### 4. Core agent-loop unit test (`agent-loop-core-test.ts`)

Tests the low-level `runAgentLoop()` function with a mock provider. Verifies the tool execution loop, event lifecycle, and turn counting without any real network I/O.

```bash
bun run scripts/agent-loop-core-test.ts
```

Validates:

- Tool execution happens exactly once
- Loop completes in 2 turns (tool-call + response)
- Final text matches expected
- `tool-result` and `text-delta` events are emitted

Failure modes:

- Turn count mismatch → tool-loop is looping incorrectly or missing tool results.
- Missing events → `onEvent` callback is not forwarding.

### 5. Gateway bridge smoke test (`gateway-smoke-test.ts`)

Tests the `GatewayBridge` layer with a mock channel and mock runtime. Validates message routing, session lifecycle, and response delivery.

```bash
bun run scripts/gateway-smoke-test.ts
```

Validates:

- Mock channel receives non-empty text response
- `GatewaySessionRegistry` correctly manages sessions
- `Allowlist` and `RateLimiter` are wired up

Failure modes:

- Mock channel.sent is empty → bridge didn't route the response. Check `GatewayBridge.handle()`.

---

## Boundary & Dependency Checks

### 6. Headless boundary check (`headless-boundary-check.ts`)

A comprehensive pattern-based checker that enforces package boundaries across the monorepo. It scans source files for forbidden import/require patterns to prevent layering violations.

```bash
bun test scripts/headless-boundary-check.ts
```

Rules enforced:

- **Core package** (`packages/backend/core/`): May not import `electron`, `src/main/`, `src/shared/`, `better-sqlite3`, `@modelcontextprotocol/sdk`, `@agentclientprotocol/sdk`, `zod`, `diff`, `uuid`
- **Host boundary** (`packages/backend/runtime/`): May not import `electron`, `src/main/`, etc.
- **Electron main** (`src/main/`): May not directly import `electron` (must use host abstractions), may not import runtime/core source directly, may not contain legacy IPC handler patterns
- **Gateway** (`packages/backend/gateway/`): May not import `@onething/backend/core` (non-gateway parts), may not import `@onething/backend/runtime`, may not contain standalone AgentEngine patterns
- **Voice** (`packages/voice/`): May not import `electron`, `BrowserWindow`, tray APIs
- Plus checks for media protocol, logging, accessibility, shell operations, network proxy, global shortcuts, power resume, window lifecycle, app lifecycle boundaries

Failure modes:

- Pattern matched → a layering violation was introduced. Remove the forbidden import and route through the correct host/platform abstraction.
- Test file not found → ensure `bun test` resolves `.ts` files. Use `bun test scripts/headless-boundary-check.ts`.

---

## Performance Benchmarks

### 7. TTFT benchmark (`ttft-test.mjs`)

Measures time-to-first-token for both raw `fetch` calls and the AI SDK (`@ai-sdk/moonshotai`) path. Also measures streaming throughput (chars/s, deltas/s) after the first token.

**Prerequisites**: Kimi (Moonshot) API key configured in `~/Library/Application Support/onething/data/settings.json`.

```bash
# Default: 3 iterations
node scripts/ttft-test.mjs

# Custom iteration count
N=5 node scripts/ttft-test.mjs
```

Reports:

- Per-iteration TTFT for raw fetch
- Per-iteration TTFT for AI SDK
- Δ avg(SDK) − avg(raw) overhead
- Streaming throughput: chars/s and deltas/s for both paths

Failure modes:

- `No Kimi API key in settings` → configure Kimi provider in onething settings.
- HTTP errors → check API key validity, base URL.
- Stream ended without content → model returned no tokens. Check prompt/model compatibility.

---

## Evaluation & Triage

### 8. Weekly evaluation diagnosis (`diagnose-weekly.mjs`)

Reads online evaluation records from `~/.onething/evals/online/records.jsonl`, clusters low-score turns, and appends a triage section to `evals/triage.md`.

```bash
# Default: last 1 week
bun run scripts/diagnose-weekly.mjs

# Custom week window
bun run scripts/diagnose-weekly.mjs --weeks 2
```

Output:

- Total records loaded
- Negative records count
- Triage report appended to `evals/triage.md`

Failure modes:

- `@onething/backend/runtime/*` module not found → ensure packages are built.
- `records.jsonl` missing → no evaluations have been recorded yet. Run the app and collect data first.

---

## Dev Signing (macOS only)

### 9. Sign dev binaries (`sign-dev-binaries.mjs`)

Code-signs `Electron.app` inside `node_modules` to satisfy macOS security requirements during development. Cached by mtime+size fingerprint to avoid redundant signing.

```bash
node scripts/sign-dev-binaries.mjs

# Force full recheck
ONETHING_FORCE_SIGN_CHECK=1 node scripts/sign-dev-binaries.mjs
```

### 10. Build macOS native panel (`build-macos-panel.mjs`)

Builds the native `macos_panel.node` addon from `native/macos-panel/` using `node-gyp`.

```bash
node scripts/build-macos-panel.mjs

# Force rebuild
ONETHING_FORCE_NATIVE_REBUILD=1 node scripts/build-macos-panel.mjs
```

---

## Data Migration Scripts

One-shot migration scripts. Run once after upgrading.

### Convert sessions (`convert-sessions.mjs`)

```bash
node scripts/convert-sessions.mjs --to=jsonl [--dry-run]
node scripts/convert-sessions.mjs --to=json [--dry-run]
node scripts/convert-sessions.mjs --verify
```

### Migrate settings (`migrate-settings.mjs`)

```bash
node scripts/migrate-settings.mjs
```

### Migrate project dirs (`migrate-project-dirs.mjs`)

```bash
node scripts/migrate-project-dirs.mjs
```

### Cleanup legacy user memory (`cleanup-legacy-user-memory.mjs`)

```bash
node scripts/cleanup-legacy-user-memory.mjs           # dry run
node scripts/cleanup-legacy-user-memory.mjs --apply   # actually delete
```

---

## Dev Server Scripts

### Unified dev (`dev-unified.mjs`)

```bash
# All lanes
node scripts/dev-unified.mjs

# Electron only
node scripts/dev-unified.mjs electron

# Web + backend only
node scripts/dev-unified.mjs web
```

### Dev with logging (`dev-with-logging.mjs`)

```bash
# Start mode (launch + keep-alive)
node scripts/dev-with-logging.mjs start

# Dev mode (foreground with log rotation)
node scripts/dev-with-logging.mjs dev
```

Environment variables:

- `ONETHING_LOG_MAX_SIZE_MB` (default 8)
- `ONETHING_LOG_MAX_ARCHIVES` (default 30)
- `ONETHING_LOG_RETENTION_DAYS` (default 14)
- `ONETHING_LOG_COMPRESS` (default 1, set 0 to disable gzip)

---

## Release

```bash
./scripts/release.sh <version>
# Example: ./scripts/release.sh 1.5.0
```

Checks branch, uncommitted changes, and tag conflicts. Updates `package.json`, commits, tags, and pushes.

---

## Troubleshooting Order

When a verification script fails:

1. Check that all packages are built: `bun run build`
2. Check that native dependencies are installed: `bun install`
3. For provider-dependent tests, verify API keys are set correctly
4. For boundary checks, inspect the specific file + pattern that matched
5. For migration scripts, run with `--dry-run` first to preview changes
6. For TTFT benchmarks, ensure the Kimi provider is configured in onething settings and the API key is valid
