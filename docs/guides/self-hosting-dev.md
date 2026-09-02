# 用 onething 开发 onething:双实例配方

2026-08-11。写给第一次做自举开发的人。配套审计:
`docs/audit/self-hosting-gap-audit-2026-08-11.md`(能力差距与工单)。

一句话:**日常那只 onething 是驾驶舱,`bun run dev:self` 起的那只是验证场。**
两只跑同一份工作树代码,但 store、端口、日志、产物、Chromium profile 全部分家,
谁也不踩谁。

## 拓扑

```
        ┌──────────────────────────────┐            ┌──────────────────────────────┐
        │  A 实例(稳定 / 驾驶舱)      │            │  B 实例(dev-self / 验证场)  │
        │  bun run dev:electron        │            │  bun run dev:self            │
        │  或已安装的正式版             │            │                              │
        │                              │            │                              │
        │  store  ~/.onething          │            │  store  ~/.onething-dev      │
        │  端口   5173 / 5174 / 8787   │            │  端口   5273 / 5274 / 8887   │
        │  产物   out/                 │            │  产物   dist/dev-self/       │
        │  日志   ~/.onething/log      │            │  日志   ~/.onething-dev/log  │
        └───────────┬──────────────────┘            └──────────────┬───────────────┘
                    │ agent 读/改文件                              │ 起进程跑这份代码
                    │ (read / edit / bash / 测试)                  │
                    ▼                                              ▼
            ┌──────────────────────────────────────────────────────────┐
            │        工作树 /Users/…/start-electron(唯一真相)          │
            └──────────────────────────────────────────────────────────┘
```

A 里的 agent 改的是**工作树文件**,不是 A 自己;B 才是"把这些文件跑起来"的那只。
所以看效果永远看 B。

**但注意:上图的隔离是数据/运行时隔离,不是代码隔离。** 两只跑同一份工作树时,
一处改动两个进程都吃到 —— 尤其当 A 也是 dev 模式(`bun run dev:electron`)起的:
渲染层改动会把 A **当场 HMR 掉**,主进程改动 electron-vite 会**自动重启 A**。
驾驶舱在飞行中被改中,是单工作树拓扑的固有风险。要么接受它(改的都是小面、
A 挂了重启就是),要么按下一节把代码也隔离开。

## 代码隔离:worktree 三件套(推荐)

`git worktree` = 同一个仓库多开一个目录:`.git` 数据库共用(提交、分支、stash
全通),只是多一个检出另一条分支的文件夹。三条命令:

```bash
git worktree add ../start-electron-dev -b dev-self   # 开第二目录 + 开发分支
git worktree list                                     # 随时查有哪几个
git worktree remove ../start-electron-dev             # 拆掉(提交不丢,历史在共用的 .git 里)
```

分工从"双实例"升级成"三件套":

```
~/data/code/start-electron        ← 主工作树:A 日常实例跑这里,代码稳定,agent 不碰
~/data/code/start-electron-dev    ← 开发工作树:agent 在这里改码,dev:self 也从这里起
~/.onething  /  ~/.onething-dev   ← 两只的数据,照旧分家
```

- 开发会话的 `/cd` 绑到 `start-electron-dev`;在**那个目录**里跑 `bun run dev:self` 起 B。
- agent 改多少码 A 都感受不到(不同目录,HMR 监听不到)。
- 让 A 用上新代码 = 收版:`bun run self:pull`(主树里跑,= 合并 dev-self + 守卫)。
  **A 是 dev 模式时连重启都不用管** —— electron-vite 监听着主树,合并落盘即自动重建 +
  自动重启,renderer 走 HMR。整个"升级正在用的 onething"仪式就这一条命令,节奏由人控制。
  (A 是打包版时才需要真发版:build + 安装,那是另一条低频路。)
- 两个注意点:①同一条分支不能同时检出在两个 worktree 里,所以开发树单独一条分支
  (上面的 `-b dev-self`);②新目录要单独 `bun install`(node_modules 不共享,
  Electron 二进制下载一次要几分钟)。
- 这也是审计里"多代理写隔离(worktree-per-worker)"同族方案的第一步:先做到
  "agent 的树"与"人的树"分开,再谈"agent 与 agent 分开"。

## 起步四步

1. **在 A 里开一个会话,把工作目录绑到本仓。**
   `/cd /Users/<you>/data/code/start-electron`(或在会话设置里选目录)。
   之后 read/edit/bash/find 的相对路径都以它为根。

2. **选引擎。** 两条路都行,纪律文件是同一份:
   - 原生 provider(claude / codex / deepseek / …)——走 onething 自己的 agent-loop 与工具;
   - Claude Code SDK 外部会话——走 `@anthropic-ai/claude-agent-sdk` 驱动真 CLI。

   两者的系统提示都会把项目根的纪律文件读进去,候选名与顺序见
   `packages/onething-runtime/src/prompts/builder.ts`(`AGENTS.md` 优先、`CLAUDE.md` 垫底,
   上限 64KB —— 本仓 CLAUDE.md 41.7KB,不会被截)。

