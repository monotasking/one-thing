# 结构债治理方案(2026-08-19)

> 起因:用户判断"代码组织很乱"。四路并行摸底 + 亲跑 checker 验证后,把"乱"拆成三种性质:
> **表层卫生**(截图/杂物/在途批次)、**结构债**(五笔有名有姓的旧债)、**体量**(单层目录过大,本方案不治)。
> 本文是结构债 + 卫生的完整分期方案。执行分工:Fable 拆分/设计/review,opus 逐期执行。

## 0. 结论速览

- **最大的债不是"一包两层"**——拆包被证实零纠缠,是 1–2 天的机械活。
- **最大的债是传输面五重镜像**:一个传统 IPC 域最多被描述在 5 处(shared 类型 → src/ipc 工厂 →
  main/ipc 适配 → preload bridge 手写枚举 → web.ts 手写 HTTP 镜像)。终点早已钦定
  (router/RPC,`apps/electron/src/main/ipc/rpc.ts` 头注释自称"@main 最后一个 handler 文件"),
  但只迁了 ~11 域,剩 ~30 域。
- 推荐顺序:**P0 卫生落库 → P1 alias 塌缩 → P2 boundary 清偿 → P3 拆包 → P4 传输面迁移(主线)**。
  P0–P3 合计约一周;P4 约 1–2 周,可逐域派工、随时暂停。

## 1. 摸底事实(2026-08-19,均已验证)

### 1.1 传输面(最大债)

- 传统域全链路 5 处描述:`packages/shared/ipc/*`(契约,~342 通道常量)→
  `apps/electron/src/ipc/*`(纯函数 DI 工厂,31 文件 ~2550 行)→
  `apps/electron/src/main/ipc/*`(适配,38 文件 ~6543 行)→
  `apps/electron/src/preload/bridge.ts`(1905 行,~353 个手写 invoke 点)→
  `packages/renderer/platform/web.ts`(1801 行 HTTP 镜像,后端孪生 `apps/server/src/http.ts`)。
- router/RPC 模型已存在且好用:`defineRouter`(`packages/core/ipc/index.ts`)自动派生通道名,
  单一 `RPC_INVOKE` 分发(`main/ipc/rpc.ts`),preload wrapper 自动生成
  (`preload/create-api.ts` `createRouterAPI`),web 侧同构(`renderer/platform/router-client.ts`)。
  已迁 ~11 域(agents/goal/markdown/prompts/providers/permission-grants/session-events/todo-plan/usage/models/channel-identity)。
- 未迁 ~30 域,其中 **6 个裸写域连工厂都没有**:collab(15 handle)、evals(14)+evals-workbench(11)、
  practice(10)、notify(2)、deeplink(2);music 混搭(8 裸 + 工厂)。
- `todo-plan` 骑墙:数据面已走 router,窗口面还在旧路(`renderer/platform/electron.ts` 有注释)。
- src/ipc ↔ main/ipc 的工厂/适配分层**本身是正当的**(可独立测试的缝),不互相合并;
  它们的消亡路径是被 router 迁移整体吸收。

### 1.2 一包两层(拆包,零纠缠)

- 反向边 0(runtime 产品层无一处 import app 层,含相对路径形式);跨包相对路径穿墙全仓 0 处。
- app→runtime 390 条 import 已是包说明符形式,拆包后零改动;仅 16 条相对逃逸边(7 文件,
  目标 `plugins/themes/auth/toolkit` 全部已在 exports/alias 中)。
- 宿主 163 个 `@onething/app` subpath import 一字不用改(保住包名即可)。
- 配置面:`onething.aliases.ts` 1 处 + `tsconfig.json` 1 处;四份 vite/vitest 配置全部继承
  aliases.ts,零直接引用。
- boundary checker:层边界核心只有 `checkRuntimeHostBoundary()` 一个函数的 `startsWith(appRoot)`
  分叉,拆包后退化为两包各跑一套;其余 ~240 处 src/app 路径字符串为功能性断言,机械替换。
- 唯一风险:新 `packages/app/package.json` 的 exports 需覆盖 163 subpath(照抄 alias 表)。

### 1.3 alias 手工表

- 110 条里**仅 1 条不规则映射**:`@onething/runtime/gateway` → `src/gateway-runtime.ts`;
  其余全部同形,可塌缩为每族一条正则(sessions 家族 L265 已示范正则写法)。
- 事故根因:vite 显式表与 tsconfig 通配(`@onething/runtime/*` → `src/*`)语义不一致,
  typecheck 全放行、漏登记只在构建/运行时炸;boundary-check 只验"表内条目 target 存在",
  不反查 import 是否登记。
- 各包 package.json 的 exports 已经很规整(runtime 73 键、32 通配,已正确处理 gateway/barrel),
  可作进阶方案的唯一事实源。
- 附带发现:登记动作兼任"边界门禁"副作用(aliases.ts L260-262 注释),塌缩后此职责需显式移交。

### 1.4 boundary 13 红(全部存活)

