# onething — Style Reference

> ink on paper, lit by a desk lamp at night
> 夜里台灯下的一页墨稿

**Theme:** `flexoki` · dark · accent `blue`（产品默认）
**Scope:** 本文只出**一套具体色值**（默认主题）。色值之下的 **token 逻辑与主题无关** —— 换主题换的是这张表里的值，不是这张表的结构。

---

onething 读起来像一本摊在台灯下的账本：底是 Flexoki 的暖墨灰（#282726），不是冷黑；正文用纸白（#F2F0E5）压在墨上，层级靠**四档明度不同的墨色**而不是透明度堆叠。它有一条罕见的排版主张——**标题用衬线（Lora + 思源宋），正文用无衬线（Public Sans + 思源黑）**，这让界面里的每一处标题都带一点书卷气，而不是又一个 SaaS 控制台。

它的深度语言是克制的：**内容面一律靠 1px 墨线分隔，只有真正浮起来的东西才有阴影**（全库 `--shadow-floating` 用了 16 次，其余九档合计 21 次）。圆角同样收敛，实际只在用三档：3px（绝大多数）、6px（控件）、999px（丸）。动效几乎只有一种手势——120ms + `cubic-bezier(.4,0,.2,1)`，全库 647 处引用同一条缓动。

它还有一件别处没有的东西：**整套 token 自带"浓度"行为层**。每一枚交互态 token 都是「墨 × 旋钮」的合成物，所以贴上壁纸时全站的 hover、选中、面底会成比例地一起变淡，而不需要任何组件知道壁纸的存在。

---

## Token 架构

这是本系统真正的骨架，也是它和一般 style guide 最不一样的地方：**颜色不是一张表，是四层管道**。

```
① 原色板  flexoki-colors.css
   --fx-base-50…950（13 档墨阶，明暗两套互为倒序）
   --fx-{red,orange,yellow,green,cyan,blue,purple,magenta}[-100…600]
                    ↓  只被 ② 引用，组件永不直接消费
② 语义字典  variables.css
   --bg-*（46）  --text-*（67）  --border-*（20）  --color-{danger,warning,success,info}-*
                    ↓
③ UI 语义层  themes/resolver.ts → SEMANTIC_UI_TOKENS（约 130 条 × 5 字段）
   --ui-<族>-<角色>-{fg,bg,border,ring,shadow}
   族：surface(19) text(9) border(6) action(9) state(7) status(4)
       sidebar(9) tabBar(8) message(7) tool(14) table(3) category(7×3) accent(2)
                    ↓  组件只写这一层
④ 行为层  state-alpha.css / state-alpha.ts
   --ot-ink-X（墨，实色） → --ui-X = color-mix(墨 × var(--ot-*-alpha), transparent)
```

**第 ④ 层是这套系统的特色。** 墨与成品必须异名（否则构成 `--x: var(--x)` 自引用环，整条静默作废）；旋钮必须与定义位同元素（所以 `--ot-state-alpha` 拨在 `html.has-wallpaper` 上，不是 `body`）。默认 alpha = 100% 时与实色逐像素相同，对无壁纸场景零开销。

### 四个正交维度

同一套 token 被四个互不干涉的开关调制：

| 维度 | 载体 | 取值 |
|---|---|---|
| 明暗 | `html[data-theme]` | `dark`（默认）/ `light` —— **无 `prefers-color-scheme` 跟随** |
| 强调色 | `html[data-color-theme]` | `blue`（默认）/ purple / green / orange / cyan / red / pink |
| 排版密度 | `html[data-typography-density]` | 默认 / `comfortable`（整体上移一档） |
| 壁纸 | `html.has-wallpaper` | 拨 `--ot-surface-alpha:18%` `--ot-state-alpha:45%` `--ot-active-alpha:60%` `--ot-frost-blur:6px` |

主题 JSON（18 套内置）在运行时经 `generateCSSVariables()` 写成 `documentElement` 的**内联样式**，盖过 `variables.css` 里的静态兜底。插件可覆盖 token，白名单即 `CSS_VAR_MAP`，合成点在 `resolveThemeUI` 之前——所以一次覆盖会让 `--ui-*` 语义层、`-rgb` 变体与色阶**一起重新派生**。

---

## Tokens — Colors

以下为 **flexoki · dark · blue** 的解析值。

### 面（Surfaces）

| 名称 | 值 | Token | 角色 |
|---|---|---|---|
| 墨底 Ink Ground | `#282726` | `--bg-app` / `--ui-surface-app-bg` | 应用画布，最底的一层，窗口本身的颜色 |
| 账页面 Ledger Ground | `#343331` | `--bg-sidebar` `--bg-chat` `--bg-panel` | 区域 chrome —— 侧栏 / 会话区 / 面板**三者同值**，靠墨线而非底色分区 |
| 抬升面 Raised Ink | `#403E3C` | `--bg-elevated` | 卡片、输入框聚焦态、被抬起来的块 |
| 浮层面 Floating Ink | `#575653` | `--bg-floating` | 菜单、下拉、popover 的底 |

> light 模式下这一梯**会塌**：`#e6e4d9`(app) → `#f2f0e5`(sidebar) → `#fffcf0`(chat/panel/elevated/floating **四者同值**)，实际只剩三层。

### 字（Text）

层级靠**四档不同的墨色**，不是同色不同 alpha。

