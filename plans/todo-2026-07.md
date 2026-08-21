# TODO（已分类排期 2026-07-29）

> 2026-07-29 执行记录：第一批、第二批、第三批全部完成；第四批完成 #11 / #12 / #13。
> 未做：#5（你自己标注最后做）、第五批（待定义）。
> 验收：typecheck 全绿、5025 tests 全绿、boundary:gate 无新增、构建通过。全部未提交。
> #13 只做了静态验证，需真机拖一遍确认（见该条末尾）。

## 第一批 · P0 发布阻塞（立即）

### 14. 打包后的应用无法运行 ✅

**根因不是排除规则**，也和 `npmRebuild: false` 无关。

仓库同时有 `bun.lock` 和 `package-lock.json`，electron-builder 26.x 的
`detectPackageManagerByFile` 要求"恰好一个"锁文件，两个就退回环境变量探测；
`bun run build:mac` 会带进 `npm_config_user_agent=bun` → 选中 `BunNodeModulesCollector`。
该 collector 覆写的 `isProdDependency` 用 `tree.dependencies` 而不是 `tree._dependencies`，
而 npm 树里"重复依赖"节点的 `dependencies` 恰恰是空的 → 它的整棵子依赖被过滤掉。

用 electron-builder 自己的 collector 实测（真值 = 按 node 解析算出的 prod 闭包 304 个包）：

| collector | 收集到 | 缺失 |
| --- | --- | --- |
| npm | 304 | **0** |
| bun | 239 | **95**（fast-deep-equal / fast-uri / express / body-parser / jose / orderedmap …） |

`fast-deep-equal` 只是第一个炸的，后面还有 94 个 —— 已发布 asar 里正好 239 个模块目录。

修复：新增 `scripts/run-electron-builder.mjs`，抹掉 `npm_config_user_agent` / `npm_execpath`
强制走 npm 采集器，并在打包前预检闭包完整性（缺任何一个直接失败）。`build:mac/win/linux/unpack`
改走该包装器。重打后 asar 从 239 → **304** 个模块，缺的全部就位。

## 第二批 · 高频交互 bug（体验止血）

### 1. 滚动失效 ✅

根因一处：`CollapsePanel` 的 `.collapse-panel-content` 同时写了 `overflow: hidden` 和
`overscroll-behavior: contain`。Chrome 把这种"自己滚不动"的盒子也当成 scroll container，
滚轮既滚不动它、也不再往外层链——落在面板里的 think 正文、markdown 表格、工具结果区
就全成了死区。真浏览器实测：

| 组合 | 外层列表滚动量 |
| --- | --- |
| `hidden` + `contain`（原样） | **0** |
| `hidden` + `auto` | 200 ✅ |
| `clip` + `contain` | 200 ✅ |

这也解释了为什么 ToolStepDetails / ToolResultRenderer / ToolContentPreview 各自挂了一份
`chainWheelToScrollableAncestor` 的 JS 补丁——它们在绕这个坑。

修复：删掉 `overscroll-behavior`（保留 `overflow: hidden`，不动 BFC/布局）。
守卫测试 `packages/renderer/styles/__tests__/wheel-dead-zone.test.ts`，已验证把 bug 塞回去会红。

### 2. inputbox 多行输入与历史记录键冲突 ✅

根因：首/末行判断按 `\n` 数**逻辑行**，而输入框开着软换行。长文本折行后光标停在中段
仍被判成"第一行"，按上直接把草稿换成历史记录。

修复：改成按**视觉行**判断——新增 `EditorHandle.getVisualLineEdges()`，CodeMirror 用
`coordsAtPos` 比行高；拿不到坐标（jsdom / 未挂载）退回逻辑行。

### 3. todo markdown 渲染 ✅