3. **改码。** 正常用 edit/write/bash;跑测试用 `bun run test`(直接 `vitest run`,不再有
   原生模块 rebuild 那一步),门用 `bun run typecheck` / `boundary:gate` / `ui:gate`。

4. **`bun run dev:self` 起 B,真机走查。**
   默认只起 Electron(桌面宿主):

   ```bash
   bun run dev:self            # = dev:self electron:桌面实例,renderer 5273
   bun run dev:self web        # web 前端 5274 + headless server 8887
   bun run dev:self all        # 两条都起(注意下面的 StoreLock 约束)
   ```

   开机横幅会把 store / 日志 / 端口 / 产物目录逐行打出来 —— 那就是这一只的身份证。

## dev:self 到底隔离了什么

| 维度 | A(日常) | B(dev-self) | 机制 |
| --- | --- | --- | --- |
| store | `~/.onething` | `~/.onething-dev` | `ONETHING_STORE_PATH` → `getOnethingStorePath()` |
| renderer dev server | 5173 | 5273 | `ONETHING_RENDERER_PORT`(`electron.vite.config.ts` 读它);主进程不用改,electron-vite 会把实际端口写进 `ELECTRON_RENDERER_URL` |
| web 前端 | 5174 | 5274 | vite `--port`(dev-unified 传) |
| headless server | 8787 | 8887 | `ONETHING_SERVER_PORT`(本来就是 env 驱动) |
| 主/预加载产物 | `out/` | `dist/dev-self/` | `ONETHING_ELECTRON_OUT_DIR` + `ELECTRON_ENTRY` |
| server bundle | `dist/server/` | `dist/dev-self-server/` | `server:build -- --outDir …` |
| vite 依赖预构建缓存 | `node_modules/.vite/web` | `node_modules/.vite/web-dev-self` | `ONETHING_WEB_CACHE_DIR` |
| Chromium profile | `~/Library/Application Support/Electron` | `<store>/dev-self-user-data` | `electron-vite dev -- --user-data-dir=…` |
| runner 日志 | `~/.onething/log/dev.log` | `~/.onething-dev/log/dev.log` | 日志目录跟着 store 走 |
| 单实例锁 | `~/.onething/run/backend.lock` | `~/.onething-dev/run/backend.lock` | `StoreLock` 天然按 store 路径隔离 |

任何一项都能在外面用同名 env 覆盖,例如换一个 store:

```bash
ONETHING_STORE_PATH=~/.onething-scratch bun run dev:self
```

**空 store 是合法起点。** 脚本不从 `~/.onething` 拷任何东西 —— 拷贝等于两份真相,
要不要播种(设置、主题、插件)由你自己决定,手动 copy 就行。

## 两条泳道为什么不互相误杀

`dev-unified` / `dev-with-logging` 起手都会清扫"本项目的残留 dev 进程"。这套清扫按
**命令行 marker** 划界(`scripts/lib/dev-self.mjs`):dev-self 的每个进程命令行里都带
`dev-self` 这个子串 —— runner 的 `--dev-self`、electron-vite / Electron 的
`dist/dev-self/main/index.js`、Electron helper 继承的 `--user-data-dir=…/dev-self-user-data`、
server 的 `dist/dev-self-server/main.js`;web 前端没有产物路径,用它独占的端口号兜底。
清扫只处理与自己同侧的进程。

改这几个名字要连着 `scripts/lib/dev-self.mjs` 一起改,**改歪了的直接后果是两只实例互相
杀进程**(而且现象是"另一台莫名其妙退出",不会有报错指向这里)。

## 边界与坑(如实)

- **B 要重启/HMR 才反映改动。** 渲染层改动走 vite HMR;主进程 / preload 改动
  electron-vite 会重建并重启 Electron;`electron.vite.config.ts`、脚本本身、依赖变更要手动重起。
- **两实例不共享任何数据**:会话、设置、主题、插件、权限授予、账本全都在各自 store 里。
  在 B 里装的插件 A 看不到,反之亦然。
- **插件只在桌面宿主执行**。`dev:self web` 起的 server 会扫另一棵目录树,
  它的 `/api/plugins/*` 写的 enable 标记桌面根本不读(见 CLAUDE.md 插件系统一节)。
  想验插件就起桌面那条。
- **同一个 store 里 desktop 和 server 不能同时起**:`StoreLock` 一个 store 只允许一位持有者
  (`desktop` / `daemon` / `server`)。所以 `dev:self all` 在桌面已起时,server 泳道会撞锁。
  要同时要两条,给 server 另开一个 store(`ONETHING_STORE_PATH` 指别处再单起)。
- **`bun run test` 不再 rebuild 任何原生模块**(2026-09-03,better-sqlite3 退役):今天在用的
  三件都是 N-API,一块二进制同时喂 Node 与 Electron,没有 ABI 要对。想验这句话:`bun run gate:native`。
