# onething 内置浏览器：休眠、后台与代理异常检查

检查日期：2026-09-16；时间均为北京时间（UTC+8）。

## 结论

**应用在后台不等于网页停止联网。** 隐藏网页仍可能轮询、刷新会话、维持长连接，或按网页自己的逻辑发送状态信息。实测隐藏页面仍定时请求，正常走配置好的代理。

**代理服务暂时不可用，不会在本次测试的配置下自动改为直连。** HTTP、HTTPS 请求失败，WS、WSS 无法建立连接；代理接受连接但不响应时，请求超时，目标服务没有收到请求。这里使用的是单一固定 HTTP 代理，没有添加 `DIRECT` 后备路线。

**但当前实现不能保证“开启代理后，所有连接都经过代理”。** 找到三处需要处理的缺口：无效代理配置会变成直连；代理配置应用失败后仍允许页面继续加载；启用代理不会迁移已经存在的直连 WebSocket。第三点连加密的 WSS 也已复现。

**这些发现不能证明今天的 Claude 封号由代理或休眠导致。** 08:00–08:25 缺少逐请求路由记录；服务端记录的封禁时间也不一定是触发风控的请求时间。

## 三种状态分别会发生什么

| 状态 | 浏览器可能发送什么 | 是否经过代理 | 证据与边界 |
|---|---|---|---|
| 应用进入后台、标签页隐藏 | 网页轮询、重试、会话刷新；已有 WebSocket 消息；网页自行注册的可见性事件上报等 | 新 HTTP/HTTPS/WS/WSS 连接使用所属浏览器分区的代理配置；隐藏本身不会切换路由 | 隐藏测试页 3.2 秒内发出 3 次轮询，全部经过代理。具体发送内容由网页决定，不能据此认定 Claude 发了上述全部内容 |
| 整机真正休眠 | 普通页面脚本通常暂停，不能等同于持续运行后台网页；系统仍可能有连接保活和维护性唤醒活动 | 不能仅凭休眠判断实际路由。已有 TCP 连接若执行保活，仍对应原连接端点，不会把代理连接自动变成直连目标网站 | 历史电源日志能证实休眠与短暂唤醒，但没有该时段的 onething 数据包或请求记录；未实际让用户电脑休眠做实验 |
| 休眠前后、唤醒恢复 | 休眠前网页可能收到状态变化；恢复后可能继续计时器、重新请求或重连 | 沿用浏览器分区配置；本项目没有在恢复时等待代理服务就绪的专门流程 | 代码检查未发现电源 suspend/resume 的网络管理处理。不能承诺每次电源休眠都会触发网页 visibilitychange |
| 代理端口关闭 | 新请求尝试连接代理后失败 | 本次测试没有自动直连 | HTTP/HTTPS 为 `ERR_PROXY_CONNECTION_FAILED`，WS/WSS 建连失败 |
| 代理监听但不响应 | 请求等待直至超时或取消 | 测试观察期内没有直连 | 使用 2.5 秒测试超时，目标服务收到 0 次请求；不代表所有代理实现、所有协议的无限期行为 |

浏览器默认的后台限制主要是降低动画与计时器频率，不是关闭网络。macOS App Nap 也不能作为“网页已经完全停止”的保证。参见 [Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences) 和 [Apple App Nap 文档](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html)。

本项目未找到“进入休眠就向某个服务器额外发送一条上报”的专门逻辑。网页自己的后台请求、浏览器网络连接与系统维护活动是不同层面的行为，不能混为一次 onething 上报。

## 已复现的代理边界

| 场景 | 观察结果 | 含义 |
|---|---|---|
| 正常代理访问 HTTP、HTTPS | 目标返回 200；分别从代理转发、CONNECT 隧道到达 | 正常配置确实生效 |
| 正常代理连接 WS、WSS | 均成功；目标收到的测试消息来自代理隧道 | 正常长连接也能经过代理 |
| 停止代理并断开其连接 | HTTP/HTTPS 失败，WS/WSS 建连失败 | “代理服务掉线”与“代理设置没生效”必须分开判断 |
| 代理恢复并重新应用配置 | HTTP 再次通过代理成功 | 连接可以恢复；本实验没有复现完整电源唤醒过程 |
| 已启用但 URL 为 `not a proxy` | 生产配置转换函数返回 `DIRECT`；HTTP 直连成功 | 底层对无效配置采用放行直连。设置界面校验能限制正常输入，但底层本身不提供失败即阻断保证 |
| 注入 `setProxy` 失败，原状态是 DIRECT | 错误被记录，但 apply 和 ready 都正常完成；保留原 DIRECT 状态的真实 Chromium 会话能继续直连 | 这是显式故障注入，验证错误处理允许继续；不是发现今日发生过 Electron 原生 setProxy 异常 |
| 注入 `setProxy` 失败，原状态已有代理 | 保留原代理状态的会话仍经过旧代理 | 应用失败不必然导致直连，取决于原来的状态。注入模拟失败发生在配置改变之前，不穷尽原生失败的内部状态 |
| 域名明确匹配 bypass 规则 | `DIRECT`，目标收到直连请求 | 这是绕过规则的预期含义；本机当前列出的 localhost、127.0.0.1、::1、*.local 不匹配 claude.ai |
| 先直连建立 WSS，再开启代理 | 新请求解析结果为 PROXY；旧 WSS 仍以 DIRECT 发送消息 | 新策略不迁移现存长连接；仅查看新请求的代理解析结果不足以保证旧连接已切换 |
| 对上述会话再调用 `closeAllConnections()` | 本次 Electron 41.1.1 中，WSS 仍为 OPEN，仍能直连发送 | 单靠这个调用不足以解决本次复现的存活 WSS；不能泛化为所有 Electron 版本或所有连接类型 |

