# 独立 React 桌面壳(2026-08-25)

## 0. 已拍与待拍

已拍(2026-08-25):

- **形态 = 独立的新 Electron 应用**。不动现有 Vue renderer、apps/web、apps/electron;新应用是第四个 UI 宿主。
- ~~视觉 = 复用 ui token 体系与主题系统~~ **改拍(2026-08-25 晚)**:结构全部重新设计(无衬线标题、无灯蓝),**颜色仍走主题系统管道,但新壳用自己的 token 命名**。结构规范画布(artifact `react-shell-style`,10 画板两页)是权威:圆角 6/10/14/999、控件 28/32/38、行 40、hover=前景 6% 薄膜、active=10%、selected=accent 10% 晕(悬停 16%)、focus=柔光环(1px accent 边 + 3px accent 18% 晕,仅 `:focus-visible`)、120ms 唯一手势、无位移原则、面四层梯 + 影三档 + z 七档、"内容面不投影,浮起才投影"。
- **token 策略(2026-08-25 晚拍定)三段结构**:① 命名归新壳——六族 `surface-0…3` / `text-1…4` / `line-1…2` / `accent` / `state-*` + 结构族 `r-* sp-* fs-* sh-* z-*`,新壳 CSS 不出现 `--ui-*`;② 色值从主题管道来——`themes` RPC 域 `apply` 返回解析完的 `cssVariables` 表(插件覆盖/皮肤档/旋钮已在域内组合,不分叉 transport),新壳 ~20 行贴 `:root` + 一个 ~60 行静态别名文件(`--sf-1: var(--ui-surface-panel-bg)` 式)翻译键名,态强度在桥文件集中合成——hover/active 用 `color-mix(in srgb, var(--ui-text-primary-fg) 6%, transparent)`(**审查更正 08-25**:主题表没有 `--ui-*-rgb`,`-rgb` 变体只有 accent/bg/status 等 12 键,前景色无 rgb,故用 color-mix;合成只住在 theme-bridge 一个文件,等价于旧系统"档位住在主题层"的治理),selected 用现成 `--accent-rgb`——**不改共享主题层,旧壳零影响**;③ 结构值归新壳自有常量,来源即规范画布。明暗/7 种 accent/自定义主题/插件覆盖全部免费获得。
- **字体(2026-08-27 试用中,未终拍)**:甲组 **Schibsted Grotesk + Noto Sans SC + JetBrains Mono**,九块规范板已全部以此组渲染;备选乙 IBM Plex 同族、丙 Public Sans + 系统 mono(与旧壳连续)。配套规则:全回退栈、数字场合 mono + tabular-nums、宽字距只用于 ≤11px 全大写、桌面本地打包 400/500/600/700 四档。design system 场景无关层至此闭合(九块板:尺规/交互态/控件/行与陈列/层级/旋钮/字体/排版与表单/反馈与杂项)。

待拍:

- **聊天数据层路线**(§5.1)。用户侧另有进行中的事项,等其完事再拍。P0/P1 与该决定无关,可先行。

## 1. 调查结论(为什么架构支持这么做)

2026-08-23 调查核实的事实,全部有代码可指:

1. 宿主与 UI 之间零反向依赖:`apps/electron`、`packages/backend`、`runtime`、`core` 没有一处 import `@renderer`/`@/`。
2. UI→宿主全部收口在两条通用通道:`rpc:invoke` / `POST /api/rpc`(50 个 `defineRouter` 域,`packages/shared/ipc/`)+ `shell:invoke`(10 个窗口系域)。契约层 `@shared`/`core`/`backend` 零 `vue`/`pinia`/`electron` import。
3. **HTTP/SSE 面已经是产品的一等公民**(A 期,`docs/design/one-core-2026-08.md`):桌面主进程挂载与 `server:start` 同一份 `packages/backend/server/http.ts`,写发现文件 `<store>/run/http.json = {port, host, token, pid, owner}`。apps/web 今天就是这样连的。
4. `packages/renderer/platform/`(67 文件 / 3100 行)**完全不依赖 Vue/Pinia**,React 可直接消费;`services/` 只有 2 个文件沾 Vue;`stores/helpers/`(2896 行工具展示纯函数)只有 `expansion-intent.ts` 和 `tool-ui-registry.ts` 两个沾 Vue。
5. `packages/core/session/projection/reducer.ts` 是零依赖、浏览器安全的纯归约器,已被 S1 影子模式在真机验证与引擎行为逐字节等价(battery 200+ runs / 0 mismatch)——React 里一句 `useReducer` 就能用(数据层走路线 A 时)。
6. 仓里已有 React 19(`apps/mobile`,React Native 0.86)。

