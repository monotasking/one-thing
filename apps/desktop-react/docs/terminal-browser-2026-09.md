# 终端与浏览器接进 React 壳(2026-09-11 方案,v2)

> 用户一句话:「浏览器和 terminal 对接一下吧」;追加三条硬要求(09-11):**浏览器要真正可用
> (能登谷歌账号、能用电脑的 PIN / 通行密钥)、能被 chrome-mcp 当内置浏览器控制、AI 要能操控它**。
> v1 拍的 `<webview>` 方案被第二条推翻(§2.2-1),本版是改过的形;**内核钉官方 Electron,不回 castlabs**(用户 09-11)。拍定后逐单派工
> (Fable 拆分审查 / opus 执行 / haiku 提交),每单交卷带三张状态表与真机门。

## 0. 一句话

**终端是「后端全在、只差最后一公里」;浏览器是「主进程真源 + 壳做壳、CDP 口开给 chrome-mcp、
AI 走资源管线」。** 两条线共用同一副骨架:一种内容 = `content/kinds/<x>.tsx` 自述一次;一块瓦 =
`stage/items.ts` 一行 + 启动瓦一份;AI 能操作 = 一份资源自述(`browser:` 在主进程 in-process 挂,
`terminal` 沿用已有 RPC 域)。**core 与拼贴树一个字不改**。

## 1. 摸底(2026-09-11,两路代理各自独立核过 + 三条硬要求逐条查实)

### 1.1 终端

| 层 | 现状 | 位置 |
| --- | --- | --- |
| PTY | node-pty 懒加载 spawn,**唯一** spawn 点 | `runtime/src/terminal/pty-backend.ts:50` |
| 服务 | `TerminalService`:create/list/write/resize/kill/attach/ack、16ms 合批、seq、ring 回放、高低水位流控、ack 代次、ack 停滞自动 detach、SIGHUP→SIGKILL | `runtime/src/terminal/service.wiring.ts:90` |
| 宿主口 | `TerminalBroadcaster { sendData, sendExit }`;`configureTerminalBroadcaster` / `hasTerminalHost()`;未注入永不构造服务 | 同文件 `:34 / :359 / :367` |
| RPC 域 | 七条,每条开头 `if (!hasTerminalHost()) return 结构化拒绝` | `backend/rpc/domains/terminal.ts:54` |
| 能力位 | `/api/capabilities.terminal = hasTerminalHost()` | `backend/server/runtime.ts:628` |
| 推送 | **没有通道**:`terminal:data` / `terminal:exit` 只是两个常量,不是全局事件,SSE 不转发 | `shared/ipc/channels.ts:214` |
| React 壳宿主表 | **`terminal: null`** | `apps/desktop-react/electron/host-ports.ts:142` |
| React 壳渲染 | 16 行硬编码 `<pre>`;零 xterm 依赖 | `src/content/TerminalMock.tsx` |

一句话:`hasTerminalHost()` 在生产恒 false,七条恒拒,壳里是假面板。

### 1.2 浏览器

| 层 | 现状 | 位置 |
| --- | --- | --- |
| 契约 | 19 动词 `browserRouter` + 类型 + omnibox 纯函数;**无人 import** | `shared/ipc/browser.ts` |
| 推送 | `BROWSER_TABS_CHANGED` 常量,无人订阅 | `shared/ipc/channels.ts:222` |
| 实现 | backend / runtime / core / 主进程 **零**文件;`webviewTag` 没开 | — |
| React 壳渲染 | 14 行假面板 | `src/content/BrowserMock.tsx` |
| AI 侧 | `web_open` / `web_search` 走 `fetch` + 字符串抽正文,无浏览器内核;没有「操作内置浏览器」的工具 | `runtime/src/tools/builtin/web-search/page-fetch.ts` |
| Vue 时代 | 每 tab 一个 `WebContentsView`、主进程 `BrowserService` 真源、`persist:browser-<id>` 多 profile、元素拾取 → 附件;`50ff9cbd` 整体删除,**git 里能整份挖回来**(`50ff9cbd^:apps/electron/src/browser/{service,tab-state,session,profiles,pick-script,search-engine}.ts`) | `docs/design/browser-v2.md` |

### 1.3 三条硬要求逐条查实(09-11)

**① 登谷歌。** 仓里有一份**用户 07-26 亲测通过**的配方(`docs/design/browser-v2/castlabs-migration.md`
+ 记忆 `project_embedded_google_login_2026_07`),四件:castlabs Electron(`v41.1.1+wvcus`)、
`--disable-features=FedCm`、`components.whenReady()`、**UA 只删 ` Electron/x` 一个 token**(洗得太干净
反而被判假)。同一份文档写明「官方 Electron 上同样配方登不了」。**内核钉官方 Electron,不回 castlabs
(用户 09-11 裁定)**,所以这一条在方案里是一个**有阶梯、有出口的实验**,不是一句承诺:
- 07-26「官方登不了」那次实验发生在「UA 洗过头」这条根因被发现**之前**,官方核 + 修正后的配方**没有
  被验过**;网上大量 Electron 壳(Ferdium 一族)靠「Chrome UA + 持久分区」在官方核上登谷歌至今可用。
- castlabs 与官方的差只有 Widevine CDM 一件(其余同一份 Chromium)。若官方核最终登不了,差的就是
  EME 存在性,而 CDM 是 Google 授权的二进制,官方核**造不出来也不该造**。
- 差分法现成:Flow Browser 在本机(`~/data/code/flow-browser`,castlabs 底座,能登),07-26 用
  `fp.html` 两边 dump 指纹逐格比对的方法直接复用。

