# Claude 封禁与 onething 代理排查

调查日期：2026-09-16。以下时间均为北京时间（UTC+8）。目标时段为 08:00–08:25，浏览器为 onething 内置浏览器。

## 结论

**确认 Claude 记录的账号封禁时间为 08:25:51；无法确认封禁由未走代理造成。** 从本机内置浏览器的 HTTP 缓存中解码出的 Claude 账号状态响应，明确包含 `banned_at: 2026-09-16T00:25:51.165265Z`。服务端仅给出 `ban_category: other`，没有披露具体触发原因。

系统电源记录显示，本机当时处于合盖休眠阶段，中间仅有短暂后台唤醒。这不支持“08:25 正在操作内置浏览器，某一发请求突然直连便立刻被封”的具体时间线；但不能排除更早访问、后台活动或其他设备的影响，也不能据此证明历史访问从未直连。

本次仅调查本地记录及公开官方说明，没有修改代理、账号或浏览器配置，没有重新登录 Claude 或提交申诉。

## 已确认的时间线

| 北京时间 | 证据与事实 | 解释边界 |
| --- | --- | --- |
| 08:03:20 | macOS 电源日志：`Clamshell Sleep`，合盖休眠 | 系统状态，不代表此前没有网络活动 |
| 08:11:13–08:11:58 | `DarkWake` 后再次休眠 | 后台维护唤醒，不是完整用户唤醒 |
| 08:21:36–08:22:21 | 第二次 `DarkWake` 后再次休眠 | 不能仅凭它判断有哪些应用发了网络请求 |
| **08:25:51.165265** | Claude `/api/account/standing` 缓存中的 `banned_at` | 服务端报告的封禁时间，并非推测自本地文件修改时间 |
| 09:13:11 | 系统由后台唤醒转为 `FullWake` | 恢复完整唤醒 |
| 09:22:23 | onething 当前日志段开始，记录浏览器宿主安装 | 是已找到的今日日志起点，不能证明 09:22 前程序绝对未运行 |
| 09:24:09 | 内置浏览器缓存中的组织接口返回 HTTP 403，正文为 `permission_error` / `Invalid authorization` | 证明此时已有授权失败；403 本身不说明代理路线或封禁原因 |
| 11:13:45.129887 | `/api/account/current_appeal` 缓存记录申诉创建时间 | 是已有申诉，本次调查没有提交新申诉 |
| 11:26:08 | 账号状态、申诉状态接口的缓存响应时间 | 当时为 `bad_standing`、分类 `other`，申诉为 `open`；不能当成调查时的实时状态 |

账号状态响应还显示 `has_active_org: false`，被封组织同样归类为 `other`。没有从该响应中得到“代理泄漏”“地区违规”或某一 IP 的具体判定。

## 能否判断当时走了代理

目前做不到，关键证据存在缺口：

1. **代理逐连接日志没有覆盖目标时段。** 检查时 Clash Verge 的 service 日志最早从 11:59:31 开始，多个文件约 128 KiB，属于轮转日志。08:00–08:25 的连接记录不在现存保留范围内。
2. **onething 的现有日志不记录每次浏览器导航的实际代理决策与公网出口。** 本次检查的当前日志及前一压缩日志在目标时间窗口没有记录；前一段结束于 9 月 15 日 23:49:04，下一段开始于 9 月 16 日 09:22:23。
3. **当前设置不能证明历史状态。** 目前 `network.proxy.enabled` 为 `true`，地址为 `http://127.0.0.1:7890`，绕过规则为 `localhost;127.0.0.1;::1;*.local`。这组绕过规则没有列入 Claude 域名，但设置文件在事后更新过。
4. **当前 Clash 规则也不能代替上午证据。** 现有规则把 `claude.ai`、`anthropic.com` 转交代理节点组，TUN 关闭、系统代理开启；生成的规则文件最后更新于 11:10。较晚的日志中找到 31 条 Claude / Anthropic 连接，均选择名为“日本W02 | IEPL”的节点，但进程标记为 Chrome、Claude 或 Node，没有 onething / Electron 标记。这既不能证明内置浏览器上午的路线，也不能证明节点名称所代表的真实公网出口所在地。

