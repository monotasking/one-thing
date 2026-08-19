# 消息引用(Message References):文件与 URL 的可点击约定

日期:2026-08-19 · 状态:P0–P2 已实施(未提交) · 范围:文件(含行号)+ URL 两类;`onething://session/…` 明确延后

## 0. 一句话

**不发明新语法。** 引用 = markdown 链接(或裸路径)+ 一张 *target 解析表*。渲染端把每个链接归类成 `file` / `url` / `external`,点击时由一个统一的 `openReference()` 决定动作:文件进 workbench 的编辑器 tab(可定位到行),`http(s)` 进内置浏览器 tab,其余交给系统。模型侧只需一段"事实型"的系统提示词片段告诉它这些写法会被识别。

## 1. 现状(探索结论,决定了插入点)

| 事实 | 位置 |
| --- | --- |
| markdown-it 用默认 `linkify:true`,**没有** `link_open` 规则、没有 `validateLink` 覆盖、点击也没有任何拦截 | `packages/renderer/composables/useMarkdownRenderer.ts:25-30` |
| 因此点击 `<a href="https://…">` → 顶层 `will-navigate` → 非 app URL → `shell.openExternal` → **系统浏览器** | `apps/electron/src/window/external-links.ts:16-21`,装在 `window/index.ts:536` |
| `file://` 被 `isElectronRendererWindowUrl` 视为 **app URL**(`startsWith('file://')`),一个 `file://` 锚点会把整个渲染器导航走 | `apps/electron/src/window/renderer-targets.ts:31-37` |
| markdown-it 默认 `validateLink` 拒绝 `file:` scheme,所以 `[x](file:///a)` 今天渲染成纯文本 | markdown-it 默认 |
| 现有的一次性 DOM 委托点击处理器(code copy / say-clamp / collab tag)= 我们的点击拦截应挂的地方 | `useMarkdownRenderer.ts:216-301` `ensureMarkdownDomHandlers()` |
| 内置浏览器是 workbench 的 `browser` tab;`useBrowserStore.navigate(url)` 无活动 tab 时自动 `openTab(url)`;`platformApi.capabilities.embeddedBrowser` 在 web 为 false | `packages/renderer/stores/browser.ts:64-76`,`RightWorkbenchPanel.vue:179-183, 588` |
| workbench 已有 Monaco 文件查看器:`RightWorkbenchPanel.openFile(filePath)`(按 path 去重开 `type:'file'` tab),**没有行号**;md 走 live-preview,binary/>1MB 有兜底,**没有图片分支** | `RightWorkbenchPanel.vue:1467-1490`,`composables/useEditorWorkspace.ts:188-238` |
| `open-file` 事件链已通:App(`openFileInRightWorkbench`, `App.vue:743`)→ ChatContainer → … → MessageBubble;StepsPanel 点活动目标已在用它 | `StepsPanel.vue:629-640` |
| 文件 IPC 两端都有:`readFileContent` / `statPath` / `revealPath`;web 走 `/api/files/*` | `preload/bridge.ts:1554-1580`,`platform/web.ts:939-982` |
| `shell:open-external` 已暴露(`platformApi.openExternal`);web 实现 `window.open(_blank)` | `preload/bridge.ts:1304`,`web.ts:1708` |
| `{{file:}}` / `{{page:}}` 是 **composer 侧**的草稿 token,发送时展开,渲染端不认识 | `prompts/prompt-references.ts` |
| 提示词:`BUILTIN_PROMPT_FRAGMENTS` 表 + `content/*.md?raw`,有 golden 测试 | `prompts/builder.ts`,`prompts/__tests__/golden/` |
| 工具结果卡片没有任何路径链接化 | `ToolResultRenderer.vue` 等 |

## 2. 引用语法(模型看到的契约)

模型写普通 markdown 即可;以下 target 会被识别:

| 写法 | 归类 | 说明 |
| --- | --- | --- |
| `[标签](/abs/path/file.ts)`、`[标签](file:///abs/path)` | `file` | 绝对路径;`~/` 展开 |
| `[标签](/abs/path/file.ts:12)`、`…:12-30`、`…:12:5`、`…#L12`、`…#L12-L30` | `file` + `line`/`endLine`/`col` | 行号定位 |
| 行内代码 `` `/abs/path/file.ts:12` `` | `file`(autolink) | 模型最常见的写法,不写 `[]()` 也能点 |
| 行内代码 `` `src/foo.ts:12` ``(相对路径) | `file`(autolink,按会话工作目录解析) | 点击时才解析+存在性校验;解析不到 → 灰 + 提示 |
| 正文裸绝对路径 `已写入 /Users/me/a.ts` | `file`(autolink,保守正则) | P3 再开,先只在行内代码里 |
| `[标签](https://…)`、裸 `https://…` | `url` | 进内置浏览器 |
| `mailto:`、`vscode://`、其他 scheme | `external` | 行为不变:系统处理 |
| `javascript:`、`data:`(非图片)、`vbscript:` | 拒绝 | 渲染为纯文本 |

**不做**:新的围栏块、自定义标记、`onething://session/…`(等第一个真实生产者)。

## 3. 架构

```
packages/renderer/references/                       (新目录,纯 TS,无 Vue 依赖)
├── parse.ts       parseReference(href, ctx) → Reference | null    ← 唯一的分类表
├── autolink.ts    findPathSpans(text) → [{start,end,ref}]          ← 行内代码 / 正文裸路径
├── open.ts        setReferenceHost(host) / openReference(ref, mods) ← 唯一的动作表
├── dom.ts         installReferenceClickHandler()                    ← 委托 click,挂进 ensureMarkdownDomHandlers
└── index.ts

Reference =
  | { kind:'file', path, line?, endLine?, col?, raw }
  | { kind:'url',  url, raw }
  | { kind:'external', url, raw }

ReferenceHost = {                                   ← App.vue onMounted 注册,只有一份
  openFile(path, { line?, endLine?, col? }): Promise<OpenResult>
  openUrl(url): Promise<void>                        // 内置浏览器 or openExternal
  openExternal(url): Promise<void>
  revealPath?(path): Promise<void>
  statPath?(path): Promise<{ exists, isDirectory, isImage } | null>
  resolveRelative?(path): string | null              // 会话工作目录
}
```

- **一表两用**:`parse.ts` 同时被"渲染时打标"和"点击时解析"调用,保证同一 href 两处结论一致。
- **宿主注入而非直接 import store**:`references/` 不 import `RightWorkbenchPanel`/`useBrowserStore`,由 App.vue 把已有的 `openFileInRightWorkbench` 和浏览器 store 包成 host 注册进来。这样 tool 卡片、插件描述树、以后的 `onething://` 深链都能复用同一个 `openReference()`,且 web/electron 差异全部收在 host 实现里。
- **多宿主降级**在 host 里分支:`embeddedBrowser=false` → `openUrl` 退化为 `openExternal`;`localFileSystem/workspaceFileSystem` 都为 false → 文件引用渲染时仍打标但点击提示"此宿主无法打开本地文件"。网关(微信/TG)走 markdown→文本已有链路,路径自然是纯文本,不受影响。

## 4. 渲染层改动(`useMarkdownRenderer.ts`)