| 名称 | 值 | Token | 角色 |
|---|---|---|---|
| 纸白 Paper | `#F2F0E5` | `--text-primary` / `--ui-text-primary-fg` | 正文、标题、主要内容 |
| 纸灰 Paper Dim | `#E6E4D9` | `--text-secondary` | 次要正文、说明行 |
| 灰烬 Ash | `#B7B5AC` | `--text-muted` | 标签、元信息、未选中导航 |
| 淡烟 Smoke | `#9F9D96` | `--text-faint` | 时间戳、占位符、描述行 |

### 线（Borders）

| 名称 | 值 | Token | 角色 |
|---|---|---|---|
| 墨线 Rule | `#575653` | `--border-default` | 默认边框——**本系统分隔内容的唯一手段** |
| 淡墨线 Rule Faint | `#403E3C` | `--border-subtle` / `--border-divider` | 分组线、表格行线、弱分隔 |
| 重墨线 Rule Strong | `#6F6E69` | `--border-strong` | hover 时的边框、需要站住的轮廓 |

### 色（Accent & Status）

| 名称 | 值 | Token | 角色 |
|---|---|---|---|
| 灯蓝 Lamp Blue | `#4385BE` | `--accent` / `--ui-accent-primary-fg` | **全系统唯一的主行动色**：主按钮、选中、焦点环、指示条 |
| 朱砂 Cinnabar | `#D14D41` | `--color-danger` | 破坏性操作、错误 |
| 琥珀 Amber | `#DA702C` | `--color-warning` | 警告、需要注意 |
| 苔绿 Moss | `#879A39` | `--color-success` | 成功、完成 |
| 铜绿 Verdigris | `#3AA99F` | `--color-info` | 提示、中性信息 |

强调色可整体换成 7 种之一（`--fx-{blue,purple,green,orange,cyan,red,magenta}-300`），换的是同一枚 `--accent`——**不是给某个组件单独上色**。

另有一组 **7 色分类轮** `--ui-category-1…7-{icon,badgeBg,badgeText}`，专供 Badge 与 Agent 头像等"需要互相区分但无语义高低"的场合，与 accent 互不干涉。

### 态（States）

| 名称 | 值 | Token | 角色 |
|---|---|---|---|
| hover 薄膜 | `rgba(255,255,255,0.04)` | `--bg-hover` → `--ui-state-hover-bg` | 悬停加深一档 |
| active 薄膜 | `rgba(255,255,255,0.08)` | `--bg-active` → `--ui-state-active-bg` | 按下 |
| 选中晕 | `rgba(67,133,190,0.15)` | `--bg-selected` → `--ui-state-selected-bg` | 选中——**accent 的淡底，不是灰底** |
| 选中 + hover | `rgba(67,133,190,0.20)` | `--bg-selected-hover` | 选中态**仍然要能再加深一档** |

---

## Tokens — Typography

### 字体族

| 角色 | Token | 栈 |
|---|---|---|
| 正文 / 标签 / 说明 | `--font-body` → `--font-sans` | Public Sans Variable · Noto Sans SC Variable · system-ui |
| 标题 / Display | `--font-display` → `--font-serif` | **Lora Variable · Noto Serif SC Variable** · Georgia |
| 代码 / 文件名 / 数值 | `--font-mono` | SF Mono · Fira Code · JetBrains Mono · Menlo |

**衬线做标题**是本系统最强的排版签名。中英配对固定成组（Public Sans↔思源黑、Lora↔思源宋），不允许单独换掉一半。

### 原子字号阶梯

| Token | 值 |
|---|---|
| `--type-size-100` | 10px |
| `--type-size-200` | 11px |
| `--type-size-300` | 12px |
| `--type-size-400` | 13px |
| `--type-size-500` | 14px |
| `--type-size-600` | 15px |
| `--type-size-700` | 16px |
| `--type-size-800` | 18px |
| `--type-size-900` | 20px |
| `--type-size-1000` | 22px |

> ⚠️ **阶梯封顶 22px。** 这是一个已知的结构性限制：系统内没有 display 层级，空态、引导、区块大标题物理上做不出压迫感。见文末《与实现的偏差》。

### 语义角色

每个角色 = 字号 + 行高成对定义。

| 角色 | size | line-height | Token 前缀 |
|---|---|---|---|
| display | 20px | 1.3 | `--type-display-*` |
| headline | 16px | 1.3125 | `--type-headline-*` |
| title | 14px | 1.2857 | `--type-title-*` |
| body | 14px | 1.5 | `--type-body-*` |
| label | 13px | 1.3077 | `--type-label-*` |
| meta | 12px | 1.4167 | `--type-meta-*` |
| caption | 11px | 1.3636 | `--type-caption-*` |
| micro | 10px | 1.2 | `--type-micro-*` |
| code | 13px | 1.5385 | `--type-code-*` |

**聊天正文独立成一档**，且带三级密度：`chat-compact` 14/1.4286 · `chat-comfortable` 15/1.6 · `chat-spacious` 16/1.8125，各自另有 `-line-height-px` 供需要整数行高的计算使用。

行高别名：`--type-leading-{none,control,title,meta,body,reading,code}`。

### 字重

| Token | 值 |
|---|---|
| `--font-weight-normal` | 400 |
| `--font-weight-medium` | 500 |
| `--font-weight-semibold` | 600 |
| `--font-weight-bold` | 700 |