因此，“现在代理开启”“较晚其他应用走了日本节点”“现在测试连接成功”都不足以推导“封禁前一直走代理”。同样，缺少早上的日志也不等于早上发生了直连。

## 代码检查发现的风险

内置浏览器曾有过“代理只设置给默认 session，没有覆盖浏览器独立分区”的缺陷，仓库在 **9 月 12 日 18:30:16** 的提交 `1369c29b8` 中修复。当前代码会登记浏览器分区，并在页面首次加载前等待代理应用。今天新增的网络代理设置页接的是已有后端能力，并不是今天才首次给浏览器接代理。

不过，当前实现仍有两处非强制代理行为：

- [network-proxy.ts](../../apps/desktop-react/electron/network-proxy.ts#L109)：代理关闭时使用直连；已启用但 URL 校验失败时，也返回直连配置。
- [network-proxy.ts](../../apps/desktop-react/electron/network-proxy.ts#L188)：`setProxy` 失败会记录警告，错误不再向上抛出。[session-policy.ts](../../apps/desktop-react/electron/browser/session-policy.ts#L214) 也会吞掉代理初始化失败，允许等待结束。失败后具体保留什么网络状态取决于原 session 状态，不能一概说必然直连。

**这些是代码层面的真实风险，不是本次封禁的已证实原因。** 没有目标时段的配置快照、实际代理决策或出口记录，也没有发现对应时间的失败日志，无法证明这些分支被触发。

## 后续最有价值的动作

- 对已有申诉补充准确封禁时间与账号提示，向 Anthropic 要求人工核查具体原因。官方说明表示，其 Safeguards 团队可进一步调查账号停用原因；公开列举的原因有多种，并不支持把所有封禁都归因于代理。[官方申诉说明](https://support.claude.com/en/articles/8241253-safeguards-warnings-and-appeals)
- 如果产品要求“启用代理后绝不允许意外直连”，应另外实现代理失败时阻止导航、明确显示失败，并记录每个浏览器分区应用代理的结果。这属于后续修复，本次未修改。
- 后续诊断日志应保留足够长的连接时间线，至少记录时间、浏览器分区、目标域名、代理解析结果及配置变更；避免记录 Cookie、登录凭据和完整敏感 URL。即使补充这些日志，也需要服务端证据才能确定封禁因果。

## 证据来源与校验

本地账号状态信息来自 `Electron/Partitions/browser-default/Cache/Cache_Data`，读取 Chromium Simple Cache 文件键与缓存响应，并对 Zstandard 压缩正文解码。只保留与封禁相关的字段，不在本报告记录账号 ID、Cookie 值、登录凭据或数据导出链接。

基础目录：`/Users/yitiansong/Library/Application Support/Electron/Partitions/browser-default/Cache/Cache_Data/`

| 文件 | 内容 | 调查时 SHA-256 |
| --- | --- | --- |
| `c22aa1f0c209c995_0` | 11:26:08 的 `/api/account/standing` 响应 | `b3a42539f76686e00b69557236cedee8804d456453c0d9e6c83f26641ca50263` |
| `a7e262ec20f3c547_0` | 11:26:08 的 `/api/account/current_appeal` 响应 | `c2d249562052e5df30a44fe71d63d465349ca63dc2c410fc1fb24a7c65f51e89` |
| `eef16bd5c75f4076_0` | 09:24:09 的组织接口 403 响应 | `37157e222f624699a6f21c8138a6872c1a78e2549fe0da8a5396ed319989aa95` |

其他来源：macOS `pmset -g log`；`/Users/yitiansong/.onething/log/`；`/Users/yitiansong/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/service-logs/service/`；当前网络设置及上述仓库代码。浏览器缓存、日志会持续变化，本报告描述的是调查时读取到的记录。
