# `~/.onething` 存储清单(2026-08-19)

> 只读调查。代码写入点(线 A)与真机实况(线 B)互相印证。**本次调查未删改任何文件。**

## 1. 存储根解析规则

`getOnethingStorePath()`(`packages/onething-runtime/src/storage/paths.ts:30`)按 `options.storePath` → `ONETHING_STORE_PATH` 环境变量 → `path.join(os.homedir(), '.onething')` 三级回退解析;`packages/onething-runtime/src/app/stores/paths.ts` 把它逐个转包成 `getStorePath()/getLogDir()/getSessionsDir()/…` 供装配层使用,`packages/core/storage/paths.ts` 是 core 侧的同形副本。

真机总量:**3.0 GB**(`~/.onething`,51 个顶层条目)。

---

## 2. 总表

宿主列:D=Electron desktop,S=apps/server,C=CLI daemon,G=gateway,X=脚本/工具。

| 路径 | 内容 | 格式 | 写入模块(文件:行) | 宿主 | 生命周期 | 真机 |
| --- | --- | --- | --- | --- | --- | --- |
| `settings.json` | 全局设置(含 provider/模型/主题/存储开关) | json | `app/stores/paths.ts:71` → `app/settings/*` | D S C | 常驻 | 524 KB |
| `app-state.json` | UI 状态、currentSessionId | json | `app/stores/app-state.ts:21` | D S | 常驻 | 4 KB |
| `window-state.json` | 窗口位置/尺寸 | json | `apps/electron/src/window/index.ts:139`、`search/window.ts:52` | D | 常驻 | 4 KB |
| `variables.json` | 变量系统持久值 | json | `app/variables/store/persistence.ts:24` | D S C | 常驻 | 4 KB |
| `prompts.json` | 自定义提示词 | json | `app/prompts/store.ts:10` | D | 常驻 | 8 KB |
| `agents.json` | Agent 档案表 | json | `storage/paths.ts:74` (`getOnethingAgentsPath`) | D S | 常驻 | 28 KB |
| `channel-identity.json` | 渠道身份 → profile 映射 | json | `app/channel/identity-store.ts:27` | D G | 常驻 | 4 KB |
| `oauth-tokens.json` | provider OAuth token(**凭证**) | json | `auth/token-store.ts:26` | D | 常驻 | 4 KB(实为 2 字节空对象) |
| `plugin-settings.json` | 插件 enabled/config/health 三键 | json | `packages/core/plugins/loader.ts:53` | D S | 常驻 | 488 B |
| `mcp-tools-catalog.md` | MCP 工具目录快照 | markdown | `storage/paths.ts:236` | D | 缓存 | 64 KB |
| `login-shell-env.json` | 登录 shell 环境变量缓存 | json | `apps/electron/src/app/login-shell-env.ts:68` | D | 缓存 | 8 KB |
| `onething.sqlite` | **无消费者** 的旧会话库 | sqlite | 仅 `storage/paths.ts:117` 定义,生产代码零引用 | — | **孤儿** | **256 MB**(2026-06-30) |
| `sessions/<id>/` | 会话:`meta.json` + `messages.jsonl` | json/jsonl | `app/stores/sessions.ts:242`、`sessions/storage-driver.ts` | D S C | 常驻 | 640 MB / 410 目录 |
| `sessions/<id>/events.jsonl` | 七事件轨迹日志 | jsonl | `app/session/event-log.ts:31` | D S | 常驻 | 仅 5 个会话有 |
| `sessions/<id>/segments.jsonl` | 会话目录 TOC 分段 | jsonl | `toc/store.ts:18,39` | D | 派生/可重建 | 66 个会话 |
| `sessions/<id>/messages.cleared-<ts>.jsonl` | 清空前的转录留档 | jsonl | `sessions/storage-driver.ts:526` | D | 归档(永不读) | 179 个 / 14.3 MB |
| `sessions/<id>/.meta.json.<pid>.<ts>.<n>.tmp` | 原子写临时文件 | json | `packages/core/storage/json-file.ts:202` | D | **临时(泄漏)** | 12 个残留 |
| `sessions/legacy-backup/` | 旧整文件会话原件 | json | `sessions/storage-driver.ts:537` | D | 归档 | **276 MB / 164 文件** |
| `sessions/<id>.json` | 未惰性迁移的 legacy 会话 | json | `storage/paths.ts:110` | D | 遗留 | 1 个 |
| `log/app.log` `dev.log` + `*.log.gz` | 主进程/dev 日志(按大小+日期轮转) | text/gz | `app/logging/index.ts:63,86` | D | 日志 | 8 MB + 39 条 |
| `log/provider-requests/` | **provider 请求/响应全量 dump** | json + json.gz | `providers/request-dump.ts:54,241` | D | 调试(默认开) | **1.1 GB / 12999 文件** |
| `log/memory/` | 已退役 soul-memory 插件日志 | — | 无 | — | **孤儿** | 0 B |
| `log/daemon.log` | CLI daemon 日志 | text | `app/logging` | C | 日志 | 16 KB |
| `debug/theme-tokens/*.json` | 主题 token 解析快照 | json | `themes/theme-runtime.ts:77` | D | 调试缓存 | 460 KB |
| `debug/last-system-prompt.txt` | 最近一次系统提示词 | text | `storage/paths.ts:56` | D | 调试 | — |
| `evals/traces/<sid>/<turnId>/round-N.json` | 逐轮追踪 | json | `evals/trace-store.ts:59` | D | 评估数据 | **197 MB / 213 会话** |
| `evals/incidents/<date>-<hash>/` | 事故工作台快照 | 目录 | `evals/incident.ts:159,557` | D | 评估数据 | **256 MB / 146 条** |
| `evals/captures/*.json` | 现场保真捕获 | json | `evals/capture-store.ts:37` | D | 评估数据 | 66 MB / 200 |
| `evals/fixtures/auto/` | 自动 fixture | json | `evals/fixture.ts:256` | D | 评估数据 | 19 MB |
| `evals/online/records.jsonl` | 在线评估记录 | jsonl | `evals/turn-evaluator.ts:99` | D | 账本 | 956 KB |
| `tool-outputs/*.txt` | bash 等工具输出溢出落盘 | text | `toolkit/families/process.ts:163`、`app/toolkit/runner.ts:39`(目录 `storage/paths.ts:217`) | D S C | 缓存(无清理) | 38 MB / 92 |
| `file-mutations/<date>/*.json` | 文件改动审计(edit/write 前后) | json | `toolkit/families/mutating-file.ts:165`、读:`app/goals/file-changes.ts:45` | D S C | 审计(无清理) | **214 MB / 75 天** |
| `media/images/` `media/files/` `media/index.json` | 媒体库 | 二进制 + json | `app/media/media-library-service.ts` | D | 常驻 | 12 MB / 16 图 |
| `media/preview-temp/` | 预览临时目录 | 目录 | **代码无引用** | — | **孤儿** | 0 B |
| `usage/usage-YYYY-MM.jsonl` | token 计费账本 | jsonl | `app/usage/index.ts:100` | D S | 账本(月分片) | 5.9 MB / 2 |
| `plugins/package.json` + `package-lock.json` | 插件 npm 账本 | json | `packages/core/plugins/loader.ts:49` 树下 | D | 常驻 | 11 KB |
| `plugins/node_modules/@onething-plugins/*` | 插件代码(纯代码区) | 目录 | npm(`--ignore-scripts`) | D | 常驻 | 14 MB 内 |
| `plugins/<id>/{config.json,kv.json,storage/,message-state/}` | 插件私有数据 | json/目录 | `app/plugins/*`;message-state `plugins/<id>/message-state/<sid>/<mid>.json` | D | 常驻(5MB/插件配额) | far-hills / memory-wiki / quick-translate / tps-meter / wallpaper |
| `plugins/legacy-backup/` | 卸载插件的数据归档 | 目录 | 卸载流程 | D | 归档 | tps-meter ×2 |
| `plugins-dev/` | 本地开发插件目录 | 目录 | `packages/core/plugins/loader.ts:64` | D | 常驻 | **磁盘上不存在** |
| `plugin-data/` | 旧插件数据区 | 目录 | `storage/paths.ts:248`(仅建目录) | — | **归档专用** | 7.1 MB |
| `plugin-data/soul-memory.sqlite(-wal/-shm)` | 已退役插件数据库 | sqlite | 无 | — | **孤儿** | 主要占用 |
| `plugin-data/legacy-backup/` | 已清扫的插件残留 | 目录 | 孤儿清扫 | D | 归档 | soul-memory / ui-demo |
| `permissions/workspace-grants.json` | 权限授予账本 | json | `permissions/permission-runtime.ts:29` | D S | 常驻 | 148 KB |
| `run/backend.lock` | 单实例 StoreLock | text | `storage/store-lock.ts:35` | D S C | 运行期 | 92 B |
| `run/daemon.sock` | CLI daemon unix socket | socket | `apps/electron/src/main/cli/paths.ts:24` | C | 运行期 | **当前不存在**(daemon 未跑) |
| `scheduler/tasks.json` `state.json` `runs/*.jsonl` | 调度任务与运行账本 | json/jsonl | `storage/paths.ts:199-215` | D S | 常驻 | 76 KB |
| `agents-v3/<agentId>/{inbox.jsonl,inbox.cursor,notebook.md,state.json}` | 协作 Actor v3 的 agent 邮箱 | jsonl/md/json | `app/collab/actors/agent-mailbox.ts:46` | D | 常驻 | 2.8 MB / 11 |
| `collab/<roomId>/{state.json,board.json,digests.json,activity.jsonl,actors/}` | 房间状态/白板/摘要/调度日志 | json/jsonl | `app/collab/digest-store.ts:28`、`actors/scheduler-log.ts:162`、`room-runtime.ts:185` | D | 常驻 | 1.7 MB / 25 |
| `rooms/<roomSessionId>/` | 房间自动分配的工作目录 | 任意 | `app/collab/room-folder.ts:25,38` | D | 常驻(用户产物) | 24 KB |
| `backup/collab-v2-<ts>/` | Actor v3 迁移前的 v2 备份 | 目录 | `app/collab/actors/migrate.ts:81` | D | 归档 | 232 KB |
| `backups/settings-pre-space-migration-*.json` | space 迁移前的 settings 备份 | json | `app/providers/space-config-migration.ts:122` | D | 归档 | 1.0 MB |
| `workspaces/index.json` `<spaceId>/{space,providers,credentials}.json` `avatars/` | Space 配置与**凭证池** | json | `spaces/persistence.ts:17`、`storage/paths.ts:127-155` | D S | 常驻 | 52 KB |
| `project-dirs/index.json` `data/<hash>.json` | 项目目录记忆 | json | `project-dirs/persistence.ts:37` | D | 常驻 | 104 KB |
| `skills/<name>/SKILL.md` | 用户自定义 skills | 目录+md | `skills/loader.ts:351`(`getUserSkillsPath`) | D S C | 常驻 | 304 KB / 7 |
| `themes/*.lua` | 用户主题 | lua | `themes/index.ts:75,437` | D | 常驻 | 16 KB / 4 |
| `todo-plan/{plan.md,ai-todo.md,user-notes/,sessions/,workspaces/}` | Todo/计划(可被设置改到别处) | md/目录 | `todo-plan/store.ts:160` | D | 常驻 | 252 KB |
| `scratchpads/<sessionId>.md` | 草稿纸 | md | `scratchpad/store.ts:23` | D | 常驻 | 108 KB |
| `practice/{config.json,practice-YYYY-MM.jsonl}` | 练习系统账本 | json/jsonl | `app/practice/index.ts:47` | D | 账本(月分片) | 12 KB |
| `music/{programme,radio-*,search-N}.json` | 电台节目单/搜索缓存 | json | `app/music/radio.ts:66` | D | 常驻+缓存 | 1.3 MB |
| `external-agents/session-links.json` | 外部 Agent 会话映射 | json | `app/external-agents/index.ts:73` | D | 常驻 | 8 KB |
| `gateway/{wechat-token.json,wechat-sync.json,wechat-accounts/<id>/sync.json}` | 网关渠道状态(**含 token**) | json | `packages/gateway/src/core/storage.ts:12` | G | 常驻 | 12 KB |
| `browser/{profiles.json,search-engine.json}` | 内嵌浏览器 profile 与搜索引擎 | json | `apps/electron/src/browser/profiles.ts:32`、`search-engine.ts:20` | D | 常驻 | 4 KB |
| `browser-chrome/` | 真 Chrome profile(Default/、db、缓存) | Chrome 数据目录 | 仅 `scripts/spike-real-chrome.mjs:27` | X | **spike 残留** | **145 MB** |
| `owners/<uid>/<wid>/…` | server 多租户树(plugin-store / skills / media / todo-plan / scheduler / memory) | 混合 | `apps/server/src/runtime.ts:857,1259,6249,…` | S | 常驻(server 专有) | 4.5 MB |
| `agents/<agentId>/{SOUL.md,daily/,plugin-data/}` | **已退役** soul-memory 的 agent 工作区 | md/目录 | `getOnethingAgentsDir` 只建目录,无写者 | — | **孤儿** | 612 KB / 12 |
| `memory/{SOUL.md,daily/,…}` | **已退役** soul-memory 默认工作区 | md | 仅 `scripts/archive-soul-memory.mjs:48` 归档脚本 | X | **孤儿** | 324 KB |
| `notes/` | 只剩 `.DS_Store` | — | **代码无引用** | — | **孤儿** | 8 KB |
| `screenshots/` | 截图目录 | 目录 | `storage/paths.ts:169`(仅建目录) | D | 空 | 0 B |
| `user-profile/profile.json` | 用户档案 | json | `storage/paths.ts:157-167` | D | 空 | 0 B |
| `features-dev/<featureId>/` | 自演化 feature 开发目录 | 目录 | `app/toolkit/builtin/feature-runtime.ts:23` | D | 按需 | **磁盘上不存在** |
| `mcp-oauth-credentials.json` | MCP OAuth 凭证 | json | `storage/paths.ts:242` | D | 常驻 | **磁盘上不存在** |
| `.DS_Store`(遍布) | Finder 元数据 | 二进制 | macOS | — | 噪声 | 顶层 34 KB |