### 字距

**无 scale token。** 现状是散落的字面量（`0.04em` / `0.05em` / `0.08em` 用于小字全大写标签）。大字号**没有负字距体系**——这是与成熟排版系统的明确差距。

---

## Tokens — Spacing & Shapes

**基数 4px。**

### 间距

| Token | 值 |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |
| `--space-10` | 40px |
| `--space-12` | 48px |

（跳过 7 / 9 / 11 档。）阅读列宽 `--content-measure: 46rem`，宽版 `--content-measure-wide: 56rem`。

### 圆角

| Token | 值 | 实际用量 | 用于 |
|---|---|---|---|
| `--radius-xs` | 3px | **73** | 本系统的默认圆角：chip、行、小面 |
| `--radius-sm` | 6px | 27 | 控件、菜单项 |
| `--radius-md` | 10px | 6 | — |
| `--radius-lg` | 16px | 4 | — |
| `--radius-xl` | 24px | 1 | — |
| `--radius-full` | 9999px | 15 | 丸：SegmentedPill、Switch 轨道、round 按钮 |

> 实际在用的只有 **3px / 6px / 999px 三档**。md/lg/xl 合计 11 次引用，可以视为死档。
> 另有一枚皮肤旋钮 `bubbleRadius`（`SKIN_KNOBS` 中唯一一枚），专管消息气泡圆角，插件递档位名、宿主查表给值。

### 阴影

| Token | 值 | 实际用量 |
|---|---|---|
| `--shadow-xs` | `0 1px 2px rgba(0,0,0,.2)` | 2 |
| `--shadow-sm` | `0 2px 4px rgba(0,0,0,.25)` | 1 |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,.3)` | 4 |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,.35)` | 5 |
| `--shadow-xl` | `0 16px 48px rgba(0,0,0,.4)` | 2 |
| `--shadow-inner` | `inset 0 2px 4px rgba(0,0,0,.15)` | 1 |
| `--shadow-elevated` | `0 8px 32px rgba(0,0,0,.4)` | 3 |
| **`--shadow-floating`** | `0 12px 48px rgba(0,0,0,.5)` | **16** |
| `--shadow-paper` | `4px 4px 0 color-mix(--border-strong 24%)` | 3 |

**立场：内容面不投影，只有浮起来的东西投影。** 分隔内容用 1px 墨线。`--shadow-paper` 是唯一的硬阴影（纸片错位效果），只在少数纸墨语境使用。

### 动效

| Token | 值 | 实际用量 |
|---|---|---|
| `--duration-fast` | 120ms | **405** |
| `--duration-normal` | 200ms | 245 |
| `--duration-slow` | 300ms | 28 |
| `--ease-default` | `cubic-bezier(.4,0,.2,1)` | **647** |
| `--ease-out` | `cubic-bezier(0,0,.2,1)` | 14 |
| `--ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | 5 |

**归档口径**：≤140ms → fast，150–250ms → normal，260ms+ → slow。系统实际只有一种手势：**120ms + ease-default**。弹性缓动被刻意压在 5 处。

### 层级（z-index）

| Token | 值 | 用于 |
|---|---|---|
| `--z-base` | 0 | 常规内容 |
| `--z-sticky` | 10 | 粘性表头、分组头 |
| `--z-ambient` | 50 | 环境装饰层 |
| `--z-dropdown` | 100 | 下拉、Select 面板 |
| `--z-sidebar` | 200 | 侧栏及其抽屉 |
| `--z-overlay` | 500 | 遮罩 |
| `--z-modal` | 600 | 对话框 |
| `--z-tooltip` | 700 | 提示 |
| `--z-toast` | 800 | 全局反馈 |
| `--z-max` | 9999 | 保留 |

**纪律**：只允许 `var(--z-*)`，禁 fallback；同档内相对顺序用 `calc(var(--z-x) + n)` 且 `n ≤ 30`；第三方库自带的高 z（Monaco 的 10000）用 `isolation: isolate` **收监**，绝不抬高 `--z-max` 去压它。

---

## Surfaces

四层实色梯，外加壁纸模式下的六级分档。

| 层 | 名称 | 值（dark） | 用途 |
|---|---|---|---|
| 0 | 应用画布 | `#282726` | 窗口本身。mac 下窗口 `transparent: true` + `titleBarStyle: 'hidden'` |
| 1 | 区域面 | `#343331` | 侧栏 / 会话区 / 面板——**同值**，靠墨线分区不靠底色 |
| 2 | 抬升面 | `#403E3C` | 卡片、聚焦输入框、被抬起的块 |
| 3 | 浮层面 | `#575653` | 菜单 / 下拉 / popover |

消费原语只开四档：`.app-surface[data-surface='app' | 'panel' | 'chat' | 'elevated']`。

**壁纸模式**另有六级半透明分档（`--ot-surface-alpha: 18%` 起），作用域 `html.has-wallpaper`；组件端**认章不认类名**——只引用 token，不检测壁纸是否开启。

---

## Interaction States

这是本系统治理最严的一轴，唯一出处表：

| 态 | 唯一出处 |
|---|---|
| hover 背景 | `var(--ui-state-hover-bg)` |
| selected 背景 | `var(--ui-state-selected-bg)` |
| active 背景 | `var(--ui-state-active-bg)` |
| 焦点环 | 工具类 `.u-focus-ring`；伪类**一律 `:focus-visible`**，禁裸 `:focus` |
| 过渡 | 必须 `var(--duration-*) var(--ease-default)`，禁字面时长 |