2026-08-19 亲跑 `bun run boundary`,13 条与基线逐条一致,无一自愈(check 校验委派符号,
不校验旧路径,"文件搬迁自愈"推断已被证伪)。分组:

| 组 | 内容 | 改法 |
| --- | --- | --- |
| A | gateway 2 处越权 import(`permission-coordinator.ts:6`、`bridge.ts:10`) | 从 `gateway-runtime` 入口再导出,各改一行 |
| B | 宿主未委派 4 条(window menu、main-window binding、entrypoint、core-system 裸 import) | 逐条委派/下沉,或按符号名核对 check 是否过期后重录 |
| C | runtime 未收口 5 条(sessions 校验、settings、plugins、SQLite×2) | 下沉;其中 sessions/plugins 两条会被 P4 迁移自然吸收,只做最小修 |
| D | 测试注释/path.join 假阳性 2 条 | 改措辞或加 checker 豁免 |

清零后 `scripts/boundary-gate.mjs` 可删除整套基线 diff 机制(~40 行)退化为"任一 failed 即 exit 1",
删 `docs/audit/boundary-baseline-2026-08-07.txt`。

### 1.5 事件双份 & UI 存量(小项)

- `stream-chunks`:shared 是纯类型 re-export,无债。
- `session-events`:core/shared 分裂是"core 禁 @shared"边界的必然产物,**不可消**;
  缺口是 core ~25 个内联事件字面量与 shared 50 项注册表之间无 parity 测试(小时级可补)。
- UI 76 条 surface-literal:散在 42 文件,前 5 文件(EvalsWorkbench 8 / RoundTimeline 5 /
  ImagePreviewWindow 4 / IncidentTranscript 4 / RoomSurface 4)占 1/3;evals 三件套最肥。
  5 条语义保留(title-attr×2 / transition×1 / focus-bare×2)维持豁免。
  **不属结构债,单独排期,本方案不含**(待拍板确认)。

### 1.6 卫生面

- 已做(停在工作区未提交,可 `git restore` 回退):28 张根目录截图移入
  `TMP/root-screenshots-2026-08/`;`.gitignore` 改为根目录图片一律忽略(删 5 条逐个点名);
  `git rm` 两份 5 月过期会话记录(CHANGES_DETAILED/CHANGES_LOG,描述的是迁移前的树);
  hermes 研究文档 `git mv` 至 `docs/reference/`。
- **package-lock.json 判定:保留**。package.json scripts 全走 npm、
  `npm rebuild better-sqlite3` 是 test/postinstall 硬依赖、electron-builder 的
  node-module-collector 按锁文件探测包管理器——正是 07-29"bun collector 打包缺依赖"的变通,
  08-14 仍有真实提交维护。治理动作只有一条:在 CLAUDE.md 记一行"npm 是打包/rebuild 权威,
  bun 用于日常 dev/test 执行",消灭"看起来像误跑残留"的歧义。
- todo.md / todo2.md(2026-07 任务清单,批次已执行完):去向待拍板(归档进 `plans/` 或删)。
- 在途批次:dirty tree 47 项(29M/6A/4D/7?/1R),约含 4-5 个逻辑批次
  (tool-ui 清理、工作组重分组、消息引用、logging 设计、蓝图文档),
  其中 tool-ui 清理与工作组重分组同摸 `steps-panel-runs.ts`,可能需合并提交。

## 2. 分期计划

### P0 卫生落库(半天)

1. diff 归属分析:porcelain 全量 47 项逐文件看 diff 定批次,产出"每个 commit 的文件清单 +
   建议 message",**清单经用户确认后**逐批提交(含本方案文档与卫生批次)。
2. todo.md / todo2.md 按拍板结果处置;CLAUDE.md 补一行双锁文件说明。
3. 验收门:`git status` 干净;根目录无图片/杂物;`bun run test` + `boundary:gate` + `ui:gate` 全绿。

### P1 alias 塌缩(半天)

1. `onething.aliases.ts`:runtime/core/gateway/electron-host 各族塌缩为一条正则 catch-all,
   保留 `@onething/runtime/gateway` 等不规则显式覆盖(排正则之上);app 族维持目录前缀不动。
2. 门禁移交:boundary-check 增加"枚举全仓 @onething/* import → 逐条实际解析并 stat"的检查,
   替代"登记即门禁"(**门禁形态变化,已列拍板项**)。
3. 顺带删除 aliases.ts 中未被任何 import 使用的富余条目(99 实用 vs ~110 登记)。
4. 验收门:四配置构建全绿(`build:check`、`web:build`、`server:build`)+ `bun run test` +
   新门禁检查通过。
5. 可选后续(P1b,不阻塞):以各包 exports 为唯一事实源生成 alias 与 tsconfig paths,
   消灭三份 paths 手工同步。

### P2 boundary 清偿 + parity 测试(2–3 天)

1. A 组两处一行修;D 组假阳性豁免;B/C 组逐条核对 check 语义后委派/下沉
   (C 组 sessions/plugins 只做最小修,大改留给 P4 吸收)。