---

## 3. 按领域详述

### 3.1 会话(640 MB active + 276 MB legacy-backup)

新格式是 per-session 目录:`sessions/<id>/meta.json` + `messages.jsonl`,流式期间 append/suffix 写。目录里还可能有三种附加文件:

- `events.jsonl` —— E0 期的七事件轨迹(`app/session/event-log.ts`)。**只往已存在的会话目录追加,自己从不建目录**,所以 legacy 整文件会话天然不记事件。真机上仅 5/408 个会话有,说明这条流是最近才开的。
- `segments.jsonl` —— 会话目录 TOC(`toc/store.ts`),66 个会话有,纯派生数据,删了能重建。
- `messages.cleared-<ts>.jsonl` —— 清空消息前的原样留档(`storage-driver.ts:526`),**没有任何读取路径**,179 个共 14.3 MB。

Legacy 整文件 `sessions/<id>.json` 惰性迁移后原件搬进 `sessions/legacy-backup/`(164 个 / **276 MB**,占整个 sessions 目录的 43%)。真机上还剩 1 个未迁移的根级 `<id>.json`。

### 3.2 插件

`plugins/` 是 npm 账本区:`package.json`(ledger)+ `package-lock.json` + `node_modules/@onething-plugins/*`(纯代码)。每个插件的数据在同级同名目录 `plugins/<id>/`:`config.json`、`kv.json`、`storage/`、`message-state/<sid>/<mid>.json`。真机装了 5 个:far-hills、memory-wiki、quick-translate、tps-meter、wallpaper(其中 quick-translate 只有 `storage/`,尚无 config)。