## 2. 目标形态

```
┌────────────────────────────────────────────────────┐
│ 新应用 main 进程(薄壳,不装配 backend)             │
│  1. 读 <store>/run/http.json 发现在跑的 core        │
│     - 旧桌面在跑 → 连它的内嵌 HTTP 面               │
│       (同一 core 两个 UI,这正是 A 期的设计目标)    │
│     - 没有 → spawn dist/server/main.js 子进程,      │
│       等它写出发现文件,退出时收尸                   │
│  2. 窗口管理 + 最小原生面(dialog/notify/clipboard/ │
│     标题栏),经自己的 preload 暴露                  │
│  3. preload 把 {baseUrl, token} 交给渲染层          │
│     (发现文件 0600,渲染层不许自己读盘)            │
└──────────────┬─────────────────────────────────────┘
               │ HTTP /api/rpc + SSE /api/events(Bearer)
┌──────────────┴─────────────────────────────────────┐
│ 现有 core(不改装配):桌面内嵌面 或 dist/server     │
└────────────────────────────────────────────────────┘
```

三条关键裁定:

- **薄壳,不装配第二个 backend**。新应用不是第二个桌面,是"一个 core,任何 UI"的第一个异构 UI。同 store 单写者靠发现文件裁决(2026-08-24 重申:不加锁,server StoreLock 已撤)。
- **与旧桌面同时跑是天然支持的**,不是要规避的冲突——两个 UI 订同一条事件流,状态自然同步。
- **原生能力走"新应用自己的 shell 表"**,与 `packages/renderer/platform/shell-web/` 同构:同一份 `@shared/ipc` 窗口系契约,宿主处理者换成新应用自己的实现。不复用旧壳的 `apps/electron/src/ipc/shell/`(那是旧壳的窗口系)。

## 3. 复用清单(import,不复制;例外注明)

| 资产 | 位置 | 复用方式 |
| --- | --- | --- |
| 50 域 RPC 契约 + 10 域窗口系契约 | `packages/shared/ipc/` | 直接 import(`@shared` 需给新应用配同款 alias) |
| `createRouterClient` | `packages/shared/ipc/router.ts` | 直接 import |
| HTTP/SSE 传输面 | `packages/renderer/platform/web.ts`(757 行) | import 或抽取;**前置修改见 §5.6**(基址/token 目前写死同源) |
| 各域 `*-client.ts` | `packages/renderer/platform/` | import(vite alias 指向 `packages/renderer`,同 apps/web 的做法;抽独立包后置,见 §5.5) |
| core 投影归约器 | `packages/core/session/projection/reducer.ts` | 路线 A 时直接 import |
| 日志内核 | `packages/core/logging/` | 直接 import(浏览器安全,与 L3 renderer hub 同款) |
| 主题色值 | `themes` RPC 域 `apply` 的 `cssVariables` 表 | 新壳贴 `:root` + `theme-bridge.css` 别名翻译(§0 token 三段结构)。旧 `packages/renderer/styles/*.css` **不复用**——旧命名旧值,与"新壳不出现 `--ui-*`"矛盾(审查更正 08-25) |
| 工具展示纯函数 | `packages/renderer/stores/helpers/`(除 `expansion-intent.ts`、`tool-ui-registry.ts`) | import |
| `ChatMessage` 等消息类型 | `@shared` / `@onething/core` | 直接 import |

不复用:`stores/`(Pinia)、`services/ipc-hub.ts`(写 Pinia)、`composables/`、全部 `.vue` 组件、旧壳 preload/bridge。

## 4. 分期总览

