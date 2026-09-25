# Agent Client Protocol (ACP) — integration reference, 2026-09-25

Ground truth used, in order of authority:

1. `node_modules/@agentclientprotocol/sdk` **0.17.1** (2026-03-27) — what this repo pins (`package.json` → `"@agentclientprotocol/sdk": "^0.17.1"`; consumers: `packages/onething-runtime/src/acp/*`, `packages/backend/wiring/acp/*`).
2. `@agentclientprotocol/sdk` **1.5.0** (npm latest, 2026-09-21) — unpacked with `npm pack` and diffed against 0.17.1. Its schema is v1.23.0 + v2.0.0-alpha.5 ([CHANGELOG](https://github.com/agentclientprotocol/typescript-sdk/blob/main/CHANGELOG.md)).
3. Spec pages at `https://agentclientprotocol.com/protocol/v1/*.md` (the `/protocol/<page>` URLs redirect to `/protocol/v1/`), announcements and RFDs, all fetched 2026-09-25.
4. The registry index `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (41 agents) and the registry's daily probe `.protocol-matrix/latest.md|json` (35 agents probed on 2026-09-25).
5. Adapter packages unpacked and read: `@agentclientprotocol/claude-agent-acp@0.81.2`, `@agentclientprotocol/codex-acp@1.13.1`, `@zed-industries/claude-code-acp@0.16.2` (legacy), `acpx@0.19.3`, `acp-factory@0.1.15`.

Anything I could not confirm is marked **[unverified]**.

---

## A. Protocol surface (ACP v1 as of schema 1.23 / SDK 1.5.0)

### A.0 Versions, and how stale the local SDK is

- Wire version is `protocolVersion: 1` (`PROTOCOL_VERSION = 1` in both 0.17.1 and 1.5.0). ACP **v2 is a draft** (`PROTOCOL_VERSION = 2`, importable as `@agentclientprotocol/sdk/experimental/v2`; published 2026-07-20, "may change incompatibly in any SDK release"). — https://agentclientprotocol.com/announcements/acp-v2-draft, https://agentclientprotocol.com/protocol/v2/draft/overview
- SDKs reached 1.0 on 2026-06-24/25. — https://agentclientprotocol.com/announcements/sdk-1-0-releases
- **0.17.1 → 1.5.0 schema diff (measured from `dist/schema/types.gen.d.ts`)**: 110 types added, 13 removed, 111 changed.
  - Removed: `session/set_model`, `SetSessionModelRequest/Response`, `SessionModelState`, `ModelInfo`, `ModelId`, `NewSessionResponse.models` (never stabilized; removed 2026-06-02, "Agents should continue to expose model selection through Session Config Options" — https://agentclientprotocol.com/rfds/updates); `AuthMethodEnvVar` / `AuthEnvVar` (`type: "env_var"` auth methods are gone; only `terminal` and the default `agent` type remain); `ElicitationRequest/Response/Action`, `ElicitationCompleteNotification` (renamed, see A.10); `PromptRequest.messageId` and `PromptResponse.userMessageId` (message IDs stayed only on `ContentChunk.messageId`).
  - Added: `plan_update` / `plan_removed`, `notice`, `compaction_update` / `compaction_summary_chunk` session updates; `session/delete`; `additionalDirectories`; `ToolCall.name`; `mcpCapabilities.acp` + `McpServerAcp` + `mcp/connect|message|disconnect` (MCP-over-ACP); `providers/list|set|disable` (unstable); `elicitation/create` + `elicitation/complete`; `$/cancel_request`; client `session.{compaction,configOptions.boolean,notices}` and `plan` capabilities; `SessionConfigOptionCategory` gained `"model_config"`; the whole NES (next-edit-suggestion) surface (`nes/*`, `document/did*`) — unstable.
  - API: `ClientSideConnection` / `AgentSideConnection` constructors are `@deprecated` since 0.27.0 in favour of `acp.client({name})` / `acp.agent({name})` (see A.13). Old classes still work.

### A.1 Transport and JSON-RPC ground rules

Spec: https://agentclientprotocol.com/protocol/v1/transports, https://agentclientprotocol.com/protocol/v1/overview

- Only **stdio** is standardized: client spawns the agent; newline-delimited JSON-RPC 2.0 on stdin/stdout, UTF-8, no embedded newlines; **agent MUST NOT write non-ACP bytes to stdout**; stderr is free-form logging the client "MAY capture, forward, or ignore". Streamable HTTP / WebSocket is a draft RFD (https://agentclientprotocol.com/rfds/streamable-http-websocket-transport); the SDK ships experimental `experimental/http-client`, `experimental/ws-client`, `experimental/server`, `experimental/node` entry points for it.
- Error codes in 1.5.0's `ErrorCode`: `-32700 -32600 -32601 -32602 -32603` (JSON-RPC), `-32800` request cancelled, `-32000` **auth_required**, `-32002` resource not found. (0.17.1 also listed `-32042`; it is gone in 1.5.0 — meaning **[unverified]**.) `RequestError.authRequired()` / `.resourceNotFound(uri)` are the SDK constructors.
- Protocol-level request cancellation: notification `$/cancel_request { requestId }` (stabilized 2026-06-29). Receiver MAY cancel, MUST still answer the original request (a result, or error `-32800`). Internal cancellations should also surface as `-32800`. — https://agentclientprotocol.com/protocol/v1/cancellation
- `_meta` propagation: reserve root `_meta` keys `traceparent`, `tracestate`, `baggage` for W3C trace context. — https://agentclientprotocol.com/protocol/v1/extensibility, https://agentclientprotocol.com/rfds/meta-propagation

### A.2 `initialize`

Spec: https://agentclientprotocol.com/protocol/v1/initialization

Request (`InitializeRequest`, 1.5.0):
```ts
{ protocolVersion: number; clientCapabilities?: ClientCapabilities; clientInfo?: { name; version; title? }; _meta? }
ClientCapabilities = {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: { terminal?: boolean };                       // "I can run a terminal auth method"
  elicitation?: { form?: {} | null; url?: {} | null }; // each mode must be explicitly present to count
  session?: { compaction?: {}; configOptions?: { boolean?: {} }; notices?: {} };
  plan?: {};                                           // opts into plan_update / plan_removed
  nes?: {...}; positionEncodings?: ("utf-8"|"utf-16"|"utf-32")[];   // unstable NES
  _meta?
}
```
Response (`InitializeResponse`):
```ts
{ protocolVersion; agentCapabilities?: AgentCapabilities; authMethods?: AuthMethod[]; agentInfo?: Implementation; _meta? }
AgentCapabilities = {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean };   // stdio MCP is mandatory
  sessionCapabilities?: { list?: {}; delete?: {}; additionalDirectories?: {}; fork?: {}; resume?: {}; close?: {} };
  auth?: { logout?: {} };
  providers?: {};          // unstable providers/* (client-managed LLM endpoint)
  nes?: {...}; positionEncoding?; _meta?
}
```
Rules: the client sends the latest version it supports; an agent that does not support it answers with its own latest; the client should close if it cannot speak that version. A `{}` capability means supported; omitted/`null` means unsupported. `clientInfo`/`agentInfo` ("implementation information") stabilized 2024-10-24.

The SDK 0.17.1 `ClientCapabilities` has `fs`, `terminal`, `auth`, `elicitation`, `_meta` only (no `session`/`plan`).

### A.3 Authentication (`authenticate`, `logout`, `authMethods`)

Spec: https://agentclientprotocol.com/protocol/v1/authentication, RFD https://agentclientprotocol.com/rfds/auth-methods

```ts
AuthMethod = (AuthMethodTerminal & { type: "terminal" }) | AuthMethodAgent   // no `type` ⇒ "agent"
AuthMethodAgent    = { id; name; description?; _meta? }
AuthMethodTerminal = { id; name; description?; args?: string[]; env?: Record<string,string>; _meta? }
AuthenticateRequest = { methodId; _meta? }   // response: {}
LogoutRequest = { _meta? }                   // only if agentCapabilities.auth.logout is `{}` (stabilized 2026-05-21)
```
- **Agent-type** method: client calls `authenticate { methodId }`; the agent runs its own flow (device code, browser, …) and answers `{}` when done. Requests that need auth before then fail with `-32000 auth_required`.
- **Terminal-type** method (advertised only if the client sent `clientCapabilities.auth.terminal: true`): the client launches **the same agent program and base launch config** in an interactive terminal with the method's `args` appended and `env` merged, waits for exit (0 = success), then **reconnects and re-initializes** the ACP agent. The client MUST NOT send `authenticate` for a terminal method.
- Typical pattern in the wild: `session/new` throws `-32000` → client shows the auth methods → after auth, retry. The registry's daily probe found 22 of 35 agents answer `session/new` with `auth_required` on a clean machine.
- `_auth/status_update` (agent pushes its identity) is a draft RFD (https://agentclientprotocol.com/rfds/get-auth-state, "auth/status" moved to Draft 2026-07-21); claude-agent-acp and codex-acp already emit it as an extension notification.

### A.4 Sessions: `session/new`, `load`, `resume`, `fork`, `list`, `delete`, `close`

Spec: https://agentclientprotocol.com/protocol/v1/session-setup, https://agentclientprotocol.com/protocol/v1/session-list, https://agentclientprotocol.com/protocol/v1/session-delete

```ts
NewSessionRequest  = { cwd: string; mcpServers: McpServer[]; additionalDirectories?: string[]; _meta? }
NewSessionResponse = { sessionId; modes?: SessionModeState; configOptions?: SessionConfigOption[]; _meta? }
LoadSessionRequest = { sessionId; cwd; mcpServers; additionalDirectories?; _meta? }   // response: { modes?, configOptions? }
ResumeSessionRequest / ForkSessionRequest = { sessionId; cwd; mcpServers?; additionalDirectories?; _meta? }  // fork response adds sessionId
ListSessionsRequest  = { cwd?: string; cursor?: string }  → { sessions: SessionInfo[]; nextCursor? }
SessionInfo = { sessionId; cwd; additionalDirectories?; title?; updatedAt? (RFC3339); _meta? }
DeleteSessionRequest / CloseSessionRequest = { sessionId }
McpServer = McpServerStdio { name; command; args: string[]; env: {name,value}[] }
         | { type:"http"; name; url; headers:{name,value}[] } | { type:"sse"; … } | { type:"acp"; name; serverId }
```
- `cwd` MUST be absolute and is the session root regardless of where the agent was spawned; with `additionalDirectories` (stabilized 2026-06-01, gated by `sessionCapabilities.additionalDirectories`) the effective root set is `[cwd, ...additionalDirectories]`.
- `session/load` (gated by `loadSession`): agent MUST replay the whole history as `session/update` notifications (`user_message_chunk`, `agent_message_chunk`, `tool_call`, …) **before** answering. `session/resume` (gated by `sessionCapabilities.resume`, stabilized 2026-04-22) MUST NOT replay; it just reattaches. `session/fork` is still `unstable_forkSession` in SDK 1.5.0 (RFD https://agentclientprotocol.com/rfds/session-fork). `session/close` (2026-04-23) cancels as if `session/cancel` then frees resources. `session/list` (2026-03-09) is paginated by opaque `cursor`; `session/delete` (2026-06-05) removes from that list.
- MCP: stdio transport is mandatory for every agent; http/sse are optional and advertised in `mcpCapabilities`; `type: "acp"` means "the MCP server is hosted by the client and reached through `mcp/connect` / `mcp/message` on this very connection" (RFD https://agentclientprotocol.com/rfds/mcp-over-acp; the `acp` flag is in 1.5.0's schema but the RFD is not marked stabilized on the updates page — treat as draft).

### A.5 Modes and config options (`session/set_mode`, `session/set_config_option`)

Spec: https://agentclientprotocol.com/protocol/v1/session-modes, https://agentclientprotocol.com/protocol/v1/session-config-options

- `modes: { currentModeId; availableModes: { id; name; description? }[] }` on session responses; client switches with `session/set_mode { sessionId, modeId }`; agent-initiated switches arrive as `current_mode_update { currentModeId }`. The page carries a note: "You can now use Session Config Options. Dedicated session mode methods will be removed in a future version of the protocol."
- Config options (stabilized 2026-02-04): `configOptions: SessionConfigOption[]` where
  ```ts
  SessionConfigOption = { id; name; description?; category?: "mode"|"model"|"model_config"|"thought_level"|string; _meta? }
    & ({ type:"select"; currentValue: string; options: SelectOption[] | SelectGroup[] } | { type:"boolean"; currentValue: boolean })
  SetSessionConfigOptionRequest = { sessionId; configId } & ({ value: string } | { type:"boolean"; value: boolean })
  → { configOptions: SessionConfigOption[] }        // full replacement list
  ```
  Boolean options only after the client advertises `session.configOptions.boolean` (2026-07-06). Grouped selects use `{ group, name, options }`. Unsolicited changes come as `config_option_update { configOptions }`. `category: "model"` (2026-06-24) is how model selection is expressed today — there is **no `session/set_model`** in the stable protocol.

### A.6 `session/prompt` and content blocks

Spec: https://agentclientprotocol.com/protocol/v1/prompt-turn, https://agentclientprotocol.com/protocol/v1/content

```ts
PromptRequest  = { sessionId; prompt: ContentBlock[]; _meta? }
PromptResponse = { stopReason: "end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled"; usage?: Usage; _meta? }
Usage = { totalTokens; inputTokens; outputTokens; thoughtTokens?; cachedReadTokens?; cachedWriteTokens? }   // RFD end-turn-token-usage
ContentBlock =
  | { type:"text"; text; annotations? }
  | { type:"image"; data: base64; mimeType; uri?; annotations? }        // needs promptCapabilities.image
  | { type:"audio"; data: base64; mimeType; annotations? }              // needs promptCapabilities.audio
  | { type:"resource_link"; uri; name; mimeType?; size?; title?; description?; annotations? }   // always allowed
  | { type:"resource"; resource: { uri; text; mimeType? } | { uri; blob: base64; mimeType? } }  // needs promptCapabilities.embeddedContext
```
Text and `resource_link` are the baseline every agent must accept; the other three are gated. The MCP `Annotations` shape (`audience`, `priority`, `lastModified`) is reused. Stop reasons: `end_turn` (model finished), `max_tokens`, `max_turn_requests` (agent's per-turn model-call cap), `refusal`, `cancelled` (must be the answer after `session/cancel`).

### A.7 `session/cancel`

Notification `{ sessionId }`. Client SHOULD pre-mark the turn's unfinished tool calls as cancelled and MUST answer every pending `session/request_permission` with `{ outcome: "cancelled" }`. Agent SHOULD stop model/tool work, MAY still send `session/update`s, but MUST do so before replying to the prompt with `stopReason: "cancelled"`. — https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation

### A.8 `session/update` — the full union (SDK 1.5.0)

Every notification is `{ sessionId, update: SessionUpdate, _meta? }` with `update.sessionUpdate` as discriminator:

| `sessionUpdate` | payload | notes |
| --- | --- | --- |
| `user_message_chunk` | `{ content: ContentBlock; messageId? }` | replayed on `session/load`; message IDs stabilized 2026-06-05 (optional in v1, required in v2) |
| `agent_message_chunk` | same | streamed model text |
| `agent_thought_chunk` | same | reasoning |
| `tool_call` | `ToolCall` (see A.9) | first appearance of a tool call |
| `tool_call_update` | `ToolCallUpdate` (all fields optional except `toolCallId`) | partial merge |
| `plan` | `{ entries: { content; priority:"high"\|"medium"\|"low"; status:"pending"\|"in_progress"\|"completed" }[] }` | whole-plan replacement — https://agentclientprotocol.com/protocol/v1/agent-plan |
| `plan_update` | `{ plan: { type:"items"; planId; entries } \| { type:"file"; planId; uri } \| { type:"markdown"; planId; content } }` | multi-plan / file / markdown plans; gated by client `plan` capability (RFD https://agentclientprotocol.com/rfds/plan-operations, not on the stabilized list) |
| `plan_removed` | `{ planId }` | |
| `available_commands_update` | `{ availableCommands: { name; description; input?: { hint } }[] }` | full replacement list |
| `current_mode_update` | `{ currentModeId }` | |
| `config_option_update` | `{ configOptions: SessionConfigOption[] }` | full replacement |
| `session_info_update` | `{ title?; updatedAt? }` | stabilized 2026-03-09 |
| `usage_update` | `{ used: number; size: number; cost?: { amount; currency } }` | context window used/size + cumulative cost; stabilized 2026-06-05 |
| `notice` | `{ severity:"info"\|"warning"\|"error"; title; description? }` | fire-and-forget; gated by client `session.notices` (RFD https://agentclientprotocol.com/rfds/session-notices) |
| `compaction_update` | `{ compactionId; status:"in_progress"\|"completed"\|"failed"\|"cancelled"; summary?: ContentBlock[]; error? }` | gated by client `session.compaction` (RFD https://agentclientprotocol.com/rfds/session-compaction) |
| `compaction_summary_chunk` | `{ compactionId; content: ContentBlock }` | |

0.17.1 has the first eleven only (no `plan_update`, `plan_removed`, `notice`, `compaction_*`). Non-standard variants seen in the wild (codex-acp 1.13.1 emits `subagent_spawned`, `subagent_state_update`, `async_task_spawned`, `async_task_state_update`) — a client must ignore unknown `sessionUpdate` values.

### A.9 Tool calls

Spec: https://agentclientprotocol.com/protocol/v1/tool-calls

```ts
ToolCall = { toolCallId; title; name?: string;          // `name` = programmatic tool name, stabilized 2026-09-17
  kind?: "read"|"edit"|"delete"|"move"|"search"|"execute"|"think"|"fetch"|"switch_mode"|"other";
  status?: "pending"|"in_progress"|"completed"|"failed";
  content?: ToolCallContent[]; locations?: { path; line? }[]; rawInput?: unknown; rawOutput?: unknown; _meta? }
ToolCallContent = { type:"content"; content: ContentBlock }
                | { type:"diff"; path; oldText?: string|null; newText }
                | { type:"terminal"; terminalId }
```
`locations` is the "follow-along" hint; `status` starts at `pending`, and the client should treat `cancelled` as a local state after `session/cancel`.

### A.10 Agent → client requests

| method | params → result | spec |
| --- | --- | --- |
| `session/request_permission` | `{ sessionId; toolCall: ToolCallUpdate; options: { optionId; name; kind:"allow_once"\|"allow_always"\|"reject_once"\|"reject_always" }[] }` → `{ outcome: { outcome:"selected"; optionId } \| { outcome:"cancelled" } }` | https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission |
| `fs/read_text_file` | `{ sessionId; path (absolute); line? (1-based); limit? }` → `{ content }` — must reflect unsaved editor buffers | https://agentclientprotocol.com/protocol/v1/file-system |
| `fs/write_text_file` | `{ sessionId; path; content }` → `{}` (creates parents) | same |
| `terminal/create` | `{ sessionId; command; args?; env?: {name,value}[]; cwd?; outputByteLimit? }` → `{ terminalId }` — returns immediately | https://agentclientprotocol.com/protocol/v1/terminals |
| `terminal/output` | `{ sessionId; terminalId }` → `{ output; truncated; exitStatus?: { exitCode?; signal? } }` | |
| `terminal/wait_for_exit` | → `{ exitCode?; signal? }` | |
| `terminal/kill` | → `{}` (terminal stays valid for a final `output`) | |
| `terminal/release` | → `{}` (kills if running; id becomes invalid; tool calls that embedded it keep showing output) | |
| `elicitation/create` | `{ message; mode:"form"; requestedSchema } \| { message; mode:"url"; elicitationId; url }` scoped by either `{ sessionId; toolCallId? }` or `{ requestId }` → `{ action:"accept"; content? } \| { action:"decline" } \| { action:"cancel" }` | https://agentclientprotocol.com/protocol/v1/elicitation (stabilized 2026-07-22) |
| `elicitation/complete` (notification) | `{ elicitationId }` — URL flow finished out of band | same |
| `mcp/connect` / `mcp/message` / `mcp/disconnect` | client-hosted MCP over the ACP connection (draft) | https://agentclientprotocol.com/rfds/mcp-over-acp |

Elicitation rules worth building into the UI: form mode MUST NOT be used for secrets (URL mode instead); the client MUST show who is asking, show the target host and get consent before opening a URL, and let the user review form answers before sending. 0.17.1 named these `session/elicitation` and `session/elicitation/complete` (unstable) — the names changed.

The 0.17.1 `Client` interface (`dist/acp.d.ts`) has: `requestPermission`, `sessionUpdate`, `writeTextFile?`, `readTextFile?`, `createTerminal?`, `terminalOutput?`, `releaseTerminal?`, `waitForTerminalExit?`, `killTerminal?`, `extMethod?`, `extNotification?` — **no elicitation handler at all**. 1.5.0 adds `createElicitation?` and `completeElicitation?`.

### A.11 Extensibility: `_meta`, `_`-methods, real-world extensions

Spec: https://agentclientprotocol.com/protocol/v1/extensibility

- Any object with a `_meta` field may carry `{ [key: string]: unknown }`; never add non-spec fields at the root of a spec type.
- Custom requests/notifications MUST start with `_`; unknown `_` requests get `-32601`, unknown `_` notifications are ignored. Extensions SHOULD be advertised in the `_meta` of the capability objects during `initialize`.
- SDK: 0.17.1 exposes `extMethod(method, params)` / `extNotification(method, params)` on both connection classes (and optional handlers on `Agent`/`Client`); 1.5.0 keeps them but marks them deprecated and adds typed/untyped `request(method, params, { cancellationSignal })` and `notify(method, params)` on the connection/context objects, plus `ExtensionMethod = \`_${string}\`` typing in v2.
- **Extensions actually used by adapters (all read from unpacked dist code, 2026-09-25):**
  - `@agentclientprotocol/claude-agent-acp` 0.81.2: notifications `_session/steering` (inject a follow-up into a running turn; advertised via top-level `InitializeResponse._meta.steering.supported`), `_session/goal` (control method for the goal extension; `_meta.goal = { version, controlMethod, actions:["clear"] }`), `_session/async_task/stop`, `_auth/status_update` (identity push; capability marker `agentCapabilities._meta.authStatus`), `_claude/sdkMessage` (raw Claude Agent SDK message relay); `_meta` keys `claudeCode.options` (raw SDK `query()` options passthrough on `session/new`, e.g. `resume`, `allowDangerouslySkipPermissions`, `additionalDirectories`, `hooks`, `mcpServers`), `claudeCode.promptQueueing`, `systemPrompt`, `disableBuiltInTools`, `additionalRoots`, `terminal-auth` (legacy pre-`type:"terminal"` shape), `gateway` (`clientCapabilities.auth._meta.gateway === true` unlocks the `gateway` / `gateway-bedrock` auth methods with `_meta.gateway.{protocol,baseUrl,headers}`), `_claude/model`, `_claude/origin`, `_claude/rateLimit`, `quota.model_usage`, `_claude/askUserQuestionOption` (on elicitation enum options), and the JetBrains `_meta.jetbrains.air.{version,capabilities:["sessionFailure","asyncTasks","nativeSubagentSessions","recommendedConfigValue",…]}` family. Docs: https://github.com/agentclientprotocol/claude-agent-acp/tree/main/docs (permission-extension.md, goal-extension.md, session-failure-extension.md, recommended-config-values-extension.md).
  - `@agentclientprotocol/codex-acp` 1.13.1: `_session/goal`, `_codex/session/goal_control`, `_session/async_task/stop`, `_auth/status_update`, `_session/steering`, plus the non-standard session-update variants listed in A.8 and `_meta.permission` presentation text (docs/permission-extension.md, docs/async-tasks.md, docs/subagent-sessions.md — the latter implements draft "ACP subagent RFD" PR #1992).
  - Cursor CLI: `cursor/ask_question`, `cursor/create_plan` (blocking) and `cursor/update_todos`, `cursor/task`, `cursor/generate_image` (notifications) — **not underscore-prefixed**, i.e. outside the spec's reserved namespace; a strict client must special-case them. https://cursor.com/docs/cli/acp#cursor-extension-methods
  - Gemini CLI: none documented beyond standard methods; it documents `setSessionMode` and `unstable_setSessionModel` (the latter no longer in the stable schema). https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md

### A.12 Slash commands

Spec: https://agentclientprotocol.com/protocol/v1/slash-commands

The agent MAY send `available_commands_update` after session creation and again whenever the set changes (each is a full replacement). `AvailableCommand = { name (no leading slash); description; input?: { hint } }`. **Invocation is just a prompt**: the client puts the text `"/name args"` in a `text` content block of `session/prompt`; other blocks (images, resources) may accompany it. Copilot's docs spell out the consequence: commands not in the advertised list are forwarded to the model as ordinary text, and informational commands answer without invoking the model. — https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server

### A.13 TypeScript SDK API

Package `@agentclientprotocol/sdk` (Apache-2.0, "author: Zed Industries", repo https://github.com/agentclientprotocol/typescript-sdk; peer dep `zod ^3.25 || ^4`; ESM only, `main: dist/acp.js`).

**0.17.1 (installed here)** — `dist/acp.d.ts`:
- `class ClientSideConnection implements Agent` — `constructor(toClient: (agent: Agent) => Client, stream: Stream)`; methods `initialize`, `newSession`, `loadSession`, `unstable_forkSession`, `listSessions`, `unstable_resumeSession`, `unstable_closeSession`, `setSessionMode`, `unstable_setSessionModel`, `setSessionConfigOption`, `authenticate`, `unstable_logout`, `prompt`, `cancel`, `extMethod`, `extNotification`, getters `signal: AbortSignal` (aborts when the stream ends) and `closed: Promise<void>`.
- `interface Client` — see A.10. `interface Agent` mirrors the agent methods (optional ones `?`).
- `class AgentSideConnection` (agent side), `class TerminalHandle { currentOutput(); waitForExit(); kill(); release(); [Symbol.asyncDispose] }`.
- `class RequestError extends Error { code; data; static parseError/invalidRequest/methodNotFound/invalidParams/internalError/authRequired/resourceNotFound; toResult(); toErrorResponse() }`.
- `type Stream = { writable: WritableStream<AnyMessage>; readable: ReadableStream<AnyMessage> }`; `ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream`.
- Constants: `PROTOCOL_VERSION = 1`, `AGENT_METHODS` (`authenticate initialize logout session/cancel session/close session/fork session/list session/load session/new session/prompt session/resume session/set_config_option session/set_mode session/set_model`), `CLIENT_METHODS` (`fs/read_text_file fs/write_text_file session/elicitation session/elicitation/complete session/request_permission session/update terminal/create terminal/kill terminal/output terminal/release terminal/wait_for_exit`). Zod schemas for every type in `dist/schema/zod.gen.d.ts` (171 exports).
- Subprocess wiring (from `dist/examples/client.js`): `spawn(cmd, args, { stdio: ["pipe","pipe","inherit"] })`, then `ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))`, then `new ClientSideConnection(() => client, stream)`. Nothing in the SDK spawns, restarts, or reads stderr for you.

**1.5.0 (npm latest)** additions/changes:
- New app API (since 0.27.0; migration guide https://github.com/agentclientprotocol/typescript-sdk/blob/main/MIGRATION_0.26_0.27.md): `acp.client({ name }).onRequest(acp.methods.client.session.requestPermission, ctx => …).onRequest(acp.methods.client.fs.readTextFile, …).onNotification(…).connectWith(stream, async ctx => { await ctx.request(acp.methods.agent.initialize, {...}); return ctx.buildSession(cwd).withMcpServer(...).withAdditionalDirectories(...).withSession(async session => { await session.prompt("…" | ContentBlock[]); for await… session.nextUpdate() /* { kind:"session_update" } | { kind:"stop", stopReason } */; return session.readText(); }) })`. `client.connect(stream)` returns a `ClientConnection { agent: ClientContext; signal; closed; close(err?) }` for long-lived use. Handlers receive `{ params, signal, agent|client, requestId }`.
- `ClientSideConnection` additions: `deleteSession`, `resumeSession`, `closeSession`, `logout` are now stable; `unstable_listProviders/setProvider/disableProvider`, `unstable_startNes/suggestNes/closeNes/did*Document/acceptNes/rejectNes`; generic `request<M>(method, params, { cancellationSignal })` / `notify`.
- `AGENT_METHODS` 1.5.0: `initialize authenticate providers/list providers/set providers/disable session/new session/load session/set_mode session/set_config_option session/prompt session/cancel mcp/message session/list session/delete session/fork session/resume session/close logout nes/* document/did*`; `CLIENT_METHODS`: `session/request_permission session/update fs/* terminal/* mcp/connect mcp/message mcp/disconnect elicitation/create elicitation/complete`; `PROTOCOL_METHODS.cancel_request = "$/cancel_request"`.
- `AnyWireMessage` now includes batches; `ndJsonStream` propagates input-stream errors (0.18.2), flushes decoder state at EOF (0.19.1), avoids spurious `unhandledRejection` when the transport dies mid-request (0.19.1), and is "linear in message size" (1.2.0). `SendRequestOptions = { cancellationSignal?: AbortSignal }` sends `$/cancel_request`.
- Entry points: `.` (v1), `./experimental/v2`, `./experimental/node` (`createNodeHttpHandler(server)`, `createNodeWebSocketUpgradeHandler`), `./experimental/server`, `./experimental/ws-client`, `./experimental/http-client`, `./schema/schema.json`, `./schema/v2/schema.unstable.json`.
- **There is no agent-registry helper in the SDK.** The registry is a CDN JSON (section B); `acpx` ships its own resolver (`acpx/runtime` → `agent-registry.d.ts`).
- Docs: https://agentclientprotocol.com/libraries/typescript, API reference https://agentclientprotocol.github.io/typescript-sdk (v2: https://agentclientprotocol.github.io/typescript-sdk/v2/). The README points at Gemini CLI's `packages/cli/src/zed-integration/zedIntegration.ts` as the production example.

**Implication for this repo**: moving 0.17.1 → 1.5.0 is a type-level break (`models`/`unstable_setSessionModel`/`session/elicitation` gone; `AuthMethodEnvVar` gone; `ClientSideConnection` ctor deprecated) but the wire protocol is the same `protocolVersion: 1`, and every agent in the registry answers `initialize` with v1.

---

## B. Agent registry and per-agent launch recipes

### B.1 The registry itself

- Home: https://agentclientprotocol.com/get-started/registry (RFD stabilized 2026-03-09: https://agentclientprotocol.com/announcements/acp-agent-registry-stabilized). Source repo: https://github.com/agentclientprotocol/registry (one folder per agent with `agent.json` + `icon.svg`; PR to add).
- **Index URLs** (fetch these, don't scrape): `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`; JetBrains-specific `registry-for-jetbrains.json` and `registry-for-jetbrains-preview.json` (preview channel serves newest preview/stable per agent, unverified distributions). Icons at `https://cdn.agentclientprotocol.com/registry/v1/latest/<id>.svg`. Versions are bumped by an **hourly cron** across npm / PyPI / GitHub Releases.
- **Schema** (https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json, `$id: https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json`): required `id, name, version, description, distribution`; optional `repository, website, authors[], license, license_url, icon`. Index shape `{ "version": "1.0.0", "agents": [...], "extensions": [] }` (measured: 41 agents, `extensions` empty).
- **Distribution** (https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md): `binary: { "<platform>": { archive, sha256?, cmd, args?, env? } }` with platform ids `darwin-aarch64 darwin-x86_64 linux-aarch64 linux-x86_64 windows-aarch64 windows-x86_64` (archives `.zip .tar.gz .tgz .tar.bz2 .tbz2` or raw binary; installers not allowed); `npx: { package: "@scope/pkg@x.y.z", args?, env? }`; `uvx: { package: "pkg==x.y.z", args?, env? }`. An entry may carry both `binary` and `npx`.
- **Listing requires user-auth support**: only Agent Auth or Terminal Auth count; env-var auth is explicitly not accepted; CI verifies `authMethods`. https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md
- **Daily protocol-adaptation matrix** (`.protocol-matrix/latest.md|json`, https://github.com/agentclientprotocol/registry/blob/main/.protocol-matrix/latest.md): probes every agent's `initialize`, auth method types, `sessionCapabilities`, and `session/list|fork|resume|stop|set_model`. 2026-09-25 run: 35 agents, 34 initialize OK, 22 `auth_required` on `session/new`; `session/list` supported by 22, `resume` 12, `fork` 9, `set_model` 17 (mostly agents still on pre-removal schemas), `session/stop` 0.

### B.2 Registry table (from `registry.json` + `latest.json`, 2026-09-25)

Columns: launch = exactly what the registry tells a client to run; auth = method type(s) in `initialize`; caps = `loadSession` + `sessionCapabilities` advertised. "matrix" notes come from the probe on a clean machine.

| id | name / version | launch | auth | caps (load / list / fork / resume) | notes |
| --- | --- | --- | --- | --- | --- |
| `claude-acp` | Claude Agent 0.81.2 | `npx @agentclientprotocol/claude-agent-acp@0.81.2` | terminal | ✓ / ✓ / ✓ / ✓ (+ delete, close, additionalDirectories) | section C |
| `codex-acp` | Codex 1.13.1 | `npx @agentclientprotocol/codex-acp@1.13.1` | agent | ✓ / ✓ / ✓ / ✓ | section D |
| `gemini` | Gemini CLI 0.61.0 | `npx @google/gemini-cli@0.61.0 --acp` | agent | ✓ / ✗ / ✗ / ✗ | section D |
| `antigravity-acp` | Google Antigravity 1.2.1 | binary `agy_acp_server.par` (dl.google.com) | agent | ✓ / ✓ / ✗ / ✓ | Google's successor CLI for unpaid Gemini tiers (Gemini CLI page: "replaced by Antigravity CLI on June 18th, 2026" for unpaid/Google One) |
| `goose` | goose 1.52.0 | binary `./goose acp` (GitHub release tar.bz2) | agent | ✓ / ✓ / ✗ / ✗ | section D |
| `qwen-code` | Qwen Code 0.24.5 | `npx @qwen-code/qwen-code@0.24.5 --acp --experimental-skills` | agent | ✓ / ✓ / ✗ / ✓ | section D |
| `opencode` | OpenCode 1.18.32 | binary `./opencode acp` (anomalyco/opencode release zip) | terminal | ✓ / ✓ / ✓ / ✓ | section D |
| `github-copilot-cli` | GitHub Copilot 1.0.88 | `npx @github/copilot@1.0.88 --acp` | terminal | ✓ / ✓ / ✗ / ✗ | section D |
| `kimi` | Kimi CLI 1.52.0 | binary `./kimi acp` (MoonshotAI/kimi-cli release) | terminal | ✓ / ✓ / ✗ / ✓ | section D |
| `auggie` | Auggie CLI 0.36.0 | `npx @augmentcode/auggie@0.36.0 --acp` with env `AUGMENT_DISABLE_AUTO_UPDATE=1` | terminal | ✓ / ✓ / ✗ / ✗ | section D |
| `cursor` | Cursor 2026.09.18 | binary `./dist-package/cursor-agent acp` (downloads.cursor.com `agent-cli-package.tar.gz`) | agent | ✓ / ✓ / ✗ / ✗ | docs use `agent acp`; auth method id `cursor_login` |
| `junie` | Junie 3419.16.0 | binary `junie --acp=true` (JetBrains/junie-acp-release; macOS cmd is `./Applications/junie.app/Contents/MacOS/junie`) | agent | ✓ / ✓ / ✓ / ✓ | matrix: fork → "ParentNotResumable", resume → "already loaded" on the probe's fresh session |
| `amp-acp` | Amp 0.9.0 | binary `./amp-acp` (community wrapper, tao12345666333/amp-acp) | terminal | ✗ / ✗ / ✗ / ✗ in probe | README says `loadSession` + durable T-thread mapping from 0.10.0; registry still on 0.9.0 |
| `cline` | Cline 3.0.65 | `npx cline@3.0.65 --acp` | agent | ✓ / ✗ / ✗ / ✗ | |
| `factory-droid` | Factory Droid 0.227.0 | `npx droid@0.227.0 exec --output-format acp-daemon` + env disabling auto-update | agent | ✓ / ✓ / ✗ / ✓ | auth error text carries a device code; `FACTORY_API_KEY` alternative |
| `devin` | Devin 3000.11.3 | binary `./bin/devin acp` | agent, terminal | ✓ / ✓ / ✗ / ✗ | |
| `kilo` | Kilo 7.7.9 | binary `./kilo acp` or `npx @kilocode/cli@7.7.9 acp` | terminal | ✓ / ✓ / ✓ / ✓ | OpenCode fork |
| `mistral-vibe` | Mistral Vibe 2.25.8 | binary `./vibe-acp` | agent, terminal | ✓ / ✓ / ✓ / ✗ | |
| `grok-build` | Grok Build 1.0.41 | `npx @xai-official/grok@1.0.41 agent stdio` | agent | ✓ / ✓ / ✗ / ✓ | |
| `minimax-code` | MiniMax Code 0.2.7 | `npx @minimax-ai/code@0.2.7 acp` | terminal | ✓ / ✓ / ✓ / ✓ | |
| `glm-acp-agent` | GLM Agent 1.12.0 | `npx glm-acp-agent@1.12.0` | agent, env_var | ✓ / ✓ / ✓ / ✓ | still advertises the removed `env_var` type |
| `qoder` | Qoder CLI 0.2.14 | `npx @qoder-ai/qodercli@0.2.14 --acp` | — | — | not in the probe |
| `codebuddy-code` | Codebuddy Code 2.158.0 | `npx @tencent-ai/codebuddy-code@2.158.0 --acp` | agent | ✓ / ✗ / ✗ / ✗ | |
| `deepagents` | DeepAgents 0.1.7 | `npx deepagents-acp@0.1.7` | — | — | LangChain |
| `fast-agent` | fast-agent 0.10.1 | `uvx fast-agent-acp==0.10.1 -x` env `FAST_AGENT_MODEL=codexplan` | — | — | |
| `pi-acp` | pi ACP 0.0.34 | `npx pi-acp@0.0.34` (needs `pi` installed) | terminal | ✓ / ✓ / ✗ / ✗ | |
| `poolside` | Poolside 1.0.16 | binary `./pool-darwin-arm64 acp` | terminal | ✓ / ✓ / ✗ / ✗ | |
| `nova` | Nova 1.1.47 | `npx @compass-ai/nova@1.1.47 acp` | terminal | ✓ / ✓ / ✓ / ✓ | |
| others | agoragentic-acp, autohand, cortex-code, corust-agent, crow-cli, dimcode, dirac, harn, kimchi, minion-code, sigit, stakpak, vtcode | see `registry.json` | | | |

Not in the registry: **Kiro** (an ACP-speaking `kiro-cli` exists — the `@joeyshi12/casper` web client and the Obsidian plugin's "Kiro" preset target it — exact flag **[unverified]**), **Amp official** (only the community `amp-acp`), **Claude Code itself** (see C.3).

### B.3 Zed's `agent_servers` shape (the de-facto config format other clients copied)

```jsonc
{ "agent_servers": { "Kimi Code CLI": { "type": "custom", "command": "kimi", "args": ["acp"], "env": {} } } }
```
Registry-installed agents also accept per-agent overrides under `agent_servers.<agent-id>`; extension-provided agents are deprecated in favour of the registry. — https://zed.dev/docs/ai/external-agents (custom agents, "Importing Threads" = `session/list` + `session/load`, `dev: open acp logs`). JetBrains uses the same key in `~/.jetbrains/acp.json` (see E), CodeCompanion/avante/agent-shell use `command`/`args`/`env` triples.

---

## C. Claude Code

### C.1 Which package is current

- **Current**: `@agentclientprotocol/claude-agent-acp` — repo https://github.com/agentclientprotocol/claude-agent-acp, npm https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp. 0.81.2 published 2026-09-24 (115 versions since 0.24.0 on 2026-03-26; `@preview` tag is published on every push to main). `bin: claude-agent-acp`, `engines.node >= 22`, deps `@agentclientprotocol/sdk 1.5.0`, `@anthropic-ai/claude-agent-sdk 0.3.280`, `zod 4.6.5`. Registry id `claude-acp`, name "Claude Agent".
- **Legacy**: `@zed-industries/claude-code-acp` — last release 0.16.2 on 2026-02-17 (deps SDK 0.14.1, claude-agent-sdk 0.2.44); the GitHub repo `zed-industries/claude-code-acp` now redirects to the new one (its `main` README is the new package's). Do not use it.
- The maintainer is the ACP org (Zed-founded, JetBrains co-maintained), **not Anthropic**. Anthropic's own docs list Claude only "via Zed's SDK adapter" (https://agentclientprotocol.com/get-started/agents) and nothing on platform.claude.com / code.claude.com mentions ACP; `claude --help` (2.1.281, this machine) has no `--acp` flag and `anthropics/claude-code` CHANGELOG.md has no ACP entry. **There is no native `claude --acp`.**

### C.2 How `claude-agent-acp` 0.81.2 works (read from `dist/`)

- Architecture: in-process `@anthropic-ai/claude-agent-sdk` `query()`; the SDK spawns the bundled Claude Code CLI (`process.execPath` as `executable`, override with `CLAUDE_CODE_EXECUTABLE`; `CLAUDE_CONFIG_DIR` defaults to `~/.claude`). Streamed SDK messages are translated to ACP; `includePartialMessages: true`; preset system prompt `claude_code` (override via `_meta.systemPrompt` string or `{ append }`); settings from `["user","project","local"]`; a `PreToolUse` hook and an in-process MCP server named `acp` give Claude the client's `fs/*` and `terminal/*` (the SDK's own `Read`/`Write`/`Edit`/`Bash`/`BashOutput`/`KillShell` are disallowed when the client advertises `fs.readTextFile` / `fs.writeTextFile` / `terminal`; `_meta.disableBuiltInTools: true` turns the whole bridge off).
- `initialize` answer: `protocolVersion: 1`; `promptCapabilities { image: true, embeddedContext: true }` (no audio); `mcpCapabilities { http: true, sse: true }`; `auth.logout: {}`; `providers: {}` (unstable `providers/*` implemented); `loadSession: true`; `sessionCapabilities { additionalDirectories, close, delete, fork, list, resume, subagents }`; `agentCapabilities._meta.claudeCode.promptQueueing: true` and `.authStatus`; top-level `_meta.steering.supported: true`, `_meta.goal {...}`, AIR capability mirrors.
- **Auth** (`authMethods` are only emitted if the client advertised `clientCapabilities.auth.terminal` or the legacy `_meta["terminal-auth"]`): local machine → `claude-ai-login` (type `terminal`, args `["--cli","auth","login","--claudeai"]`, "Claude Subscription") and `console-login` (`["--cli","auth","login","--console"]`, "Anthropic Console (API usage billing)"); remote (`SSH_*`, `NO_BROWSER`, `CLAUDE_CODE_REMOTE`) → `claude-login` args `["--cli"]` (interactive TUI `/login`). `authenticate` only handles the `gateway` / `gateway-bedrock` agent-type methods (offered when `clientCapabilities.auth._meta.gateway === true`; params `_meta.gateway.baseUrl/headers`). Otherwise credentials are whatever `~/.claude` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_USE_BEDROCK|VERTEX` already provide; `logout` is implemented. It probes CLI auth in the background and pushes `_auth/status_update`. `shouldHideClaudeAuth()` (managed policy) can hide the subscription method.
- **Modes** = Claude permission modes, exposed both as `modes` and as config option `id: "mode"` (category `mode`): `default` "Manual", `acceptEdits`, `plan`, `auto` (falls back to `acceptEdits` when the model lacks auto mode, with a `notice`), and `bypassPermissions` only when allowed (not root; `_meta.claudeCode.options.allowDangerouslySkipPermissions !== false`). `ExitPlanMode` becomes a permission request whose options switch mode.
- **Config options**: `mode`, `model` (SDK model list; `DEFAULT_MODEL_ID = "default"`; env `ANTHROPIC_MODEL`, `CLAUDE_MODEL_CONFIG`, `ANTHROPIC_CUSTOM_MODEL_OPTION`), `effort` (per-model supported effort levels from the SDK; `MAX_THINKING_TOKENS` env), `fast` (fast mode). No `session/set_model`.
- **Permissions**: SDK `canUseTool` → `session/request_permission` with standard kinds; `allow_always` writes `addRules`/`setMode` back into Claude's session settings; a cancelled outcome aborts the tool. `_meta.permission` presentation text per docs/permission-extension.md.
- **Plan**: `TodoWrite` tool calls are rendered as `sessionUpdate: "plan"` (never as tool calls); `Task*` subagent tools are flattened into the root transcript unless the client negotiates native subagent sessions (`clientCapabilities.subagents` draft or `_meta.jetbrains.air.capabilities: ["nativeSubagentSessions"]`).
- **AskUserQuestion**: converted to `elicitation/create` (form mode, one enum field per question, custom-answer field, `_meta["_claude/askUserQuestionOption"]` on options) when the client advertised form elicitation; 0.16.2 simply disallowed the tool. MCP-server elicitations from Claude's own MCP servers are forwarded the same way (url mode supported).
- **Slash commands**: `query.supportedCommands()` → `available_commands_update` right after `session/new`/`load` and whenever the SDK reports a change (custom commands, skills). Invoked by sending `/name …` as prompt text.
- **Sessions**: id = Claude's native session id; `session/list` scans `~/.claude/projects/<encoded-cwd>/*.jsonl` (cursor = base64 offset, page 50); `session/load` re-`query({ resume })` then replays the JSONL; `resume` skips replay; `fork` = `resume + forkSession: true`; `delete`/`close` implemented.
- **Other updates emitted**: `usage_update` (context used/size + cost), `session_info_update` (titles), `notice`, `compaction_update` / `compaction_summary_chunk` (`/compact`), `_claude/sdkMessage`.
- Stop reasons observed in code: `end_turn`, `cancelled`, and `max_turn_requests` for SDK `error_max_turns` (0.16.2 code; 0.81.2 **[unverified]** beyond `cancelled`); `refusal`/`max_tokens` are not mapped **[unverified]**.
- Logs: `CLAUDE_AGENT_LOGS` directory; stderr is otherwise the log.

### C.3 Zed's and others' Claude usage

Zed installs `claude-acp` from the registry; "run `/login`" inside the thread is how billing is chosen; `CLAUDE.md` is read by the agent itself. — https://zed.dev/docs/ai/external-agents#claude-agent

---

## D. Other agents — specifics

- **Gemini CLI** — flag `gemini --acp` (registry, docs); `--experimental-acp` still works but is deprecated (the 0.30.0 binary on this machine only shows `--experimental-acp`). Auth is agent-type: `oauth-personal` (Google login), `gemini-api-key` (`GEMINI_API_KEY`), `vertex-ai` (ids from CodeCompanion's adapter); the registry probe answers `session/new` with `-32000 "Gemini API key is missing or not configured."`. Capabilities: `loadSession: true`, no list/resume/fork; docs list `setSessionMode` (approval level, e.g. `auto-approve`) and `unstable_setSessionModel`. Client MCP servers are supported; implementation lives in `packages/cli/src/acp/acpClient.ts` (docs) / `packages/cli/src/zed-integration/zedIntegration.ts` (SDK README). Debug with `--debug` or `GEMINI_TELEMETRY_*` file telemetry. Note the June-18-2026 transition of unpaid tiers to **Antigravity CLI** (separate registry entry `antigravity-acp`). Docs: https://geminicli.com/docs/cli/acp-mode/, https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
- **Codex** — `npx -y @agentclientprotocol/codex-acp` (1.13.1, repo https://github.com/agentclientprotocol/codex-acp; bundles `@openai/codex ^0.156.1`, `CODEX_PATH` overrides the binary; there is no `codex acp` subcommand in codex-cli 0.155.1). It drives the **Codex App Server** (vscode-jsonrpc). Auth: ChatGPT login (agent-type; hidden with `NO_BROWSER=1`), `api-key` (`CODEX_API_KEY` > `OPENAI_API_KEY`), `gateway` (client-opted). Modes: `read-only`, `workspace-write`, `agent`, `agent-full-access` (`INITIAL_AGENT_MODE`); config options for model, reasoning effort, fast mode, approval, sandbox. Prompts: text, embedded context, images, resource links, additional directories. Emits shell/file-change/permission/MCP/terminal/reasoning/plan/web-search/image events, `usage_update`, review events, and the non-standard subagent/async-task updates (A.8/A.11). Slash commands: `/status /mcp /skills /goal /review /review-branch /review-commit /compact /logout` + skills. Capabilities: load/list/fork/resume. Env: `CODEX_CONFIG` (JSON merged into session config), `MODEL_PROVIDER`, `DEFAULT_AUTH_REQUEST`, `APP_SERVER_LOGS`.
- **Goose** — registry binary `goose acp` (v1.52.0, block/goose releases), agent-type auth, `loadSession` + `session/list`. Zed: "native ACP implementation". JetBrains' blog/neovim examples use `goose acp --with-builtin developer` **[unverified against goose docs — every goose docs URL I tried 404'd; the goose-acp crate/ui/acp README paths also 404]**. The probe's `session/new` returned `-32603` on the clean machine (no provider configured). Sources: https://github.com/block/goose, https://zed.dev/acp/agent/goose, https://github.com/block/goose/discussions/7309
- **Qwen Code** — `qwen --acp` (registry adds `--experimental-skills`), 0.24.5; agent-type auth (Qwen OAuth or OpenAI-compatible key via the CLI; probe: "Use Qwen Code CLI to authenticate first"); load/list/resume. Known issue: modes and session management over ACP not matching Zed's expectations (QwenLM/qwen-code#2015). Docs: https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/, https://github.com/QwenLM/qwen-code/blob/main/docs/users/integration-zed.md
- **OpenCode** — `opencode acp` (binary from anomalyco/opencode releases, 1.18.32); terminal-type auth (`opencode auth login` **[flag unverified]**); load/list/fork/resume all answer in the probe. Docs show Zed and JetBrains `acp.json` config and a keymap action `agent::NewExternalAgentThread`. https://opencode.ai/docs/acp/ (the local `opencode acp --help` printed nothing — the subcommand just starts the server).
- **GitHub Copilot CLI** — `copilot --acp` (public preview since 2026-01-28; `@github/copilot` 1.0.88 in registry, 1.0.4 locally shows the flag). Transports: stdio (default, `--stdio`) or **TCP `--port N`** (loopback, multi-client, stdout free for logs). Server-level options apply to every session: `--available-tools`, `--excluded-tools`, `--effort|--reasoning-effort low|medium|high|xhigh|max`; BYOK via `COPILOT_PROVIDER_*` / `COPILOT_PROVIDERS_CONFIG` skips GitHub login. Terminal-type auth in the registry. Slash commands over ACP: send `/context`, `/session info`, `/plan`, `/review` … as a single text block; picker-style commands (`/diff /resume /theme /settings /login /help /tasks /undo`) are not available; list arrives via `available_commands_update` (built-ins + `/SKILL-NAME`). Capabilities: load + list. https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server, https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/
- **Kimi** — the Python `kimi-cli` is archived; **Kimi Code CLI** (`MoonshotAI/kimi-code`) exposes `kimi acp` (registry: binary 1.52.0 from MoonshotAI/kimi-cli releases — the registry still points at the old repo name). Terminal-type auth (log in once with `kimi`, ACP reuses it; "auth required" means run `kimi` in a terminal). load/list/resume. MCP transports `http`, `stdio`, `sse`; `acp`-type MCP entries are silently dropped. Docs: https://moonshotai.github.io/kimi-code/en/guides/ides, reference `…/reference/kimi-acp` (capability matrix).
- **Augment (Auggie)** — `auggie --acp` (`@augmentcode/auggie` 0.36.0; registry sets `AUGMENT_DISABLE_AUTO_UPDATE=1`); terminal-type auth (`auggie login`; agent-shell also supports "no auth"); load + list; docs warn "not all interactive features are supported in ACP mode". https://docs.augmentcode.com/cli/acp
- **Cursor** — `agent acp` (docs) / registry binary `cursor-agent acp`; agent-type auth `cursor_login`, or pre-auth with `agent login`, `--api-key`/`CURSOR_API_KEY`, `--auth-token`/`CURSOR_AUTH_TOKEN`; modes `agent`, `plan`, `ask`; `session/new` + `session/load` (+ list per probe); MCP from `.cursor/mcp.json`; permission options `allow-once|allow-always|reject-once`; the five `cursor/*` extension methods. https://cursor.com/docs/cli/acp
- **Junie (JetBrains)** — binary release channel https://github.com/JetBrains/junie-acp-release (`--acp=true`; GA tags are plain `x.y`; EAP/staging pointer JSONs on `main`). Agent-type auth; load/list/fork/resume advertised.
- **Amp** — community `amp-acp` (Rust, https://github.com/tao12345666333/amp-acp; also on npm as `amp-acp`): terminal-type auth (`amp login`, `AMP_API_KEY`, `amp-acp --setup`), durable ACP-session ↔ Amp `T-…` thread mapping under `$XDG_STATE_HOME/amp-acp/sessions`, `AMP_ACP_CONTINUE_LATEST=1`, `AMP_CLI_PATH`.
- **Cline** — `cline --acp` (npm `cline` 3.0.65); agent-type auth ("Call authenticate before starting a session"); `loadSession` only.

---

## E. Client implementations to learn from

Official list: https://agentclientprotocol.com/get-started/clients (editors, CLI/TUI, desktop/web, notebooks, mobile).

| client | language | what to mirror | URL |
| --- | --- | --- | --- |
| **Zed** | Rust (`crates/agent_servers`, `crates/acp_thread`) | Process lifecycle: `transport::spawn_stdio`, a background task draining **stderr into a debug log** (`AcpDebugLog::trailing_stderr`), `child.status()` awaited so an early exit becomes a load error that carries the trailing stderr, a 250 ms `EXIT_DRAIN_TIMEOUT` to finish reading stdout/stderr after exit ("descendants can keep stdout or stderr open"), `child.kill()` on drop; per-connection `ElicitationStore`; `dev: open acp logs`; thread import via `session/list`+`load`; terminal auth (`GEMINI_TERMINAL_AUTH_METHOD_ID = "spawn-gemini-cli"`) | https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs, https://github.com/zed-industries/zed/blob/main/crates/acp_thread/src/connection.rs |
| **JetBrains AI Assistant** | Kotlin (closed) | Config `~/.jetbrains/acp.json` `{ "agent_servers": { "<name>": { "command": "/abs/path", "args": [...] } } }` (absolute `command` required), registry install from the chat's agent selector; the `_meta.jetbrains.air.*` extension family (session failures, async tasks, native subagents, recommended config values) | https://www.jetbrains.com/help/ai-assistant/acp.html, https://www.jetbrains.com/acp/ |
| **acpx** | TypeScript, MIT | The most complete Node client: `acpx/runtime` (`AcpRuntime` with `ensure/startTurn/runTurn`, `timeoutMs`, `onPermissionRequest`, `onElicitation`, `mode: "prompt"|"steer"`, session journal + `watch` events with cursors, `createSharedAcpRuntime()` so a GUI and CLI share one session owner), `agent-registry.d.ts` (name → command/argv map, npm-package fallback launch via `resolveBuiltInAgentLaunch`), permission policy engine (`--approve-all|--approve-reads|--deny-all`, per-tool `autoApprove/autoDeny/escalate`, `_meta.acpx.permissionEscalation`), NDJSON output mode. Depends on `@agentclientprotocol/sdk`. | https://github.com/openclaw/acpx, https://www.npmjs.com/package/acpx (0.19.3, 2026-09-25) |
| **acp-factory** | TypeScript | "library for spawning and managing agents through ACP" — `AgentFactory` API | https://www.npmjs.com/package/acp-factory (0.1.15, 2026-06-02; README fetched from the tarball) |
| **@qlairoslabs/acp-client** | TypeScript | "Embeddable ACP client library with degraded PTY fallback" | https://www.npmjs.com/package/@qlairoslabs/acp-client (0.10.1) **[not read]** |
| **@tanstack/ai-acp** | TypeScript | ACP transport/session + AG-UI translation | https://www.npmjs.com/package/@tanstack/ai-acp (0.3.17) **[not read]** |
| **use-acp** | TypeScript/React | React hooks over the SDK | https://www.npmjs.com/package/use-acp (0.2.6, 2026-01) **[not read]** |
| **Obsidian "Agent Client"** | TypeScript (Electron plugin — closest analogue to this repo) | Nine presets + custom agents, `@`-mentions → resource blocks, slash commands with hints, modes/models/config toolbar, word-level diffs, permission banner + hotkeys, session history/resume/fork, floating windows, WSL launch | https://github.com/RAIT-09/obsidian-agent-client |
| **marimo** | TypeScript frontend + Python | Agents panel embedding Claude Code / Codex / Gemini CLI | https://docs.marimo.io/guides/editor_features/agents/ |
| **CodeCompanion.nvim** | Lua | Adapter model: `commands.default = {cmd, args}`, `defaults.auth_method`, `defaults.timeout`, `env` with `cmd:` secret resolution, `mcpServers = "inherit_from_config"`; preset adapters `claude_code`, `gemini_cli`, … | https://codecompanion.olimorris.dev/configuration/adapters-acp |
| **avante.nvim** | Lua | `acp_providers = { <name> = { command, args, auth_method, env } }` | https://github.com/yetone/avante.nvim |
| **agent-shell.el** | Emacs Lisp | Per-agent authentication objects (`:login t` / `:none t` / api-key), environment records, `agent-shell-command-prefix` for running agents inside containers (`docker exec …`) | https://github.com/xenodium/agent-shell |
| **Mitto** | (desktop, macOS/Linux) | multi-agent, multi-workspace ACP client | https://github.com/inercia/mitto |
| **ACP Inspector** | desktop | protocol debugger — useful while building | https://github.com/newioapp/acp-inspector |
| **AcpAgent Client** | Rust SDK desktop (Windows) | registry one-click install, Agent + Terminal auth, traffic inspector | https://github.com/ClickPM/AcpAgentClient |

Process-management rules distilled from the above and the spec:

1. Spawn with `stdio: ["pipe","pipe","pipe"]`; **never** let anything else write to the child's stdin; treat any non-JSON stdout line as a protocol violation (log + drop; the SDK's `ndJsonStream` will throw on malformed input since 1.4.0 "report malformed input").
2. Drain stderr continuously into a ring buffer; surface the tail when the process exits early (Zed) — most "agent exited immediately" cases are PATH/login problems (Kimi docs).
3. Watch `connection.closed` / `connection.signal` (SDK) **and** the child's `exit` event; the SDK does not restart anything. On crash mid-turn, fail the pending `prompt` with `cancelled`/error, answer pending permission requests with `cancelled`, then respawn and `session/resume` (if advertised) or `session/load`.
4. GUI-launched processes on macOS do not inherit the login-shell `PATH` (Kimi, Amp `AMP_CLI_PATH`); resolve absolute paths (JetBrains requires them) — this repo already does the login-shell-env dance for ACP adapters.
5. Terminal-type auth means re-spawning the **same** command + args + env in a PTY, appending the method's `args`, and reconnecting/re-`initialize`-ing after exit 0.
6. Kill order on shutdown: `session/close` (if advertised) or `session/cancel` for live turns → close stdin → wait a short drain (Zed: 250 ms) → SIGTERM/kill.

---

## F. Not verified / open

- Whether goose's official docs document `goose acp` flags (`--with-builtin`) — all goose doc URLs tried returned 404.
- Kiro's ACP command line (only third-party clients reference `kiro-cli` over ACP).
- OpenCode's exact login subcommand for the terminal auth method.
- claude-agent-acp 0.81.2's mapping of SDK results to `max_tokens` / `refusal` / `max_turn_requests` (only `cancelled` is literal in `acp-agent.js`; 0.16.2 mapped `error_max_turns` → `max_turn_requests`).
- The meaning of error code `-32042` present in SDK 0.17.1 and absent in 1.5.0.
- `@qlairoslabs/acp-client`, `@tanstack/ai-acp`, `use-acp` were identified from npm metadata only.
