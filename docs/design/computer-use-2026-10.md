# 电脑操控:让 onething 用上 Codex 装在本机的那台 Computer Use MCP(2026-10)

状态:调研与本机实测完成(10-08),§8 的拍点用户 10-08 按推荐拍定(权限卡,始终允许由 onething 记);**P1 + P2 已施工**
(见 §5 的施工记录),P3 待派。v1 稿里「自己写 Swift 助手」的 `computer:` 方案作废,原因见 §2:OpenAI 已经把一台能后台
操控 macOS 的 MCP server 装在用户机器上了,缺的只是让它认我们。

## 0. 一句话

Codex App 的「电脑操控」= 一台闭源 MCP server(`SkyComputerUseClient mcp`)+ 一个常驻服务进程(`SkyComputerUseService`,
持有 Screen Recording / Accessibility 权限)。服务只认**祖先进程里有 OpenAI 签名(Team `2DC432GLL2`)**的来访者;
用 ChatGPT.app 自带的签名 `codex` 二进制做跳板(`codex sandbox -c sandbox_mode="danger-full-access" -- <client> mcp`)
就能让 onething 的 MCP 客户端连上它、调它的 10 只工具。逐 app 审批经 MCP `elicitation/create` 来问,onething 今天不答
elicitation,所以**施工只有一件事:MCP 客户端学会答 elicitation,并把它画成 onething 自己的权限卡**;服务器条目本身是一条配置。

## 1. 调研:Codex 的 computer use 是三件东西

- **Codex App 的 Computer Use**(04-16 macOS,05-29 Windows 前台):插件形态 = 本地 MCP server + skill,系统权限两项,
  逐 app 审批「始终允许」。官方 MCP 闭源;CLI 不带。
- **API 的 `computer` 工具**(Responses):GA 形状 `tools:[{type:'computer'}]` + `computer_call.actions[]`,官方今天推荐
  「代码执行」而不是它,并明说经函数工具 / MCP 暴露 UI 操作的继续用自己的。对我们无用(我们的 codex 线走 ChatGPT 后端)。
- **第三方桥**(都是为了让别的宿主用上第一件):见 §7。

## 2. 本机实测(10-08,ChatGPT.app 26.930.61225,Computer Use 26.929.1001365)

```
ChatGPT.app(com.openai.codex)
 └─ SkyComputerUseService          ~/.codex/computer-use/Codex Computer Use.app(LSUIElement,常驻;持 TCC 权限)
      ▲ unix socket ~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock(+ XPC)
      │  认证:xpc audit token → 发送者的父进程 / 责任进程的签名 id 与 Team ID;
      │  失败码 -10000「Sender process is not authenticated」,原因枚举 MISSING_PARENT / UNTRUSTED_PARENT /
      │  RELAY_WITHOUT_TRUSTED_ANCESTOR(= 直接父进程不可信时还会往上找可信祖先)
 任意宿主 ─stdio NDJSON MCP(2025-06-18)─▶ SkyComputerUseClient mcp(…/SharedSupport/SkyComputerUseClient.app/…)
```

实测结论(探针在 scratchpad,全部只读或一次性会话内许可,没动用户的「始终允许」名单):