| 期 | 名 | 做什么 | 门(脚本级,拒人肉 QA) |
| --- | --- | --- | --- |
| **P0** | 壳与连通 | 新 workspace 应用脚手架(electron + vite + React 19 + TS;root workspaces **单列**,不加 glob——mobile 教训);main 进程发现/拉起 core;preload 交 `{baseUrl, token}`;§5.6 的注入式传输面落地;React 挂载,一次 `POST /api/rpc` 往返 + SSE 收到一条 `session:event` | 脚本拉起应用 → 断言 rpc 往返成功 + SSE 事件到达;旧桌面在跑/不在跑两种路径各验一次 |
| **P1** | 只读会话 + 主题 | 会话列表(`sessions` 域);历史消息渲染(contentParts → React 组件树,搬 `stores/helpers/` 纯函数;**不含流式**);`themes` 域拉变量表 apply + token CSS 引入;明暗切换 | 同一会话在 Vue 端与 React 端的消息树结构比对脚本;主题变量数逐项断言 |
| **P2** | 聊天写面与流 | **待 §5.1 拍板**。路线 A:先落服务端事件流传输(带 eventSeq、`?after=` 重放),React 聊天状态 = `useReducer(core 归约器)`;路线 B:照抄现行 chunk+快照双流,重写拼装层 | 路线 A:发消息 → 断言归约态与 `sessionReads` 读面一致;断线重连补发用例。路线 B:对齐 Vue 端既有行为 |
| **P3** | 权限与工具交互 | `permission:request`(SSE 携 targetChannel)→ 审批卡;respond 走 session-command HTTP(channel 收养逻辑服务端已有);工具调用展示、diff 渲染 | 真机脚本:触发一次需审批的工具 → React 端 respond → 工具执行完成 |
| **P4** | 原生面 | 窗口系:标题栏 `hidden` + 拖拽区(判例:app-region 只算 content box、no-drag 须同分支子孙、CDP+CGEvent 验证法);本地 shell 表(dialog/notify/clipboard,与 shell-web 同构);菜单 | 拖拽区 CDP+CGEvent 脚本验证;shell 表逐域冒烟 |
| **P5** | 桌面-only 能力逐项 | §6 缺口清单逐项单独拍板、单独排期,**不隐式承诺** | 每项自带门 |

P0+P1 不依赖任何待拍项,可立即开工。

**布局实施批(2026-08-28 开工,先于 P0 连通)**:L1 = `apps/desktop-react` 脚手架(纯 Vite+React19,自包含依赖照 apps/mobile 惯例、不进 root workspaces;Electron 壳留 P0 批套)+ 结构 token 落码 + StageItem 形态机(纯函数 transitions + 单测:一舞台一钉栏/已钉点击 flash/替换语义/宽度 clamp)+ macOS Dock(保留带 64px、双域按建议案 B、磁性放大唯一位移豁免、徽标/运行点、缩起设置接真 store)+ 舞台覆盖层 + 钉栏拖宽 + mock 内容面板;L2 = Exposé 总览(project 分组/折叠/规模化/Quick Look/⌘P 三层搜索);L3 = 钢琴键 TOC + composer。数据全 mock,P0/P1 接通后替换。验收:typecheck/vitest/build 三绿 + dev 可起。

**UI 验收附加门(2026-08-27,Nielsen 启发式)**:每期含 UI 的批次完成后,按四条重点启发式逐条自查作为出厂检查——①可见状态(每个操作有即时反馈/loading/结果提示);③紧急出口(误操作可撤、流程可退、浮层可关);⑤防错(不可选即禁用、危险操作有闸);⑨错误可恢复(文案三要素:说人话/指出哪错/告诉怎么改)。其余六条在大版本收口时过一遍。四条已落为规范硬规则(画布 Elevation/Feedback 板):**对话框必有逃生口**(×/取消 + Esc,禁"只有确定"的死胡同)、**错误文案三要素**(禁裸错误码)、**破坏性操作二选一**(确认对话框 或 先执行 + 撤销 toast,可逆操作优先后者)、**骨架延迟 150ms**(快请求不闪)。启发式是评估工具不是创作工具——只做完稿后的 checklist,不拿来从零生成界面。

## 5. 拍板点

### 5.1 聊天数据层(挂起,等用户侧事项完事)

- **路线 A(建议)**:先做一期服务端工作把带序号的事件流暴露到 HTTP/SSE(即 U 线 `docs/design/ui-event-stream-2026-08.md` 的传输部分),React 聊天零拼装、断线可重放;对 Vue/web 端也是净收益。
- **路线 B**:React 照抄现行双流协议,快但拼装层是注定要扔的过渡品,且会重踩 Vue 版踩过的位置推断 bug。

### 5.2 应用名与目录

建议 `apps/desktop-react`(与 apps/electron、apps/web、apps/mobile 并列)。root `package.json` workspaces 逐项单列。

### 5.3 无 core 在跑时的拉起策略