1. `validateLink` 覆盖:在默认策略基础上**放行** `file:` 与以 `/`、`~/` 开头的裸路径,继续拒绝 `javascript:`/`vbscript:`/非图片 `data:`。
2. `link_open` 规则:调用 `parseReference(href)`,写入 `data-ref-kind="file|url|external"`、`data-ref="<json>"`(或拆成 `data-ref-path/-line`),class `msg-ref msg-ref--file` / `msg-ref--url`。**`file` 类的 `href` 改写成 `#`**(避免中键/拖拽/`will-navigate` 把 `file://` 当 app URL 导航整窗);原始 target 只留在 `data-*` 里。`url` 类保留真实 `href`(hover 状态栏可见、右键"复制链接"可用),点击由我们 `preventDefault`。
3. `code_inline` 规则:调用 `findPathSpans(content)`,命中则整段 `<code class="inline-code">` 外包一层 `<a class="msg-ref msg-ref--file" data-ref…>`(不拆 code 内文本,避免高亮/复制受影响)。
4. `StreamingMarkdown` 的分段渲染复用同一个 MarkdownIt 实例,自动获得同样规则;需在验证阶段确认流式段落里的行内代码也走了 `code_inline`。
5. `dom.ts` 的委托 click:`target.closest('a.msg-ref')` → `preventDefault()` → 取 `data-ref` → 读取修饰键(⌘/ctrl-click = 系统打开;shift-click 文件 = 在 Finder 显示)→ `openReference()`。挂进 `ensureMarkdownDomHandlers()`(缓存命中路径 `StaticMarkdown.vue:52` 已经会重新调用它,不需要额外处理)。
6. 样式:`.msg-ref--file` 用 `--font-mono` + 前置小图标(CSS `::before`,token 色),`.msg-ref--url` 常规下划线链接;`.msg-ref.is-missing` 灰化。全部走 `--ui-*` token,过 `ui:gate`。

## 5. 动作层(`open.ts` + host 实现)

`openReference(ref, mods)`:

| ref.kind | 默认 | ⌘/ctrl | shift |
| --- | --- | --- | --- |
| `file` | `host.statPath` → 不存在:标记 `is-missing` + toast「文件不存在」;目录:开 `files` tab 以该目录为根;图片:`ImagePreview` 灯箱(`file://`);其余:`host.openFile(path,{line})` | `host.openExternal(file://…)`(系统默认程序) | `host.revealPath` |
| `url` | `host.openUrl` → electron:`useBrowserStore.openTab(url)` + `rightWorkbench.openWorkbenchTab('browser')`;web:`openExternal` | `openExternal` | — |
| `external` | `openExternal` | 同 | — |

行号:`RightWorkbenchPanel.openFile(filePath, opts?)` 加可选 `{ line, endLine, col }`,透传 `EditorWorkbench :initial-position` → `useEditorWorkspace.openFile` 完成后 `setCursor` + Monaco `revealLineInCenter`;文件已开着时也要定位(去重分支同样调用)。md 走 live-preview 没有行,忽略即可。

**URL 打开策略**:每次点击开新 tab 并前置(和内置浏览器自己的 `setWindowOpenHandler` 策略一致:http(s) 进 tab,其他 scheme 系统开)。不复用当前 tab —— 用户点消息里的链接是"看一眼",不应覆盖正在看的页面。

**主进程兜底(硬化)**:`external-links.ts` 的 `will-navigate` 里,`file://` 只放行渲染器自身的 index(精确匹配),其它 `file://` 一律 `preventDefault` 且不 `openExternal`(避免任何遗漏的 `file://` 锚点导航整窗或打开本地文件)。这是防御,不是主路径。

## 6. 提示词片段

`packages/onething-runtime/src/prompts/content/references.md` + `BUILTIN_PROMPT_FRAGMENTS` 新条目 `{ id:'references', slot:'section', channel:'system', order:450 }`(紧接 `context-update-convention`)。内容只写事实,不写"务必/不要":

> 用户界面会把以下引用渲染成可点击项:绝对路径(可带 `:行` 或 `:起-止`)打开到编辑器对应行;`http(s)` 链接在内置浏览器打开。引用文件时给绝对路径,或相对当前工作目录的路径。

更新 golden(`desktop-full.md`、`minimal.md`、`_budget.json`)。

## 7. 分期