| 事实 | 结果 |
| --- | --- |
| 直接拉起 `SkyComputerUseClient mcp` | `initialize` / `tools/list` 都通,`tools/call` 一律 -10000 |
| 经 `codex sandbox -c sandbox_permissions=[...]`(默认 seatbelt) | 客户端被沙箱杀(mach-lookup launchservicesd 被拒),exit 134 |
| 经 **`codex sandbox -c sandbox_mode="danger-full-access" -- <client> mcp`** | **`list_apps` 真答了**(当前运行与 14 天内用过的 app 列表) |
| `get_app_state(app:"Calculator")` | 客户端先发 `elicitation/create`:`message:"Allow ChatGPT to use Calculator?"`,`requestedSchema:{type:object,properties:{}}`,`_meta.persist:["always"]`;不声明 elicitation 能力它照发;答 `decline` → 工具结果 `isError`「approval denied via MCP elicitation」;答 `{action:'accept', content:{}}` → **回 AX 树文本 + 截图图片部件**,计算器在后台拉起 |
| 工具表(10 只,`app` 参数认显示名 / 路径 / bundle id) | `list_apps`、`get_app_state`、`click`(index 或坐标)、`perform_secondary_action`、`set_value`、`select_text`、`scroll`、`drag`、`press_key`(xdotool 键名)、`type_text` |
| 签名跳板 | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`(Identifier `codex`,Team `2DC432GLL2`);Homebrew 的 `codex` **没签名**,不能当跳板 |
| `cwd` | 配方里 `cwd = ~/.codex/computer-use`(Codex 自己的 config 也这么写) |

Codex App 当前版本自己走的是另一条路(`unified-computer-use` 插件的 `cua_repl`:node + `@oai/sky`,模型写 JS),
`[mcp_servers.computer-use]` 那条直连 MCP 的配置还在、标 `enabled = false`,两条路后面都是同一台服务。我们接 MCP 那条:
工具是结构化的,正好落进 onething 的工具管线与权限卡;`cua_repl` 那条等于给模型一只 JS REPL,授权粒度退化。

## 3. 方案:三件东西,`packages/backend` 只动 `mcp/`

### 3.1 服务器条目(配置,不是代码)

onething 的 MCP 设置里加一台 stdio 服务器:

```json
{
  "id": "codex-computer-use",
  "name": "Codex 电脑操控",
  "transport": "stdio",
  "command": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "args": ["sandbox", "-c", "sandbox_mode=\"danger-full-access\"", "--",
           "/Users/<me>/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient", "mcp"],
  "cwd": "/Users/<me>/.codex/computer-use",
  "env": { "CODEX_HOME": "/Users/<me>/.codex" },
  "enabled": true
}
```

后续(P3)在设置 → MCP 里加一行「检测到 Codex 电脑操控,一键添加」:探测两条路径存在就填上面这条;探测逻辑是数据
(两条路径 + 一条配方),不进 core。

### 3.2 MCP 客户端答 elicitation → onething 权限卡(施工的主体)

今天 `ONETHING_MCP_CLIENT_CAPABILITIES` 没有 `elicitation`,也没注册 `elicitation/create` 的处理函数,SDK 会答
method-not-found,客户端当作拒绝。要做的:

1. **能力声明**:`elicitation: { form: {} }`(SDK v2 `getSupportedElicitationModes`;只做 form,URL 模式答 decline)。
2. **处理函数**:`OnethingMCPClient` 构造时 `setRequestHandler('elicitation/create', …)`(SDK v2 的 `Client.setRequestHandler`)。
   处理函数不认识任何一台服务器,只认 MCP 的 elicitation 形状。
3. **它问的是哪个会话**:工具调用链今天是 `toolkit 工具.apply(ctx)` → `host.callTool(serverId, tool, args)` →
   `MCPManager.callTool` → 内核 runtime `callTool`(**按服务器串行**,`toolCallQueue`),一路没有会话坐标。改法:
   `callTool` 多一个可选 `caller: { sessionId, messageId?, callId?, principal }`,bridge 从 `ctx.invocation` 填;runtime 在
   `callToolNow` 期间把它记成「当前在飞的调用」(串行保证最多一个),elicitation 处理函数读它。没有在飞调用(服务器自发)=
   decline 并记一行日志。
4. **画成权限卡**:`Permission.ask({ type:'mcp-elicitation', title: <服务器给的 message>, pattern: '<serverId>:<app>',
   sessionId, messageId, callId, metadata:{ serverId, message, requestedSchema }, choices:[once, always] })`。
   `requestedSchema` 为空对象 = 只要同意 / 拒绝;非空(将来别的服务器)= 走 `Interaction.ask` 按 schema 出表单,
   这一期只做空 schema,非空答 decline(结构化地在日志与工具结果里说明)。
5. **「始终允许」由 onething 自己记**:不猜客户端 `_meta.persist` 的回包形状(文档没有),而是落一条 onething 的 grant
   (pattern = `codex-computer-use:com.apple.calculator` 这类,从 message 或工具参数里拿 bundle id —— 先用工具调用的
   `app` 参数,它就是模型传的那个名字),下次同一台服务器再问同一个 app 就直接 accept。撤销走现有 permissions 页。
   Codex 自己的「始终允许」名单不碰。
6. **无人值守**(CLI 档 `system` 主体、网关):沿用权限核的无人值守规则(60 秒自动拒)。

### 3.3 提示词与寿命

- **技能**:`resources/skills/codex-computer-use/SKILL.md`,把 OpenAI 自己那份 SKILL.md 的「先 `get_app_state` 再动、
  优先 element_index、动完再看、不要靠 list_apps 找名字、`type_text` 里的换行会提交表单」与「确认策略」(删除 / 发送 /
  付款 / 传敏感数据前问人)改写成 MCP 工具名;模型面只在这台服务器连着时才看到它(技能按服务器在场挂,已有机制)。
- **寿命**:服务把「有客户端连着」当作「正在占着这些 app」(Esc 取消只作用于当前 turn;客户端一直活着 turn 永不结束)。
  onething 的 MCP 连接是常驻的,所以 P2 里给这台服务器加**空闲 60 秒断开、下次调用再连**(songkeys 桥的做法);做成
  服务器条目上的一格 `idleDisconnectMs`,不点名这台。

## 4. 陌生能力演练

拿「再接一台会发 elicitation 的 MCP server」列要改的文件:零 —— 处理函数只认协议形状。拿「换一台桌面操控引擎」
(例如 amontlabs/lcu):改设置里的服务器条目一条,代码零改动。过。

## 5. 分期

| 期 | 做什么 | 验收 |
| --- | --- | --- |
| **P1 答 elicitation** | §3.2 的 1–6;`mcp/__tests__` 用假服务器:发 `elicitation/create` → 权限卡出 → 答 once / always / 拒 三条路;「始终」后第二次不出卡;无在飞调用时 decline | 单测 + `client-api:gate` 等结构门 |
| **P2 配方与寿命** | 服务器条目文档化;`idleDisconnectMs`;`gate:codex-computer-use`:真 `dist/server` + 真跳板,`tools/list` 10 只、`list_apps` 真答;ChatGPT.app 或 Computer Use 不在就 skipped,绝不碰「始终允许」 | 真机门 |
| **P3 一键添加 + 技能** | 设置页「检测到 Codex 电脑操控」一键添加;SKILL.md;工具卡显截图 | 壳门 |

**施工记录(10-08)**

- P1 落地与 §3.2 的差别只有两处:①「始终允许」不另造 choices,直接用卡上现成的「本会话 / 本工作目录」两键(落的就是
  session / workspace 两种 grant,pattern = `<serverId>:<那句话>`),`alwaysScope` 那第四键**不给** —— 它按 `<scheme>:*`
  记,会把同一台服务器往后问的每一句话都许掉;②会话坐标不走 AsyncLocalStorage,显式顺着
  `McpTool.apply → bridge.execute → executeMCPTool → CoreMCPBridgeRuntime → executeMCPBridgeTool → host.callTool →
  HeadlessMCPManager → MCPClient → CoreMCPClientRuntime` 递一格可选的 `caller`,没有坐标时各层仍按原来的参数个数调
  (旧测试替身一条不改)。效果表加一行 `mcp_consent`(ask、可记、非屏障),壳的效果标签表与 zh / en 各一行。
- 测试:`mcp/__tests__/mcp-elicitation.test.ts`(翻译:接受 / 拒绝 / grant 命中不出卡 / 无在飞调用 / URL 模式 / 带字段表单
  / 畸形参数)、`mcp/kernel/__tests__/mcp-kernel-client-runtime.test.ts`(在飞调用的挂与清)、
  `mcp/__tests__/mcp-client-elicitation.test.ts`(真 SDK 服务器经 `InMemoryTransport` 在工具里 `elicitInput`,端到端)。
- P2 的门 `scripts/gate-codex-computer-use.mjs`(`bun run gate:codex-computer-use [--build]`),断言与 §5 表一致。
  `idleDisconnectMs` **没做**:实测这台客户端连着不妨碍 Codex App 自己再开一只,先观察,留账。
- **P3 的「默认填好」已做(10-09,用户令「mcp 应用默认填好」)**,比原计划的「设置页一键添加」更省一步:
  `mcp/mcp-known-servers.ts` 是一张已知本机服务器表(今天一行 = §3.1 的配方,`detect()` 只看两条路径在不在),
  `McpSubsystem.start()` 起 manager 之前经 `prepareSettings` 跑一遍 `seedKnownMCPServers`:检测得到、设置里没有、用户
  没删过的填进 `servers` 并落盘;用户在设置里删掉一台已知服务器,id 记进 `mcp.dismissedKnownServers`,以后不再填回来
  (只是关掉不算删)。门 ⓪ 从空设置起、断言它被填进来且与配方逐字相等。P3 剩下:SKILL.md、工具卡显截图。
- **设置页「连接器」(10-09,用户令「设置也增加 mcp(连接器)配置」)**:React 壳从前没有 MCP 页。新页
  `content/settings/ConnectorsSettings.tsx`(`form` 落点,紧跟 Agent 页):一列行(状态点 + 名字 + 摘要 + 开关 +
  编辑 / 删除)、添加 / 编辑共用一张表单对话框(名称、接法 stdio / http / sse、整行命令、工作目录、环境变量、地址)。
  数据层 `data/mcp-connectors-{port,source}.ts` 走 `mcp` 域的七条方法(不碰整份设置);出进程被脱敏的私密格
  (哨兵 `MCP_SERVER_REDACTED_SECRET` 从此住在契约 `@shared/mcp/types`)编辑时留空 = 原样交回。
  三张状态表写在组件文件头;测试 5 + 8 条。

## 6. 坑与风险(都来自实测或第三方桥的 issue)

- **10-09 真事故,已修**:用户用 Claude(1M 窗口)跑电脑操控,第四张截图之后 Claude 答 400
  `prompt is too long: 1102516 tokens`。两条病根:① toolkit 的 `McpTool.apply` 把整个 MCP 结果 `JSON.stringify`
  进文本部件,`get_app_state` 那张 200KB 的 JPEG 以 **base64 文本**进请求,一次 ≈ 18 万 token;② 压缩的估算器
  对 ≥4000 字符的 base64 串按「省略」算成几十个字符,四张图 70 万真 token 一个没数到,压缩从未触发。修法:
  `mcpResultToToolResult` 按部件翻译(文本 = 内核的可读渲染,图 = `type:'image'` 部件,`details` 里的 base64 换占位),
  估算器把部件里的图按一张 1600 token 的常数算、混在文本里的 base64 按 2.5 字符一个 token 折
  (`agent-loop-context-usage.ts`)。那条撑爆的会话历史里仍躺着四段 200KB 的文本,下一次发送会按新估算触发压缩;
  压不动就另开会话。

- **非官方**:路径、认证规则、协议都可能随 ChatGPT.app 更新变;门里探测不到就 skipped,设置页答「没装」。
- **跳板必须是 ChatGPT.app 自带的 codex**;Homebrew 版没签名(openai/codex#19544 同因)。
- **沙箱档必须关**(`danger-full-access`);默认 seatbelt 杀客户端。songkeys 桥用 `--sandbox-state-json` 传
  `permissionProfile.type="disabled"`,效果相同。
- **更新后残留**:ChatGPT.app 升级后旧客户端进程不退会让传输坏掉(#28479 一族);断开重连要能杀掉自己拉起的那棵树。
- **`CODEX_HOME` 要传**(#28479);路径里带 `@` 会坏(#18555)。
- **占用**:客户端活着 = 占着 app;空闲断开(§3.3)。
- **截图进上下文**:每次 `get_app_state` 都带整张截图;agent-hands 实测一次约 5.5k token。模型面提示优先读 AX 文本。
- **AX 文本是别的 app 写的**:一律 `wrapUntrustedText`(MCP 结果进工具管线那一处已经包)。

## 7. 现成方案对照(10-08 搜到的)

| 项目 | 路子 | 审批 | 适合我们吗 |
| --- | --- | --- | --- |
| [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) | `codex sandbox` 跳板 + 透传 MCP,npm 可当 stdio server | **自动全部同意** | 配方就是它的,直接 `npx` 接也能跑,但等于取消逐 app 审批 |
| [bcharleson/codex-cu-mcp](https://github.com/bcharleson/codex-cu-mcp) | 走 `cua_repl`(JS REPL)+ 代理 | 客户端会 elicitation 就逐 app 问一次,否则 `CODEX_CU_AUTO_APPROVE` | JS REPL 面,授权粒度差 |
| [FranciscoJSBarragan/codex-cu-mcp](https://github.com/FranciscoJSBarragan/codex-cu-mcp) | 同上,加 Chrome | 要 elicitation | 同上 |
| [manaflow-ai/codex-cua](https://github.com/manaflow-ai/codex-cua) | 起 `codex app-server`,开线程发 `mcpServer/tool/call` | app-server 的审批 | 多一层 Codex 线程,重 |
| [amontlabs/lcu](https://github.com/amontlabs/lcu) | 自带安装器 + 各宿主适配 + Claude 侧审批面板 | 逐 app,有「始终允许」管理 | 做得最全,但它是另一套产品面 |
| [zm2231/agent-hands](https://github.com/zm2231/agent-hands) | app-server 路 + 压缩 AX 树省 token | 自动 | 省 token 的做法值得抄(`find` 过滤、不带截图) |
| [tmustier/codex-computer-use-mcp](https://github.com/tmustier/codex-computer-use-mcp) | app-server 路,Pi 适配 | 自动 | — |
| [mxdhavgautam/codex-hands](https://github.com/mxdhavgautam/codex-hands) | 同上,加 Windows | 自动 | Windows 线索 |

结论:**配方借 songkeys 的,审批自己做**。onething 已有 MCP 客户端与权限卡,再夹一层桥只会把审批变成「全同意」。

## 8. 拍点(一条)

逐 app 审批画成 onething 权限卡、「始终允许」由 onething 记(推荐);另一档是像 songkeys 那样全自动同意、零施工。

## 9. 留作后续

v1 稿里 `browser:` 补 click / type / key / scroll / drag 做法、以及「资源读法的结果交图片部件」那一刀,与本稿无关,仍然成立,
另开单。

## 来源

- OpenAI:[Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/)、
  [Codex App Computer Use](https://developers.openai.com/codex/app/computer-use)、[changelog](https://developers.openai.com/codex/changelog)、
  [API Computer use](https://platform.openai.com/docs/guides/tools-computer-use)。
- 本机:`~/.codex/config.toml`(`[mcp_servers.computer-use]`、`[mcp_servers.node_repl]`)、
  `~/.codex/plugins/cache/openai-bundled/{computer-use,unified-computer-use}`、`/Applications/ChatGPT.app/Contents/Resources/plugins/.../computer-use/skills/computer-use/SKILL.md`。
- 第三方:§7 的仓库,以及 openai/codex 的 issue #19544 / #21200 / #28479 / #18555 / #36696。