- **验证不改状态**:真机走查时别去点会持久化的控件;要手改 `~/.onething` 下的文件,先把对应
  实例停掉,否则内存里的缓存会把你的手改盖回去。这条对 `~/.onething-dev` 同样成立。
- **`build:native:mac` / `sign:dev:mac` 是共享步骤**:两条泳道起手都会跑一遍(检查即跳过),
  同时起两只时理论上会撞一次写,重跑即可。
- **Dock 上两只都叫 Electron**,图标一样。靠窗口内容(会话列表是空的那只就是 B)或
  `lsof -tiTCP:5273` 分辨。
- **`ELECTRON_CLI_ARGS` 这个 env 传不进去**:electron-vite 的 cli 会用 `options['--']`
  无条件覆盖它(空数组也是真值),所以透传给 Electron 二进制的参数只能走
  `electron-vite dev -- <args>`。dev-self 用 `ONETHING_ELECTRON_ARGS`(JSON 数组)喂给
  `dev-with-logging`,由它拼成 `--` 之后的参数。

## 落地记:memory-wiki 退出内置(2026-08-12)

长期记忆插件 `memory-wiki` 从宿主内置改为市场包 `@onething-plugins/memory-wiki`
(市场仓 `packages/memory-wiki`),成为 **`storage:external-root` / files 面在市场
形态里的第一个住户** —— 此前这条权限只有内置插件用过,它是不是真的够一个完整
产品用,现在有答案了。判据是"离了宿主活不了才留在内置":memory-wiki 只用注入 api
上的四样东西(`storage.files` / `registerTool` / `registerPromptContextProvider` /
`settings.onChange`),住在内置唯一换来的是"不能单独发版"。

自举时要知道的两条:

- **同 id 同家目录,数据零迁移**。npm 包的 id 仍是 `memory-wiki`,家目录仍是
  `<store>/plugins/memory-wiki/` —— 用户已选的记忆目录(`config.json` 的 `wikiRoot`)
  与整棵 wiki 原样继续用,退役与安装之间不需要任何搬运动作。
- **顺序不能反**:必须先装 npm 包、再落内置退役。防撞闸(`CorePluginManager.installPlugin`)
  拦的是"用户插件遮蔽内置",内置还在时同 id 的包装得进账本但永远不会被显示;
  而反过来先退役再安装,中间会有一段"记忆工具整个消失"的真空。CLI 的
  `onething plugin install <tarball>` 直接走安装机器、不过防撞闸,所以这个顺序做得到。

## 已知缺口(别把没有的能力写成有)

- **派工已经有了(`task` 工具,2026-08-11 批 5,审计 P0-3/P0-5),但它有边界。**
  桌面全量档独有的 builtin:`task({ prompt, workingDirectory?, model?, description? })`
  开一条**不抢焦点的真会话**去干活,当场返回 `taskSessionId`(不阻塞调用方这一回合),
  那边跑完(complete / error / aborted 都算)会**主动把完整结果投回调用方会话** ——
  空闲就起一轮、在忙就降级为 steer,不需要轮询。工作目录默认继承调用方会话
  (不是群目录),模型与权限模式同样继承。回投**不截断**。
  已知边界,别把它当成没有的能力用:
  - 工作会话就是一条**普通会话**:它出现在会话列表里,人点得进去看、也能接管。
    这是特性 —— 后台跑的东西必须看得见。
  - 它可能**停在一张审批卡上等人**。没人盯着那条会话,所以需要审批的任务可能一直
    挂着;v1 不做「卡住了也叫醒你」。兜底是 30 分钟墙钟:超时会如实报一句
    「超时结束,会话仍在」。派活时优先派在当前权限模式下跑得完的活。
  - 同一条会话上**最多 4 个**并发任务,第 5 个是**结构化拒绝,不排队**。
  - 工作会话**看不见 `task`**,禁止套娃:派工树最深两层。
  - **没有 kill 工具**。停它 = 打开那条工作会话按停止(id 在工具结果与报告里)。
  - 并发账是内存态:进程重启后在飞的任务不再被等待(会话还在盘上,人点得进去看)。
  - `model` 参数只换 model id,**provider 仍是调用方的** —— 跨 provider 的模型 id
    会在工作会话里失败。
  - `board start`(collab 那条)没有被改:它仍然是群聊看板的语义,回报仍然截 200 字符。
- **打包版跑不了 Claude Code 外部会话**(按配置推断,未在打包版实测):
  `electron-builder.yml` 的 `asarUnpack` 只放行了 sherpa 与 node-pty,
  `@anthropic-ai/claude-agent-sdk` 连同它要 exec 的 CLI 仍在 asar 里。
  自举开发按现状只在 dev(未打包)运行下可靠。
- **多代理并发写同一份工作树没有隔离**:没有 worktree-per-worker,也没有写前 stale 检查
  (审计工单 P0-6)。同一时间只让一个 agent 改文件。
- **`dev:self` 不做 store 播种、不做数据迁移、不做版本对齐**。B 是干净环境,
  它复现不出 A 的历史数据引起的 bug —— 那种 bug 只能在 A 上查(且遵守"验证不改状态")。