`plugins/legacy-backup/` 是卸载归档(tps-meter 两份)。`plugin-data/` 现在只是归档区:里面 7.1 MB 绝大部分是 **soul-memory.sqlite + -wal + -shm** 这组退役插件数据库,以及 `legacy-backup/{soul-memory-2026-08-07,ui-demo-2026-08-08}`。

server 侧的插件树完全不同,在 `owners/<uid>/<wid>/plugin-store/plugins`(见 3.8)。

### 3.3 运行时锁与 socket

`run/backend.lock`(92 B)是 `StoreLock`(`storage/store-lock.ts:35`)的单实例锁,三个宿主用 `acquire('desktop'|'daemon'|'server')` 抢。`run/daemon.sock` 由 `apps/electron/src/main/cli/paths.ts:24` 约定,当前不存在 —— daemon 没在跑。

### 3.4 日志(1.1 GB,占全库 37%)

`log/app.log` + `dev.log` 走大小/日期双轮转,`.log.gz` 归档共 39 条,加起来不到 10 MB —— 完全正常。

**问题全在 `log/provider-requests/`:1.1 GB / 12999 个文件**,从 2026-07-20 一路写到 2026-08-19。开关是 `shouldDumpOnethingProviderRequests()`(`providers/request-dump.ts:58`):`env.ONETHING_DUMP_PROVIDER_REQUESTS !== '0'` —— **默认开、无上限、无轮转、无清理**。文件名带 provider + model,内容是完整请求/响应体(即含全部对话与工具结果)。老文件被 gz 过(推测手工或某次批量),新文件是裸 json。