**两条铁律**：

1. **hover 与 selected 必须是两条正交的视觉通道。** 列表行不允许用"更深的底色"同时表达这两件事。画线风格的行用**左缘墨线**表达 selected，底色留给 hover；且 selected 态**仍须保留 hover 再加深一档**的能力。
2. **区域墨阶住在主题层**（`themes/role-mapping.ts` 的 `REGION_OVERLAY_STEPS`），组件端只引用，**不再自造 `color-mix`**。

---

## Layout

| 常量 | 值 |
|---|---|
| 主窗最小尺寸 | 600 × 600 |
| 侧栏宽度 | 300px（字面量，未 token 化） |
| 阅读列宽 | `--content-measure: 46rem` / `--content-measure-wide: 56rem` |
| 窗口装饰（mac） | `transparent: true` + `titleBarStyle: 'hidden'`；搜索窗 `frame: false` + `vibrancy: 'popover'` |

**工作区结构**：会话域 + 工作区域两段式 tab 栏（`RightWorkbenchPanel`）；工作区面板全部建在 `PanelShell` 上；**spinner 只允许出现在面板状态条里**。

响应式：断点尚未 token 化（现存 11 个不同的 `@media` 阈值），`@container` 仅 17 处使用。面板类组件应优先 `@container` 而非 `@media`。

---

## Iconography & Imagery

- **图标**：`lucide-vue-next`，88 个文件直接 import。无自研 Icon 组件。厂商标识走 `assets/provider-icons/`。
- **图标尺寸**：现状 10 档（10/11/12/13/14/15/16/18/20/28），主力 13–16px。**未 token 化**。
- **描边**：现状 5 种（1.6 / 1.8 / 1.9 / 2 / 2.2），主力 `stroke-width="2"`。
- **插画**：仅空态使用（`components/chat/empty-state-themes/`：DefaultTheme + 节日主题，由 `useHolidayTheme` 切换）。**无摄影、无 3D 渲染、无 stock 素材**——这条是既成事实，也应作为主张保留。

---

## Signature Devices

三个反复出现、构成本系统辨识度的手法。它们不是装饰，是**信息装置**。

### 图签 Frame Label

一枚小标签**骑在容器边框上**，用容器所在面的底色把线打断。工具详情框与输入框都用它。

```
┌──── ⟨ WRITE ⟩ ─────────────┐        ⟨…⟩ 处的底色 = --ui-surface-chat-bg
│                            │        标签本身：mono / 9–11px / weight 600–650
│                            │        letter-spacing 1.8–2px / uppercase
└────────────────────────────┘        位置：top: -7~-8px; left: 10~12px
```

### 尺规线 Ledger Rule

分组头不是一条底色带，是**一行文字后面拖一条 1px 横线**——账本画线的做法。
`.lgh-label`（10px / 700 / `letter-spacing .09em` / uppercase / faint）+ `.lgh-rule`（`flex:1; height:1px; background: var(--ui-border-subtle-border)`）。

### 编号列 Numbered Column

工具调用的每一步用 `counter` + `decimal-leading-zero` 起一个 `01 / 02 / 03` 的序号列（20px 宽，mono 11px），**静息时 opacity 0，鼠标进入时间线整体淡入**。

---

## Components

以下均为**实测配方**。值写字面量的地方即代码里就是字面量。

### Button

> 主行动。全系统唯一的填充色是 accent。

建在 BorderBox 上，涂装经 `--app-button-*` 变量传入。

| size | height | min-width | padding | radius | font-size |
|---|---|---|---|---|---|
| small | 28px | 60px | `0 10px` | 6px | 12px |
| **default** | **32px** | 72px | `0 13px` | 7px | 13px |
| large | 38px | 84px | `0 16px` | 8px | 14px |

共通 `font-weight: 650`、`line-height: 1`、`border-width: 1px`；`:active` 时内容 `translateY(1px)`；焦点环由 BorderBox 画，环色 `color-mix(tone 58%, transparent)`。

| type | 背景 | 文字 | 边框 |
|---|---|---|---|
| default | `--ui-action-secondary-bg`（回落 `--ui-state-hover-bg`） | `--ui-text-primary-fg` | `--ui-border-default-border` |
| **primary** | `--ui-action-primary-bg`（= accent） | `--ui-action-primary-fg` | transparent |
| success / warning / danger / info | `--ui-status-*-fg` | `--ui-status-*-on-fg` | 同背景 |

hover 一律走 `color-mix(tone 82–86%, --ui-text-primary-fg)`——**加白而不是换色**。

修饰：`plain`（10% 淡底 + 42% 边，hover 反转实心）· `dashed` · `text`（去壳，padding-x × 0.55）· `round`（999px）· `circle`（50%，宽=高）· `unstyled`（只留焦点环）。disabled = `opacity .52`。loading 换成 12/14/16px 的 spinner，`0.72s linear infinite`。

### BorderBox

> 全库边框 / 背景 / 圆角 / 焦点环的**唯一底座**。业务组件不自己画边框。