建议:spawn `dist/server/main.js`(默认桌面同权工具面),等发现文件出现再连;新应用退出时若 core 是自己拉的则一并结束(保活留给 C 期)。`dist/server` 不存在时明确报错提示先 `bun run server:build`,不静默降级。

### 5.4 React 技术栈

建议:React 19 + Vite + TS;状态用 zustand(或路线 A 下聊天面纯 `useReducer`,全局壳态才用 zustand);**不引组件库**(视觉复用 token 体系,组件库会打架);不引路由库(单窗多面板,hash 只用于窗口种类,同现在)。

### 5.5 platform 层复用方式

首版:新应用 vite config 加 alias 指 `packages/renderer`(apps/web 同款做法),直接 import `platform/` 下的客户端。抽成独立包(如 `@onething/ui-client`)后置——等 React 壳站稳、且 Vue 端也准备消费同一个包时再抽,一次抽准。

### 5.6 API 基址与 token 注入(P0 内必须解)

现状:`platform/web.ts` 写死同源相对路径(`fetch('/api/rpc')`、`new EventSource('/api/events')`),Electron 渲染进程从 `file://` 加载时不可用。两案:

- **甲(建议)**:给 web 传输面加一个可注入的 `{ baseUrl, tokenProvider }` 单槽端口(默认不注入 = 现行同源行为,apps/web 零变化);新应用 preload 注入。EventSource 无法带 header,需核实 `/api/events` 是否接受 query token,不接受则补(服务端一处小改)。
- **乙**:让 core 的 HTTP 面顺带 serve 新应用的静态 bundle,新窗口 `loadURL(http://127.0.0.1:<port>/…)`,同源相对路径直接成立。副作用是 core 面多了一个静态目录职责,且 dev 热更流程别扭。

### 5.7 与旧桌面并行期的定位(已拍,2026-08-25 晚)

**新壳是继任者,旧 Vue Electron 壳最终退役。** 由此确立两点:

- **渲染层走 HTTP 是终态不变量,不是过渡妥协。** 退役日的两种终态——甲:新壳 main 进程接任 `createOnethingBackend` 宿主,渲染层连自己内嵌的 HTTP 面(即 one-core B 期给旧壳规划的"renderer 去特权"形态);乙:C 期 core 脱壳成独立进程,新壳永远薄客户端——渲染层在两条路里都不改。甲乙之选(谁养 core 进程)退役临近再拍。
- **架构形态确认为混合**:数据面 HTTP → 唯一 core;壳面器官(terminal 本地服务、内嵌浏览器、voice 音频、窗口系)在新壳自己的 main 进程实现,走新壳自己的 shell 通道,不经过 core、不需要开 http 闸(terminal 由此从§6"待开闸"改判为"壳面本地做")。厚壳(全装 backend)被否:同 store 双写禁并行(过渡期恰需两壳并行)、宿主胶水双份维护、单例服务(网关/调度器/快捷键)翻倍、逆 B/C 期返工。"胶水双份"只存在于并行过渡期——终态甲时宿主胶水是**搬家**不是抄写。

**退役前提清单**(旧壳归档前必须在新壳侧活着):① 壳面器官(P4/P5);② 终态甲则九个 `configure*Host` 的 Electron 实现搬家;③ 窗后服务宿主侧(网关拉起/调度器/MCP/ACP/deeplink/全局快捷键);④ **CLI daemon 挪家**——`out/main/cli.js` 构建自 `apps/electron/src/main/cli/`,旧壳仓退役会带走它(C 期 daemon 升格顺路解决);⑤ 打包链(electron-builder/mac 签名/native panel 脚本)按新壳重建。数据零搬家(同一个 store)。

### 5.8 前端技术选型(2026-08-28)

原则:①旧壳验证过的判例优先复用;②渲染器全部包在组件接口后(`MarkdownView`/`DiffView`/`TerminalView` 都是 StageItem 的内容渲染器),库是实现细节、可换不伤形态机——面向对象审核过关的关键就在这层隔离;③能自研 ~100 行解决的不引库。