`log/memory/`(0 B)是退役 soul-memory 插件的日志目录残留。

### 3.5 媒体

`media/images`(11 MB / 16 张)+ `media/files`(588 KB)+ `media/index.json`(20 KB)。`media://` 协议按 images → files 顺序解析。`media/preview-temp/` 在磁盘上存在但**全仓 grep 不到任何引用**,是孤儿目录。

### 3.6 用量与评估

`usage/usage-YYYY-MM.jsonl` 月分片账本,2 个文件 5.9 MB。

`evals/` 共 **539 MB**,是仅次于 sessions 和 log 的第三大占用,四个子树全在写:traces(197 MB,`<sid>/<turnId>/round-N.json` 逐轮)、incidents(256 MB,146 条事故快照)、captures(66 MB,200 条)、fixtures/auto(19 MB)。**没有任何保留期或清理逻辑**。

### 3.7 设置与凭证

明文凭证落在四处,报告只列文件不读内容:

- `oauth-tokens.json`(`auth/token-store.ts:26`)—— 真机上是 2 字节空对象。
- `workspaces/<spaceId>/credentials.json` —— Space 凭证池,`default` 和 `space-mswl0is4es9d` 各一份。
- `gateway/wechat-token.json` —— 网关渠道 token。
- `mcp-oauth-credentials.json` —— 定义了但磁盘上还没有。

