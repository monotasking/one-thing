/**
 * The single source of truth for @onething/* module resolution.
 *
 * package.json "exports" maps are dead here (no npm workspaces — everything
 * resolves from source via these aliases), and four configs used to carry
 * hand-synced copies of this table (electron-vite, vitest, apps/server,
 * apps/web). Missing an entry fails only at build/run time, never at
 * typecheck (tsconfig wildcards accept any subpath) — so keep exactly one
 * table and spread it everywhere.
 *
 * Ordering matters: string finds are prefix matchers, first match wins —
 * keep longer prefixes before their shorter siblings within each family.
 */
import { resolve } from 'node:path'

export interface OnethingAliasEntry {
  find: string | RegExp
  replacement: string
}

export function onethingPackageAliases(projectRoot: string): OnethingAliasEntry[] {
  return [
  // Product assembly tree (the former apps/electron/src/main). One prefix
  // entry covers every subpath — do NOT add per-file entries for it.
  { find: '@onething/app', replacement: resolve(projectRoot, 'packages/onething-runtime/src/app') },
  { find: '@onething/core/actors', replacement: resolve(projectRoot, 'packages/core/actors/index.ts') },
  { find: '@onething/core/agent-loop', replacement: resolve(projectRoot, 'packages/core/agent-loop/index.ts') },
  // Browser-safe leaf module (no node deps) — must be registered BEFORE the
  // engine barrel so the renderer never drags node:crypto into the bundle.
  { find: '@onething/core/engine/attachment-mime', replacement: resolve(projectRoot, 'packages/core/engine/attachment-mime.ts') },
  { find: '@onething/core/engine/streaming-args', replacement: resolve(projectRoot, 'packages/core/engine/streaming-args.ts') },
  // §13.9:引擎回合号的那一条判定规则。采集点要读它,而引擎 barrel(以及
  // agent-loop-executor 本体)会把整棵执行器模块图拖进记录器的单测。
  { find: '@onething/core/engine/agent-loop-turn', replacement: resolve(projectRoot, 'packages/core/engine/agent-loop-turn.ts') },
  { find: '@onething/core/engine', replacement: resolve(projectRoot, 'packages/core/engine/index.ts') },
  { find: '@onething/core/events', replacement: resolve(projectRoot, 'packages/core/events/index.ts') },
  { find: '@onething/core/gateway-runtime', replacement: resolve(projectRoot, 'packages/core/gateway-runtime.ts') },
  { find: '@onething/core/http', replacement: resolve(projectRoot, 'packages/core/http/index.ts') },
  { find: '@onething/core/interaction', replacement: resolve(projectRoot, 'packages/core/interaction/index.ts') },
  { find: '@onething/core/ipc', replacement: resolve(projectRoot, 'packages/core/ipc/index.ts') },
  { find: '@onething/core/json', replacement: resolve(projectRoot, 'packages/core/json.ts') },
  { find: '@onething/core/logging', replacement: resolve(projectRoot, 'packages/core/logging/index.ts') },
  { find: '@onething/core/mcp', replacement: resolve(projectRoot, 'packages/core/mcp/index.ts') },
  { find: '@onething/core/permission', replacement: resolve(projectRoot, 'packages/core/permission/index.ts') },
  // Browser-safe leaf module (zero imports, pure serialization logic) — must be
  // registered BEFORE the plugins barrel so the renderer never drags loader.ts
  // (node:url 的 pathToFileURL) into the bundle;桶一进浏览器包就在求值时炸。
  { find: '@onething/core/plugins/request-channel', replacement: resolve(projectRoot, 'packages/core/plugins/request-channel.ts') },
  // Same reason as request-channel: a zero-import leaf (N1 的会话动词协议:枚举 +
  // 常量 + 纯函数),披露文案要在设置页复用同一份口径,所以它必须排在桶前面。
  { find: '@onething/core/plugins/sessions', replacement: resolve(projectRoot, 'packages/core/plugins/sessions.ts') },
  // 同理的第三片叶子(M1 通知音效集):枚举 + 常量 + 纯函数,零 import。
  // 音效名的事实源要被 renderer 的合成配方表引用(exhaustive Record),所以它
  // 必须排在桶前面 —— 走桶会把 loader.ts 拖进浏览器包。
  { find: '@onething/core/plugins/notify-sound', replacement: resolve(projectRoot, 'packages/core/plugins/notify-sound.ts') },
  // 第四片叶子(H4 深链协议):枚举 + 常量 + 纯解析函数,零 import。确认卡要在
  // renderer 侧复用同一份口径(长度上限、可见拒绝),所以它必须排在桶前面。
  { find: '@onething/core/plugins/deep-link', replacement: resolve(projectRoot, 'packages/core/plugins/deep-link.ts') },
  { find: '@onething/core/plugins', replacement: resolve(projectRoot, 'packages/core/plugins/index.ts') },
  { find: '@onething/core/session/storage', replacement: resolve(projectRoot, 'packages/core/session/storage/index.ts') },
  { find: '@onething/core/session', replacement: resolve(projectRoot, 'packages/core/session/index.ts') },
  { find: '@onething/core/slash-commands', replacement: resolve(projectRoot, 'packages/core/slash-commands.ts') },
  { find: '@onething/core/storage', replacement: resolve(projectRoot, 'packages/core/storage/index.ts') },
  // 工具系统内核(docs/design/tool-system-oop-2026-08.md §3)。与下面的 tools 互不
  // 为前缀('toolk' ≠ 'tools'),但仍按字典序排在它前面,别让人以为顺序无所谓。
  { find: '@onething/core/toolkit', replacement: resolve(projectRoot, 'packages/core/toolkit/index.ts') },
  { find: '@onething/core/tools', replacement: resolve(projectRoot, 'packages/core/tools/index.ts') },
  { find: '@onething/core', replacement: resolve(projectRoot, 'packages/core/index.ts') },
  { find: '@onething/gateway/config', replacement: resolve(projectRoot, 'packages/gateway/src/config.ts') },
  { find: '@onething/gateway/core', replacement: resolve(projectRoot, 'packages/gateway/src/core/index.ts') },
  { find: '@onething/gateway/telegram', replacement: resolve(projectRoot, 'packages/gateway/src/channels/telegram/index.ts') },
  { find: '@onething/gateway/wechat', replacement: resolve(projectRoot, 'packages/gateway/src/channels/wechat/index.ts') },
  { find: '@onething/gateway', replacement: resolve(projectRoot, 'packages/gateway/src/index.ts') },
  { find: '@onething/runtime/logging', replacement: resolve(projectRoot, 'packages/onething-runtime/src/logging/index.ts') },
  { find: '@onething/runtime/headless', replacement: resolve(projectRoot, 'packages/onething-runtime/src/headless/index.ts') },
  { find: '@onething/runtime/runtime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/runtime.ts') },
  { find: '@onething/runtime/product-stream-runtime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/product-stream-runtime.ts') },
  { find: '@onething/runtime/auth', replacement: resolve(projectRoot, 'packages/onething-runtime/src/auth/index.ts') },
  { find: '@onething/runtime/agent-loop/provider-error-classification', replacement: resolve(projectRoot, 'packages/onething-runtime/src/agent-loop/provider-error-classification.ts') },
  { find: '@onething/runtime/agent-loop/providers', replacement: resolve(projectRoot, 'packages/onething-runtime/src/agent-loop/providers/index.ts') },
  { find: '@onething/runtime/agent-loop', replacement: resolve(projectRoot, 'packages/onething-runtime/src/agent-loop/index.ts') },
  { find: '@onething/runtime/stream-runtime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/stream-runtime.ts') },
  { find: '@onething/runtime/stream-engine', replacement: resolve(projectRoot, 'packages/onething-runtime/src/stream-engine.ts') },
  { find: '@onething/runtime/stream-processor', replacement: resolve(projectRoot, 'packages/onething-runtime/src/stream-processor.ts') },
  { find: '@onething/runtime/gateway', replacement: resolve(projectRoot, 'packages/onething-runtime/src/gateway-runtime.ts') },
  { find: '@onething/runtime/acp', replacement: resolve(projectRoot, 'packages/onething-runtime/src/acp/index.ts') },
  { find: '@onething/runtime/external-agents', replacement: resolve(projectRoot, 'packages/onething-runtime/src/external-agents/index.ts') },
  // 会话删除的轨迹级联要的只是 trace-store 这一片叶子(`deleteSessionTraces`)。
  // 故意**不**登记 `@onething/runtime/evals` 那颗 barrel:它把整套评估台
  // (runner / judge / replay …)拖进每个宿主的包,而删会话只需要一个 rm。
  { find: '@onething/runtime/evals/trace-store', replacement: resolve(projectRoot, 'packages/onething-runtime/src/evals/trace-store.ts') },
  // Agent 身份/在场的**叶子**入口:renderer 要现算履历(agent-im-dm.md D8)就得
  // 吃 identity/presence 这两支纯函数,而 `agents` 那颗 barrel 拖着吃 node:fs 的
  // store.ts —— 走 barrel 会把文件系统拽进浏览器包。长前缀必须站在短前缀之上
  // (find 是前缀匹配,先命中者赢)。
  { find: '@onething/runtime/agents/identity', replacement: resolve(projectRoot, 'packages/onething-runtime/src/agents/identity.ts') },
  { find: '@onething/runtime/agents/presence', replacement: resolve(projectRoot, 'packages/onething-runtime/src/agents/presence.ts') },
  // 同上第三支:域模型的投影与判定(model.ts)。renderer 吃它是为了墓碑文案的
  // 单一属主(架构审查 B8)—— 它只 `import type` store.ts,类型被擦掉,node:fs
  // 进不了浏览器包。
  { find: '@onething/runtime/agents/model', replacement: resolve(projectRoot, 'packages/onething-runtime/src/agents/model.ts') },
  { find: '@onething/runtime/agents', replacement: resolve(projectRoot, 'packages/onething-runtime/src/agents/index.ts') },
  // Collab v3 的 actor 协议与金重放架。**必须站在 `collab` 之上**:find 是前缀
  // 匹配,先命中者赢 —— 落在下面的话 `…/collab/actors` 会被 `…/collab` 吃掉,
  // 解析成 `collab/index.ts/actors`,而这种错只在 build/run 时才炸(typecheck
  // 的通配符照单全收)。
  { find: '@onething/runtime/collab/actors', replacement: resolve(projectRoot, 'packages/onething-runtime/src/collab/actors/index.ts') },
  { find: '@onething/runtime/collab', replacement: resolve(projectRoot, 'packages/onething-runtime/src/collab/index.ts') },
  { find: '@onething/runtime/files/ripgrep', replacement: resolve(projectRoot, 'packages/onething-runtime/src/files/ripgrep.ts') },
  { find: '@onething/runtime/files', replacement: resolve(projectRoot, 'packages/onething-runtime/src/files/index.ts') },
  { find: '@onething/runtime/mcp', replacement: resolve(projectRoot, 'packages/onething-runtime/src/mcp/index.ts') },
  { find: '@onething/runtime/scheduler', replacement: resolve(projectRoot, 'packages/onething-runtime/src/scheduler/index.ts') },
  { find: '@onething/runtime/scratchpad', replacement: resolve(projectRoot, 'packages/onething-runtime/src/scratchpad/index.ts') },
  { find: '@onething/runtime/search/protocol', replacement: resolve(projectRoot, 'packages/onething-runtime/src/search/protocol.ts') },
  { find: '@onething/runtime/search', replacement: resolve(projectRoot, 'packages/onething-runtime/src/search/index.ts') },
  { find: '@onething/runtime/voice/kws/text2token', replacement: resolve(projectRoot, 'packages/onething-runtime/src/voice/kws/text2token.ts') },
  { find: '@onething/runtime/voice/volcano/protocol', replacement: resolve(projectRoot, 'packages/onething-runtime/src/voice/volcano/protocol.ts') },
  { find: '@onething/runtime/voice/volcano/asr-session', replacement: resolve(projectRoot, 'packages/onething-runtime/src/voice/volcano/asr-session.ts') },
  { find: '@onething/runtime/voice/volcano/tts-session', replacement: resolve(projectRoot, 'packages/onething-runtime/src/voice/volcano/tts-session.ts') },
  { find: '@onething/runtime/voice/providers', replacement: resolve(projectRoot, 'packages/onething-runtime/src/voice/providers.ts') },
  { find: '@onething/runtime/voice/text', replacement: resolve(projectRoot, 'packages/onething-runtime/src/voice/text.ts') },
  { find: '@onething/runtime/voice', replacement: resolve(projectRoot, 'packages/onething-runtime/src/voice/index.ts') },
  { find: '@onething/runtime/providers/model-capability', replacement: resolve(projectRoot, 'packages/onething-runtime/src/providers/model-capability.ts') },
  { find: '@onething/runtime/providers/provider-config', replacement: resolve(projectRoot, 'packages/onething-runtime/src/providers/provider-config.ts') },
  { find: '@onething/runtime/providers/qwen', replacement: resolve(projectRoot, 'packages/onething-runtime/src/providers/qwen.ts') },
  { find: '@onething/runtime/providers/kimi', replacement: resolve(projectRoot, 'packages/onething-runtime/src/providers/kimi.ts') },
  { find: '@onething/runtime/providers/models-dev-catalog', replacement: resolve(projectRoot, 'packages/onething-runtime/src/providers/models-dev-catalog.ts') },
  { find: '@onething/runtime/project-dirs/id', replacement: resolve(projectRoot, 'packages/onething-runtime/src/project-dirs/id.ts') },
  { find: '@onething/runtime/project-dirs/persistence', replacement: resolve(projectRoot, 'packages/onething-runtime/src/project-dirs/persistence.ts') },
  { find: '@onething/runtime/project-dirs/prompt', replacement: resolve(projectRoot, 'packages/onething-runtime/src/project-dirs/prompt.ts') },
  { find: '@onething/runtime/project-dirs/store', replacement: resolve(projectRoot, 'packages/onething-runtime/src/project-dirs/store.ts') },
  { find: '@onething/runtime/project-dirs', replacement: resolve(projectRoot, 'packages/onething-runtime/src/project-dirs/index.ts') },
  { find: '@onething/runtime/prompts', replacement: resolve(projectRoot, 'packages/onething-runtime/src/prompts/index.ts') },
  // spaces(workspace 骨架,批 B1)。子路径在 barrel 上方 —— 前缀匹配先到先得。
  { find: '@onething/runtime/spaces/provider-credentials', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/provider-credentials.ts') },
  { find: '@onething/runtime/spaces/credentials', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/credentials.ts') },
  { find: '@onething/runtime/spaces/ipc-operations', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/ipc-operations.ts') },
  { find: '@onething/runtime/spaces/notifications', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/notifications.ts') },
  { find: '@onething/runtime/spaces/overlay', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/overlay.ts') },
  { find: '@onething/runtime/spaces/provider-settings', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/provider-settings.ts') },
  { find: '@onething/runtime/spaces/persistence', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/persistence.ts') },
  { find: '@onething/runtime/spaces/store', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/store.ts') },
  { find: '@onething/runtime/spaces/types', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/types.ts') },
  { find: '@onething/runtime/spaces', replacement: resolve(projectRoot, 'packages/onething-runtime/src/spaces/index.ts') },
  { find: '@onething/runtime/providers', replacement: resolve(projectRoot, 'packages/onething-runtime/src/providers/index.ts') },
  { find: '@onething/runtime/skills', replacement: resolve(projectRoot, 'packages/onething-runtime/src/skills/index.ts') },
  { find: '@onething/runtime/goals', replacement: resolve(projectRoot, 'packages/onething-runtime/src/goals/index.ts') },
  { find: '@onething/runtime/usage', replacement: resolve(projectRoot, 'packages/onething-runtime/src/usage/index.ts') },
  { find: '@onething/runtime/toc', replacement: resolve(projectRoot, 'packages/onething-runtime/src/toc/index.ts') },
  { find: '@onething/runtime/practice', replacement: resolve(projectRoot, 'packages/onething-runtime/src/practice/index.ts') },
  { find: '@onething/runtime/media', replacement: resolve(projectRoot, 'packages/onething-runtime/src/media/index.ts') },
  { find: '@onething/runtime/music', replacement: resolve(projectRoot, 'packages/onething-runtime/src/music/index.ts') },
  { find: '@onething/runtime/markdown', replacement: resolve(projectRoot, 'packages/onething-runtime/src/markdown/index.ts') },
  { find: '@onething/runtime/themes/base46-parser', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/base46-parser.ts') },
  { find: '@onething/runtime/themes/css-mapper', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/css-mapper.ts') },
  { find: '@onething/runtime/themes/knobs', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/knobs.ts') },
  { find: '@onething/runtime/themes/resolver', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/resolver.ts') },
  { find: '@onething/runtime/themes/role-mapping', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/role-mapping.ts') },
  { find: '@onething/runtime/themes/skin', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/skin.ts') },
  { find: '@onething/runtime/themes/theme-runtime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/theme-runtime.ts') },
  { find: '@onething/runtime/themes', replacement: resolve(projectRoot, 'packages/onething-runtime/src/themes/index.ts') },
  { find: '@onething/runtime/todo-plan', replacement: resolve(projectRoot, 'packages/onething-runtime/src/todo-plan/index.ts') },
  { find: '@onething/runtime/variables/providers/agent-self', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/agent-self.ts') },
  { find: '@onething/runtime/variables/providers/background-jobs', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/background-jobs.ts') },
  { find: '@onething/runtime/variables/providers/music-radio', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/music-radio.ts') },
  { find: '@onething/runtime/variables/bootstrap', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/bootstrap.ts') },
  { find: '@onething/runtime/variables/providers/core', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/core.ts') },
  { find: '@onething/runtime/variables/providers/datetime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/datetime.ts') },
  { find: '@onething/runtime/variables/providers/git-branch', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/git-branch.ts') },
  { find: '@onething/runtime/variables/providers/global-store', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/global-store.ts') },
  { find: '@onething/runtime/variables/providers/keyed-store', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/keyed-store.ts') },
  { find: '@onething/runtime/variables/providers/goal', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/goal.ts') },
  { find: '@onething/runtime/variables/providers/notes', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/notes.ts') },
  { find: '@onething/runtime/variables/providers/session-store', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/session-store.ts') },
  { find: '@onething/runtime/variables/providers', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/providers/index.ts') },
  { find: '@onething/runtime/variables/schema', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/schema.ts') },
  { find: '@onething/runtime/variables/registry', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/registry.ts') },
  { find: '@onething/runtime/variables/format', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/format.ts') },
  { find: '@onething/runtime/variables/validation', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/validation.ts') },
  { find: '@onething/runtime/variables', replacement: resolve(projectRoot, 'packages/onething-runtime/src/variables/index.ts') },
  { find: '@onething/runtime/triggers/skill-review', replacement: resolve(projectRoot, 'packages/onething-runtime/src/triggers/skill-review.ts') },
  { find: '@onething/runtime/triggers/skill-review-state', replacement: resolve(projectRoot, 'packages/onething-runtime/src/triggers/skill-review-state.ts') },
  { find: '@onething/runtime/triggers', replacement: resolve(projectRoot, 'packages/onething-runtime/src/triggers/index.ts') },
  { find: '@onething/runtime/settings', replacement: resolve(projectRoot, 'packages/onething-runtime/src/settings/index.ts') },
  // The catch-all below already resolves this one, but the boundary checker
  // wants每个真实用到的子路径都在表里有名有姓 —— 登记本身就是那条门禁。
  { find: '@onething/runtime/sessions/session-events', replacement: resolve(projectRoot, 'packages/onething-runtime/src/sessions/session-events.ts') },
  // A 期把 server runtime 搬进装配层之后,这三条从 apps/server 一起进了包内 ——
  // 门禁因此开始要求它们也有名有姓。
  { find: '@onething/runtime/sessions/session-message-runtime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/sessions/session-message-runtime.ts') },
  { find: '@onething/runtime/sessions/session-repository', replacement: resolve(projectRoot, 'packages/onething-runtime/src/sessions/session-repository.ts') },
  { find: '@onething/runtime/sessions/storage-driver', replacement: resolve(projectRoot, 'packages/onething-runtime/src/sessions/storage-driver.ts') },
  // Deep-family catch-alls: leaf modules resolve to <name>.ts; keep them
  // ABOVE the family barrel so the prefix entry cannot swallow them.
  { find: /^@onething\/runtime\/sessions\/(.+)$/, replacement: resolve(projectRoot, 'packages/onething-runtime/src/sessions/$1.ts') },
  { find: '@onething/runtime/sessions', replacement: resolve(projectRoot, 'packages/onething-runtime/src/sessions/index.ts') },
  { find: '@onething/runtime/storage', replacement: resolve(projectRoot, 'packages/onething-runtime/src/storage/index.ts') },
  { find: '@onething/runtime/permissions', replacement: resolve(projectRoot, 'packages/onething-runtime/src/permissions/index.ts') },
  { find: '@onething/runtime/plugins/theme-overrides', replacement: resolve(projectRoot, 'packages/onething-runtime/src/plugins/theme-overrides.ts') },
  { find: '@onething/runtime/plugins/skin', replacement: resolve(projectRoot, 'packages/onething-runtime/src/plugins/skin.ts') },
  { find: '@onething/runtime/plugins', replacement: resolve(projectRoot, 'packages/onething-runtime/src/plugins/index.ts') },
  { find: '@onething/runtime/tools/background-jobs', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/background-jobs.ts') },
  { find: '@onething/runtime/tools/bash-classifier', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/bash-classifier.ts') },
  { find: '@onething/runtime/tools/bash-executor', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/bash-executor.ts') },
  { find: '@onething/runtime/tools/edit-engine', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/edit-engine.ts') },
  { find: '@onething/runtime/tools/file-mutation-audit', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/file-mutation-audit.ts') },
  { find: '@onething/runtime/tools/file-mutation-queue', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/file-mutation-queue.ts') },
  { find: '@onething/runtime/tools/file-snapshot', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/file-snapshot.ts') },
  { find: '@onething/runtime/tools/output-accumulator', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/output-accumulator.ts') },
  { find: '@onething/runtime/tools/replacers', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/replacers.ts') },
  { find: '@onething/runtime/tools/sandbox-runtime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/sandbox-runtime.ts') },
  { find: '@onething/runtime/tools/sandbox', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/sandbox.ts') },
  { find: '@onething/runtime/tools/sensitive-files', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/sensitive-files.ts') },
  { find: '@onething/runtime/tools/text-truncation', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/text-truncation.ts') },
  { find: '@onething/runtime/tools', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tools/index.ts') },
  { find: '@onething/runtime/toolkit', replacement: resolve(projectRoot, 'packages/onething-runtime/src/toolkit/index.ts') },
  { find: '@onething/runtime/tasks', replacement: resolve(projectRoot, 'packages/onething-runtime/src/tasks/index.ts') },
  { find: '@onething/runtime/perf', replacement: resolve(projectRoot, 'packages/onething-runtime/src/perf/index.ts') },
  { find: '@onething/runtime', replacement: resolve(projectRoot, 'packages/onething-runtime/src/index.ts') },
]
}

/**
 * apps/electron 自己的内部路径别名:`@onething/electron-host/<domain>/<file>`
 * → `apps/electron/src/<domain>/<file>.ts`。它不是一个包,只是 Electron 宿主
 * 内部的一套路径写法 —— 所以不进上面那张跨宿主的包表,只有真正需要它的两个配置
 * spread 它:electron.vite.config.ts(三段构建)和 vitest.config.ts
 * (apps/electron 的测试、以及装配层里 mock 宿主模块的测试要能解析)。
 * apps/web / apps/server 不 import 这个族,也不应该拿到它。
 *
 * 两条就够,顺序有讲究:
 * 1. barrel(唯一走 index.ts 的 `window`)用**锚定正则**放在最前 —— 写成字符串
 *    的话 vite 的 string find 是前缀匹配,`@onething/electron-host/window` 会把
 *    `…/window/types` 一起吞成 `…/window/index.ts/types`;
 * 2. 叶子模块的 catch-all 正则在后,`$1` 直接落到 `<domain>/<file>.ts`。
 */
export function electronHostAliases(projectRoot: string): OnethingAliasEntry[] {
  return [
    { find: /^@onething\/electron-host\/window$/, replacement: resolve(projectRoot, 'apps/electron/src/window/index.ts') },
    { find: /^@onething\/electron-host\/(.+)$/, replacement: resolve(projectRoot, 'apps/electron/src/$1.ts') },
  ]
}
