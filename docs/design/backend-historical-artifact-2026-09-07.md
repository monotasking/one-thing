# 官方 v1.1.7 macOS 产物识别与隔离启动诊断

本轮已取得并校验**真实官方历史 ZIP**，并以包内 Electron 的 Node 模式执行真实历史 headless daemon。普通空库启动、双向锁互斥和实际退出均取得证据；带未知能力标记的合成库仍被旧程序打开，并新增默认业务文件，未达到“拒绝且业务零改动”的要求。没有启动 GUI、安装到 `/Applications`、替换当前 app、打开真实用户 store 或选择受支持回滚版本。[发行兼容说明](backend-release-compatibility-2026-09-07.md) 的完整认证仍未完成。

## 1. 官方身份与本地产物差异

`origin` 是 `git@github.com:monotasking/one-thing.git`。本轮 `gh release view` 和 GitHub 官方 REST 元数据均读取成功，取代此前仅有网络失败的调查状态。

- 官方 [v1.1.7 release](https://github.com/monotasking/one-thing/releases/tag/v1.1.7)：release ID `369629315`，非草稿、非预发布，`published_at=2026-08-13T02:21:59Z`，`immutable=false`。
- 官方 annotated tag 对象 `13bdfe9533e88a1e81d55fcf79e68f2eb61bb640` 解引用为提交 `470b5d0ac951b722b505f5d174191d2a97b395e2`。release 的 `target_commitish=main` 不能替代这个精确提交身份。

| 官方资产 | asset ID / 大小 | 官方公开 SHA-256 |
| --- | --- | --- |
| [onething-1.1.7-arm64-mac.zip](https://github.com/monotasking/one-thing/releases/download/v1.1.7/onething-1.1.7-arm64-mac.zip) | `512354546` / 276,430,527 bytes | `3c1a8562fd4bfbfec5f01e260b5cf1a1df9050fe5f532987137ab9ce78d9fb06` |
| [onething-1.1.7-arm64.dmg](https://github.com/monotasking/one-thing/releases/download/v1.1.7/onething-1.1.7-arm64.dmg) | `512354547` / 285,813,366 bytes | `039cb82df714fa264043a05fef9ffae1a8809b434f4f596a054ca1ec07956c26` |

只下载了已确认的 ZIP；DMG 只读了官方元数据。官方资产未被标记 immutable，所以后续必须固定 asset ID 和摘要，并再次核对所执行文件，不能仅按文件名下载最新版替换。

仓库已有 `release/onething-1.1.7-arm64-mac.zip` 大小为 280,218,113 bytes、SHA-256 `0954ebb7c2c90e807f6468b425f80c1106c3c4305b89ab27a24ea47fc55ba870`；同名 DMG 为 289,816,821 bytes、SHA-256 `822d6ebfeaec57ec18676245e9be0384ac2931815d4b5299b8c5445f25be47db`，**两者均不是官方资产字节**。仓库 `latest-mac.yml` 记录这些本地产物与 `releaseDate=2026-08-27T01:38:05.750Z`。`release/mac-arm64/onething.app` 也显示版本 1.1.7，但其 asar 哈希为 `9deb14fc323631fb3cc41c9ab8b183f7761fba1c73f3af9de513f1cbed731a6b`；不能用相同版本字符串推定为官方历史包。本轮没有扫描用户 Downloads 或凭据目录。

## 2. 已执行的产物检查

新增 [backend-historical-artifact-inspect.mjs](../../scripts/backend-historical-artifact-inspect.mjs) 是只下载、校验和静态解包入口，必须传入新的目录：

```sh
node scripts/backend-historical-artifact-inspect.mjs /tmp/onething-v117-official-new-inspection
```

脚本先核对官方 asset ID、名称、大小和公开摘要；下载后再次计算 SHA-256，匹配才允许解包。读取包内 plist、package 和实际入口，不执行包内 JavaScript；导出 25 个 main/CLI/chunk 文件便于静态检查，并读取 Electron fuse，不修改签名或 fuse。

本轮实际结果保存在 `/tmp/onething-v117-official-20260907-inspect/`：

| 项目 | 实际结果 |
| --- | --- |
| ZIP | 大小与 SHA-256 均与官方记录完全一致 |
| app | `unpacked/onething.app`，arm64，bundle ID `com.onething.app`，executable `onething`，版本和 build 都是 1.1.7 |
| asar | `Contents/Resources/app.asar`；SHA-256 `aa91ec47633ee617eaae12aec5b85ef1e34c8e7c96cee82e57cfc7f3d941b833`；8,822 entries |
| 图形应用入口 | `out/main/index.js`；SHA-256 `bc1135cdb0795ccd47cd3e7a46c042331f0902c26209c39ef1b392e8368940f1` |
| 实际 CLI 入口 | `out/main/cli.js`，存在 `--daemon-child` 和显式 `--store` 路径处理 |
| Electron fuse | 只读 `RunAsNode=49`（ASCII `1`，已启用），允许用包内 Electron 的 Node 模式执行包内 CLI |
| 签名元数据 | `codesign -dv` 显示 ad hoc / runtime，`TeamIdentifier=not set`；这不是 Developer ID 或 notarization 成功证明 |

`inspection.json`、`release-metadata.json`、`inspect/packaged-main.js`、`inspect/out/main/` 和 `inspect/packaged-code-hashes.json` 均来自此校验后的 ZIP。补充 chunk 导出和 fuse 读取属于静态检查，未启动 app。

## 3. 实际包内的路径与 Keychain 边界

以下位置指上述 `inspect` 中原样导出的历史打包代码，避免把当前源码实现套到历史包上：

- `out/main/chunks/paths-CJjwp00T.js:194–210`：业务 store 使用显式 `storePath`、`ONETHING_STORE_PATH`，然后才回退到 `os.homedir()/.onething`。
- `packaged-main.js:22106` 和 `22229`：GUI 会读写 `HOME/.onething/login-shell-env.json`，检查 shell 配置时间戳并启动登录 shell。`22364` 的 ready 流程在取得桌面锁**之前**完成这一步。单独设置 store 路径不能隔离这些文件和 shell 配置。
- `packaged-main.js:22051`、`22718` 起的装配：GUI 绑定真正的 Electron `safeStorage`。应用层未发现对 `userData/appData` 的明确临时目录重定向；空 store 的 OAuth token reader 在文件不存在时返回空值，但这不能证明整个 Electron GUI 不触及宿主配置或 Keychain。**本轮没有建立安全的完整 GUI 启动隔离证明。**
- `out/main/chunks/backend-OUN52dfT.js:19042–19172`：OAuth 文件默认随 store 走；加密适配器来自 host 绑定。`out/main/cli.js:221–228` 的 `--daemon-child` 先设置 store 和 `ONETHING_HEADLESS=1`，再导入真实 daemon。
- `out/main/chunks/daemon-server-tcjCD-iP.js:55–75`：headless 启动使用实际历史 Backend；home/downloads 由 `os.homedir()` 派生，未绑定 GUI 的 Electron safeStorage。该启动链不执行 GUI 的登录 shell 环境加载。空合成 store 不配置 MCP/ACP/provider 凭据，也不发送模型或工具请求。

因此本轮执行的是**这个官方包内的真实 headless daemon**。这属于历史实际产物的启动检查；证明范围不包含完整图形宿主或历史业务数据读写兼容。

## 4. 已执行的隔离入口与证据身份

新增 [backend-historical-daemon-probe.mjs](../../scripts/backend-historical-daemon-probe.mjs) 严格限定到上述固定大小、SHA-256 的官方 ZIP。默认仅打印计划，根任务复核后才加 `--run`。本次实际命令为：

```sh
node scripts/backend-historical-daemon-probe.mjs \
  --archive /tmp/onething-v117-official-20260907-inspect/onething-1.1.7-arm64-mac.zip \
  --report-dir /tmp/ot-v117-daemon-0907 \
  --run
```

重跑必须选择另一个尚不存在的短路径目录；入口原子创建证据目录，拒绝覆盖旧报告。计划输出 `/tmp/backend-historical-daemon-plan.json`，实际执行日志 `/tmp/backend-historical-daemon-real.log`，完整结果及所有合成 store 保留在 `/tmp/ot-v117-daemon-0907/`。根任务执行退出码为 0，报告时间为 `2026-09-06T18:43:46.469Z` 至 `2026-09-06T18:43:51.919Z`（北京时间 9 月 7 日 02:43）。

执行宿主为 macOS 26.5（25F71）、arm64，运行器 Node v22.22.3；历史 CLI 使用官方 app 内的 Electron 二进制，未用当前 Node 替换其运行时。

| 本次证据 | SHA-256 |
| --- | --- |
| `report.json` | `ff06765a5fbdd9429f534d35b186a23c70af5cc4cff8a0837073c407632b476a` |
| 实际包内 `out/main/cli.js` | `6aba4ef3a1c53c4ae89e7548e3f143f9b551e43434f0bcabe5968b8bb910a760` |
| 当次编译的当前维护锁 helper | `f880ad29c6dc918bd8315c1992c4b82df5178665fb0ea47cce6b66c946b2b7df` |

报告还记录当前 helper 的全部源码输入摘要，并在编译前后校验一致。helper 使用当前公开 `StoreLock`，只用于与真实历史进程争用维护锁，不代表当前完整发布产物。

运行器在每个独立用例内创建 `home/tmp/config/cache/data/store` 并切换工作目录。它完整重建环境，只保留固定系统 PATH、隔离的 HOME/ZDOTDIR/TMPDIR/XDG 路径、显式 store、`ELECTRON_RUN_AS_NODE=1`、`ONETHING_HEADLESS=1`、`TZ=UTC` 和 `LANG=C`；不继承 `NODE_OPTIONS`、代理、token、SSH agent 或用户配置路径。实际 argv 是新解包 app 的 Electron 二进制、包内 `cli.js`、`--daemon-child --store <合成库>`，没有调用会自行脱离的 `daemon start`。没有发送聊天、模型或工具请求。

## 5. 独立判定与实际结果

复核读取完整原报告，重新计算报告内两个启动用例的全部业务文件 SHA-256，并核对实际目录；所有冷读结果与记录一致。业务快照只排除 store 根目录下的 `run` 发现记录，其余文件和目录均纳入。另核对全部 5 个拥有进程的退出结果，以及三个用例退出后的锁/socket/PID 文件。

| 检查 | 判定要求 | 本次实证与结论 |
| --- | --- | --- |
| 普通启动 | 真实 `daemon.health` 成功，回复 PID、锁 PID、`daemon.pid` 均属于启动的子进程；socket 在历史 `await backend.start()` 后监听 | PID `17171`，三处身份一致，实际历史 Backend 已就绪。新增 3 个默认业务文件和 25 个目录；原哨兵字节不变。普通空库启动成立。 |
| 未知能力 | 带有效 `version:1`、未知 `requiredCapabilities` 的库应在业务加载前拒绝，且业务快照无增删改 | 实际 PID `17263` 仍 ready，忽略 `future-historical-diagnostic-v999` 标记；新增 28 项业务路径。**拒绝与业务零改动要求不成立。** |
| 旧进程先持锁 | 当前 helper 必须因真实 `LockConflictError` 拒绝；诊断须对应仍存活的旧 PID 与同一 legacy 文件锁；不能把任意 acquire 异常算成功 | 当前 PID `17262` 自行以 code `23` 退出，`name=LockConflictError`、真实类检查为真，`legacy-lock/running`、旧 PID `17171`、canonical path、inode/device/hash 匹配；锁内容和身份保留。互斥成立。 |
| 当前维护者先持锁 | 旧程序自行退出且有明确锁冲突文本；超时、外部终止或其他崩溃均不能算拒绝 | 当前 PID `17264` 持目录锁，旧 PID `17265` 自行以 code `1`、无 signal 退出，明确报告 `Cannot start daemon: another onething daemon is already running (pid -1).`。当前锁 inode/device/owner 字节未变且 owner 仍活。互斥成立；`-1` 只说明旧程序不识别目录锁元数据。 |
| 关闭与清理 | 汇总所有旧进程、竞争 helper、当前 owner 和兜底清理；任何强杀、未 close、存活 PID/进程组或漏结果都不得成功 | 全部 5 个进程均真实 `close`，`forced=false`、`pidAlive=false`、`processGroupAlive=false`；无遗漏和兜底清理。两个已就绪旧 daemon 收到 SIGTERM 后 code `0`、无 signal 退出；当前维护者释放锁后 code `0` 退出。三个用例的 `backend.lock/daemon.sock/daemon.pid` 均已不存在。 |

未知能力用例新增的 **3 个文件**是 `agents.json`、`settings.json` 和 `collab/v3-migrated.json`；另有 **25 个目录**，合计 **28 项路径**。原 `diagnostic-sentinel.bin` 和 `store-format.json` 摘要均未改变，删除、修改已有路径的计数均为 0。普通空库启动也生成相同种类的默认文件。这证明旧版未执行未知能力准入拒绝并发生初始化写入，**不构成“已有用户业务数据损坏”的证据**；本轮合成库没有带入真实历史会话或新格式业务数据。

报告的 `status=diagnostic-complete` 表示这三个诊断场景和进程收尾均完成，**不表示历史兼容通过**；报告保留 `releaseCertification=incomplete`。旧 daemon 日志还显示隔离工作目录下的 builtin skills 路径不存在，因此这次 ready 也不能用于认证打包资源查找、内置技能或完整 GUI 功能。

这份结果补齐了可识别官方历史包、真实启动、当前维护锁双向互斥及正常退出证据。它没有把 v1.1.7 选为受支持回滚目标；未知能力拒绝已明确失败。支持版本组合、回滚策略、完整匹配备份由所选真实旧产物恢复后的业务读写、完整 GUI 隔离和跨平台发行验收仍需各自证据。完整 GUI 若要求不访问现有用户 Keychain，应使用没有真实凭据的独立 macOS 账户或 VM；当前结果不能替代该证明。