| 期 | 内容 | 产出/自证 |
| --- | --- | --- |
| **P0 解析+渲染** | `references/parse.ts` `autolink.ts`;`validateLink`/`link_open`/`code_inline` 三规则;CSS | `parse.test.ts`(表驱动 30+ 用例:各种行号写法、`~`、Windows 盘符、`javascript:` 拒绝、相对路径);`useMarkdownRenderer.test.ts` 新增 HTML 断言 |
| **P1 打开动作** | `open.ts` `dom.ts`;App.vue 注册 host;`openFile` 行号透传到 Monaco;URL → 浏览器 tab;web 降级;主进程 `file://` 兜底 | `dom.test.ts`(happy-dom 委托点击 + 修饰键);`RightWorkbenchPanel.test.ts` 加 `openFile(path,{line})`;`external-links.test.ts` 加 `file://` 用例;`useBrowserStore` mock 断言 `openTab` |
| **P2 提示词** | `references.md` + 表条目 + golden | golden 更新 + `prompt-golden.test.ts` 绿 |
| **P3 扩展面**(可选,按需) | 正文裸路径 autolink;工具结果卡片里的路径复用 `openReference`;右键菜单(复制路径 / Finder 显示 / 外部打开);EditorWorkbench 图片分支 | 各自单测 |

P0–P2 一起交付,P3 拆条按需。真机走查只留审美项(图标/hover 态),功能靠脚本级自证。

## 8. 风险与决定

- **误链接化**:只在行内代码里 autolink 是有意的保守;正文裸路径放 P3。裸绝对路径(行内代码与将来的正文同一把尺)须**已知根**(`/Users /home /root /tmp /private /var /etc /opt /usr /bin /sbin /dev /mnt /srv /Volumes /Applications /Library /System`)、或带扩展名、或带行号 —— 否则 `/api/files/read` 这类 HTTP 路由会被当文件(实施后 review 补的判据)。相对路径须带扩展名或行号。
- **`href` 改写为 `#`**会让"复制链接地址"拿到 `#`;右键菜单(P3)补"复制路径"。接受。
- **相对路径解析依赖会话工作目录**:host 的 `resolveRelative` 从 workspace store 拿当前会话 workDir;拿不到就当不存在处理。
- **web 宿主**:文件可开(有 `/api/files/read`),浏览器退化为新标签页;这是能力差异不是 bug。
- **安全**:`data-ref` 里的路径来自模型输出,渲染时只打标不读文件;读文件仍走已有 `readFileContent` IPC(其自身有大小/编码兜底)。`file://` 锚点不再可导航。
- **性能**:`findPathSpans` 只跑在 `code_inline`(短文本),正则常数级;流式渲染无额外 DOM 观察者。

## 9. 不在范围

`onething://session/<id>#<msg>`(无生产者)、工具调用/轨迹/媒体/Todo/设置/变量引用、"在终端运行"按钮、hover 预览、存在性预取。表已按 scheme 留好行,加一行是几十行改动。

## 10. 实施记录(2026-08-19)

- 落地文件:`packages/renderer/references/{parse,autolink,open,dom,index}.ts` + 三份测试;`useMarkdownRenderer.ts`(validateLink / link_open / code_inline / 委托点击安装);`styles/markdown.css`;`markdownRenderCache.ts` 版本 7→8;`App.vue`(`createReferenceHost`,仅主窗);`RightWorkbenchPanel.openFile(path, position)` → `EditorWorkbench :initial-position` → `MonacoEditor.revealPosition`;`external-links.ts` + `renderer-targets.isElectronRendererIndexFileUrl`;`prompts/content/references.md` + builder 条目(order 450)+ golden 重生成。
- 与 §2–§5 的偏差:① `~/` 渲染端没有 home 可展开(platformApi 无此口),点击提示"无法解析路径",待补一个 host 端口;② 行内代码 autolink 按空白切 token,含空格的路径不 autolink(显式 `[]()` 仍可);③ `data:image/…` 链接返回 null(不打标),不交给 openExternal;④ 图片走已有 `platformApi.openImagePreview(file://…)`,不需要全局灯箱;⑤ `ReferenceHost` 比 §3 多 `openFolder / openImage / notify` 三个可选成员。