| prop | 取值 |
|---|---|
| `radius` | none / xs / sm / md（默认）/ lg / xl / full |
| `surface` | transparent（默认）/ panel / elevated / input |
| `tone` | default / subtle / strong / accent / success / warning / danger |
| `shadow` | none / xs…xl / inner / floating；**`shadow:none` 时 hover 自动升到 `--shadow-xs`** |
| `padding` | xs `--space-1` … xl `--space-6` |

焦点环是**双环**：`0 0 0 2px var(--ui-surface-app-bg), 0 0 0 4px var(--ui-state-focus-ring)`——先用画布色隔一圈再上主色，所以在任何底上都读得出来。

### Input

三档 variant，对应三种语境。

| variant | 形 | 用于 |
|---|---|---|
| **box**（默认） | `1px solid --ui-border-default-border` + `--ui-surface-input-bg`，radius 8px | 通用表单 |
| **ledger** | **radius 0**、透明底、边框 `--settings-rule` | 设置页的账页风表单 |
| **underline** | 只有 `border-bottom`，radius 0，`padding: 4px 0 5px` | 内联编辑、轻量字段 |

尺寸：small 30px / default 34px / large 38px（min-height）。box 聚焦时加 `0 0 0 2px color-mix(accent 24%, transparent)`；ledger 与 underline **不加阴影环**，只换线色。

### Select

触发器同 Input 三档。下拉面板：`max-height 268px`、`max-width min(360px, 100vw - 24px)`、`padding 3px 5px`、radius 8px、`box-shadow: var(--shadow-floating)`、z `calc(var(--z-dropdown) + 20)`。
选项行 `min-height 31px` / radius 6px / hover `--ui-state-hover-bg` / selected `color-mix(accent 11%)` + accent 字。
**ledger 档的选中改用左侧 `::before` 竖标，不涂底**——与画线风保持一致。

### Checkbox / Radio / Switch

| 控件 | 关键尺寸 |
|---|---|
| Checkbox·rule 档（默认） | 标记槽 `12px`，`::before` 是一条 `7px × 1px` 横线；选中变 `10px × 2px` 并转 accent |
| Checkbox·box 档 | 盒 15px（small 13px），勾用 `border-width: 0 2px 2px 0` + 旋转 45° |
| Radio | 环 10px，点 4px，未选 `opacity 0 / scale(.4)` → 选中 `1 / scale(1)` |
| Switch | 轨道 24×40（default）/ 20×32（small）/ 28×50（large），旋钮 18/14/22px，轨道 radius 999px |

Checkbox 默认档是**一条横线**而不是方框——这是账页语汇的一部分。

### Badge

| size | min-height | padding | font-size |
|---|---|---|---|
| xs（默认） | 17px | `0 5px` | 9.5px |
| sm | 20px | `0 7px` | 10.5px |

共通 `border-radius: 5px`、`font-weight: 750`、`text-transform: uppercase`、`line-height: 1`。
14 种 tone 分四族：neutral / accent / status(4) / **category-1…7**（走分类色轮，底 12% 边 28%）。

### Chip（StatusChip / FileChip）

| | 高 | padding | 形 |
|---|---|---|---|
| StatusChip | 24px | `0 9px` | `1px solid --ui-border-default-border`，radius `--radius-xs`，**透明底** |
| FileChip | 28 / 26px | `0 9px` | 边 `color-mix(--ui-border-strong-border 45%)`，radius `--radius-xs`，透明底，文件名用 **mono 11px** |

Chip 一律**空心**——填充留给 Badge 和主按钮。

### SegmentedPill

容器 `padding 2px` + `1px solid --ui-border-subtle-border` + radius full + `--ui-surface-input-bg`；段 `height 22px` / `padding 0 11px` / `font-size 11.5px`。
**选中段只换成 panel 底 + 主色字 + weight 600，不涂 accent 底。**

### Tabs

tab `min-height 34px` / `padding 0 14px` / `max-width 240px`；line 型指示条是 `::after` 的 2px accent 条，靠 `opacity 0 → 1` 切换。
active **只换字色**（`--ui-tab-bar-item-active-fg`），底色留给 hover。nav 下方 `1px solid --ui-border-subtle-border`。

### Dialog

| size | 宽 |
|---|---|
| sm | 400px（`useConfirm` 固定用这档） |
| md（默认） | 480px |
| lg | 600px |

| | default | **paper** |
|---|---|---|
| 圆角 | `--radius-lg` 16px | **0（方角）** |
| 边框 | `--ui-border-default-border` | `--ui-border-strong-border` |
| 背景 | `--ui-surface-elevated-bg` | `--ui-surface-app-bg` |
| 阴影 | `--shadow-elevated` | **`--shadow-paper`（硬阴影）** |
| header padding | `20px 24px` | `14px 18px 12px` |
| 标题 | `--type-headline-*` | **`--font-display` 衬线 15px** |
| 遮罩 | `rgb(0 0 0 / .6)` + `blur(4px)`（light 下 .3） | `color-mix(app-bg 55%)`，**无 blur** |

进出场：遮罩 `opacity`，面板 `scale(.98) → 1`，均 120ms `--ease-default`，**无位移**。`max-height: 85vh`。

### 菜单族（Popover / Dropdown / ContextMenu）

三档面，由 `popover-surface.ts` 统一发放：