| 领域 | 采用 | 理由 | 备选/风险 |
| --- | --- | --- | --- |
| **Markdown(流式)** | **streamdown**(Vercel,为 AI 流式聊天而造:未闭合语法容错、块级 memo、内置 shiki 管道) | 正中"每 16ms 批重渲染长消息"的痛点,免自研块缓存 | 备选:react-markdown + 自研块级 memo(把旧壳 `parseStreamingMarkdown`/`markdownRenderCache` 策略移植)。风险:streamdown 较新、迭代快——P1 试点验收:5k 字消息流式 CPU 与滚动帧率;不达标即切备选。**禁 rehype-raw**(不渲染消息内 raw HTML,安全默认) |
| 代码高亮 | **shiki**(单例 highlighter + 按需语言) | 旧壳同款,主题 token 接入判例现成("var() 被换占位色"坑已知);流式中未闭合代码块降级 plaintext | 不再带 highlight.js(旧壳双库,新壳只留一个) |
| 数学 | remark-math + **KaTeX** | 比旧壳 mathjax3 轻 | 风险:与 MathJax 渲染差异;P2 随聊天面进 |
| **Diff** | **自研组件** 读 core 结构化 hunks(`@onething/core` diff-hunks 共享形状)+ shiki 行级高亮 | 数据面给的就是结构化 hunks,库(react-diff-view)反而要转形状;旧壳 `DiffView.vue` 判例可对照 | `diff`(jsdiff)不进首版——客户端不算 diff,只渲染 |
| **终端** | **@xterm/xterm 6** + addon-fit / webgl / unicode11 | 旧壳同款同版本;判例:拖分隔条期间不 refit | 无备选必要;跑在新壳 main 进程本地(§5.7 混合形态) |
| 状态 | **zustand**(壳态:布局/设置/会话列表)+ 聊天态 `useReducer`(路线 A = core 投影归约器) | 早前已建议,与"聊天状态=归约器输出"天然合 | 不引 redux/jotai/mobx |
| 数据层 | 复用 `platform/*-client` + SSE 推送驱动 store | 推送驱动与 TanStack Query 的请求缓存模型冲突 | **不引 TanStack Query** |
| 动画 | **零库**:全 CSS token;Dock 磁性放大自研 hook(指针距离→scale,~60 行) | 120ms 唯一手势 + 三条 Dock 例外,库反而引入规范外时长 | 不引 framer-motion/motion |
| 分隔条/布局 | 自研(钉栏单分隔条 pointer events ~80 行) | 舞台形态只有一条分隔线,react-resizable-panels 过度 | — |
| 虚拟滚动 | **不做**(消息列表 plain map) | 继承旧壳判例:消息列表不虚拟化,长会话靠分页 | 真需要时 @tanstack/react-virtual 只上表格类 |
| 图标 | **lucide-react** | 与旧壳 lucide-vue 同源,视觉零漂移;直接匹配规范 14/16/20、描边 1.75 | — |
| 样式 | **CSS Modules** + 全局 `tokens.css`/`theme-bridge.css` | 组件作用域 + token 体系;**不引 Tailwind**(原子类与 token 治理冲突) | 字面值治理走 lint(继任 ui:gate) |
| 编辑器类 | 首版不进(Monaco/ProseMirror 留给 P5 的对应能力) | — | — |
| 测试 | vitest + @testing-library/react | 与仓统一 | — |
| i18n(2026-08-28 拍) | **自建 typed 字典**:`src/i18n/{zh,en}.ts` + `t(key, vars?)`,key 由 TS `keyof` 约束(漏译编译期报),语言=设置档(跟随系统/中/英) | 双语桌面应用不需要 ICU 复杂度;~60 行零依赖 | 需要复数/日期本地化时再升级 react-i18next;**规则:组件里不落字面文案**,与"不落字面色值"同级铁律 |
| 组件库(2026-08-28 拍) | 基础件一律建 `src/ui/`(Button/Segmented/Tabs/Menu/Badge/Tooltip…),业务只消费 | 规范九板 = 组件规格书,散装实现必漂移 | — |


### 5.9 D1 落地记录(会话侧接真数据,2026-08-29)

P1 的会话那一半已落地(消息流式渲染与主题仍在 P1 内,未做)。四处 mock 退役:
Exposé 总览、检索面板会话侧、Quick Look、钢琴键 TOC。

**新增结构(只在 `apps/desktop-react` 里,共享层一行未改)**

