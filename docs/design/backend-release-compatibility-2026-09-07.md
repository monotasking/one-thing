# 后端发行与回滚兼容事实

本文件记录维护性方案 [§8](backend-maintainability-plan-2026-09-06.md#8-兼容回滚与失败处置) 的发行验收现状。调查日期为 2026-09-07，证据包括仓库源码、本地 Git 历史、官方 v1.1.7 mac-arm64 产物及隔离测试；没有打开真实用户数据目录，没有创建版本、提交、标签或发行，也没有推送。

**尚无历史发行版被本轮认证为安全回滚目标。** 当前能力门禁及备份恢复测试不等于历史二进制兼容认证。本文件不将支持范围缩为当前构建来宣告 §8 完成，也不选择新版本号或代替待确认的回滚策略。

## 1. 可识别的本地版本

下表记录本地 tag 所指提交；日期为该提交的提交日期，不是 GitHub 发行时间。`package.json` 是该提交中的源码版本，不能直接充当安装包版本：发布工作流会用 tag 覆盖它。

| 本地引用 | 提交 | 提交日期 | 根 package 版本 |
| --- | --- | --- | --- |
| `v1.1.7` | `470b5d0ac951` | 2026-08-13 | 1.1.7 |
| `v1.1.6` | `98ff361bf03b` | 2026-05-05 | 1.1.0 |
| `v1.1.5` | `71439c560974` | 2026-03-27 | 1.1.0 |
| `v.1.1.4` | `4d6ba23d30d1` | 2026-03-27 | 1.1.0 |
| `v1.1.3` | `46dace4b0e3b` | 2026-03-27 | 1.1.0 |
| `v1.1.2` | `c5b3525fd438` | 2026-03-27 | 1.1.0 |
| `v1.1.1` | `d40f24a949d8` | 2026-03-27 | 1.1.0 |
| `v1.1.0` | `f4d36f342133` | 2026-03-25 | 1.1.0 |
| `v1.0.3` | `dc315bf3554a` | 2026-01-21 | 1.0.3 |
| `v1.0.1` | `e53216e22241` | 2026-01-21 | 0.1.0 |
| `v1.0.0`、`1.0.0` | `b092874da8f6` | 2026-01-21 | 0.1.0 |
| 调查时 `HEAD` | `bbc15a7b386b` | 2026-09-06 | 1.1.7 |

调查时工作树根版本仍为 1.1.7，`packages/client` 和 `packages/backend` 均为 0.0.0。新的目录 lease、store-format 和同步版本门禁来自尚未提交的工作树修改；上表各 tag 及 HEAD 均没有当前 store-format 实现。对本地 `--all` 历史检查也未找到该文件或当前目录 lease 的提交。因此，不能把当前构建能力标成“v1.1.7 已发布能力”，也不能以 HEAD 作为包含本轮可靠性修复的提交回滚点。

远端配置指向 `monotasking/one-thing`。早期读取远端发行信息失败；后续已取得[官方 v1.1.7 发行](https://github.com/monotasking/one-thing/releases/tag/v1.1.7)及 mac-arm64 ZIP，校验其资产 ID、字节数、SHA256 和 app.asar，并在隔离合成目录运行产物自带的 headless CLI。本地同名 release 文件的哈希与官方资产不同，未混用为历史证据。完整身份和执行记录见 [官方历史产物诊断](backend-historical-artifact-2026-09-07.md)。

真实旧版的普通 Backend 初始化、两方向锁互斥及 5 个进程实际干净退出均已确认；未知 capability 场景却仍启动成功，并新增 3 个默认业务文件和 25 个目录。原有合成文件未改动，因此结论是旧版缺少拒入保护，不是已有用户数据损坏。这补强了下文源码结论，但不认证 GUI、完整业务读写、升级后数据的可读性或任何安全回滚发行目标。

## 2. 历史代码与当前构建的实际差异

### 锁和持久能力

- `v1.1.7:packages/onething-runtime/src/storage/store-lock.ts` 使用 `openSync(..., 'wx')` 创建锁文件后再写 metadata。遇到已存在但为空、不可读或进程已退出的 metadata 时，会删除锁文件并重试；它没有本轮 B2 的目录 lease、身份核验和失败关闭语义。其余 11 个本地 tag 未找到 `StoreLock` 或 `backend.lock` 实现引用。
- 历史 tag 和调查时 HEAD 不识别 `store-format.json`。旧程序不会因为新库中存在能力标记就自动拒绝普通写入。当前版本正常停机释放锁之后，单靠该标记不能约束未修改的旧程序。
- 当前 `Backend.assemble` 取得 lease 后，先 `openStoreFormat` 并可靠启用全部四项能力，再开始业务服务初始化：`session-owner-generation-v1`、`session-deletion-journal-v1`、`scratchpad-owner-migration-v1`、`external-execution-checkpoints-v1`。回滚实现必须真正支持目标数据的语义；仅声明同名能力不足以获得兼容性。

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

### HTTP 和同步协议

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

| 组合 | 已知事实与下一步可验证边界 |
| --- | --- |
| 当前 client + 当前 Backend | 同步协议 1 的完整状态恢复已有真实 HTTP/Backend 契约测试；发行认证仍需绑定具体源码和最终产物。 |
| 当前 client + HEAD `bbc15a7b386b` Server | HEAD 已有 `/api/rpc`，SSE 仍使用旧 `after` / `Last-Event-ID`。适合建立具体跨提交接口测试；目前没有完成该历史代码组合的整体验收。 |
| 当前 client + `v1.1.7` Server | 旧 Server 支持 `/api/events` 和单一序号续播，但没有 `/api/rpc`。当前 client 的 `invoke` 使用 `/api/rpc`，所以旧 SSE 可降级不代表整个应用可以混用。 |
| `v1.1.7` web client + 当前 Server | 旧客户端以 EventSource 订阅旧事件，并调用多条旧 REST 路由；当前架构已迁移部分路由。必须按实际保留接口逐项验证，不能由 SSE 路线保留推导整客户端兼容。 |
| 任意未修改历史写者 + 当前已启用能力的 store | 没有安全普通写入回滚认证；需要符合 §8 的回滚构建或完整离线恢复流程。 |

> 2026-09-07 撤回：会话同步协议已整条删除（第二套真相），见 docs/audit/session-sync-retirement-2026-09-07.md

上述 HTTP 历史判断来自具体提交源码，不是运行旧安装包所得结果。第 6 节新增了实际执行历史锁组件的证据，仍没有把它表述为旧应用整体启动或旧安装包认证。同步协议的现有证据与保证范围详见 [同步兼容说明](backend-client-sync-compatibility-2026-09-06.md)。

## 3. 现有测试证明了什么

- `packages/backend/__tests__/store-format-startup.test.ts` 使用真实 Backend：未知持久能力在恢复及业务文件改动前拒绝；当前能力先可靠发布，再允许初始化和冷重开。
- `packages/onething-runtime/src/storage/__tests__/store-format.test.ts` 的子进程来自 `fixtures/store-format-profile.ts`，运行的是**当前实现的受控低能力配置**。它证明不同能力配置的拒绝和准入，以及无标记新状态的识别，不是任何历史发行版测试。
- `store-backup.test.ts` 的 legacy 恢复例使用合成旧库和低能力配置，证明完整匹配备份的暂存、校验、原址激活与不兼容拒绝。`store-backup-crash.test.ts` 覆盖真实子进程在恢复屏障处崩溃；`packages/backend/__tests__/store-backup-activation.test.ts` 覆盖真实 Backend 原址恢复后的媒体字节读取。
- 当前 CLI `store backup/verify/restore` 调用默认当前能力配置，尚没有“目标发行版”或目标能力清单选项。库 API 的 `supportedCapabilities` 参数不能被描述成 CLI 已经认证某个旧版本。

这些证据可作为后续发行矩阵的基础；完整操作和限制见 [备份与恢复说明](backend-store-backup-2026-09-06.md)。跨平台状态以 [平台验收记录](backend-platform-verification-2026-09-07.md) 和实际运行报告为准，配置三平台 CI 不等于已经获得三平台成功结果。

## 4. 标签发布必须经过同一份验收

本轮将 `.github/workflows/test.yml` 增加为可复用的 `workflow_call` 入口，保留原有分支/PR 触发及所有 jobs。原持久性矩阵与测试文件清单未变。

`.github/workflows/build.yml` 的标签流程现在先运行 `verify`，通过相对路径调用同一 tag 提交中的 `test.yml`。它包含 Node 测试、桌面/Web renderer 测试、三平台持久性测试，以及 boundary、assembly、transport、renderer UI、log、session 门禁。三个平台构建都依赖 `verify`；发布同时依赖 `verify` 和构建，未添加允许失败后继续发布的条件。

原发布策略保持 `draft: false`：验收和构建成功后自动发布。`scripts/release.sh` 只修正了与此不符的草稿提示，没有改变版本、提交、推送或公开发布逻辑。本轮未执行该脚本，也没有触发工作流或发行。

这个接线消除了“tag 只做类型检查和打包即可发布”的缺口。它不自动创建尚不存在的历史兼容测试，也不能替代目标产物校验和真实平台执行结果。

本轮本地检查通过：两份 YAML 解析、依赖图及失败不能继续的断言、构建/发布其余字段与原配置逐项比较、发布脚本仅提示文字变更、`bash -n`、文档相对链接和差异空白检查。独立只读审查也确认依赖和原发布策略保持正确。未将这些静态检查表述为远端 GitHub Actions 已运行成功。

## 5. §8 尚需完成的具体工作

1. **确定发行和回滚身份。** 为本轮提交/产物选择新且明确的发行标识，并选择实际回滚基线。记录源码提交、产物哈希、支持平台和同步/持久能力；既有 1.1.7 标签不能代表此次工作树。
2. **准备符合契约的回滚构建。** 无论选历史 tag 还是重构前提交，都须保留单写者、授权及保存失败契约，并在业务读取/恢复/写入前执行能力门禁。若允许继续使用升级后的数据，就必须保留所需持久协议实现；若只允许恢复升级前完整备份，则须明确拒绝新库普通启动。启动器的单次预检查不能替代整个写入生命周期的独占保证。
3. **运行具体版本组合。** 对选定源码或安装包，用隔离合成数据验证历史格式升级、正常退出与冷恢复、不兼容回退的零业务写入、整库备份原址恢复，以及所支持客户端/Server 的真实接口与协议降级。保留升级前副本，不删除新能力标记，不在测试中使用真实用户库。
4. **把结果绑定到实际发行。** 完成所需平台的同源码验收与最终产物启动检查，再记录可支持组合。当前新增流水线会要求现有测试通过；尚待确认的 Windows 环境和回滚策略仍保留为发行验收事项，不能靠一份清单或绿色的低能力配置测试关闭。

本节是尚未完成的交付工作，不是新增发布授权。新版本号、回滚策略和远端发行均未在本轮决定或执行。

## 6. 可执行的隔离兼容入口

[backend-release-compatibility.mjs](../../scripts/backend-release-compatibility.mjs) 已实现并本地执行。它只创建临时合成 store；子进程的 HOME、缓存、临时目录和 `ONETHING_STORE_PATH` 都指向隔离目录，不继承 provider 密钥、`NODE_OPTIONS` 或用户 store 配置。它不修改 Git 状态，不发布、不迁移真实用户数据，也不决定正式版本号。

```sh
node scripts/backend-release-compatibility.mjs --report-dir /tmp/backend-release-compatibility-run
npx vitest run scripts/__tests__/backend-release-compatibility.test.mjs
```

入口用宿主的共享 esbuild 配方现场构建真实 Backend 夹具和真实 CLI；Backend 夹具放在所属包的 `testing` 目录，脚本没有绕过后端边界导入私有业务模块。先发现构建依赖图，再在实际编译前后核对每个输入文件的哈希及依赖图是否相同；并发源码修改使本次运行失败，不能把新源码哈希标给旧产物。另一路从本地 `v1.1.7^{commit}` 提取未修改的 `StoreLock`、`paths` 和所有转递依赖，全部解析到同一历史提交，拒绝混入当前实现。报告记录 Git 提交、每个构建输入的 SHA-256、当前构建输入摘要和三份产物 SHA-256，并把产物留在报告目录的 `artifacts`。报告目录必须是新目录，以原子创建拒绝覆盖旧证据；已实测重复路径被拒且原报告字节不变。临时业务目录在实际进程关闭后删除。

固定执行范围如下：

| 隔离检查 | 实际断言 |
| --- | --- |
| 当前 Backend 排他退出 | 真实 Backend 接受后台任务并打开文件；收到 stop 后挂在真实 IO 链，第二个 Backend 仍拒入；放行后写入、fsync、close，再等待 Backend 停机和子进程 `close`，最后冷重开。 |
| 当前未知能力与未知格式 | 两类普通启动均在 `afterSettings` 前拒绝；业务文件字节和空目录快照完全不变。快照只排除 `run`，不排除能力或恢复元数据。 |
| 历史锁对新能力和未知能力 | `v1.1.7` 的真实文件锁都允许取得锁，并能拒绝第二个活跃旧锁进程；这证明旧锁阶段没有数据能力门禁，**不证明旧业务服务安全启动或正确处理新数据**。 |
| 历史锁对空锁的处理 | 相同隔离空锁文件，当前 Backend 拒入并原样保留；旧 `StoreLock` 删除后接管。没有将这个历史缺口当作可接受回滚行为。 |
| 当前完整备份和原址恢复 | 真实 CLI 备份、校验和暂存；恢复前后所有文件逐一比对，不限索引。暂存路径启动被拒，保留原 store 后原址激活，真实 Backend 冷读 Session owner、消息、blob 和绝对 media 路径；损坏备份的校验和恢复均失败，拒绝目标目录未创建。 |

当前数据夹具通过实际 Session 创建者、事件 writer、blob 和 media 服务生成。2026-09-07 macOS arm64 / Darwin 25.5.0 / Node 22.22.3 的最终基础运行 **7 项通过**，业务检查耗时合计约 4.44 秒（不含构建）；整库对比包含 16 个文件。报告为 `/tmp/backend-release-compatibility-20260907-frozen/report.json`，日志为 `/tmp/backend-release-compatibility-frozen.log`。当前 Backend 夹具产物哈希为 `aa0c7026a8c022d1a1a01040c6041cef67fe850a00cad0c316a04b9daf71a805`；这是工作树测量夹具身份，不是已发布应用身份。历史来源为完整提交 `470b5d0ac951b722b505f5d174191d2a97b395e2`，历史锁源码哈希为 `428825b828c57876bf5ebbaf73aaa012fd5061f3d686261889bcac567d009c1a`。

### 为实际回滚产物预留的执行契约

提供实际产物后使用同一入口：

```sh
node scripts/backend-release-compatibility.mjs --report-dir /tmp/backend-rollback-artifact-run --rollback-manifest /absolute/path/rollback-manifest.json
```

manifest 格式如下；占位示例不能直接作为发行证明：

```json
{
  "schemaVersion": 1,
  "label": "待确认的实际回滚产物身份",
  "artifact": { "path": "/absolute/path/actual-artifact.cjs", "sha256": "实际文件的64位小写SHA-256" },
  "command": ["{node}", "{artifact}", "{input}"],
  "supportedCapabilities": [],
  "unsupportedExitCodes": [23]
}
```

`{input}` 展开为包含隔离 `store` 的 JSON；也可用 `{store}` 作为宿主的显式路径参数。命令必须包含经过哈希核对的 `{artifact}`。测试适配入口需要由实际产物提供或经审查接入其实际启动/退出路径：stdout 使用 `COMPAT_RESULT ` 前缀发送 JSON 行，启动成功发送 `{ "event": "ready", "pid": 实际进程PID }`；拒绝发送 `{ "event": "rejected", "businessStarted": false }` 并以列明的非零码退出；stdin 收到 `{ "event": "stop" }` 后执行真正的退出协调，完成时发送 `{ "event": "stopped" }`。命令不能只发 ready 后脱离受测进程，也不能以当前代码的低能力配置代替历史产物。适配器本身仍须审查，事件声明不构成独立认证。

这一分支执行：未知能力及每一项声明不支持的当前能力都必须零业务改动拒启；空锁必须拒入并保留；产物存活时第二个同产物、当前 lease 写者和当前 CLI 维护者均不可接管；真实进程关闭后才允许整库备份、逐文件恢复校验、暂存拒启和原址冷启动，最后确认 lease 可重新取得。每个子进程有期限；超时或 SIGKILL 结果失败，收到 ready/stopped 不能替代实际 `close`。POSIX 还检查进程组是否残留，强制清理不算正常通过。

为了验证这条适配执行路径，另用**上述当前 Backend 已构建夹具**作为明确标记的 adapter self-test 输入，10 项检查通过，报告 `/tmp/backend-release-compatibility-20260907-adapter-frozen/report.json`。它只验证入口可执行，**不是历史回滚产物的 10 项认证**。脚本自身的 4 个测试验证真实 child 超时失败与退出、拒绝诊断、业务快照和必填产物身份；Node 类型、boundary 和 log 门禁通过。

这 4 个测试初次以 `node:test` 单独运行通过，但根 Vitest 全量会发现该文件，无法登记其测试而报 `No test suite found`；那次独立成功不代表已经接入项目完整回归。现已仅将测试注册改为项目既有的 Vitest，保留全部实际断言和 child 清理，不修改发现范围或门禁；以上命令是修正后的入口。修正后 Vitest 定向运行 **1 文件 / 4 测试通过，exit 0**，总计 694 ms，日志 `/tmp/backend-release-compatibility-vitest-frozen.log`；后续同源全量结果由根验收记录，不用该定向结果代替。

随后装配门禁发现真实 child 夹具新增了 6 个模块级 `let`。现将这些生命周期状态及回调完整移入单次 `main()` 的局部作用域，保留文件路径、实际 IO 和退出行为，不修改基线或排除范围。再次验证：assembly 门禁无新增项、Vitest 4 例、真实隔离兼容 7 项和 Node 类型全部通过。最新报告 `/tmp/backend-release-compatibility-20260908-local-state/report.json` 记录该夹具修正后的源码及产物哈希，仍验证 16 文件完整恢复；日志分别为 `/tmp/backend-release-compatibility-assembly-local-state.log`、`/tmp/backend-release-compatibility-vitest-local-state.log`、`/tmp/backend-release-compatibility-local-state.log` 和 `/tmp/backend-release-compatibility-types-local-state.log`。前文 adapter self-test 报告对应此前明确记录的产物，不能将其哈希归给此次夹具。

### 仍未取得的证据

无 manifest 时报告始终输出 `rollbackArtifact: "not-provided"`；即便可执行检查通过，`releaseCertification` 仍为 `incomplete`。当前入口未运行 v1.1.7 完整应用或历史安装包，也未覆盖实际历史 client/Server 接口组合，不能由旧锁组件推导这些结果。回滚产物的持久语义、保存失败传播和授权实现仍须保留主方案要求，由目标产物对应的业务契约与故障回归提供证据；仅填相同能力名称不算实现。

最小后续动作仍是第 5 节的发行/回滚决策和对应代码：取得实际目标产物及哈希，接入它的真实启动/退出适配，保留所需 B2/R2/R5/授权契约，再运行本入口与对应业务、协议、平台验收。若目标原始历史产物无法满足门禁或单写者契约，应按已确认策略准备支持这些契约的回滚构建或完整离线恢复流程，而不是删除能力标记或降低断言。本次没有选择上述策略；Windows 和最终历史产物状态仍待确认。
