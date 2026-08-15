# design-sync 笔记

## 2026-08-15 · 首次同步

目标项目：**onething Tokens** `978b192f-93c2-4aa9-867a-084ab64985bd`
构建：`node .design-sync/build-tokens.mjs` → `ds-bundle/`（30 文件 / 644K）

### 为什么没走官方转换器

`design-sync` 的 package 与 storybook 两条转换器都要求 React 设计系统。本仓库三条硬性不匹配：

1. **Vue 3**，零 React —— 子技能 `non-storybook/SKILL.md:262` 明说 "a non-React DS has
   nothing for the claude.ai/design agent to build with"。就算硬打出 bundle，那边的
   React runtime 也 import 不了、render 不出。
2. **无 `dist/`** —— 五个 package 全都没有构建产物；renderer 是 `"private": true`，
   被 electron-vite / apps/web 直接吃源码。
3. **无 barrel 导出** —— `components/common/` 没有 index，全靠深路径 alias import，
   没有可枚举的具名导出面。

故改为**部分同步**：只出样式面（token / 字体 / 规范），不出组件 bundle、`.d.ts`、预览卡。
相应地也没有 `_ds_sync.json` 锚点 —— 无组件可哈希，下次全量重建即可，这是有意的。

### 唯一的语义改造：`tokens/defaults.css`

onething 把颜色全挂在 `[data-theme]` / `[data-color-theme]` 上，裸 `:root` 上一枚语义颜色都没有
（宿主 `packages/renderer/main.ts` 启动时写这两个属性）。claude.ai/design 渲染的页面不带它们。

选择器是**被实测逼出来的**，踩过两个坑：

| 写法 | 特异性 | 结果 |
|---|---|---|
| `:where(:root)` | (0,0,0) | ✗ 压不过 flexoki-colors.css 写在真 `:root` 上的**亮色**墨阶 —— 实测裸页面出亮色 |
| `:root` | (0,1,0) | ✗ 与 `[data-theme="light"]` 同级，靠源序决胜，会顶掉亮色主题 |
| **`:root:not([data-theme])`** | (0,2,0) | ✓ 没设属性时压得过 flexoki 的 `:root`；设了属性则**根本不匹配** |

还有一层：`variables.css` 的 dark 块写的是 `var(--fx-base-100)` 这类**引用**，
所以兜底必须**连 Flexoki 墨阶一起**重发（31 枚），只搬语义层会解析到亮色原色板上。

### 真机验证（Playwright）

裸状态逐值等于 dark（`--bg-app #282726` / `--text-primary #F2F0E5` / `--accent #4385BE`）；
`data-theme="light"` 正常切亮（`#e6e4d9` / `#575653`）；`data-color-theme="purple"` → `#8B7EC8`；
18 个抽验 token **零空值**；Public Sans + Lora 两族均 `loaded`；视觉抽查衬线标题 / 墨线 / 主按钮全对。

### 字体

只带拉丁两族（Public Sans + Lora，20 woff2 / 0.4MB）。
中文 Noto Sans SC + Noto Serif SC 是 **202 个分片子集 / 10.4MB**，体积不成比例，未分发；
字体栈保留名字，落到系统中文字体。中文标题因此回退系统宋体 —— 已知且接受。

### 规范头有自动校验

`.design-sync/conventions.md` 会被塞进设计 agent 的系统提示，写错名字比不写更糟
（agent 会照写不误然后静默产出无样式界面）。构建器末尾硬校验其中点名的每个 token 与类名，
不通过 `exit 1`。当前：**49 枚 token + 24 个类名全部存在**。

两条提取规则：尾部带连字符的忽略（那是 `--ui-sidebar-*` 通配符或 markdown 的 `---`）；
打了 ⛔ 的行忽略（那是反例，"不要发明 `.card`" ——它们不存在正是本意）。

---

## 已知的另一个项目：不要碰

`4a2f39d4-4b0e-48d2-8fb6-e7a8c7e7c3d5` **onething Design System** 是一套**手写的 React 再创作**
（Button / Badge / Card / Input / Switch / ToolCall 六件 + 约 60 枚近似 token），
不是从本仓库源码生成的。2026-08-15 明确决定：**不动它**，另开 `onething Tokens`。

若将来要合并，先修这三处，否则 token 再准也会教错设计 agent：

- **7 枚自造 token** 本系统没有：`--bg-code` `--bg-tool` `--bg-overlay` `--text-inverse`
  `--text-on-accent` `--accent-strong` `--color-accent-purple`（换 token 层会让其组件丢样式，
  需垫片映射）。其余 33/40 名字与真 token 集兼容。
- **`Card` 自带阴影**，违反头号禁令「内容面不投影」；且真系统根本没有通用 Card 组件。
- **`ToolCall` 画成带阴影的紫色卡片**，而真实现是**无卡片**的 radius-0 编号行、
  hover 走纯墨通道全程无背景带、工具名 mono 12px weight 620 lowercase。

其默认档是**亮色**，与产品默认（`packages/shared/defaults/settings.ts:485` `theme: 'dark'`）相反。

## 待办 / 下次注意

- `ds-bundle/` 是构建产物，已进 `.gitignore`；改样式后重跑构建器即可。
- 上游若新增 `packages/renderer/styles/*.css`，构建器的 `COPY` 数组要同步加，否则漏传。
- 规范头（`conventions.md`）**内容归作者**，下次同步不要重写；只重跑校验、报告失效的名字。