| 档 | 背景 | 圆角 | 阴影 |
|---|---|---|---|
| floating（Popover 缺省） | `--ui-surface-floating-bg` | 6px | `--shadow-floating` |
| menu（Dropdown 缺省） | `--ui-surface-menu-bg` | 10px | `--shadow-floating` |
| elevated | `--ui-surface-elevated-bg` | 10px | `--shadow-elevated` |

**全族无箭头。** 定位默认 `bottom-start` / `offset 6` / `margin 8` / flip + clamp 皆开。进场 `opacity 120ms ease-default` + `transform 120ms **ease-spring**`，出场两者都回 ease-default——弹性只给"出现"。

菜单项：`padding 8px 12px` / radius 6px / `font-size 12.5px`；hover 时**同时**换底色**并点亮左缘 2px accent 竖条**。分隔线 `height 1px; margin 4px 6px`。分组小标题 `10px / 600 / .08em / uppercase / faint`。

### Tooltip

`padding 6px 10px` / radius 6px（字面量）/ `12px / 500` / `max-width min(260px, 100vw - 24px)` / `backdrop-filter: blur(8px)` / `--shadow-floating`。
背景用 `--ui-surface-menu-bg`——**2026-08-11 起不再反色**。5px 三角箭头（仅无自定义内容时）。
延迟 400ms；移向面板宽限 400ms，离开面板 120ms，面板光环 12px。过渡 200ms，无位移。

### Toast

底部居中，`bottom 24px`、`gap 8px`、`max-width min(520px, 100vw - 48px)`、`padding 12px 20px`、radius 10px。
停留：success 2600ms / info 3200ms / error 5000ms。进出 `opacity + translateY(12px)`，200ms。
状态只体现在**边框色与图标色**，不换底。

### PanelShell

> 所有工作区面板的骨架。**全应用唯一允许出现 spinner 的地方。**

| 部位 | 配方 |
|---|---|
| 控制条 | `padding 10px 14px 9px`，gap 8px，下边 `1px --ui-border-subtle-border` |
| 内容区 | `flex: 1`；`is-padded` → `padding 0 14px 16px` |
| 状态条 | `min-height 26px`，`padding 0 14px`，上边 1px 线，底 **`--ui-surface-sidebar-bg`**（比面板面低一档），**mono 10.5px** muted |
| spinner | 11×11，1.5px 环，700ms linear |

根元素**不涂底**，底色留给 Surface 档位决定。

### 账目行 / 分组头

| | PanelLedgerRow | LedgerGroupHeader |
|---|---|---|
| 几何 | `height 44px`，`padding 0 6px`，gap 10px | `padding 12px 0 6px`，gap 8px，baseline 对齐 |
| 分隔 | 下边 `1px --ui-border-subtle-border` | 尺规横线 `flex:1; height:1px` |
| 标题 | 12.5px primary | 10px / 700 / `.09em` / uppercase / faint |
| 次级 | mono 10px faint | mono 10px faint tabular-nums |
| **hover** | **面**：`--ui-state-hover-bg` | **墨**：只提字色，不涂底 |
| **selected** | **左缘墨线**：`inset 2px 0 0 accent` + 标题转 accent | — |

这一对是"hover 与 selected 两条正交通道"的标准实现。

### 会话行 SessionItem

`min-height 30px` / `max-height 44px` / `padding 6px 10px 6px 32px` / radius 7px / 行间 2px。
字：14px / 400 / 行高 20px。
hover = 底 `--ui-state-hover-bg` + 字提亮；selected = 底 `--ui-state-selected-bg` + 字重 500；
**selected + hover 显式再补一档**：`color-mix(active-fill 92%, --ui-text-primary-fg)`。
树线是 `1px dotted --ui-border-strong-border` 的 L 形（opacity .55），不是行左缘条。

### 消息气泡

| | 用户 | AI |
|---|---|---|
| 背景 | `color-mix(--ui-text-primary-fg 4%, transparent)` | transparent |
| 边框 | `color-mix(--ui-border-strong-border 52%)` | 无 |
| 圆角 | `--skin-bubble-radius`：sharp 0 / standard 3px / soft 10px / round 18px | 0 |
| padding | `--message-padding`（随密度 8/14/18px 档） | 0 |
| 最大宽 | `min(74%, 680px)`，`width: fit-content` | 100% |
| 正文字体 | **`--font-display` 衬线** | sans |

**AI 消息没有气泡**——它就是页面上的文字。只有用户发言被框起来。

字号两级派生：密度类给 14/15/16px，用户设置存在时内联覆盖，并由字号推出行高、段距（`×0.5`）、列表间距（`×0.4`）、标题上距（`×0.55`）。聊天内标题用 em 相对（h1 1.08em / h2 1.04em / h3 1em，weight 620）——**故意不做大**，正文流不允许被标题打断。

### 工具调用时间线

**没有卡片。** 整条时间线是一列带编号的行：

| 部位 | 配方 |
|---|---|
| 行 | `min-height 26px`，`padding 4px 8px 4px 4px`，**radius 0** |
| 行间 | `1px solid color-mix(tool-border 32%)`，仅 `> * + *` |
| 动作名 | mono 12px **weight 620** lowercase，`min-width 46px` |
| 目标名 | mono 12px weight 450，`margin-left 10px` |
| hover | 纯墨通道——提字色 + 文件名转 accent 加下划线，**全程无背景带** |
| 详情框 | `padding 13px 14px 10px`，**radius 0**，边 `tool-border 90%`，骑一枚图签 |

### 输入区 Composer