1. **光标丢失 / 左移** —— 输入规则本身没问题（headless 驱动 inputRules 测过，状态层落点全对）。
   问题在 `prose/offset-map.ts`：草稿偏移靠"取光标前 12 个渲染字符去草稿里找同名出现"，
   而渲染文本里没有 `**` / `` ` `` 这些标记，于是偏移左移；块首前面没有渲染字符时 context
   为空，直接 `return draft.length` —— 光标被甩到文末。
   改成**插哨兵**：把一个私有区字符插到光标处整篇序列化一次，哨兵下标就是精确偏移；
   反向用二分（偏移随位置单调不减）。哨兵带 `$pos.marks()`，所以光标在加粗 run 内部时
   偏移落在标记内部（`abc **1|**` 而不是 `abc |**1**`）。
2. **方框偏高** —— `top: calc(0.775em - 8px + 0.1em)` 里的 `em` 按元素**自己的** font-size
   解析，而同一条规则写了 `font-size: 11px`：0.775em 只有 8.5px，而不是半个行高的 11.6px，
   方框被顶高约 2px。改成 `calc((1em * var(--pm-note-line-height) - 16px) / 2)`，勾号的小
   字号挪到 `::after`，并显式 `font-size: inherit`（button 默认不继承字号）。实测 3.625px = 理想值。

## 第三批 · 清理减法

### 6+8. skills 系统瘦身 ✅

- `skill_view` / `skill_manage` 两个工具连同 `tools/builtin/skill.ts`、`app/tools/builtin/skill.ts`
  已删；三个工具 barrel 的 async 分支一并收掉。`skills/manage.ts` 保留 —— 技能复盘触发器和
  设置页仍在用它写文件。
- 复盘触发器的门从"有没有 skill_manage 工具"改成"有没有写文件的工具"
  （`skillAuthoringAvailable`），只读档(server readonly)因此仍然不会被提示去创建技能。
- Hermes 文件记忆整块关闭（你拍板的"整块关"）：不再注入提示词、`memory` 工具与
  `/memory remember` 下线、复盘目标收窄成 soul/dreams。USER.md / MEMORY.md 仍在盘上，
  memory 面板走通用文件 API 读盘，不受影响。门禁里那条"runtime 必须拥有 Hermes 文件记忆
  模块"的规则已作废并删除。

### 7. todo tool 已删但 AI 仍调用 ✅（调查结论）

全仓库没有任何 todo 工具的定义、注册或提示词引用。真因是 `prompts/content/todo-rules.md`
仍在指示模型 "Use `ls` on the notes directory"，而 `ls` 在上一轮工具裁减里已经删了
（注册表只剩 `find`）。模型照着提示词去调一个不存在的工具，看起来就像"已删的工具还在被调用"。
已改成 `find`，并核过提示词里其余点名的工具（read/edit/write/variable/find）都还在。

### 4. refresh 增加确认动作 ✅

两段式：第一次点只把按钮"上膛"（强调色 + 停在半圈 + tooltip 改成 "Click again to regenerate"），
第二次点才真的重来。指针移开这一行或 4 秒不动自动撤销。没有弹窗、没有新组件。
测试 `message/__tests__/regenerate-confirm.test.ts` 覆盖三条路径 × 两种角色。

## 第四批 · 功能增强

### 13. traffic lights / tab header 拖拽 ✅（改成单一 drag 祖先）

现象：侧栏收起时，按钮之外、红绿灯之外的空白拖不动。

根因是**拖拽层被拆在三个 DOM 分支里**。Chromium 只让 drag 元素的**子孙**用 `no-drag` 挖洞，
跨分支的 fixed 浮层挖不动：

| 分支 | 是什么 | app-region |
| --- | --- | --- |
| `.tab-bar`（面板树里） | 真正的顶栏 | `drag` |
| `.app-sidebar-actions`（`.app-content` 里的 fixed 浮层） | 三颗按钮 | `no-drag` |
| `.app-sidebar-actions::before` | 100vw×40px 的假带子 | `drag` |

第 2 层挖不进第 1 层，于是顶栏只能**按坐标手工预留**一块 `no-drag`
（`width:160px; padding-left:84px`，靠 border-box 算出内容盒恰好 `x∈[84,160]`），
再拿第 3 层把浮层够不着的红绿灯段补回来。这套数字同时写死在三处：`App.vue` 的
`SIDEBAR_ACTION_COLLAPSED_LEFT=84`、`TabBar.vue` 的 `84/160`、`main-window.ts` 的
`MAIN_TRAFFIC_LIGHT_POSITION`。

**预留的是坐标区间而不是控件本身**，所以按钮数、侧栏宽度、交通灯位置任一变化就错开：
错开处要么吃掉点击，要么变成拖不动的死带。实锤之一：`MediaPanel` 的同类槽是
`width:176px` 整块 `no-drag`（没有 TabBar 那个 padding 收窄技巧），按钮只占 `[84,160]`，
剩下全是死带；未预留时还留着 16px 的 `no-drag` 缺口 —— 两个宿主的洞根本不一样大。

修法：按钮改成各自 drag 宿主的**真实子孙** ——

```
header 行              drag
  ├─ 交通灯让位盒       （不带 app-region → 回退到 drag）
  ├─ 三颗按钮           no-drag
  ├─ 页签               no-drag
  └─ 缝隙               （自动可拖）
```

- 展开态住 `SidebarHeader`（新开 slot），收起态住 `TabBar` / `MediaPanel` 头部
- 两个槽都去掉 `no-drag`，只留一个不带 app-region 的交通灯让位盒
- 删掉 fixed 浮层、`::before` 假带子、`sidebarActionLeft` 与两个常量、两处预留宽度
- TabBar 本来就声明了 `toggleSidebar/openSearch/createNewChat` 三个 emit 却没人触发
  （按钮原本的家），事件链 TabBar→ChatWindow→ChatContainer→App 现成可用

守卫测试 `packages/renderer/styles/__tests__/drag-region-composition.test.ts`：拦住"预留槽"
这种写法回来。

⚠️ **这一版只做了静态验证**（typecheck + 5025 tests + lint 全过），没有跑真机 CDP 量
draggable region。请在两种侧栏状态 + 媒体面板开/关下各拖一次确认。

### 11. sidebar agent 收缩组件 ✅

Agent 执行会话分区改用现有的 `CollapsePanel`（`variant="plain"`，和 MessageThinking 同款
极简形态），默认收起，标题带条数 `Agent · N`，收着也知道有多少。没有新造组件。

### 12. agent 角色可配置 ✅

`title`（角色）和 `avatar`（头像）在数据模型、IPC、store 的 `patchOptional` 里本来就是通的，
房间花名册 / 消息署名 / 看板都在读，只是编辑器没给入口 —— 所以只能是 agents.json 里写死的
那份。已在 agent 编辑器 Name 下面补上 Avatar + Role 两栏；空串落成 `null` 才清得掉（后端
`patchOptional` 把 `undefined` 当"不改"）。

### 5. refresh 之后 < > 切换 ⏸ 未做

按你自己的排期："最后做，单独开工"。实质是 retry 多版本存储 + 消息树 UI，要动消息存储结构，
不适合和上面这批混在一起改。

## 第五批 · 待定义范围（做之前先明确）

### 9. 后台任务 preview 调用可配置
待明确：配置到什么粒度？

### 10. memory 梳理
待明确：梳理的目标是什么？（注：#6+8 已把 Hermes 文件记忆整块关掉，这一项的起点变了）