Chromium 对单一手动 HTTP 代理不可达时的行为有明确说明：连接失败；额外配置 `direct://` 才提供相应的直连后备路线。参见 [Chromium 代理文档](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md)。这也与本次代理端口关闭实验一致。

Electron 提醒切换代理时考虑旧连接池；但本次实际存活的 WSS 表明，修复时需要验证长连接确实被终止并重新建立，不能只调用清理函数就认为完成。参见 [Electron Session API](https://www.electronjs.org/docs/latest/api/session)。

## 代码定位

- [network-proxy.ts:105](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/network-proxy.ts:105)：未启用时使用 direct；已启用但 URL 验证失败也返回 direct。正常配置使用 fixed_servers。
- [network-proxy.ts:187](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/network-proxy.ts:187)：`setProxy` 异常只回调记录，没有向调用方传播失败。
- [session-policy.ts:214](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/session-policy.ts:214)：代理回放成功、失败都会让 ready 完成。
- [tab.ts:317](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/tab.ts:317)：加载页面会等待 ready，但上述错误处理使 ready 不等于“代理成功应用”。
- [layout.ts:233](/Users/yitiansong/data/code/start-electron/apps/desktop-react/electron/browser/layout.ts:233)：隐藏视图使用 setVisible，不会销毁页面或停止网络。

在应用与包源码中未找到管理这些网络行为的 `powerMonitor` suspend/resume 处理，也未找到切换代理时调用 `closeAllConnections` 的实现。现有清理 dispatcher 缓存的逻辑针对 Node 网络客户端，不等于关闭内置 Chromium 网页的连接。Electron 提供相应电源事件，但项目当前未用它们建立休眠/唤醒网络保护流程，参见 [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)。

## 与今天上午事件的关系

已有电源日志记录：

| 时间 | 事件 |
|---|---|
| 08:03:20 | 合盖休眠，电池供电，记录 `TCPKeepAlive=active` |
| 08:11:13–08:11:58 | 一次约 45 秒的 DarkWake，之后回到维护休眠 |
| 08:21:36–08:22:21 | 又一次约 45 秒的 DarkWake，之后回到维护休眠 |
| 08:25:51 | Claude 缓存的 account/standing 响应中记录的服务端封禁时间 |
| 09:13:11 | FullWake |

`TCPKeepAlive=active` 是电源日志中的状态，不能证明 Claude 的某条连接获得保活，更不能证明浏览器发了新的登录请求。DarkWake 也不能直接等同于 onething 页面脚本在运行。

本机 onething 日志没有覆盖该上午窗口；Clash 连接日志已轮转，缺少当时数据。对该时段 Electron 和 mihomo 的系统日志查询也没有取得可归属的事件。**日志缺失不是“没有联网”的证据，也不是“发生直连”的证据。**

账户缓存只能确认封禁状态与时间，没有公开具体触发依据。综合当前材料，无法在“此前请求导致的延迟处理”“当时某个设备或连接触发”“代理链路问题”等可能性间作出可靠归因。之前的缓存证据和时间线见 [Claude 账号封禁调查](/Users/yitiansong/data/code/start-electron/docs/audit/claude-account-ban-2026-09-16.md)。

## 修复方向与后续取证

1. 对“已开启但配置无效”和“配置应用失败”提供明确失败状态，阻断受影响分区继续请求，避免界面成功而实际沿用旧路由。
2. 切换直连/代理时处理已有连接，尤其是 WebSocket；需要验证关闭旧页面或重建受控浏览上下文等方案对表单、会话和未完成请求的影响。
3. 为唤醒恢复设计显式状态：代理待就绪、恢复中、失败。是否在休眠前断开网页连接，需要同时考虑网页任务中断和用户输入保留。
4. 记录最小必要的代理策略版本、分区应用结果、休眠/唤醒时间、连接失败类型及受控网络诊断。代理解析结果只能说明选择的本地代理，不能单独证明最终公网出口；要关联代理端路由日志。不要记录 Cookie、令牌或请求正文。

这些是后续修复方向；本次只检查与复现，没有修改生产代理行为，也没有操作 Claude 账号。

## 实验范围与可复查材料

- 运行环境：macOS arm64，仓库安装的 Electron **41.1.1**、Chromium **146.0.7680.166**。
- 使用实际 `ShellProxyPolicy` 与原始 URL validator 的临时 bundle。为避免导入无关模块，仅收窄了 validator 的入口；没有替换验证逻辑。
- 实验脚本：[probe-proxy-background.cjs](/Users/yitiansong/data/code/start-electron/apps/desktop-react/scripts/probe-proxy-background.cjs)。运行参数为策略 bundle、临时证书、临时密钥，另加独立 `--user-data-dir`；本次临时输入位于 `/tmp/onething-proxy-audit/`，清理后需重新准备。
- 使用独立 Electron 进程与独立浏览器会话。测试域名 `proxy-probe.invalid` 映射到本地回环地址，HTTP、HTTPS、WS、WSS 的目标和代理均在本机；没有访问 Claude，没有复用用户登录信息，也没有改变系统代理。
- 在本地目标服务器观察请求实际来源，区分代理转发、CONNECT 隧道和直连；不只依赖 `resolveProxy` 显示值。
- 完成最终一轮实验并正常退出，脚本语法检查通过。该脚本是观测工具，输出逐场景结果，不是带断言的自动化回归测试。
- 没有进行真实电源休眠实验，也未检测所有网络协议、WebRTC/UDP、DNS、系统网络扩展或远端代理出口策略。因此报告的协议实验结论限于上述 HTTP/HTTPS/WS/WSS 与固定 HTTP 代理组合。