**② 电脑的 PIN / 通行密钥(WebAuthn)。** Windows Hello 是 Chromium 原生路,官方 Electron 直接可用,
零改动。macOS Touch ID 平台认证器是 **Electron `app.configureWebAuthn({ touchID: { keychainAccessGroup } })`**
(PR #51255,2026-04 合入 main,**回港 41-x-y**;41.5.0 起的 d.ts 里有,**41.1.1 没有**)+ 多凭据时的
`select-webauthn-account` 事件(不监听 = 永不自动选、直接 `NotAllowedError`,所以要一张选账号的小面)。
**硬条件**:`keychainAccessGroup` 必须同时写进 app 的 `keychain-access-groups` 签名 entitlement
(`<TEAM_ID>.<bundle>` 形),即**要 Developer ID 真签名**;`sign:dev:mac` 是 ad-hoc,dev 构建上
Touch ID 不会亮(密码 / 手机扫码兜底照常)。今天 `electron-builder.yml` 没有 entitlements 段。
跨设备(二维码)通行密钥要 Chromium 的 Views UI,Electron 没有 —— 不承诺。

**③ chrome-mcp 控制。** `chrome-devtools-mcp`(本机装的是 1.9.0)靠 `--browserUrl http://127.0.0.1:<port>`
连一个开了 `--remote-debugging-port` 的 Chromium;它列页面用的是 puppeteer `browser.pages()`,**只认
CDP `type: 'page'` 的目标**。`<webview>` 的 guest 是 `type: 'webview'`(puppeteer #6473),**列不出来**;
`WebContentsView` 是顶层 page,**列得出来**。这一条直接否掉 v1 的 `<webview>`。Electron 在 CDP 上有
过一次踩坑史(chrome-devtools-mcp 0.20.1 调 `Target.getDevToolsTarget` 把所有 Electron 宿主炸红,
#1197,已修),`holepunchto/electron-devtools-mcp` 是专为 Electron 修过的同源分叉,留作备胎。
CDP 口一开,**壳自己的渲染页也是一个 page 目标**(chrome-mcp 能看见 onething 的 UI),这是 Chromium
的形,不挡。

### 1.4 壳这一侧已经有的路(两条线都骑它)

- **内容种类自述**:`workbench/kinds.ts` `registerContentKind` —— `id / singleton / level / title / icon /
  render / focusInto / fullable / companion`;加一种 = 自己的模块 + `content/kinds/index.ts` 一行。
- **启动瓦**:`stage/launchers.ts` `registerStageLauncher` —— `open() / dragRef() / residentKind`;`files`
  瓦是样板。
- **隐藏不卸载**:切 tab 只翻 `.layerHidden`(`content-visibility: hidden` + `inert`);原位换 ref 会卸载,
  能力可把自己写进 `workbench/kept-contents.ts`「组件级停靠」表免掉。
- **资源内核**:`wiring/resource/index.ts` `mountBuiltinResources` 是内置资源唯一注册点;宿主自己的
  资源(MCP 那样)经 `backend.resources` 的 mount 口挂,in-process,`home: 'core'`;每个在场的 scheme
  自动得一个 AI 工具、`resources.read/do` 两条 RPC、事件走 `resource:event` → SSE。
- **音乐面板**(ca67f35a)= 「状态真源不在渲染进程」那一类面板的样板:`data/<x>-port.ts` 三口端口
  (`read / do / onResourceEvent`)+ `data/<x>-source.ts` query/mutation + 面板 + 焦点域 + i18n + 真机门;
  **每颗按钮走 `resources.do`,与 AI 同一条路**。浏览器正是这一类(真源在主进程)。

## 2. 拍定的形(每条一句为什么)

### 2.1 终端:输出走 SSE 全局事件,壳是 xterm(与 v1 相同)

1. **推送 = 两条全局事件** `terminal:data` / `terminal:exit`(`@shared/events/global-events.ts` 新增,
   `GLOBAL_EVENT_LEAVES_PROCESS` 置 true)。不是新通道:React 壳只有一个 IPC,`transport:gate` 钉着;
   全局事件本来就走 `GET /api/events`;回放终端服务自己有(attach 带 ring + seq + 代次)。
2. **广播器住装配层** `packages/backend/wiring/terminal/bus-broadcaster.ts`
   `createEventBusTerminalBroadcaster()`:惰性取 `getEventBus()` 发全局事件。哪台宿主要它是宿主表的事:
   React 壳 `host-ports.ts` 那一行从 `null` 改成它;server / CLI 本批照旧 `null`。
3. **收尾归 own()**:注入广播器那一步返回的 restore 先 `killAllTerminals()` 再
   `configureTerminalBroadcaster(null)`,`backend.dispose()` 一次收干净。
4. **壳侧一格实例一个类** `content/terminal/session.ts` `TerminalSession`(xterm `Terminal`、attach 回放、
   ack 流控、fit、`exited` 态);xterm 实例活在模块级注册表 `content/terminal/registry.ts`,组件挂载只
   `appendChild`,卸载不销毁(旧壳 D6 判例,拖到别的叶不丢屏)。
5. **内容种类 `terminal`**:`key` = 终端 id,`singleton: true`,`level: 'space'`(终端开在项目目录,目录属于
   工作区),`title` 活标题(OSC 标题 → cwd 末段 → shell 名),`icon: 'Terminal'`,`focusInto: 'terminal'`,
   `fullable: true`。重启后账上残留的 id 已死:渲染「已结束」态 + 「在同一目录再开一个」(cwd 由
   `terminal-memory` 本地小账本记,封顶 32 条)。
6. **Dock 瓦 `terminal` 降格成启动瓦**(照 `files`):点 = 在当前会话工作目录开一个,落 `edge:bottom`;右键 =
   活着的终端 + 「新建终端」+ 「在目录…新建」;拖 = 拖出焦点终端;`ctrl+\`` 召唤(三平台空闲,desktop-os §8.2)。
7. **键盘礼让**(desktop-os §8.1):`attachCustomKeyEventHandler` —— mac 上 ⌘ 一族放给应用,Ctrl 进 PTY;
   Win / Linux 上 Ctrl+Shift+X 放给应用,单 Ctrl+X 进 PTY,例外表三条(Ctrl+Tab 族 / Ctrl+\` / Ctrl+,)。
   表在 `content/terminal/key-courtesy.ts`。
8. **主题**从 CSS token 现算,主题切换时重算;**关闭 = 杀**,不弹确认;**用户按键不过管线**(`write` 直调
   RPC 域);AI 操作终端见 §5 T3。

### 2.2 浏览器:主进程 `WebContentsView` 真源,壳做壳,CDP 开口,AI 走资源管线

1. **内核形态 = 主进程 `WebContentsView`,每 tab 一个**(v1 拍 `<webview>`,被 §1.3-③ 推翻:chrome-mcp
   列不出 webview)。代价回来了:①渲染进程要把「这片叶此刻的矩形与显隐」告诉主进程 —— 加**一条** IPC
   `host:native-view`(rAF 合批的 `{ viewId, bounds, visible }`),`transport:gate` 的 `ipcMain` 钉数
   **1 → 2**,理由与 `host:connection` 同族:窗口系统的管道,不是数据面,基线文件那一行写明;②**遮挡**:
   原生视图永远压在 DOM 之上,浮窗 / 右键菜单 / 命令面板 / 弹层盖到浏览器那片时会被它盖回去 ——
   治法「遮挡 = 快照」:壳判到有东西盖上来(浮窗矩形相交、弹层计数 > 0、拖拽中)就让主进程
   `setVisible(false)` 并在占位格里画上一张 `capturePage` 快照,盖的东西走了再换回真视图(B0 量闪烁);
   ③拼贴树里切 tab / 拖到别的叶 / 撕成浮窗都只是换矩形,**不重载**(这是相对 webview 赚回来的)。
   `--mode web` 没有主进程:种类渲染「此宿主没有内嵌浏览器」,`browser:` 不 mount。
2. **主进程一个模块,类各管一件** `apps/desktop-react/electron/browser/`(旧壳的 service / tab-state /
   session / profiles / pick-script 从 git 挖回来做底):`BrowserService`(tab 表、生死、活动 tab)、
   `BrowserTab`(一格 = 一个 `WebContentsView` + 状态投影:url / title / favicon / loading / canGoBack /
   canGoForward / error)、`BrowserSessionPolicy`(分区 `persist:browser-<profile>`、UA 最小洗、权限缺省全拒、
   下载、`setWindowOpenHandler`:http(s) 新 tab、其余 deny)、`UserAgentPolicy`(只删 ` Electron/\S+`,
   app token 与完整构建号留着 —— 07-26 那条反直觉根因)、`NativeViewLayout`(收 `host:native-view` 帧,
   `setBounds` / `setVisible`,遮挡快照)。`--disable-features=FedCm` 在 app ready 前。
3. **`browser:` 是 in-process 资源,不是壳侧 mount**:主进程**就是** core 进程,`home: 'shell'` 的寿命 =
   连接是错的(浏览器与 app 同寿),经 SSE 绕自己一圈也是错的。`electron/browser/resource-provider.ts`
   实现 `ResourceProvider`,`main.ts` 装配后经 `backend.resources` 挂上(与 MCP 挂法同族),`own()` 摘。
   自述:读法 `tabs`(命名空间:id / url / title / active)、`page`(ref:标题 + url + 正文,P0 `innerText`
   封顶 20k 字)、`screenshot`(ref:PNG dataURL,给 AI 看);做法 `open {url}`(命名空间)/ `navigate {url}` /
   `back` / `forward` / `reload` / `activate` / `close`(ref);效果 `open / navigate / reload` = **拍点 ③ 定**(用户主体一律 `[]`,
   AI 主体缺省 `browser_navigate`),`activate / close` = `ui_change`;事件 `opened / closed / navigated / loading`。**`BrowserTab` 的状态变化
   经 provider `emit` → `resource:event` → SSE,壳按它更新**,壳里不存第二份真相。
4. **壳 = 壳**:`browser/` 目录只有 `data/browser-port.ts`(`read / do / onResourceEvent` 三口,照
   `music-port.ts`)、`data/browser-source.ts`(tab 状态 query + 七只 mutation,写就地更新)、
   `content/kinds/browser.tsx`(`key` = tab id,`singleton: true`,`level: 'app'`,活标题 = 页标题 → 主机名,
   `icon: 'Globe'`,`focusInto: 'browser'`,`fullable: true`)、`content/browser/BrowserLeaf.tsx`(地址栏 +
   四颗导航钮 + 加载条 + `NativeViewSlot` 占位格)、`content/browser/NativeViewSlot.tsx`(ResizeObserver +
   可见性 + 遮挡判据 → `host:native-view` 帧;**这一只与 `browser` 无关**,将来任何原生视图都用它)、
   `content/browser-launcher.tsx`(点 = 激活最近的 tab 或新开空白 tab;右键 = 开着的 tab + 新标签页;
   拖 = 活动 tab;`defaultPlacement: center`)。omnibox 规则从 `shared/ipc/browser.ts` 搬到壳,**其余
   孤儿契约与 `BROWSER_TABS_CHANGED` 删掉**。**用户的每一颗按钮走 `resources.do`**(音乐先例:真源不在
   壳里,壳与 AI 同一条路),AI 与用户落主进程同一张 ops 表。
5. **AI 操控 = 两层,各干各的**:
   - **应用层** = `browser:` 资源工具(§2.2-3):开 / 导航 / 读正文 / 截图 / 关,给模型「这台 app 的浏览器
     里有什么、去哪」;这一层任何宿主形态都在(server 没有它 —— 结构化「此宿主没有浏览器」)。
   - **页面层** = **chrome-devtools-mcp 挂在内置浏览器的 CDP 口上**:快照 / 点击 / 填表 / 按键 / 网络 /
     性能 26 个工具,一行代码不写。设置页「内置浏览器 › 允许 AI 与外部工具控制(CDP)」一格开关 +
     端口(缺省关;开 = 下次启动 `--remote-debugging-port=<port> --remote-debugging-address=127.0.0.1`,
     行上写明「重启生效、本机任何进程都能驱动这个浏览器」)+ 一键「给 AI 装上」= 往 MCP 设置里写一条
     `chrome-devtools`(`npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:<port>`),MCP
     工具照既有路投影进 AI 面 + 一键复制给 Claude Code / Cursor 的配置片段。`run/http.json` 加 `cdp`
     一格,别的客户端能发现。
6. **登谷歌与通行密钥**(§1.3-①②;**内核 = 官方 Electron 41.10.7,不回 castlabs**):
   - **B0-① 登录阶梯**(每一阶都是官方核上的一次真机登录,登上即止):
     ㈠ 完整配方(FedCm 关 + UA 只删 ` Electron/\S+` + 全新 `persist:` 分区);
     ㈡ 加 CDP `Network.setUserAgentOverride` 带完整 `userAgentMetadata`(brands 含 "Google Chrome"、
        `fullVersionList`、platform 与真值一致,`browser-auth-profiles.md` §3.1 那条)—— 让 `Sec-CH-UA-*`
        请求头与 `navigator.userAgentData` 都像真 Chrome;
     ㈢ 与本机 Flow 做 `fp.html` 指纹差分,逐格补齐**除 EME 以外**的差。
     **出口**:三阶都不过 → 交一页证据(差分表 + 哪一格是 EME),浏览器其余功能照常入库,谷歌登录这一格
     写「官方核上不可得」由用户另拍;方案不预设「甩给系统浏览器」那条路(07 月已判为假浏览器)。
   - **macOS Touch ID**:`app.configureWebAuthn({ touchID: { keychainAccessGroup } })` + `electron-builder.yml`
     加 `keychain-access-groups` entitlement + Developer ID 签名(拍点 ①:今天没有签名流水线,这一格
     要不要本批建);`select-webauthn-account` 一张选账号小面(B3)。**dev ad-hoc 构建上 Touch ID 不亮**,
     密码 / 手机兜底照常;Windows Hello 零改动。
7. **安全钳**(主进程):视图 `webPreferences` = `sandbox: true` / `contextIsolation: true` / 无 preload /
   `partition: persist:browser-<profile>`;`will-navigate` 拦非 http(s) / `about:blank`;权限缺省全拒
   (B3 改询问);下载走 Electron 缺省(B3 接);CDP 口缺省关。

## 3. 生命周期(atom §10.2 / §10.3 在两个 scheme 上的填法)

### 3.1 `terminal`(home = core;寿命 = PTY)

| 状态 | 进入 | 离开 | 期间(壳) |
| --- | --- | --- | --- |
| 未创建 | — | `terminal.create` | 瓦上没有它 |
| 活着 | create 成功 | exit / kill / core 退出 | xterm 在写、ack 在回、`terminal:data` 在到 |
| detached | ack 停滞(服务侧自动) | 壳再 `attach` | 屏幕停在最后一帧,檐上「已断开,点击重连」 |
| exited | `terminal:exit` | 关标签 | 屏幕保留,输入禁用,「进程已退出 (code)」+「再开一个」 |
| 已死(账上残留) | 重启后 attach 失败 | 关标签 / 再开一个 | 「已结束」态,cwd 从本地小账本取 |

### 3.2 `browser`(home = core,主进程 in-process;寿命 = app)

| 状态 | 进入 | 离开 | 期间 |
| --- | --- | --- | --- |
| 未挂 | web 模式 / 装配前 | `main.ts` 装配后 mount | `do(browser:…)` → `ResourceSchemeUnknownError`,AI 面没有它 |
| 已挂 | mount | `backend.dispose()` | AI 工具 `browser` 在面;chrome-mcp 只在 CDP 口开着时能连 |
| tab 开着 | `open` / 启动瓦 | `close` / 关标签 | 视图在窗里;`opened` 已发;`navigated / loading` 随导航发 |
| tab 隐藏 / 停靠 / 被遮 | 切走 / 浮窗盖上 | 切回 / 盖的走了 | `setVisible(false)`,占位格画快照;不发事件(隐藏不算关闭)。**B0 实测:隐藏视图被 Chromium 节流到 1Hz**(`visibilityState=hidden`,与 Chrome 后台标签同义:倒计时 / 长轮询近乎冻住)——这是接受的形;被遮期间快照每秒重拍一次(`capturePage` 对隐藏视图照样拍得到且是活的)所以最多旧 1 秒 |
| 重启 | 账上有 `browser:<id>` | — | 视图随 app 死;P0 渲染「重新打开 <url>」态(url 记在本地小账本);B3 做会话恢复 |

## 4. 分期总览

| 单 | 内容 | 产物 | 门 |
| --- | --- | --- | --- |
| **T0** 后端最后一公里 | 两条全局事件 + `bus-broadcaster.ts` + React 壳宿主表注入 + own() 收尾;删两个死常量 | `capabilities.terminal = true`;七条 RPC 在壳上通 | 后端单测(广播器 → bus → SSE 帧);`gate:packaged` 不动 |
| **T1** 壳侧真终端 | `@xterm/xterm` + fit + web-links;`terminal-port`;`TerminalSession` / 注册表;kind `terminal`;启动瓦 + 右键 + `ctrl+\``;焦点域;键盘礼让;主题;i18n | 假面板退役 | 新 `gate:terminal`:Dock 开终端 → `printf` 标记上屏 → 刷新页面回放仍在 → kill → exited 态;`gate:a11y` 加一屏;`gate:focus` 不红 |
| **T2** 终端收尾 | 已结束 / 断开态;`terminal-memory`;组件级停靠;搜索 addon;多窗口 ack 代次 | — | `gate:terminal` 加条;`verify` 接门 |
| **B0** 三个 spike(各半天,不改产品) | ①升官方 41.10.7,按 §2.2-6 三阶登谷歌(每阶一次真机、fp 差分法);②`WebContentsView` 在拼贴树里:bounds 跟随延迟、浮窗遮挡快照切换的闪烁、chrome-devtools-mcp 1.9 `list_pages` 列得出 / `new_page` 在 Electron 上开出什么(能否被 `new WebContentsView({ webContents })` 收编成一格 tab);③CDP 口开着时 `gate:*` 系列(它们自己也走 CDP)有无端口打架 | 一页读数(①含差分表) | 只量不改 |
| **B1** 主进程 + 契约清账 | `electron/browser/` 五个类 + `resource-provider.ts` + 装配挂载 + `host:native-view` IPC + FedCm 开关 + 安全钳;`transport:gate` ipcMain 基线 1 → 2;删孤儿 `browserRouter` / `BROWSER_TABS_CHANGED`;omnibox 搬壳;**Electron 不升**(B0-⑥:41.1.1 官方核上 ②③ 全通,升 41.10.7 只为 Touch ID,随 B3 签名一起) | `resources.describe` 列出 `browser` | 主进程单测(UA 洗法 / 权限 / window-open / provider ops);`gate:native` 绿 |
| **B2** 壳侧真浏览器 | `browser-port` / `browser-source`;kind `browser`;`BrowserLeaf` + `NativeViewSlot`(遮挡快照);启动瓦;焦点域;web 模式降级 | 假面板退役;AI 自动得 `browser` 工具 | 新 `gate:browser`:门自起本地 http 页 → Dock 开 tab → 地址栏回车 → 活标题落 → `POST /api/rpc resources.do open` 开出第二格 → `read(page)` 拿到正文 → 浮窗拖到浏览器上方占位格换成快照、拖走换回;web 模式一条降级断言 |
| **B2′** CDP 与 chrome-mcp | 设置格(开关 / 端口 / 一键装 MCP / 复制片段);`run/http.json.cdp`;启动参数 | chrome-devtools-mcp 连得上、`list_pages` 列出 tab | `gate:browser` 加条:门用 puppeteer `connect({browserURL})` 列出 tab 并 `page.title()` 对上 |
| **B3** 浏览器收尾 | Touch ID(`configureWebAuthn` + entitlement + 签名 + 选账号面);@ 引入(元素拾取 → 附件,旧壳 P2 路);多 profile 的设置面;权限询问;下载;页内查找;起始页;会话恢复 | — | `gate:browser` 加条 |
| **T3**(待拍) | `terminal:` 资源自述给 AI(读 `screen` / 做 `run`),或等 24 域迁投影 | — | — |

次序:T0 → T1(与 B0 并行)→ B1 → B2 → B2′ → T2 / B3 穿插。T 线与 B 线可在两个 worktree 并行
(共同触碰:`content/kinds/index.ts`、`stage/items.ts`、`electron/host-ports.ts`、`global-events.ts`、i18n,
各一行,合树手并)。

## 5. 每单交卷带

- 三张状态表(生命周期 / UI 生命状态 / 交互状态)+ 组件树,先按表自审整面(09-05 判例)。
- 「超量」格:终端一屏 2000 行流式时最长帧;浏览器 8 格 tab 全开切换耗时、遮挡快照切换的最长帧;第 5 轴口径。
- 真机门跑法:临时 store + 独立 user-data-dir + `ONETHING_GATE_HEADLESS=1` + CDP,不连 5175,
  窗口不到前台,`~/.onething` 零改动;**B2′ 起门自己的 CDP 端口与产品的 CDP 口分开**(B0-③ 量)。
- 反证:每条门至少一条「把关键判据改坏 → 门红」。

## 6. 拍点(三条,其余按上文缺省)

1. **macOS Touch ID 通行密钥要真签名**:本批建 Developer ID 签名流水线 + entitlement(推荐 **B3 做**,
   先把浏览器本身立起来;dev 构建 Touch ID 不亮是 Apple 的规矩不是 bug),还是先不做。
2. **CDP 口缺省关**(推荐)还是缺省开:开着 = 本机任何进程都能驱动一个登着谷歌的浏览器。设置一格 +
   一键装 MCP,离「开」只差一次点击。
3. **AI 让浏览器去一个地址,要不要问**(§9-2 挖出):效果表里 `net_fetch` 是 `silent`,而登着账号的
   浏览器去一个地址 = 带着 cookie 以用户身份发请求,与 `web_open` 匿名 fetch 不是一类。推荐**新立效果类
   `browser_navigate`,policy `ask`,barrier false**,用户经许可卡「始终允许 browser:*」一次放行
   (合表 863332c7 已有这条路);读 `page` / `screenshot` 照旧无效果。另一档是沿用 `net_fetch` 静默。

已裁定(09-11):**内核钉官方 Electron,不回 castlabs**;谷歌登录按 §2.2-6 三阶实验,登不上交证据由用户另拍。

缺省不问:terminal `space` / browser `app`;关终端不确认;用户按钮走 `resources.do`;`ctrl+\`` 召唤终端;
`ipcMain` 钉数 1 → 2(基线行写明理由);孤儿契约删除;B0 之前不写遮挡代码;tab 表由主进程落盘(§9-5)。

## 7. 陌生能力演练(法条要求)

**能力甲:「AI 在浏览器当前页点一个元素」。** 走页面层 = chrome-devtools-mcp 已有 `click`,零改动;
若要进应用层,`electron/browser/resource-provider.ts` 自述加一条 `click {selector}` + `BrowserTab` 一个方法。
core / 拼贴树 / RPC / 壳一字不动。

**能力乙:「第二种原生视图:PDF 阅读器」。** `electron/pdf/` 自己的 service + provider,壳 `content/kinds/pdf.tsx`
+ `kinds/index.ts` 一行,占位格**复用 `NativeViewSlot`**(它不认识 browser)。`host:native-view` 帧带 `viewId`,
主进程按 id 路由,钉数不再涨。

**能力丙:「终端按 cwd 分组放进 Dock 右键」。** `content/terminal-launcher.tsx` 右键那张表。

三问答案都是「能力自己的模块 + 一行登记」,骨架到位。

## 8. 留账

- `terminal:` 资源自述与 24 域迁投影的关系(T3 拍点)。
- 两扇壳(桌面 + :5174 网页)同时 attach 一个终端:服务按代次核 ack,行为已定义未真机走。
- server 宿主接终端广播器 = `packages/backend/server/runtime.ts` 宿主表一行。
- chrome-mcp 的 `new_page` 在 Electron 上的行为(B0-② 量);MCP 看见壳自己的 UI 页是 Chromium 的形。
- chrome-devtools-mcp 上游若再对 Electron 炸红(#1197 前科),备胎 `holepunchto/electron-devtools-mcp`。
- 页内正文 P0 `innerText`;可读性抽取住 runtime,壳不该 import runtime,B3 走 core 侧 `web_open` 同一函数。
- 多窗口:今天单窗;`NativeViewLayout` 按窗 id 分账留口,不提前做。
- 遮挡快照是权宜:Chromium 视图不能开洞;真解是壳里所有会盖到浏览器的弹层都做成原生视图(Flow 的
  `portal-component-windows` 那条路),本批不走。

## 9. 深查(2026-09-12,把 v2 当被告审:每条断言回代码核,核不到的立成 B0 量项)

### 9.1 核过、成立的(方案里写下时没验,现在验了)

| 断言 | 证据 |
| --- | --- |
| 宿主能 in-process 挂资源 | `OnethingBackend.resources` getter(`backend.ts:315`)+ `ResourceKernel.mount(provider)`,`mcp-mount.ts:192` 就是这么挂的;`ResourceProvider` 四口 `spec / read / plan / apply`(+ `visibleIn?`) |
| 广播器能发全局事件 | `bus.emitGlobal(...)`(`wiring/resource/event-bridge.ts:46` 同一口);SSE 侧 `global-event-delivery.ts` 按 `leavesProcess(type)` 放行,一帧一事件 |
| 壳能订任意全局事件 | `@onething/client` `hub.on(name, cb)` 按名字建表(`events/subscriptions.ts`),音乐面板订 `resource:event` 就是这条路 |
| 零 tab 时 `browser` 工具也在面 | 露面规则只有一句「provider 在注册表里,那只工具就在目录里」(`catalog-sync.ts` 文件头)—— AI 能开第一格 |
| 效果按主体定 | 音乐 provider `plan`:`ctx.principal.kind === 'user'` → `effects: []`(`music-provider.ts:612`),浏览器照抄 |
| 主进程→渲染推送不占 IPC 钉数 | `host:fullscreen` 先例(`main.ts:412` `webContents.send`,`preload.ts:30` `ipcRenderer.on`);`transport:gate` 只数 `ipcMain.handle/on` |
| 旧壳代码挖得回 | `50ff9cbd^:apps/electron/src/browser/` 九个文件在,`service.ts` 625 行 |
| 终端事件形状 | `TerminalDataEvent {terminalId, seq, data}` / `TerminalExitEvent {terminalId, …}`(`shared/ipc/terminal.ts:106/113`),全局事件直接包它 |

### 9.2 挖出的洞与改判(编号进正文引用)

**9-1 焦点在原生视图里时,整套响应链失明(最大的洞,v2 一字没写)。** `WebContentsView` 拿到焦点后,
键盘事件进的是**页面那个 webContents**,渲染进程 `focus/dispatch.ts` 那条 window 捕获监听一个键都收不到:
⌘K / ⌘P / 全部全局命令、`browser` 作用域自己的 ⌘L 全部死掉;Esc 退层、`returnTo` 归还、I1「activeElement
永不是 body」都不知道有个原生视图在。旧壳靠**应用菜单加速器**(`apps/electron/src/menu/application-menu.ts`
`accelerator: 'CmdOrCtrl+W'`,菜单加速器不管哪个 webContents 有焦点都响)—— React 壳没有菜单,而且键位
在渲染进程 `keymap/store.ts` 的 localStorage 里可改绑,主进程读不到。**改判**:
- **键位表下沉**:渲染进程在键位 store 变化时把「已绑定的组合键」(全局命令 ∪ `browser` 作用域局部键)
  经 `host:native-view` 通道的一个 `keymap` 动词推给主进程(同一条 IPC,钉数不涨);主进程给每个浏览器
  视图挂 `before-input-event`:组合键在表里 → `preventDefault` 并经 `webContents.send('host:native-view',
  {kind:'key', …})` 推回渲染进程,渲染进程交给**唯一那个派发器**照常走(局部先接、全局兜底);不在表里
  → 页面自己吃。这正是 Chrome 自己「保留键先于页面」的形,也是 VS Code 对 webview 的做法。
- **焦点双向同步**:页面拿到焦点(`webContents.on('focus')`)→ 主进程推 `{kind:'focus', viewId}` →
  渲染进程 `activateScope('browser')`,落点是占位格(`tabindex=-1` 的 `NativeViewSlot`);反向,树把焦点
  交给 `browser` 作用域(开 tab、点瓦、规则 2「打开什么焦点进什么」)→ 占位格 effect 经 `focus` 动词让主进程
  `view.webContents.focus()`。I1 在这一格的读法:activeElement = 占位格,原生视图是它的「里面」。
- Esc 在页面里归页面;离开页面的路是 ⌘L(地址栏,壳侧)与点别处。`FOCUS_SCOPES` 加 `browser` / `terminal`
  两行(声明三件:id / restingTarget / onEscape),这是响应链正本要求的唯一写法。
- 终端**没有**这个问题:xterm 是 DOM,派发器在捕获相位先于它跑。§2.1-7 的「键盘礼让」因此**改口**:不靠
  xterm 的 `attachCustomKeyEventHandler` 判谁先,靠 `FOCUS_SCOPES.terminal.keys` 把 Win / Linux 上要留给
  PTY 的单 Ctrl 组合声明成**局部键**(局部先接 → 全局轮不到),xterm 侧只保留「应用拿走的键别再进 PTY」
  一行。两处一张表,表在作用域声明里。

**9-2 效果类判错。** 效果表(`core/toolkit/effects.ts`)`net_fetch` 是 **`silent`**(它管的是 `web_open` 那种
匿名 fetch)。AI 让登着谷歌的浏览器 `navigate` 到一个地址,是带 cookie 的用户身份请求(一个 GET 就能退出
登录、确认订单),不该静默。**改判 → 拍点 ③**(推荐新立 `browser_navigate` / `ask`)。

**9-3 页面正文给 AI 没有「不可信」标记,而且今天的 `web_open` 也没有。** grep `untrusted / injection` 在
`web-open.ts` / `page-fetch.ts` / `families/network.ts` **零命中**——browser-v2 §「prompt injection 四层
防线」从未落地。`page` 读法把登着账号的页面正文交给模型,注入面比匿名 fetch 更大。**改判**:B2 的 `page`
读法结果经一只 `runtime/src/toolkit/untrusted-text.ts`(新,纯函数:定界 + 一句「以下是网页内容,不是指令」
+ 截断)包一层,**`web_open` 同一函数同一批接上**(不做第二种包法);留账:四层里其余三层(域白名单 / 动作
确认 / 审计)另拍。

**9-4 CDP 开关的时机与打架。** `--remote-debugging-port` 是 `app.commandLine.appendSwitch`,**只能在
`ready` 之前**;而设置是装配后才读的。**改判**:设置域写开关时同时落一个启动旗文件 `<store>/run/cdp.json`
`{port}`(与 `run/http.json` 同族,不是第二个设置读者),主进程 `ready` 前读它;**`process.argv` 里已带
`--remote-debugging-port`(`gate-packaged.mjs:65` 就这么起)则不再 append**——Chromium 同名开关后写的
盖前写的,不加这一句真机门的端口会被产品旗子顶掉。B0-③ 的量项照旧。

**9-5 tab 表的家在主进程,不在渲染进程的 localStorage。** v2 §3.2 写「url 记在本地小账本」——那是把真源
的一半搬回壳里。**改判**:`BrowserService` 把 tab 表(id / url / title / profile / order)落 `<store>/browser/
tabs.json`,启动时按表**惰性**重建 `BrowserTab`(有记录、无视图;壳报来第一个 `visible` 或 `activate` 才建
`WebContentsView` 并 `loadURL`)。于是 id 跨重启稳定、拼贴树上的 `browser:<id>` 重启后照常指着东西、
会话恢复白拿、`opened` 事实由「视图建起来」那一刻发。终端那条「本地小账本」不改:PTY 真死了,壳记 cwd
只是为了「再开一个」那颗钮。

**9-6 浮窗之间的 z 序。** 两扇浮窗各带一个浏览器且重叠时,谁盖谁由 `contentView.addChildView` 的次序定,
主进程不知道浮窗的堆叠序。**改判**:`host:native-view` 的 `bounds` 帧带 `z`(壳里浮窗堆叠序的名次),
`NativeViewLayout` 按 `z` 重排子视图。

**9-7 快照要在藏之前拍,且要一条回来的路。** `capturePage` 对已 `setVisible(false)` 的视图拍不到。
**改判**:遮挡判定 → 壳发 `{kind:'occlude', viewId}` → 主进程**先** `capturePage` 再 `setVisible(false)`,
把 PNG dataURL 经 `webContents.send('host:native-view', {kind:'snapshot', viewId, dataUrl})` 推回,占位格
收到才换图(推送先例 9.1 表)。B0-② 量的是「从盖上来到图换上」那一段闪不闪。

**9-8 换 Electron 二进制之后第一次起桌面必须人手起**(仓根 CLAUDE.md 09-03 判例:`safeStorage` 绑 app 签名
身份,换二进制 = 换身份 → 钥匙串弹授权框,脚本起的进程永远等不到那一下,`createOnethingBackend` 挂在
`migrateProviderConfigToDefaultSpace()` 0% CPU 无日志)。**B1 升 41.10.7 交卷单必须写这一步**:代理跑
`sign:dev:mac` 之后停下,由用户手起一次点「始终允许」,之后真机门才许跑;任何门在此之前挂住不算回归。

**9-9 终端在隐藏层里 fit 会算出 0 列。** `content-visibility: hidden` 下容器无尺寸,`FitAddon.fit()` 得 0 →
发 `resize(0,0)` 会让 PTY 重排乱屏。**改判**:`TerminalSession` 只在容器可见(ResizeObserver 报非零)时
fit + resize;切回时补一次。

**9-10 坐标单位。** `setBounds` 收 DIP,`getBoundingClientRect` 给 CSS px;两者相等的前提是渲染进程缩放
因子为 1 —— 今天壳里零处 `setZoomFactor`(核过),成立;`NativeViewSlot` 文件头写明这条前提,将来谁加
⌘+/− 缩放就得在这一格乘回去。

**9-11 遮挡判据的来源。** 壳里「有东西盖上来」= 三件事之并:浮窗矩形与占位格相交(`workbench` 的浮窗
区域有矩形)、`focus/registry` 里挂着 `kind: 'float' | 'modal'` 的作用域(菜单 / 弹层 / 命令面板 / 对话框,
`scopes.ts` 已按 kind 分好)、`workbench` 的 `dragging` 态。前两条今天的表就答得出,第三条是既有字段;
B0-② 顺手核「registry 能不能列出挂载中的作用域」,不能就加一口只读枚举。

**9-12 网页壳(`--mode web`)连着桌面 core 时也看得见 `browser:`。** 它是同一台 core 的另一扇窗:
`describe` 列得出、AI 在网页壳里说「开个页」会开在桌面窗里,`resource:event` 也会推到它。这是「一个 core」
的形,不是 bug;网页壳那一格渲染「此宿主没有内嵌浏览器,页开在桌面里」而不是「没有」。

**9-13 CDP 口开着 = 壳自己的渲染页也被暴露**,里面内存里有 Bearer token(`host:connection` 交来的)。
与 0600 的 `run/http.json` 同一信任级(本机同用户),不新增一类暴露;拍点 ② 缺省关的理由再加这一条。

**9-14 chrome-devtools-mcp 作为 onething 的 MCP server** 跑在 `mcp` 效果类下(表里 `ask`),每一调都会问,
「始终允许」一次即可 —— 与拍点 ③ 的 `browser_navigate` 同一档待遇,两层不打架。

**9-15 Widevine 没了**:官方核上 Netflix / Spotify 网页版不播(browser-v2 本来就列为非目标),写进设置页
浏览器那一格的说明,不藏。

### 9.3 深查改了分期表的哪几格

- B0-② 加两项:焦点双向同步的可行性(`webContents.on('focus')` 在 `WebContentsView` 上是否触发、
  `before-input-event` 对组合键的 `preventDefault` 是否真挡住页面)与 9-11 的作用域枚举。
- B1 加:9-4 旗文件 + argv 判据;9-5 tab 表落盘 + 惰性视图;9-8 人手起一次的交接步骤;拍点 ③ 的效果类
  (若立新类,效果表加一行 + 合表一行)。
- B2 加:9-1 键位下沉 + 焦点同步 + `FOCUS_SCOPES` 两行;9-3 `untrusted-text` 同批接 `web_open`;9-6 `z`;
  9-7 快照次序与回路;`gate:browser` 加三条:页面焦点下 ⌘K 仍开命令面板、⌘L 回地址栏、浮窗盖上去占位格
  换图且 200ms 内。
- T1 加:9-9;§2.1-7 改成作用域局部键的写法。
- T0 不变。

### 9.4 B0 读数(2026-09-12,官方 Electron 41.1.1,脚本 `scripts/spike-browser/`)

**证实**:①bounds 跟随 p50 2–9ms / p95 11–13ms,`getBounds` 与目标 0 次不符——「切 tab / 拖 / 撕浮窗只换矩形」成立;②`before-input-event` 对 ⌘K `preventDefault` 后页面收不到、⌘B 放行页面收得到——9-1 键位下沉成立;③chrome-devtools-mcp **1.9.0 真跑**:targets 里壳页 + 两个 `WebContentsView` 全是 `type:'page'`,`list_pages` 列出、`take_snapshot` 拿到视图页真 a11y 树,29 个工具——§1.3-③ 不止「列得出」还「驱动得了」;④z 序:`addChildView(v)` 再调一次提到顶,还有 index 参数——9-6 成立;⑤DIP:2x 屏 CSS px == DIP == 视图页 `innerWidth`——9-10 成立;⑥CDP 旗:append 的口**盖掉** argv 的口且被盖的口彻底不听,`hasSwitch()` argv 带时为 true——9-4 两半成立;⑦遮挡回路端到端 p50 18–29ms / p95 54–96ms(`capturePage` 本身 p50 5–6ms)。

**推翻 / 改口径**:
- **9-7 前提错**:`capturePage()` 对已 `setVisible(false)` 的视图**照样拍得到而且是活的**(藏着改底色再拍,回来是新色)。次序「先拍再藏」保留(省掉藏后第一帧没画的风险),断言改成「拿得到且是活的」;被遮期间每秒重拍一次刷新快照。
- **新洞:隐藏视图节流到 1Hz**(16ms 心跳 → 藏后中位 1000ms,放出即恢复)。后果三条:(a) 后台 tab 近乎冻住,与 Chrome 后台标签同义,接受;(b) 长时间被遮(命令面板开着)快照要按秒刷新(上一条);(c) **`ONETHING_GATE_HEADLESS`(`show:false`)下整扇窗 1Hz**,`gate:browser` 凡与页面时间有关的量项必须用 `--offscreen` 式 `showInactive`(macOS 会把窗钳到 `[0,33]`,不抢焦点)或在门里 `setBackgroundThrottling(false)`。
- **新洞:`win.webContents.capturePage()` 不含原生视图**——「浏览器画对了没有」只能截视图自己的 webContents,「占位格换成快照了没有」才截窗页,两个判据两张图;`capturePage` 走了色彩变换(255,0,0 → 234,51,35),像素断言留容差。
- **9-1 焦点同步一半证实一半没证**:`WebContentsView` 上 `focus` / `blur` 事件在、主进程 `view.webContents.focus()` / `win.webContents.focus()` 双向搬焦点都灵;但 `sendInputEvent` 点视图**零事件、焦点不动**,CDP `Input.dispatchMouseEvent` 让页面侧 `document.hasFocus()` 变 true 却**不发 Electron 事件**——「真鼠标点进页面 → focus 事件」没法在不动真鼠标的前提下证,列为 B2 的**人手走查项**(唯一一条);壳**不许**拿页面侧 `document.hasFocus()` 当判据。
- **`new_page` 在 Electron 上开不出来**:`Target.createTarget: Not supported`,主进程连 `web-contents-created` 都没收到——留账那条「能否收编」不存在;AI 开新标签只走应用层 `browser: do open`,设置页 / 文档写明页面层 `new_page` 不可用。
- **Electron 不必升**:现装官方 41.1.1 上 ②③ 全通,dist 里零 Widevine 二进制;升 41.10.7 只为 Touch ID,随 B3 签名一起做(9-8 人手起一次也随之后移)。
- **9-13 加证据**:CDP 口开着时壳自己的页在 `pages()` 里,chrome-mcp 能对它 `take_snapshot` / `evaluate_script`。

**spike ①(未登录,用户手跑)已知**:UA 前后逐字只少 ` Electron/41.1.1`;㈠㈡ 都能到 accounts.google.com 首屏(首屏不是判据,谷歌在提交账号后才拦);㈡ 的 `userAgentData.brands` 真多了 `Google Chrome 146`;EME 栈活着,`clearkey` ok、`com.widevine.alpha` `NotSupportedError`——§1.3-① 预言的唯一结构性差在真二进制上量到;`window.chrome` 是 `{}`(真 Chrome 有 `loadTimes/csi/app/runtime`),大概率在 ㈢ 的差分里冒出来。**㈡ 阶三个坑写进 B1**:`Network.setUserAgentOverride` 对从没导航过的视图 promise 永不 resolve(先导航 + 超时护栏);热身页必须 `file://`(`about:blank` / `data:` 上 `navigator.userAgentData` 不存在);只「插」缺的那一格别自己算(传顶层 `platform` 会把 `navigator.platform` 改成 `macOS`、`app.getSystemVersion()` 与 Chromium 报的差一个大版本)。`webRequest.onBeforeSendHeaders` 看不到 `Sec-CH-UA*`,那份 dump 不能当 client hints 证据。

### 9.5 施工账(2026-09-12)

| 单 | 提交 | 要点 |
| --- | --- | --- |
| T0 | `dce6c15e` | 两条全局事件 + `wiring/terminal/bus-broadcaster.ts` + 壳宿主表注入 + 还原先杀后摘;传输基线三降 |
| B0 | `69219d30` | §9.4 读数 + `scripts/spike-browser/` 七脚本(谷歌登录三阶留用户手跑) |
| B1-a | `72c998f8` | `electron/browser/` 十二类 + `browser:` in-process provider + `browser_navigate` 效果类 + `untrusted-text`(`web_open`/`web_search` 同批)+ 删孤儿契约;ipcMain 1→2 递归扫描 |
| B2′ | `6fba799b` | `browser.cdp` 设置键缺省关 9333(不给端口框)+ 一键装 chrome-devtools-mcp + `run/http.json.cdp` 由宿主按命令行填 |
| T1 | `d6e31abb` | xterm 进壳、五档状态机、`gate:terminal` 八条(超量 2 万行零长帧);**两条真病顺带治**:①键位内核 `matchCombo` 把 ⌘ 与 Ctrl 当同一位 → 按下侧 `primaryPressedIn(e, platform)` + `offHandPressed`,`platform` 必填;②`TerminalService.handleExit` 的 `disposing` 守卫让 RPC `kill` 永不发死讯 → `exitSent` 闩 |
| B2 | `76d98911` | 壳侧真浏览器:`browser` 内容种类 + 启动瓦 + `NativeViewSlot` + 键位下沉与焦点双向同步 + `gate:browser` 十一条 |
| T2 | 本单 | 终端内查找(`@xterm/addon-search`,⌘F 进 `terminal.keys`,叶顶查找行四态)+ 组件级停靠**量了不做**(数字见下)+ 重载 detach 宿主调用点 + `gate:terminal` / `gate:browser` 定档进 `verify`(两档渲染层各一趟)|
| B3-b | `65ec160f` | 「把这一页交给对话」+ 多 profile 身份 + 起始页 + 查找读数函数合一 |
| 代理 | `1369c29b` | 浏览器分区各自 `setProxy`(`ShellProxyPolicy`,分区建出来那一拍登记 + 第一发 `loadURL` 等回放落地)+ 宿主表 `settings` 接上(改设置重套);`gate:browser` ⑱ |
| 收养 | (本笔) | **页面自己开出来的那一格要有一片叶**:新事实 `spawned`(`{id,url,openerId,background}`,与 `opened` 分家 —— 后台开的 tab 不 materialize,靠 `opened` 永远等不到它)+ 壳侧单槽 `setBrowserTabAdopter` → `placeBrowserTabNear`(落在开它的那片叶的**下一位**,后台档不抢活动格;开它的那格不在屏上就退回常规落点,**后台档照样摆**只是不激活不抢焦点 —— 不摆就是本单在治的那个病)。**配额**:`SPAWN_WINDOW_MS 2s / SPAWN_BURST 3`,同一 opener 超了就 `deny` 并发 `spawnBlocked {openerId,url}`(壳侧只记一行日志,不画 —— 那一下是页面按的,人没做任何事);`window.open` 这条路上按下的是页面不是人,一句 `for` 循环就能塞满拼贴台。**孤儿清理入口**:启动瓦右键多一行「关闭不在屏上的标签(N)」(N = `read tabs` 里 `locateBrowserTab` 答 null 的那几格,0 时不画)。叶檐那颗 + 与 ⋯ 表里「以另一个身份打开此页」一并改走 `near`;`gate:browser` ⑲ |
| B3-a | `b2d46373` | 页内查找(`host:native-view` 两动词一推送,不进资源面)+ 网页权限询问(`permissionRequested/Resolved` 事实 + `respondPermission` 做法,非用户主体一律拒,60s 超时按拒,无「始终」)+ 下载落地提示(`app.getPath('downloads')` 重名加序号);真 bug:Electron `findNext` 语义反的——首发要 `true`(`find.ts` `beginsNewFindSession`);`gate:browser` 十四条两档绿 |

**「收养」这一单的归因读数(2026-09-12 真机报障,三句话一件事)**。用户报:内置
浏览器里能搜索,**点搜索结果链接没有任何反应**;后来又报「页面跑到不知道哪儿去了,
视频开始放、关不掉」「叶檐按钮点不到」「整个壳点不了,只有原生视图那块能点」。
真机复现(临时 store + 独立 `--user-data-dir` + 屏外档 + 只用 CDP/RPC)量到的是:

- **一格 `target=_blank`(以及 `window.open`、⌘-click)在主进程这一侧全走通了**:
  `setWindowOpenHandler` → `decideWindowOpen` → `service.open` → 视图 materialize →
  `loadURL` 成功、标题落下来。`read tabs` 多一格、`activeId` 换成它。
  **而 `leafIds` 一片都没多。** 那片视图的矩形是 `{0,0,0,0}` / `visible:false`
  (`layout.register` 的第一句:壳没报过帧,谁都不知道它该在哪)——
  **页面照样在跑**(Chromium 只把隐藏视图的**渲染**节流到 1Hz,音视频照走)。
  三句报障因此是同一件事:屏幕不动 = 没反应;它在窗里但 0×0 = 跑到不知道哪儿去了;
  没有叶就没有那颗 ✕ = 关不掉。用户账本 `~/.onething/browser/tabs.json` 里 **16 格
  tab、14 格 YouTube、活动那格是一段正在放的视频**,正是这条缝一次一次漏出来的。
- **`BrowserWindow.getAllWindows()` 恒为 1**:没有第二扇原生窗口(`setWindowOpenHandler`
  永远 `deny`,这一半是对的)。「点新建开出来一个窗口」是**壳这一侧**的事:
  `browser-launcher.regionForLauncher` 读的是**瓦的位置记忆**,而一格新 tab 在记忆里
  永远没有自己的位置 —— 记忆是 `float` 时每按一次 + 就去要一扇新浮窗。本单一并改走
  `near`。
- **代理那一半已经治好了,`-100` 是代理自己的 REJECT**:`resolveProxy` 在
  `defaultSession` 与 `persist:browser-default` 上都答 `PROXY 127.0.0.1:7890`
  (本地回环答 `DIRECT`),YouTube 载得上来。stderr 里那两行
  `ssl_client_socket_impl.cc handshake failed … net_error -100` 与
  `webRequest.onErrorOccurred` 一一对上的是 **`static.doubleclick.net`
  (`ERR_CONNECTION_CLOSED`,`resourceType: 'script'`,子资源不是主框架)**;
  `curl -x http://127.0.0.1:7890 https://static.doubleclick.net/…` 在同一台机器上
  复现同一种失败,而同一把代理下 `www.youtube.com` 答 200、`fonts.gstatic.com` 答 404。
  **这是 Clash 对广告 / 统计域名的 REJECT 规则,不是壳的 bug,产品一个字不改** ——
  要核的话看 Clash 的连接日志里那条 `REJECT`。(顺带:`www.google.com/search` 在
  这把代理下会跳 `/sorry/`,那是 Google 认出了代理出口 IP,同样不是壳的事。)
- **「整个壳点不了」这一条没能在隔离实例里复现**,读数如实报:12 格孤儿 tab +
  3 格真 YouTube 之后,壳的 `evaluate` 往返 2–12ms、`[inert]` 计数与基线同为 1、
  浮层 / 模态作用域 0 格、渲染层错误 0 条、点 Dock 瓦照样开得出叶;`WebPermissionCard`
  的作用域是 `kind:'region'` 不是 `modal`(而且它只画在**某一片叶的檐下**,没有叶就
  根本不渲染),所以「一张看不见的模态卡锁死全壳」这条路在代码上就不成立。檐钮矩形
  (y 55–77)与原生视图矩形(y 90 起)**不相交**,`elementFromPoint` 每一处都命中真
  元素。**今天能证的只有一条**:那扇窗里当时挂着 15 片各自活着的隐藏页面(15 个渲染
  进程,一格在解视频),而本单之后这些页面不再会无主地长出来。留账:若收养落地之后
  用户仍遇到整壳不响应,再查资源侧(进程数 / 内存)与那一刻的作用域树 dump。

**T1 立下的判例**:启动瓦开出内容那一拍树上只有叶没有内容格,`focusIntoRefAfterCommit` 落空 → 「开的人点名、被开的那一格挂载时取走」(`registry.requestTerminalFocus`,与 `stage/summon.requestFocusOnOpen` 同族);`appendChild` 走 ref 回调不走 effect(子 effect 先于父,落焦那一刻 textarea 还不在文档里);目录瓦有同一缺口未动。**缺省拍**:`toggle:terminal` 出厂键读作主修饰键 + 反引号 → Win/Linux `Ctrl+\``、mac `⌘\``(macOS 把 ⌘\` 交给应用,单窗无冲突;今天没有绑定表达得出「就是 Ctrl 那一枚」,`DEFAULT_COMBOS` 行上标 ⚠️)。`gate-a11y` 起的是 server 宿主(`terminal: null`),终端那一屏永远等不到叶 → axe 进 `gate:terminal` ⑧。

**T2 的三个结论**(2026-09-12):
1. **组件级停靠:量了,不做。** 派工单那道题(同一片叶上 `session:A → terminal:X →
   session:A` 会不会卸载重挂)在今天的产品里**凑不出来** —— 会卸载重挂的只有
   「原位换 ref」(`store.replaceRef`),而壳里叫它的三处全在 `content/session-open.ts`,
   换掉的一格恒是**会话那一格**(`leafSessionTabOf`)或那格保留键,一格终端标签
   既不是前者也不是后者。终端真会走的两条路量出来是:**藏起来再拿回来**(切 tab,
   `content-visibility`)prod 3–8ms / dev 6–14ms;**搬家**(⌘⇧↩ 铺满 / 还原,真的
   卸载重挂 + `appendChild` 把屏幕 DOM 搬走)prod 15–24ms / dev 27–41ms;两条路上
   ≥50ms 长帧**都是 0**。都在第 5 轴的 50ms 以内,所以 `workbench/kept-contents`
   一个字不加(读数与判词进 `gate:terminal` ⑩,回归了会被抓住)。
2. **浏览器 ⑩「每格 ~85ms」是门自己睡的。** B2 报的 688–712ms 里 **640ms 是
   `delay(80) × 8`**;分段计时之后产品那一侧每格 `activate` 往返 prod 1–5ms /
   dev 1–9ms、状态落定 1–6ms,冷轮(每格现建 `WebContentsView`)与热轮几乎同价。
   所以 `tabSwitchMs` 直接吃第 5 轴原数 50ms,不给过渡值。**B2 报的「1–2 个 ≥50ms
   长帧」也是量错了窗口**:那只 LoAF observer 是 `buffered: true` 起的,收的是整道
   门的历史帧;切窗口之后逐格切换那一段**零长帧**。
3. **遮挡回路是今天唯一一格达不到第 5 轴的**:实测 148–192ms(B2 三遍 160–239),
   `BUDGET` 写 100ms(方案 §2.2-1 的口径),`TRANSITIONAL` dev 320 / prod 300 并
   写明退场判据 —— 差的那一百多毫秒在壳这一侧的 `img.decode()` + 留一帧,治到
   100ms 以内就删掉那两行。

---

## 代码块运行(2026-09-14)

用户拍板一句话:**聊天里的 bash 代码块檐上加一颗「运行」钮,点下去把脚本写进终端并
回车,像 IDE 一样。**

### 用户看到什么

檐上「运行」在前、「复制源码」在后(点得多的在前;两颗都在檐上,露出预算缺省 2)。
只有 `bash / sh / zsh / shell / console` 五种围栏、**而且围栏已经闭合**时才露出这一颗 ——
还在流式的围栏里是半句命令,`console` 那种带 `$ ` 提示符的正文由块这一层剥成可跑的脚本。
点下去:这条会话那一格运行终端被**亮出来**(架子收着就展开、非活动 tab 就点名、
被压住的浮窗就置顶)、**焦点进终端**,脚本连同一个换行写进 PTY。

**结果在终端里**,不在对话里:没有就地反馈、没有 Toast、没有通知(与复制那种「按钮
换字」的档不同 —— 那一档在这里没有位置可长,人要看的是 shell 打出来的东西)。开不出
终端时就地记一条 `content.blocks.run` 的 warn,这块内容一个像素都不变。

### 生命周期

**运行动作是借用者,终端是所有者。** 这一单没有造出一种新东西:它借的就是那一族普通
终端 —— 寿命是那格 PTY、**关标签 = 杀**(`content/kinds/terminal.tsx` 那条一字不改)、
换宿主不丢屏、⌘⇧T 拿回来的是一台新 shell。`run-script.ts` 里那张「账本键 → 终端 id」
的小表**不拥有**任何终端:那一格被关掉、被杀掉、被拖走,下一次问的时候自然答「不能
复用」(三问:实例还在 ∧ 没死 ∧ 还在拼贴台树上),于是新开一格。

**每会话一格**(用户拍):账本键 = `sessionId` ?? `dir:<baseDir>` ?? `'none'`。
**不复用用户自己开的终端** —— 往一台人正在用的 shell 里插一行命令,是这颗钮最容易
吓着人的失败方式。新开那一格的落点问的是终端那块启动瓦的记忆
(`terminal-launcher.terminalLauncherRegion`),所以用户把终端摆到哪儿,这颗钮开出来
的就在哪儿。

分层四件,块层不认识终端:词表加一格 `run`(`blocks/registry.ts`)→ 单槽注入口
(`blocks/shell/run-port.ts`,没人装 = 这颗钮不露出)→ 执行器三个 case
(`blocks/shell/actions.ts`)→ 装配点在 `content/kinds/terminal.tsx` 末尾(「这台壳
画得出终端」与「这台壳跑得了脚本」是同一个事实)。

### 留账

- **「那一格正在跑长任务」测不出来**:没有 shell integration(OSC 133 那一族),
  PTY 这一侧报不出前台进程是谁,所以复用那一支有可能把第二条命令打进正在跑的程序的
  stdin。这与 VS Code 的「在终端运行」是**同一种行为**;唯一诚实的替代是接 shell
  integration,不是发明一条「看起来空闲」的启发式(猜错比现在坏得多)。
- **结果不进对话、不落账本**:AI 看不见这次运行跑出了什么。
- **路 B「结果挂在块下」被推迟**:那是一个**新的所有者 + 新的账本**(谁拥有这次运行、
  它活多久、重开会话之后还在不在、谁能读它),不是这颗钮的延伸。等到要让 AI 看运行
  结果的那一天,按原子那套「**作业是资源**」做 —— 有地址、三动词、效果声明,一条管线
  所有出口皆投影(`docs/design/atom-2026-09.md`),而不是在聊天流里长出第二套状态。
- **没有终端能力位可读,所以 web 模式对着无终端的 core 时这颗钮是一颗会失败的钮**:
  装配点是种类表(`content/kinds/index.ts` 静态 import `./terminal`),`main.tsx` 在
  desktop 与 `--mode web` 两种模式下都加载它,于是 web 壳上「运行」照样露出。连着桌面
  core 时它真的跑(PTY 在桌面主进程里,输出经 SSE 回到 web 壳的 xterm);连着一台
  `server:start`(`hasTerminalHost()` 为假)时 `terminal.create` 结构性拒绝,点下去只落
  一条 `content.blocks.run` 的 warn。壳里今天没有同步的 `capabilities.terminal` 读数
  (只有 `data/home-dir.ts` 那条异步 `client.capabilities()`),`BlockRunPort` 因此没有
  `available()` 那一口 —— 补法是让能力位进一个同步 store 后再给这一口加一问,不是在
  块里猜宿主。