`background: transparent`（不是一块面）+ `1px solid color-mix(--ui-border-strong-border 52%)` + **radius 3px**。
宽度 `--chat-composer-width` → `--content-measure`（46rem）。
聚焦换线色 + `0 0 0 1px color-mix(focus-ring 28%)`；**命令态与转写态改 `border-style: dashed`**。
编辑区 `min-height 42px`，`--editor-font-size: 15px`。
工具条 `min-height 34px`，上边 1px 线，按钮 **radius 0、贴满高度**、`padding 0 11–12px`，标签 mono 11.5px / 600。
左上骑一枚 9px 图签。

### Table

外框 radius 8px；表头 **36px**（`HEADER_HEIGHT` 常量注入），11px / 700，底 `color-mix(--ui-text-primary-fg 4%)`；行 **40px**，内容盒 `padding 6px 10px`。
分隔**只有横线**，无竖线。hover / selected / current 三态分别走 `--ui-state-hover-bg` / `-selected-bg` / `-selected-hover-bg`。

### Markdown 正文

| 元素 | 配方 |
|---|---|
| 段落 | `margin-bottom: --content-paragraph-gap`（字号 × 0.5） |
| h1–h4 | `--type-headline-font/weight(600)/line-height(1.3125)`；**h1 1.4em / h2 1.25em / h3 1.1em / h4 1em** |
| 引用块 | 左 `2px solid color-mix(muted 42%)`，**透明底、radius 0** |
| 代码块 | 底 `color-mix(code-block-bg 62%, chat-bg 38%)`，边 55%，**radius 3px，无阴影**；头条 22px + 语言签 mono 10px `.14em` uppercase |
| 行内代码 | `padding 1px 4px`，radius 2px，底为代码块底再稀释 40%，`font-size .9em` |
| 表格 | `border-collapse: collapse`，格线 `--ui-border-subtle-border`，`padding 7px 12px`，偶数行 40% 表头底 |
| 图片 | `max 400×400`，radius 12px，hover `scale(1.02)` |

---

## Do's and Don'ts

### Do

- **底色分层，墨线分区。** 侧栏 / 会话区 / 面板同为 `#343331`，靠 1px 线划开——不要给相邻区域调不同底色。
- **一屏只有一个填充色块。** `--accent` 是唯一的填充行动色；其余行动一律用 default（描边）、plain（10% 淡底）或 text（去壳）。
- **hover 与 selected 走两条正交通道。** 底色归 hover，左缘墨线（或字色 / 字重）归 selected；selected 态**仍须能再加深一档**。
- **状态色只上边框和图标，不上底。** Toast、Chip、Badge-status 都遵守。
- **所有边框 / 圆角 / 焦点环经 BorderBox。** 业务组件不自己画壳。
- **所有浮层机制经原语层。** 定位、Teleport、z-index、遮罩、Esc、outside-click 全部归 `useFloatingLayer`；可 `Teleport to="body"` 的文件只有 9 个。
- **过渡一律 `var(--duration-*) var(--ease-default)`。** 默认取 `fast`（120ms）。
- **焦点用 `:focus-visible`**，画环用 `.u-focus-ring`。
- **第三方高 z 用 `isolation: isolate` 收监**，不要抬 `--z-max` 去压它。
- **面板用 `@container` 而不是 `@media`。**

### Don't

- **不要给内容面加阴影。** 分隔内容用 1px 墨线；阴影只属于真正浮起来的东西（`--shadow-floating`）。
- **不要用 `--radius-md/lg/xl`。** 实际语汇只有 3px / 6px / 999px 三档，其余是死档。
- **不要在组件里写 `color-mix` 造 hover。** 区域墨阶住在主题层 `REGION_OVERLAY_STEPS`，组件只引用。
- **不要写 `var(--ui-x, #fff)` 这类颜色字面 fallback**，别名链最多一层。
- **不要写字面 z-index / 字面过渡时长 / 原生 `<select>` / 原生 `confirm()` / `title=` 属性**——这五条由 `bun run ui:gate` 执法。
- **不要用渐变。** 系统是平涂 + 墨阶；仅消息气泡保留一处历史渐变变量。
- **不要把配置塞进工作区面板。** 配置形状的交互属于设置页；面板是给活内容的。
- **不要让 spinner 出现在状态条以外的地方。**
- **不要为聊天正文里的标题做大字号。** h1 也只有 1.08em——正文流不允许被打断。

---

## Quick Start