2. 清零后简化 `boundary-gate.mjs`(删基线 diff 机制),删除基线文件;CLAUDE.md 同步。
3. 补 core↔shared session-events 注册表 parity 测试(core 内联字面量 ⊆ shared 注册表)。
4. 验收门:`bun run boundary` 0 failed;gate 退化为零基线模式;全量测试绿。

### P3 拆包:src/app → packages/app(1–2 天)

1. 新建 `packages/app/package.json`(name 保持 `@onething/app`,exports 照抄 alias 面覆盖
   163 subpath 或用 `./*` 通配)+ `tsconfig.json`;`git mv` ~595 文件。
2. 改 16 条相对逃逸 import(7 文件)为包说明符;改 `onething.aliases.ts`(1)+ `tsconfig.json`(1);
   `headless-boundary-check.ts` 路径串批量替换 + `checkRuntimeHostBoundary` 拆为两包各跑;
   ~13 处测试/脚本硬编码路径。
3. 文档提及(~140 处)只改 CLAUDE.md 与活跃设计文档,历史 audit 文档不动。
4. 验收门:`build:check` + `test` + `boundary` 全绿;`import-side-effect-free.test.ts` 与
   `architecture-boundaries.test.ts` 通过;electron/server/web 三宿主冒烟启动。

### P4 传输面 router 迁移(主线,1–2 周,逐域可暂停)

1. 前置拍板:RpcRequest 是否加 context 字段(T1 遗留,见传输面统一记录)。
2. Fable 出**每域迁移契约模板**(defineRouter 定义 → `app/rpc/domains/<域>` 注册 →
   删工厂+适配 → 削 bridge.ts/web.ts 对应段 → 测试迁移),并 review 每域产出;opus 逐域执行。
3. 批次顺序:
   - P4a 六个裸写域(collab / evals+workbench / practice / notify / deeplink / music 混搭部分)
     ——无工厂层,纯增益,先趟模板;
   - P4b todo-plan 窗口面收尾(消灭骑墙);
   - P4c 其余 ~24 工厂域按"低风险→高风险"排(建议:themes/scratchpad/app-state 等小域先,
     sessions/chat/media 等大域后)。
4. 每域验收门:该域全部通道走 RPC_INVOKE;工厂/适配文件删除;bridge.ts/web.ts 无该域手写段;
   `transport:gate` 棘轮下降;desktop+web 双端该域功能冒烟。
5. 终态:`main/ipc/` 仅剩 rpc.ts 与少数真窗口系 handler;`src/ipc/` 目录删除;
   CLAUDE.md 的"添加 IPC 通道五步"改写为"defineRouter 一步"。

### 明确不做

- 不合并 src/ipc ↔ main/ipc(会丢可测缝,且方向违背钦定终点);
- 不消除 session-events 的 core/shared 分裂(边界规则必然产物);
- 不在本方案内做 UI surface-literal 清零与目录内聚重组(单独排期);
- 不切换 npm/bun 双锁现状(记录即可)。

## 3. 顺序与依赖

```
P0 卫生落库 ──► P1 alias 塌缩 ──► P2 boundary 清偿 ──► P3 拆包 ──► P4 传输面迁移
 (硬前置)      (P3 新包受益)      (旧路径上修完,       (checker 已零红,
                                  P3 只做机械替换)      纯机械搬迁)
```

- P0 必须最先:任何结构手术不能在 4-5 批未提交改动上进行。
- P2 中 C 组两条红与 P4 有重叠,P2 只做最小修,避免过度投资即将被删的文件。
- P4 独立于 P1–P3,理论上可提前;但排最后是因为它最长,且前面全绿后每域迁移的回归信号最干净。

## 4. 待拍板

| # | 决策 | 默认建议 |
| --- | --- | --- |
| 1 | P4 现在启动,还是先只做 P0–P3(约一周)? | 先 P0–P3,P4 另起一轮 |
| 2 | P1 门禁形态:登记式 → boundary-check 显式解析检查 | 同意迁移 |
| 3 | UI 76 条 surface-literal 单独排期 | 同意,不捎带 |
| 4 | todo.md / todo2.md 去向 | 归档进 plans/ |
| 5 | P4 前置:RpcRequest 加 context 字段与否 | P4 启动时再议 |

## 5. 风险与回退

- P1:正则 alias 若有漏网不规则映射,构建立即红(验收门覆盖三种构建),回退=还原 aliases.ts 单文件。
- P3:全程 `git mv` + 配置两处,单 commit 落库,回退=revert 单 commit;
  exports 覆盖不全会在宿主构建期显性报错,不会静默。
- P4:逐域独立 commit,任一域出问题单独 revert,不影响已迁域;
  `transport:gate` 棘轮防新增手写通道。
- 已知工期陷阱:server 单文件包对动态 import 的 TDZ 坑(toolkit 重建时踩过),
  P3/P4 动 backend.ts 静态 import 边时须保留既有注释语义。