另有 `backups/settings-pre-space-migration-*.json` 两份 settings 全量快照(1.0 MB),`settings.json` 本体 524 KB。

### 3.8 其余

**协作三件套**:`agents-v3/`(agent 邮箱:inbox.jsonl + cursor + notebook.md + state.json,11 个)、`collab/<roomId>/`(state/board/digests/activity + actors/,25 个房间)、`rooms/<roomSessionId>/`(房间自动工作目录,里面是用户/agent 产出的真文件)。`backup/collab-v2-2026-08-03T09-50-51/` 是 v3 迁移前的 v2 备份。

**server 专有 `owners/` 树**(4.5 MB):`owners/<uid>/<wid>/` 下有 plugin-store/、plugin-data/、skills/、todo-plan/、media/、scheduler/、memory/、memory-logs/、agents.json。真机上有三个 owner:`local-user/default`(最全)、`default/default`(只有 scheduler)、`alice/scheduler-workspace`(只有 scheduler)—— 后两个明显是测试产物。注意 `owners/local-user/default/memory/default/SOUL.md` 是 soul-memory 在 server 侧的同款残留。

**其余小目录**都各有活的写入点:project-dirs(104 KB)、skills(7 个自定义 skill)、themes(4 个 .lua)、todo-plan(252 KB,含两张 CleanShot 截图和 workspaces/sessions 两棵子树)、scratchpads(108 KB,含一张截图)、practice、music(1.3 MB,含 17 个 `search-N.json` 和 4 个 `search-tmpN.json`)、external-agents、browser、scheduler、permissions(149 KB 单文件)。

`browser-chrome/`(**145 MB**)是完整的 Chrome 用户数据目录(Default/、first_party_sets.db、各种 component cache),唯一引用是 `scripts/spike-real-chrome.mjs:27` —— 一次 spike 实验留下的。

---

## 4. 遗留/孤儿目录清单(代码无写入点,磁盘上存在)

**未删任何一项。** 按占用排序:

| 路径 | 占用 | 判定依据 |
| --- | --- | --- |
| `onething.sqlite` | **256 MB** | `getOnethingSessionDatabasePath` 只在 `storage/paths.ts:117` 和测试里出现;生产零引用。mtime 2026-06-30,即弃 sqlite 那次改造之后再没动过 |
| `browser-chrome/` | **145 MB** | 唯一引用是 `scripts/spike-real-chrome.mjs`,不是产品路径 |
| `plugin-data/soul-memory.sqlite{,-wal,-shm}` | 7 MB 内 | soul-memory 2026-08-06 退役(`docs/audit/soul-memory-retirement-2026-08-06.md`) |
| `agents/<id>/{SOUL.md,daily/}` | 612 KB | 同上;`getOnethingAgentsDir()` 现在只被 `ensureOnethingStoreDirs` 用来建空目录,没有任何写者 |
| `memory/` | 324 KB | 同上;唯一引用是归档脚本 `scripts/archive-soul-memory.mjs:48`(未执行过——`memory/legacy-backup/` 不存在) |
| `plugin-data/legacy-backup/` | — | 孤儿清扫留下的归档,按设计保留 |
| `sessions/legacy-backup/` | **276 MB** | 按设计保留的迁移原件,但无读取路径 |
| `notes/` | 8 KB | 只剩 `.DS_Store`,全仓无引用 |
| `log/memory/` | 0 B | soul-memory 插件日志目录 |
| `media/preview-temp/` | 0 B | 全仓无引用 |
| `owners/{default,alice}/` | 小 | server 测试残留(只有 scheduler/state.json) |
| `sessions/**/*.tmp` ×12 | 小 | 原子写崩溃残留,见 §6 |