```css
:root {
  /* ── 面（flexoki · dark）───────────────────────── */
  --bg-app:        #282726;   /* 应用画布 */
  --bg-sidebar:    #343331;   /* 区域面：侧栏 / 会话 / 面板同值 */
  --bg-chat:       #343331;
  --bg-panel:      #343331;
  --bg-elevated:   #403E3C;   /* 抬升 */
  --bg-floating:   #575653;   /* 浮层 */

  /* ── 字 ────────────────────────────────────────── */
  --text-primary:   #F2F0E5;
  --text-secondary: #E6E4D9;
  --text-muted:     #B7B5AC;
  --text-faint:     #9F9D96;

  /* ── 线 ────────────────────────────────────────── */
  --border-default: #575653;
  --border-subtle:  #403E3C;
  --border-strong:  #6F6E69;

  /* ── 色 ────────────────────────────────────────── */
  --accent:         #4385BE;  /* 唯一主行动色 */
  --color-danger:   #D14D41;
  --color-warning:  #DA702C;
  --color-success:  #879A39;
  --color-info:     #3AA99F;

  /* ── 态 ────────────────────────────────────────── */
  --bg-hover:           rgba(255,255,255,0.04);
  --bg-active:          rgba(255,255,255,0.08);
  --bg-selected:        rgba(67,133,190,0.15);
  --bg-selected-hover:  rgba(67,133,190,0.20);

  /* ── 字体 ──────────────────────────────────────── */
  --font-sans:  "Public Sans Variable", "Noto Sans SC Variable", system-ui, sans-serif;
  --font-serif: "Lora Variable", "Noto Serif SC Variable", Georgia, serif;
  --font-mono:  "SF Mono", "Fira Code", "JetBrains Mono", Menlo, monospace;
  --font-body:    var(--font-sans);
  --font-display: var(--font-serif);   /* 标题用衬线 —— 本系统的排版签名 */

  /* ── 字号阶梯 ──────────────────────────────────── */
  --type-size-100: 10px;  --type-size-200: 11px;  --type-size-300: 12px;
  --type-size-400: 13px;  --type-size-500: 14px;  --type-size-600: 15px;
  --type-size-700: 16px;  --type-size-800: 18px;  --type-size-900: 20px;
  --type-size-1000: 22px;

  --type-body-size:    var(--type-size-500);  --type-body-line-height:    1.5;
  --type-label-size:   var(--type-size-400);  --type-label-line-height:   1.3077;
  --type-meta-size:    var(--type-size-300);  --type-meta-line-height:    1.4167;
  --type-caption-size: var(--type-size-200);  --type-caption-line-height: 1.3636;

  --font-weight-normal: 400;   --font-weight-medium: 500;
  --font-weight-semibold: 600; --font-weight-bold: 700;

  /* ── 间距（基数 4px）──────────────────────────── */
  --space-1: 4px;   --space-2: 8px;   --space-3: 12px;  --space-4: 16px;
  --space-5: 20px;  --space-6: 24px;  --space-8: 32px;  --space-10: 40px;
  --space-12: 48px;
  --content-measure: 46rem;

  /* ── 形 ────────────────────────────────────────── */
  --radius-xs:   3px;    /* 默认 */
  --radius-sm:   6px;    /* 控件 */
  --radius-full: 9999px; /* 丸 */

  /* ── 深度：只给浮层 ────────────────────────────── */
  --shadow-floating: 0 12px 48px rgba(0,0,0,0.5);
  --shadow-elevated: 0 8px 32px rgba(0,0,0,0.4);

  /* ── 动 ────────────────────────────────────────── */
  --duration-fast:   120ms;   /* 默认 */
  --duration-normal: 200ms;
  --duration-slow:   300ms;
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring:  cubic-bezier(0.34, 1.56, 0.64, 1);  /* 只给"出现" */

  /* ── 层 ────────────────────────────────────────── */
  --z-base: 0;      --z-sticky: 10;    --z-ambient: 50;   --z-dropdown: 100;
  --z-sidebar: 200; --z-overlay: 500;  --z-modal: 600;    --z-tooltip: 700;
  --z-toast: 800;   --z-max: 9999;
}
```

---

## 附：文档与实现的偏差

本文描述的是**系统应有的样子**。截至 2026-08-15，实现与它的距离如下：

| 维度 | token 采用率 | 现场漂移 |
|---|---|---|
| 颜色 | ~95% | 10741 处 `var()` vs 564 处字面量 ✅ |
| 动效 | 91% | 342 条 transition 中 311 条走 token ✅ |
| z-index | 100% | `ui:gate` 零违规 ✅ |
| 圆角 | 20% | 19 种字面量在用 |
| 字号 | **14%** | **28 种字号** |
| 行高 | — | **41 种**，含 `1.3846` `1.4167` `1.8125` 等像素凑数 |
| 字重 | — | 8 种（含 520 / 560 / 620 / 650） |
| 内边距 | **5%** | 369 种字面量组合 |
| gap | **4.3%** | — |
| `--space-*` | **0.3%** | 1882 处间距声明里只有 6 处走阶梯 |
| 图标尺寸 | 0% | 10 档（10–28px），描边 5 种 |
| 断点 | 0% | 11 个不同 `@media` 阈值；`@container` 仅 17 处 |

另有三项结构性缺口：

1. **字号阶梯封顶 22px**，系统内不存在 display 层级——87% 的字号落在 9–13px，`≥18px` 全仓仅 18 处（其中 4 处在春节彩蛋主题里）。空态、引导、区块标题物理上做不出层级。
2. **共享 Button 与裸 `<button>` 打平**：337 处裸写（分布 89 个文件，其中 74 个完全不引 Button）对 331 处共享。
3. **没有可见的系统**：无 Storybook、无组件展示页、`components/common/` 无 barrel，唯一的 `VirtualTable.example.vue` 是死代码。

棘轮现状：`ui:gate` 绿（81 条已知违规，零增零减），其中 76 条是 `surface-literal` 存量，自 2026-08-13 起未推进。

---

*相关文档：`docs/design/ui-system.md`（禁令与执法）· `docs/audit/ui-production-gap-audit-2026-07-22.md`（差距审计）· `docs/theme-ui-semantic-token-map.md`（token 映射表）*