| 层 | 落点 | 职责 |
| --- | --- | --- |
| 端口 | `src/data/sessions-port.ts` | 平台调用面的**子集**(listMeta / getSegments / getMessagesPage / getUserMarkers / onSessionEvent),测试可换 |
| 数据源 | `src/data/sessions-source.ts` | 全应用唯一的会话真数据源:启动拉列表 + 订 SSE + 三份按会话缓存 |
| 投影 | `src/expose/projection.ts` | `SessionMeta` → 屏幕形状 + 分组(取代退役的 `expose/data.ts` mock 表) |
| 形态机 | `src/expose/transitions.ts` | 不变,只是数据一律从**参数**进来(mock 默认值退役) |

**三处裁量**

1. **分组维度 = `SessionMeta.workingDirectory`**。它是 `SessionMeta` 上唯一被
   注释写明「surfaced into the list so the sidebar can group by project」的字段,
   Vue 壳的 `stores/projects.ts` 也是同一条判例(项目分组是**推导**出来的)。
   项目名 = 路径末段;协作形态(room / dm)优先于项目归属,单独成组;
   没有工作目录的进「独立会话」。空组不出现。
2. **SSE:增量优先,只有一种情况重拉**。可到手的只有 `session:event`;
   `session:created` / `session:deleted` 是全局事件,而 `@renderer/platform`
   **没有开全局事件订阅面** —— 于是:信封的 sessionId 不在列表里 = 有新会话 →
   整表重拉(合并到 ≤1 次/秒);`session:renamed` = 改一格标题;
   message:\* / messages:replaced / stream:complete = 抬 updatedAt + 作废那条会话的
   按需缓存(`stream:complete` 额外作废章节,章节是一轮跑完才推导的);其余忽略。
   **删除是一个诚实缺口**:没有 per-session 事件说「我没了」,补法是开全局事件
   订阅面(要动共享层),不在本批。
3. **没有产地的字段整格删掉**,不留空壳:改动数 / 测试通过 / 未读数 /
   房间头像字 / 房间实况行,以及旧 mock 的「不活跃项目默认折叠」
   (`ProjectMock.active` 在 `SessionMeta` 上没有对应事实)。

**本批新增/保留的诚实缺口**

- **消息正文检索**:后端没有跨会话内容检索面,前端唯一替代是把每条会话每页
  消息拉下来在内存里扫 —— 那是把缺口伪装成功能。检索面与总览搜索都只到
  「标题 / 预览 / 已拉到手的章节」两层,判据写在 `expose/transitions.ts`。
- **文件侧检索**:仍是 `search/data.ts` 的 mock 表(要的是 ripgrep / 索引器,
  后端 `search` 域是**网页搜索**不是文件搜索)。
- **TOC 点击落到 mock 聊天**:键来自真锚点,聊天区仍是 `ChatMock`(真消息流是
  D3),所以两边的下标此刻不同源;点不到的锚点什么也不做,D3 自然对上。

**门**:`npm run gate:data`(`scripts/gate-data.mjs`)—— 临时 store 起 core →
用 token 直接 `sessions.create` ×2 + `addSystemMessage` → 拉起应用 → 断言
**渲染出的会话集合(id + 标题)与 HTTP `listMeta` 逐条相等**(集合相等,多画一条
假卡同样是红)→ 开 Quick Look 断言那条真消息的正文出现在 DOM 里。

## 6. 首版能力缺口(诚实清单)

新应用走 HTTP transport,以下能力首版**没有**,与 `PlatformCapabilities` 能力位及各域 http 分叉的既有裁定一致:

- **terminal**:`terminal` 域 http 分叉七条一律结构化拒(D2 判例:闸在域里,不在渲染侧能力位)。放开 = 去分叉 + server 接推送广播器,或等 C 期后另议。
- **内嵌浏览器**:`browser` 域是旧壳的 WebContentsView,新壳不可得;要有得自己实现宿主侧。
- **voice**:音频链路走旧壳原生面。
- **plugins 管理写面**:独立 server 无插件管理器,回结构化"desktop host only";读面/开关面可用。
- **桌面窗口系**(todo-plan/search/settings 独立窗、macOS panel):P4 起在新壳自己的 shell 表里逐个实现。
- 能力位基线即今天 web 端的那一档;`/api/capabilities` 是唯一判据,UI 不硬编码。

## 7. 不做

- 不动现有 Vue renderer、apps/web、apps/electron 的任何行为。
- 新壳不装配第二个 backend,不引入任何锁(单写者 = 发现文件裁决)。
- 不在本方案内承诺 P5 各项的时间;每项单独拍。
- 不借机换视觉语言(已拍:复用 token 与主题,CSS 仅做迁移性调整)。