## 5. 代码有写入点但真机不存在的路径

| 路径 | 何时才会出现 |
| --- | --- |
| `run/daemon.sock` | CLI daemon 启动时(`apps/electron/src/main/cli/paths.ts:24`) |
| `plugins-dev/` | 放本地开发插件时(`packages/core/plugins/loader.ts:64`) |
| `features-dev/<featureId>/` | 自演化 `feature_mount` 时(`app/toolkit/builtin/feature-runtime.ts:23`) |
| `mcp-oauth-credentials.json` | 首次走 MCP OAuth 时(`storage/paths.ts:242`) |
| `debug/last-system-prompt.txt` | 相应 debug 开关打开时 |
| `screenshots/`、`user-profile/profile.json` | 目录已被 `ensureOnethingStoreDirs` 建出但一直是空的 —— 两个功能实际没在用 |

## 6. 观察

**1. 唯一真正的泄漏:`log/provider-requests/` 1.1 GB。** 开关写成 `!== '0'` 即**默认开启**,一个月攒了 12999 个文件,没有轮转、没有保留期、没有大小上限,而 `log/` 里其他所有东西加起来不到 10 MB —— 说明轮转机制存在,只是这个目录没接进去。内容是完整请求体,等于把全部对话和工具结果又抄了一份到磁盘。这是全库最该处理的一项。

**2. 三份"同一批对话"的重复存储。** sessions(640 MB)+ evals/traces+captures+incidents(519 MB)+ log/provider-requests(1.1 GB)本质上都是同一批对话的不同投影。真正的一手数据只有 sessions;另外两份是可再生的观测数据,却比一手数据还大 2.5 倍。

**3. 归档区从不过期。** `sessions/legacy-backup`(276 MB)、`messages.cleared-*`(14 MB)、`plugins/legacy-backup`、`plugin-data/legacy-backup`、`backup/`、`backups/` 六个归档区都是"只进不出",没有任何一处定义了保留期。

**4. 原子写临时文件残留 12 个。** `.meta.json.<pid>.<ts>.<n>.tmp`(`packages/core/storage/json-file.ts:202`),散在会话目录里。启动时没有清扫逻辑 —— 崩溃/强杀一次留一批。数量不大但会无限累积,且和 `meta.json` 同目录,任何按目录扫文件的逻辑都要额外过滤。

**5. 命名不一致三组。**
   - `backup/`(collab v2 备份)与 `backups/`(settings 备份)—— 单复数两个目录,语义同类。
   - `agents/`(退役 soul-memory 工作区)、`agents.json`(Agent 档案表)、`agents-v3/`(协作 Actor 邮箱)—— 三个 `agents*` 指三件毫不相干的事,其中一个还是死数据。
   - `plugins/<id>/`(现行插件数据)与 `plugin-data/`(退役归档)—— 单复数区分现行/归档,极易读反。

**6. `getOnethingStoreDirs()` 在替死功能建空目录。** `screenshots/`、`user-profile/`、`plugin-data/`、`agents/` 每次启动都被 `ensureOnethingStoreDirs` 建出来,但前两个从来没有写者,后两个已退役。这让"目录存在"不再是"功能在用"的证据,也是本次调查必须靠 grep 而不能靠 `ls` 判断的原因。

**7. 未清理的膨胀候补(按当前增速)。** `file-mutations/`(214 MB / 75 天,约 2.9 MB/天,无清理)、`tool-outputs/`(38 MB / 92 文件,无清理)、`evals/incidents`(256 MB / 146 条)。三者都是每次工具调用产生一条,只要 app 在用就单调增长。

**8. 凭证分散在四个文件、两种归属。** `oauth-tokens.json`(全局)、`workspaces/<spaceId>/credentials.json`(按 space 隔离)、`gateway/wechat-token.json`(渠道)、`mcp-oauth-credentials.json`(MCP)。Space 隔离那份是设计如此,但全局那份与 space 那份并存意味着凭证归属存在两套真相 —— `space-config-migration.ts:345` 会去读全局 `oauth-tokens.json`,说明迁移路径已经意识到这点,只是旧文件还留着(真机上已空)。
