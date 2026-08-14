# UI 系统查表卡

写 UI 时翻这一页。方案与理由在 [ui-system-consolidation.md](./ui-system-consolidation.md);这里只有结论。
**本页每条禁令都由 `bun run ui:gate` 执法** —— 存量在基线里,新增会被挡下。

---

## 1. 我要做一个 X → 用哪个

| 想做的东西 | 用 | 状态 |
|---|---|---|
| 悬停提示 | `components/common/Tooltip.vue` | 已有,**别再写 `title=`**;不能套壳的位置走下面的 `trigger-el` 写法 |
| 锚定在某元素旁的面板 | `components/common/Popover.vue` | 已有(P1) |
| 菜单(含右键) | `components/common/Dropdown.vue` / `ContextMenu.vue` | 已有(P1;ContextMenu = Dropdown 的坐标触发包装) |
| 确认框 / 表单弹窗 | `components/common/Dialog.vue` + `composables/useConfirm.ts` | 已有(P2)。**别再写 `.dialog-overlay`/`.dialog` 全局类**,它们只剩存量 |
| 通知条 | `composables/useToast.ts` | 已有(P2);皮肤仍是 components.css 的 `.toast` |
| 下拉选择 | `components/common/Select.vue` | 已有,**别用原生 `<select>`** |
| 多选 | `components/common/Checkbox.vue` | 已有(P3);默认 `variant="rule"` 挂线 tick,支持 `indeterminate`。**无标签的密集行(表格选择列)传 `variant="box"`** —— 15px 有框方块、选中填色打勾,对齐它替下来的原生 `accent-color` 方块的辨识度(P3-B 实测:裸 7px 挂线在无标签行读不出"可选中",像分隔线)。行内对齐由组件自己 `align-items: center` 解决,表格不要用 `:deep()` 去够它 |
| 单选 | `components/common/Radio.vue`(+ `RadioGroup.vue`) | 已有(P3);墨环+点。组可选,单个 `v-model` 也成立 |
| 开关 | `components/common/Switch.vue` | 已有,别自绘。设置区传 `variant="ledger"` |

**Tooltip 的 detached 用法(`trigger-el`)—— 组件根 / 截断块的标准解。**
`<Tooltip>` 默认要求把触发元素**包进**它的 `.tooltip-wrapper`(`display: inline-flex`)。
包不得的场合有三类,它们正是 `title=` 存量最后赖着不走的地方:

1. **组件根元素**(`Badge`、`FileChip`):套一层 wrapper 会把 wrapper 变成父级 flex/grid 的子项,
   吃掉 gap、打乱负 margin 拼接;
2. **行内的一枚 chip**(`Select` 的 `+N` 计数标签):同上,行内节奏会被顶开;
3. **被截断的整块**(`CollapsePanel` 的元信息条):触发区就是这个块本身,没有"外面"可套。

写法:给元素一个 ref,把它交给 `trigger-el`,Tooltip 放在**元素内部**当兄弟节点即可 ——
`.tooltip-wrapper-detached` 是 `display: none`,自身不占位,只留传送到 body 的浮层。

```vue
<span ref="badgeRef" class="badge">
  {{ label }}
  <Tooltip :trigger-el="badgeRef" :text="title || label" />
</span>
```

组件根是 `<Button>` 之类的**组件**时,ref 拿到的是实例,取 `.$el`:
`const el = computed(() => (btnRef.value?.$el as HTMLElement) ?? null)`(见 `AllowSplitButton.vue`)。
其它现成例子:`SessionItem.vue`(整行做触发区)、`Sidebar.vue`(rail 按钮)、`GoalStatusBar.vue`。

**仍然保留 `title=` 的地方(P5 逐个查过,不是漏网):**

| 位置 | 理由 |
|---|---|
| `MenuItem.vue` / `SubMenu.vue` 的 `:title="title \|\| undefined"` | 这里的 `title` **就是菜单项自己的可见文案**(同一个 prop 渲染成 label),原生 title 在这只当"截断了才浮出来"的兜底。换成 Tooltip = 每划过一行都弹一次样式化气泡,复述用户已经看见的字,比现状更吵;而且菜单本身是浮层,再叠一层浮层要处理 z 序与 Esc 栈 |
| `<iframe title="…">` | 是嵌套浏览上下文的**可及名**,不是 tooltip。检查器已豁免(与 `img`/`abbr`/`svg`/`title` 同列) |
| `Dialog` 的 `title` prop | 属性名恰好叫 title,渲染成标题栏文案。检查器按组件名豁免 |

**图标钮没有可及名 ≠ 有 Tooltip 就够了。** Tooltip 是视觉悬停提示,不进可及性树;
纯图标按钮必须另外写 `aria-label`(P5 补了 `MessageActions` 11 处、`MCPServerItem` 3 处)。

**表单控件的三个"皮肤"**(P3 起由组件自己出,不许消费者用 scoped 规则重画 ——
根元素上的类和组件自己的规则同为 (0,2,0),平局归注入顺序):

| 场景 | Select | Switch |
|---|---|---|
| 聊天/面板 | `variant="box"`(默认,圆角输入面) | `variant="pill"`(默认) |
| 设置区 | `variant="ledger"`(方角发丝框,= SettingsPage `:deep(select)` 画的那个) | `variant="ledger"`(虚线轨+空心环 → 实线+实心点) |
| 纸墨对话框/房间表单 | `variant="underline"`(线即控件) | —— |

**列表行的两种状态不能是同一种记号。**
`hover`/键盘 active 是**瞬时**的,`selected` 是**持久**的;两者若都画成满底色块,紧邻时
各自的圆角会被邻居的直边填平,渲染成一整条通板,行与行读不开(真机报告:复合器的
permission 选择器)。规则:

- **所有列表行留 2px 缝**:行上 `margin-block: 2px`,面板 block padding 相应减去。
  注意面板是普通块容器,**相邻行的纵向 margin 会合并**取大值 —— 写 `1px` 得到的是
  1px 缝而不是 2px(实测)。
- **面 register(box)**:两态都可以是底色块 —— 有 2px 缝 + ✓ 就够读。
- **画线 register(ledger / underline)**:`selected` **不画底色**,改左缘 2px 墨线 +
  主色字(与 `sidebar-entry.is-active` 的 `inset 2px 0 0 accent`、`.member-line.is-on`
  同一套说法);`hover` 保留淡底。两条通道正交,所以紧邻可读,且同一行可以同时是
  "选中的 + 手正指着的"。
- **选中行必须保留 hover 反馈**:`selected` 不是"这一行不再响应指针"。两态各自成立
  还不够,**叠在同一行时也要看得出手指着它** —— 否则选中行就是死区(真机报告:
  Select 的 box 变体,`.selected` 写在 `:hover` 之后、同为 (0,2,0),底色块把 hover
  整个吞掉)。做法:`selected:hover` / `selected.highlighted` 在 **selected 自己的底**
  上加深一档,配方是"往对立色调混" ——
  `color-mix(in srgb, <selected 底> 92~94%, var(--ui-text-primary-fg))`,与全局
  `.btn.primary:hover` 同一个说法。**禁止写死 alpha 或 hex**:`--ui-text-primary-fg`
  在浅色主题是深的、深色主题是浅的,所以"更深一档"两边都成立;单纯抬 accent 的 alpha
  在深色主题里几乎不动(实测 One Dark 下 `--ui-state-hover-bg` 只比面板亮 5 级)。
  画线 register 同理 —— `hover` 的淡底照旧画在墨线**下面**,两条通道不互相取消。
  这一档要贴着 `selected` 的静息态写(共享一个自定义属性),别让两处数值各自漂移。
- **键盘 active 与鼠标 hover 是同一视觉通道**:几何只写在基类上,状态只改 paint,
  两者共用一条选择器 —— 别给其中一个单独加内外边距。加深一档也照此办理:
  `:hover` 与 `.highlighted` 必须挂在同一条规则上。
- `Dropdown.vue` / `Mention.vue` **不需要这条缝**:它们只有瞬时态(`ContextMenuItem`
  没有 `selected`),两行不可能同时上色。菜单按惯例就是紧排的,别去加缝。

**铁律:业务组件不写浮层机制。** 定位、Teleport、z-index、遮罩、Esc、outside-click 归原语层;
业务组件只给内容。P1 起唯一的定位内核是 `composables/floating/useFloatingLayer.ts`
(纯几何在同目录 `compute-position.ts`,有单测),`Popover.vue` 是它的薄壳,`Dropdown.vue`
是 Popover 的菜单特化。可以 `<Teleport to="body">` 的文件只有 `common/` 下这几个:
`Popover.vue`、`Dropdown.vue`、`ContextMenu.vue`、`Dialog.vue`、`Tooltip.vue`、
`Select.vue`、`Mention.vue`、`ImagePreview.vue`、`Table.vue`。(Teleport 到自定义容器不算浮层机制,不受限。)

**Dialog 不是 Popover 的特化**:它不锚定任何元素,自己居中,所以没接定位内核 ——
共用的只有焦点管理(`composables/floating/useFocusTrap.ts`,P2 从内核里抽出来的,
两边同一份 Tab 算术)。两个变体:`default`(圆角、elevated 面、黑色遮罩)与
`paper`(方角、app-bg 面、`--shadow-paper`、遮罩是 app-bg 的淡洗 —— 设置区用它)。
尺寸、内边距、遮罩色都走 `--app-dialog-*` 自定义属性;**这些属性写在 `:style` 上,
Dialog 把 `style` 挂在遮罩(根)上**,因为自定义属性只向下继承 —— 挂在面板上时
`--app-dialog-overlay-bg` 会静默失效。`class` 仍然落在面板上。

**scoped 与全局同名 = 靠注入顺序活着的平局(P2 实测事故)。**
一条 scoped 单类选择器 `.btn` 编译成 `.btn[data-v-x]`,特异性 (0,2,0) —— 和全局的
`.btn.primary` **一模一样**。平局由样式表注入顺序裁决,而注入顺序会随组件增删被洗牌:
P2 新增 Dialog/ConfirmHost 后它当场翻边,全局实心 `background` 赢了、scoped 的 `color`
还在,于是「Add Server」变成蓝底蓝字。
规则:**局部样式不要复用全局组件类名**(`.btn`/`.form-*`/`.dialog-*`/`.toast` …)。
要么用全局那套(别再 scoped 重写一遍),要么换个自己的名字。提特异性只是换个方向掷同一枚
硬币,不算修。对话框页脚的墨线文本按钮用 Dialog.vue 非 scoped 块发布的
`.app-dialog-text-btn`(修饰符 `is-primary` / `is-danger`,刻意不叫 `primary`/`danger`)。

**同一族的第二种变体:组件内部规则 vs 消费者 scoped(根元素即他人组件)。**
`<Button class="x">` / `<BorderBox class="x">` 里那个 `.x` 落在**别人组件的根元素**上,
而组件自己的 scoped 规则也在给同一个元素刷同样的属性。数一下:
`.app-button[data-v-组件]` = (0,2,0),消费者 `.x[data-v-消费者]` = (0,2,0) —— 又是平局;
更糟的是 `.border-box.is-interactive[data-v]:hover` = **(0,4,0)**,消费者
`.x:hover[data-v]` = (0,3,0),**消费者根本赢不了**,写了也白写。
(实测:`MCPServerDialog` 的 transport 卡片 hover 时边框整条消失;`Dropdown.vue` 早就为此
改用原生 `<button>` 绕开。)

- **组件侧**:声明"我不画"的模式必须真的**不发出声明**,而不是发出一个 transparent。
  `Button unstyled` / `BorderBox unstyled` 现在把整组 paint 声明(border / radius /
  background / shadow / padding / color / transition)用 `:where(:not(.is-unstyled))`
  整条关掉 —— `:where()` 特异性为 0,已上色的用法权重分毫不变,零爆炸半径。
  P5 把 `Button` 的**布局/排版**残雷一并收了:`min-width` / `height` / `min-height` /
  `color` / `font*` / `letter-spacing` / `text-align` / `white-space` / `transition`
  以及 `:hover` 的 `color` 同样进了门控组(它们与消费者根类是 (0,2,0) 平局,hover 那条
  更是 (0,3,0) 的必输官司)。**保持无条件的只有 Button 机制必需的骨架**:
  `display` / `align-items` / `justify-content`(`.app-button-content` 写着
  `justify-content: inherit`,它是内部机制不是对消费者盒子的主张)/ `position` /
  `flex` / `gap` / `appearance` / `cursor` / `user-select` / `vertical-align`。
  `.app-button.is-unstyled` 里的 `--app-button-*` 变量覆写要留着(自定义属性不占别人
  的命名空间,`.is-icon-only` 的 `width: var(--app-button-height)` 还在读),但属性级的
  `inherit` 反写已删 —— 没有要反的东西了。
  改门控时的自检法:把编译产物里的 `:where(:not(.is-unstyled))` 文本删掉、合并同选择器
  的相邻规则,应与改前逐条相等(P5 实测 36 条规则全等,且合并后无重复属性,
  规则内声明顺序因此无关)。
- **消费者侧**:别在别人组件的根元素上抢属性。要么用组件暴露的确定性 API,要么——
  当你其实不需要这个组件的任何能力时——**直接写原生 `<button>`**。对话框页脚就是后者:
  它们不需要 loading/icon/group,套 `Button unstyled` 只会换来一场必输的特异性官司
  (`.app-button` 的 `font: inherit` + `font-size` 会盖掉页脚自己的 mono 12px)。

**用 Popover 时的一条坑**(方案 §6.1):Popover 的根元素**拿不到**调用方的 scoped 作用域
(它的根是 Teleport,Vue 只把 scopeId 传给单个根元素)。浮层的皮肤要么写进插槽里的那层
`div`(插槽内容仍在调用方作用域内),要么写进调用方的**非 scoped** `<style>` 块。
`SayMessageRow` 走前者,`MessageActions` 的 `.more-menu`/`.branch-menu` 走后者。

**第三条路(2026-08-10 起的首选):`surface` 档位。** 上面那两条是"消费者自己画面"的
变通;缺的是"组件按名字画面"的能力。`Popover.vue` 的 `surface` 现在同时收布尔与档位名,
面色/边框/圆角/阴影由组件画,消费者一个 CSS 规则都不用写:

| `surface` | 面 | 边框 | 圆角 | 阴影 |
|---|---|---|---|---|
| `false` | 不画(内容自带框) | —— | —— | —— |
| `true` / 缺省 / `"floating"` | `--ui-surface-floating-bg` | `--ui-border-subtle-border` | `--radius-sm` | `--shadow-floating` |
| `"menu"` | `--ui-surface-menu-bg` | `--ui-border-strong-border` | `--radius-md` | `--shadow-floating` |
| `"elevated"` | `--ui-surface-elevated-bg` | `--ui-border-subtle-border` | `--radius-md` | `--shadow-elevated` |

几何(`--app-popover-padding`)不随档位变 —— 换档不该把内容挤位。实例级
`--app-popover-{bg,border,radius,shadow}` 仍然赢过档位(档位只挪 fallback)。
**缺省档不加修饰类**,所以既有调用点的 DOM 与命中规则逐字节不变
(`components/common/__tests__/Popover.surface.test.ts` 钉住这条)。
`Dropdown.vue` 跟随同一张表,只是它的缺省档是 `menu`、面画在内框上;
`ContextMenu.vue` 是 Dropdown 的预绑定,跟着拿缺省档。

---

## 2. 交互态配方(唯一出处)

| 态 | 唯一写法 |
|---|---|
| hover 背景 | `background: var(--ui-state-hover-bg)`(区域别名如 `--ui-sidebar-item-hover-bg` 由主题层派生,组件端只引用) |
| selected 背景 | `var(--ui-state-selected-bg)` 或其区域别名。**不要**拿 `--ui-accent-primary-fg` / `--accent` 当选中底色 |
| focus ring | `.u-focus-ring`(components.css);输入框用 `.u-focus-ring-input` |
| focus 伪类 | 一律 `:focus-visible`。裸 `:focus` 只留给输入框 caret 场景 —— 而且要**把元素选择器写出来**(`input.form-input:focus`),检查器就是按元素名放行的,类名再像输入框也没用 |
| 过渡 | `transition: <prop> var(--duration-fast) var(--ease-default)`。**禁字面时长** |
| 过渡时长档位 | `--duration-fast` 120ms / `--duration-normal` 200ms / `--duration-slow` 300ms。归档口径:**≤140ms→fast、150–250ms→normal、260ms+→slow**(P5 按这条把 411 行归了位,±30ms 级偏移是[方案 §2.2](./ui-system-consolidation.md) 批准的设计决策,不逐处求像素不变) |
| 缓动档位 | `--ease-default` = `cubic-bezier(.4,0,.2,1)`(含关键字 `ease` / `ease-in` / `ease-in-out`)、`--ease-out` = `cubic-bezier(0,0,.2,1)`(含各路 expo-out 曲线)、`--ease-spring` = `cubic-bezier(.34,1.56,.64,1)`(含各路 overshoot)。`linear` 保留原样 —— 它没有语义档位,进度条/跑马灯要的就是匀速 |
| 圆角 | `var(--radius-xs|sm|md|lg|full)` = 3 / 6 / 10 / 16 / 9999px |
| 浮层阴影 | 锚定浮层 `--shadow-floating`,对话框 `--shadow-elevated`,纸墨签名影 `--shadow-paper` |

**区域墨阶(P4a 起住在主题层)。** 侧栏与设置区的行状态不走通用 state ramp ——
它们要的是**同一条墨色上的等比阶梯**(分组头全墨 > 行文 72% > 选中 14% > hover 8% >
rail 底 2.5%),直接引通用 token 时这几档的相对关系不可控(实测:分组头与行文同色、
hover 看不见)。配方表在 `themes/role-mapping.ts` 的 `REGION_OVERLAY_STEPS`,
`css-mapper.ts` 按各主题的**区域底色**解析成实色发出来:

| token | 是什么 |
|---|---|
| `--ui-sidebar-row-ink` / `--ui-sidebar-row-fg` | 侧栏行的墨 / 行文(72%) |
| `--ui-sidebar-item-hover-bg` / `--ui-sidebar-item-active-bg` | 侧栏行 hover(8%)/ 选中(14%) |
| `--ui-sidebar-rail-bg` / `-hover-bg` / `-active-bg` / `-muted-fg` | rail 与 ActiveWorkCard 这类嵌套面(2.5 / 4.5 / 7.5 / 47%,**叠在 rail 底上**) |
| `--ui-settings-row-hover-bg` / `--ui-settings-row-active-bg` | 设置区行(accent 5% / 10%) |
| `--ui-state-hover-accent-bg` / `--ui-state-hover-accent-strong-bg` | 通用「叠 accent 淡底」两档(accent 10% / 16%,画在 panel 面上)。**手写 `color-mix(in srgb, var(--accent) N%, transparent)` 一律换成它** —— 存量 99 处自绘 hover 底的根因就是缺这枚 token。淡档给瞬时 hover,重档给要压住的强调/当前项底。如实记:淡档与 `--ui-settings-row-active-bg` 百分比同为 10,解析出同一个实色,那是巧合不是别名 |
| `--ui-state-hover-raised-bg` | 「hover 底上再进一档」(墨 8%,**画在 `--ui-state-hover-bg` 上**,不是区域面)。给**静息底本身就是 hover 底**的那批控件(collab-tag 是原型):它们迁中性档会两态同色、hover 归零,换 `--ui-state-active-bg` 又变成按下态。定值取全仓「加深一档」的存量常数 8(`color-mix(<静息底> 92%, <墨>)` 四处 + collab-tag 自己的墨 8%)。它是 hover 族的续档,不是新的选中态 —— 构造断言钉住"不得重过侧栏行选中档 14%" |

**组件端只引用,不再自造 `color-mix`。** 要加新档位就改 `REGION_OVERLAY_STEPS`,
改完跑 `themes/__tests__/state-overlay-audit.test.ts`(16 主题 × 声明模式,断言
"有值 / 是实色 / ΔRGB ≥ 5 / 阶梯单调")。混色一律 `in srgb` —— oklch 在近中性色上泛粉。

**focus ring 的三个 shadow token**(拿不到全局工具类的 scoped 规则直接引,别手抄双环):
`--ui-focus-ring-shadow`(双环)/ `--ui-focus-ring-input-shadow`(输入框单环 15%)/
`--ui-focus-ring-soft-shadow`(浮面、侧栏 rail 的半透明单环 36%)。

**双轨已终止(P4b)。** `--accent` / `--text` / `--muted` / `--hover` / `--border` 这一批
**159 个 legacy 变量名,主题层不再写了**(`css-mapper.ts` 的 `UI_LEGACY_VAR_MAP` 已缩成
`UI_ALIAS_VAR_MAP`,只剩两类真别名:`--shadow-floating`/`--shadow-elevated` 档位名,
以及 `--ui-table-*`/`--ui-category-N-*` 这种比自动名好听的短名)。它们在
`variables.css` 里还有静态定义,但**不再跟主题变** —— 新代码引用它们 = 拿到一个死值。

**只用 `--ui-*` 正主。** 忘了对应关系就查 `UI_LEGACY_VAR_MAP` 的 git 历史,或直接看
`css-mapper.ts` 的 `CSS_VAR_MAP`。语法高亮那套(`--text-code-*` / `--hljs-*`)不在此列,
hljs-theme.css 与 StreamingCodeBlock 仍按那套名字消费,照旧双写。

**fallback 纪律:**
- `--ui-*` 引用**禁止 hex/rgba 字面 fallback**。`var(--ui-state-hover-bg, #f4f2ed)` 在 dark 主题下 token 一缺就爆白。
- fallback 链最多一层别名:`var(--ui-x, var(--ui-y))`,不嵌三四层。
- **写之前先确认 `--ui-x` 真的存在。** P4a 抓到 15 个拼错/臆造的名字(`--ui-surface-hover-bg`
  该是 `--ui-state-hover-bg`、`--ui-border-subtle` 该是 `--ui-border-subtle-border`…),
  其中 3 处连 fallback 都是不存在的变量 —— 整条声明在计算期作废,那块颜色一直没画出来过,
  而且**没有任何报错**。P4b 已全部修掉;别再造新的。

---

## 3. z-index 层级表

| 变量 | 值 | 允许的东西 |
|---|---|---|
| `--z-base` | 0 | 常规流 |
| `--z-sticky` | 10 | sticky 头、resize 手柄、滚动条轨、局部悬浮触发区 |
| `--z-ambient` | 50 | 插件氛围层(G2 全窗动画覆盖,`pointer-events:none`)。**浮在内容之上、每一层可交互浮层之下** —— 雪飘在消息/输入框上方,但在下拉/菜单/对话框/权限账页/tooltip 之下。覆盖层永不遮任何可交互浮层,是对"画假 UI 诱导点击"的结构性封堵 |
| `--z-dropdown` | 100 | 锚定浮层:下拉、picker、popover、flyout、hover 卡 |
| `--z-sidebar` | 200 | 浮动侧栏 |
| `--z-overlay` | 500 | 全屏遮罩类面板:语音悬浮/通话、搜索结果阅读器 |
| `--z-modal` | 600 | 对话框及其遮罩 |
| `--z-tooltip` | 700 | tooltip 专用 |
| `--z-toast` | 800 | toast 专用 |
| `--z-max` | 9999 | 图片全屏预览、SelectionToolbar 等确需压一切的 |
| —— | —— | **第三方库自带 z 用 `isolation` 收监**,不给它抬表(见下) |

规则:
- **只允许 `var(--z-*)`,禁数字字面量**(个位数的局部堆叠除外,如卡片内角标)。内联 style 同样适用:写 `zIndex: 'var(--z-dropdown)'`。
- **禁给 `--z-*` 写 fallback**。variables.css 全局加载,fallback 永远用不上,却会在改档位时误导人 —— `var(--z-dropdown, 1000)` 的真值是 100。
- 同档内相对顺序用 `calc(var(--z-x) + n)`,`n ≤ 30`。
- **第三方库自带的 z 不进这张表,用 stacking context 收监。** Monaco 的
  `.overlayWidgets` 是 10000、`.quick-input-widget` 是 2550,都高于 `--z-max`(9999),
  同一个层叠上下文里它的查找条/peek 会压过 Dialog、Toast、图片预览。**正解不是抬
  `--z-max`**(那是用更大的数字应对军备竞赛),而是在宿主容器上写 `isolation: isolate`
  ——层叠上下文一建,库内所有 z 都改为相对本容器解析,整棵子树以宿主自己的层级作为
  一层参与页面。落点:`editor/MonacoEditor.vue` 的 `.monaco-editor-host`。
  用 `isolation` 而不是 `z-index: 0`/`transform`:它只建上下文,不带布局与绘制约束,
  suggest/hover 这类溢出容器的挂件照旧能溢出。新接任何自带 z 的库照此办理。

**`--z-dropdown` 档内的既定次序**(加塞前先看这里):

| n | 谁 |
|---|---|
| +0 | 普通锚定浮层(nav rail、SubMenu、主题菜单、emoji 面板底、prompt 引用卡) |
| +1 / +2 / +3 | 复合器三兄弟:ComposerExtensionPanel / InputBox 浮层 / AgentSelector flyout |
| +20 | 表单下拉:Select、Mention、ProviderModels 能力 popover |
| +24 | 表格筛选菜单、emoji 面板遮罩 |
| +25 | 消息级浮层:MessageActions 三个菜单、branch-menu、MessageItem 反应卡、emoji 面板 |

**两处层级裁量**(不按表面语义走,理由记在这里):

- `chat/permission/RejectReasonDialog.vue` 原来写死 `--z-max`,P2 迁 Dialog 时**归回
  `--z-modal`**:它是从权限卡里抬起来的,而权限卡是普通页面内容,没有需要压过的
  modal 级宿主。要压宿主的对话框走 Dialog 的 `zOffset`(同档 `+n`)或 `baseZ`。
  `editor/FileExplorer.vue` 的两个文件操作框用 `zOffset: 1`,保留它原先的
  `calc(var(--z-modal) + 1)`。

- `common/ContextMenu.vue` 留在 `--z-modal` 而不是 `--z-dropdown`:右键菜单要能在对话框内部弹出并压住宿主。
  P1 起这是**显式的 `zLayer` prop**(默认 `'modal'`),不再是写死的例外;不需要压宿主的调用点
  传 `z-layer="dropdown"` 即可回到 dropdown 档。同档内的相对顺序用 Popover/Dropdown 的
  `zOffset`(= `calc(var(--z-x) + n)`),完全跳出档位表则用 `baseZ` 传整条表达式。
- `evals/EvalsWorkbench.vue` 用 `calc(var(--z-modal) + 10)` 而不是 `--z-overlay`:它是从设置弹层里打开的,
  掉到 overlay 档就会被设置弹层盖住。

- **两条 media 行已撤(P2,2026-08-13)**:原先的 `+5 MediaPanel 工具条` 与 `+0` 那行里的
  「MediaPanel 抽屉」都不再存在。`MediaPanelContent.vue` 现在在自己根上写 `isolation: isolate`
  建一个层叠上下文,于是"控制区盖住网格"「详情盖住整格」全部降为**个位数的局部关系**
  (控制区 2 / 粘底条 3 / 详情 4),不再从 `--z-dropdown` 借档 —— 借档本来也只是为了赢过
  同层的兄弟,而那正是 stacking context 该解决的事。整棵子树另被工作台的 pane
  (`isolation: isolate`,`RightWorkbenchPanel.test.ts` 钉着)再关一层,所以这些局部值
  与全局层级表没有任何交涉。视图内唯一还在表上的浮层是右键菜单,它走 `ContextMenu` 原语的
  `--z-modal` 档。

`Select.vue` / `Mention.vue` 默认在 dropdown+20(=120),**压不过 modal(600)**。
P3 起 Select、P5 起 Mention 都接了内核,这条不再是陷阱而是一个 prop:**在 Dialog 里
放它们就传 `z-layer="modal"`**(→ `calc(var(--z-modal) + 20)` = 620,压过 600 的遮罩)。
Select 还要额外传 `teleported`(它默认在流内);Mention **默认就是 teleported**
——@ 列表挂在复合器的光标上,几乎总是贴着视口底,翻转是它的常态而不是边角情况。

**Esc 归谁**:`composables/floating/esc-stack.ts`。浮层开着时把自己的 token 压栈,
只有栈顶那层响应 Esc。Dialog 与 Select 都用它 —— 两者的监听都挂在 `window` 捕获期,
**同一目标的捕获监听按注册顺序跑**,Dialog 永远先注册,所以内层 `stopPropagation`
来不及(实测:对话框里开着下拉按 Esc,整张表连同下拉一起关了)。新写浮层照办,
且**卸载时必须出栈**,否则 Esc 全局失灵。

---

## 4. 禁令清单(= `ui:gate` 的 12 条检测项)

| 规则 | 禁什么 |
|---|---|
| `z-literal` | `z-index: 100` / `zIndex: 1000` —— ≥10 的数字层级 |
| `z-fallback` | `var(--z-dropdown, 1000)` —— `--z-*` 一律不带 fallback |
| `raw-teleport` | 原语层白名单之外的 `<Teleport to="body">` |
| `native-select` | 原生 `<select>` —— 用 `Select.vue` |
| `native-confirm` | 原生 `confirm()` / `alert()` —— 用 `useConfirm()`。引了 `composables/useConfirm` 的文件整体豁免(`await confirm({…})` 是治愈后的样子) |
| `title-attr` | 模板里的 `title=` / `:title=` —— 用 `Tooltip.vue`(包不住就用 `trigger-el`,见 §1);纯调试信息直接删。豁免:`img` / `abbr` / `svg` / `title` / **`iframe`**(可及名)、`<slot :title>`、`Dialog` 的同名 prop |
| `ui-hex-fallback` | `var(--ui-x, #fff)` / `var(--ui-x, rgba(…))` |
| `transition-literal` | `transition: … 0.15s` —— 用 `var(--duration-*)`。豁免:注释行、**全零时长**(`transition-duration: 0s` 是"关掉过渡",没有档位可归) |
| `shadow-literal-floating` | 浮层类选择器(popover/dropdown/menu/dialog/tooltip/flyout/popup/modal)里的字面 `box-shadow` |
| `focus-bare` | 裸 `:focus`(输入框元素选择器除外)—— 用 `:focus-visible`。豁免:`:focus:not(:focus-visible)`(这**就是**关掉鼠标焦点环的标准写法)、行内出现 `caret`/`contenteditable` 的 caret 场景。元素选择器白名单认引号前导(CSS-in-JS 的 `'input.x:focus':` 也算) |
| `overscroll-contain-chat` | `components/chat/` 下**滚轮边界已交给 JS** 的面里的 `overscroll-behavior: contain`(判据:文件引了 `utils/scroll-chain`,或在 `WHEEL_CHAIN_SUBTREE_FILES` 那张小表里)—— 内容不满 max-height 的盒子仍被 Chrome 当 scroll container,contain 于是**吞掉**滚轮而不是链给祖先,而 `chainWheelToScrollableAncestor` 对滚不动的盒子直接放行、救不了这一格。边界由根上的 `@wheel` handler 独占(它只在真能滚且到边时才 preventDefault)。**不禁**侧栏/复合器/nav rail 那些真有独立滚动区、没接 handler 的面 |
| `surface-literal` | `background: var(--ui-surface-{app,panel,chat,elevated}-bg)` —— 区域面自绘,用 `surface="<tier>"` 档位(§6.6 / §6.7)。豁免域:`styles/`(全局层,档位表本身住这里)与 `components/common/`(原语层)。放行:态选择器(`:hover` / `.is-active` 一族,那是 S 级态 token 的规则域)、区域别名的**定义位**(`--x: var(--ui-surface-…)`)、`var()` 的 fallback 臂、浮层三档面(`--ui-surface-menu-bg` / `-floating-bg`,归 `popover-surface.ts`) |

**第 12 条(`overscroll-contain-chat`,2026-08-12)落地即 0 违例**:过程区的 contain 在同一轮里全部撤掉了,所以它不进基线 —— 棘轮从第一天起就只咬新增。

**第 11 条为什么值得立**(G7-3,2026-08-11):G7-2 把壁纸的区域面覆写改成认
`.app-surface[data-surface]` 的章之后,"新面忘了登记 → 没被壁纸覆盖"这条老病的入口
只剩一个 —— **组件绕开档位自绘区域面**(自绘的面盖不到章)。这条规则守的就是那个入口:
不是新规矩,是把 G7-1/G7-2 已经建好的路变成默认路。

判据刻意克制,代价也如实记:行级正则**分不出**"区域面"和"局部小件"(一张 badge 画
elevated 面和一整块面板画 elevated 面,文本上一模一样)。所以存量 85 条全部进基线、
棘轮只咬新增;新代码确实是小件时用 `ui-gate-allow: surface-literal` 放行 —— 代价是
写的时候必须想一次"我画的是不是一张区域面",那正是这条规则要买的东西。

误报出口:文件里加一行 `/* ui-gate-allow: <规则名> */`(也认 `// …` 和 `<!-- … -->`,
多条逗号分隔,`all` 全放)。**用之前先确认它真是误报** —— 白名单是给语义场景留的,不是给赶工留的。

已知盲区(行级正则的代价,不是可以钻的空子):跨行的 `transition:` 续行、
多行属性写法的 `<Teleport\n to="body">`、CSS-in-JS 里的浮层阴影。
其中"跨行续行"在 P5 的清扫脚本里是**跟到分号为止**处理的(108 行续行债一并归了档位),
检查器本身仍然看不见它们 —— 新代码别指望 gate 拦下这一类。

---

## 5. 执法

```bash
bun run ui:check   # 全量清单(存量 + 新增),按规则分类计数
bun run ui:gate    # 棘轮:只对基线之外的新增 exit 1;治愈的行会打印出来
```

基线:`docs/audit/ui-baseline-2026-08-13.txt`(**81 条**存量,按 [分期表](./ui-system-consolidation.md#5-分期总览) 逐期消)。
P0 首录 1144 条 → P2 实测 1044(`native-confirm` 归零、`raw-teleport` 12→4,未重录)
→ P4 收官 768(`ui-hex-fallback` 151→0、`focus-bare` 65→27,已重录)
→ P5 第一波 376(`title-attr` 455→63)→ P5 收官 70(已重录)
→ 波 0 的 `title-attr` 豁免扩表 **58 → 12**(2026-08-10 重录)
→ G7-3 新增第 11 条 `surface-literal` **12 → 97**(2026-08-11 重录;旧五条计数一条没变)
→ Media Panel 设计落地 P5 净治愈 16 条 **97 → 81**(2026-08-13 重录;规则数 11 → 12,新增的 `overscroll-contain-chat` 存量为 0)。

**重录纪律**:检查器读的是**工作树**,所以重录必须在 `git worktree add --detach <tmp> HEAD`
出来的干净树里跑(新规则的实现 `cp` 进去),否则当时未提交的工作会被一起录进基线 ——
healed 的和新引入的红一起入账,棘轮当场失去公信力。

剩下的 97 条构成:

| 规则 | 条数 | 是什么 |
|---|---|---|
| `surface-literal` | 85 | **区域面迁移的待办清单**(不是"确认无害")—— 46 个文件绕开档位自绘四枚区域面 token,波 6 按这张表逐处改成 `surface="<tier>"`。分布头部:`components/chat` 21、`components/evals` 17、`components/workbench` 13、`components/editor` 7 |
| `title-attr` | 2 | `MenuItem`/`SubMenu` **内部**那两行真·原生 title(截断兜底,§1 有独立裁决) |
| `focus-bare` | 7 | `SettingsPage` 的 6 条 `:deep`(`.row-input`/`.row-select`/`.add-model-input` 骑在 `<Input>`/`<Select>` 组件外壳上,加元素前缀会打空)+ `ShortcutInput` 的录制态 |
| `native-select` | 2 | `ConnectionsSection` 两处 |
| `transition-literal` | 1 | `PracticeStrip` 的倒计时进度条(`width 1s linear` 与每秒一跳的计时器同步,已就地注明) |

前四条之外的那 12 条是"确认无害"的语义保留;`surface-literal` 那 85 条不是 ——
它是**自动生成的待办**,清一条基线降一条。

清掉一批之后重新生成基线把棘轮收紧:

```bash
node scripts/ui-style-check.mjs > docs/audit/ui-baseline-<date>.txt   # 记得同步改 scripts/ui-gate.mjs 里的路径
```

---

## 6. 壁纸模式(wallpaper mode)

插件可以给主窗铺一张整窗背景图(`.app-background-layer`,`position:fixed` z0,
App.vue)。**壁纸是全局行为,不是主内容区的局部效果** —— 所有表面都要按各自方式
支持它。**2026-08-11(Surface v2·行为内置)之后,规则不再全住在一份文件里。** 行为长在
原语,壁纸那一侧只剩"拨旋钮 / 记例外 / 存豁免档案":

| 层 | 文件 | 管什么 |
|---|---|---|
| 态 token 自带公式 | `packages/renderer/styles/state-alpha.ts` + `state-alpha.css` | S 级。`.ts` 是**唯一的归档表**(哪枚 token 跟哪个旋钮),接在 `applyThemeVariables` 上;`.css` 是未加载主题时的同值兜底 |
| 区域面自带公式 | `packages/renderer/styles/components.css` 四条 `.app-surface[data-surface=…]` | B 级。区域根声明档位就自带行为 |
| 旋钮 + 例外 + 豁免 | `packages/renderer/styles/wallpaper.css` | 拨数;C / E 两级(还没有原语);具名例外清单;不参与的理由档案 |

新态 token 落地时**只在 `state-alpha.ts` 加一行**就进了壁纸体系(旧结构要在三处
各登记一次,漏一处就是一条"这块没被壁纸覆盖"的报障 —— G8-b 的 rail 窟窿即此)。
`wallpaper.css` 的文件头注仍是六级语义与判例的唯一出处,这里只留查表卡。

### 6.1 六级分级表

新面进树时**先定级再落规则**,别逐个打地鼠。

| 级 | 面 | 处理 |
|---|---|---|
| **A·让位** | 纯布局包装,面上一个字都不读(`.app-content` / `.app-main-region` / `.workspace-view-stack` / `.sidebar-header` / rail) | `background: transparent` |
| **B·纱** | 区域 chrome:侧栏、右侧工作台(`.right-workbench`)、media / workspace 面板(`.media-panel`) | **原语自带**:`color-mix(材质 × --ot-surface-alpha)`(18%) |
| **S·态** | hover / active / selected 等交互反馈,**全窗所有 chrome 按钮**(侧栏折叠/搜索/设置钮、页签条、复合器工具条…) | **token 自带**:`color-mix(墨 × --ot-state-alpha / --ot-active-alpha)`(45% / 60%) |
| **C·可读卡** | 内容面:代码块、代码头、表头 | `--wallpaper-card-alpha`(88%) |
| **E·磨砂** | 浮层家族:菜单 / popover / 下拉 / @面板 / 会话预览卡 / 表情面板 / ⋯ 菜单 / media inspector 抽屉 / 浮层侧栏 | 半透明底(76%)+ `backdrop-filter: blur(14px)` |
| **×·窗外不适用** | 设置窗 / 搜索窗 / todo 窗 / 图片预览窗 / 语音运行时窗 | 各自独立 BrowserWindow,根类不挂,整份文件对它们是死的 |

**E 级取代了旧的 D 级"弹层永不透"**(2026-08-10 用户裁决推翻)。浮层的可读性靠
"高不透明度 + 磨砂"而不是"完全不透"。

**不参与磨砂的三类,理由记在 wallpaper.css 里**:`.tooltip`(反色小卡 + 已自带
`blur(8px)`,再兑透明两边都不像)、`.app-dialog`(任务面 + 自带遮罩已把壁纸压暗,
磨砂收益为零)、全屏遮罩类(`image-preview` / `evals-workbench` / `voice-overlay`,
职责本来就是盖住一切)。

### 6.2 六个旋钮

| 旋钮 | 值 | 拨在哪 | 管谁 |
|---|---|---|---|
| `--ot-surface-alpha` | `18%` | `html.has-wallpaper` | B 级纱(区域面原语在读) |
| `--wallpaper-card-alpha` | `88%` | `html.has-wallpaper body` | C 级可读卡 |
| `--ot-state-alpha` | `45%` | `html.has-wallpaper` | S 级 hover(态 token 在读) |
| `--ot-active-alpha` | `60%` | `html.has-wallpaper` | S 级 active / selected |
| `--wallpaper-frost-alpha` | `58%` | `html.has-wallpaper body` | E 级磨砂底浓度 |
| `--wallpaper-frost-blur` | `6px` | `html.has-wallpaper body` | E 级磨砂半径 |

同级全体只认同一个数 —— 用户一处调、处处齐。"侧栏和主区观感不一致"就是各写各的
浓度造出来的。

**S / B 两级的旋钮拨在 `html` 而不是 `body`,是被公式的定义位决定的**:它们的公式
写在 token / 原语自己的定义里,而自定义属性的 `var()` 在**定义元素**上解析 ——
态 token 定义在 `:root`(= `html`),旋钮就必须在同一个元素上,类一挂才会重算。
C / E 两级还没有原语,沿用旧的 body 快照层(见 6.4 纪律 3)。

B 级另有一枚**材质**旋钮 `--ot-region-ink`:四档区域面在壁纸下统一取页面底的墨。
那是 B 级从一开始的裁决("同级全体只认同一个数"),不是第七个浓度旋钮。

### 6.3 作用域根:`html.has-wallpaper`

由 App.vue 的 `watch` 挂/摘(`onUnmounted` 清理),只在主窗挂
(`pluginBackgroundActive && !isAuxiliaryWindow`)。

**为什么是根级而不是 `.app-shell` / `.app-content`**:菜单、popover、下拉、会话
预览卡、@面板全部 `Teleport to="body"`,是 `.app-shell` 的**兄弟** —— 挂在 shell 上
的选择器(哪怕加了 `:deep`)永远够不着。上一轮那条治浮层侧栏的
`.app-shell.has-plugin-background :deep(.sidebar.floating .sidebar-content)` 就是这么
变成死码的(浮层侧栏同样在 shell 之外)。根类一挂,今天的浮层和明天任何新
teleport 面都自然进入体系。

### 6.4 三条实现纪律

1. **层级优先 token。** 能覆写 CSS 变量的绝不写类名规则 —— 覆写
   `--ui-sidebar-surface-bg` 一次,`.sidebar` 本体 / `.sidebar-header` / 会话分组
   pill / 以及任何尚未被枚举到的后代面会一起跟随。类名规则只留给变量够不着的面。
   **但覆写要落在"区域根"上而不是全局**:`--ui-surface-panel-bg` 既是工作台的区域
   面,也是 `.session-preview` / `.app-select-dropdown` 的浮层面 —— 在 body 上改一次
   就把浮层一并稀释成 18% 的纱。

2. **自定义属性按计算值继承 —— 两个方向都要记。**
   `--ui-sidebar-action-hover-bg: var(--ui-state-hover-bg)` 定义在 `:root`,它在
   `:root` 处就被算成一个**实色**并按计算值继承下去;在 `.app-shell` 上改
   `--ui-state-hover-bg` **不会**让它重算。派生 token 必须逐条列名。

   Surface v2 反过来**吃**这条法则:把公式写进定义本身
   (`color-mix(墨 var(--旋钮, 100%), transparent)`),旋钮拨在**同一个元素**上,
   于是类一挂即重算,一处拨、全窗齐。推论(实测,别照直觉写):**在后代上改旋钮
   是没用的** —— 浮层里要"反馈用满",只能在浮层上把 token 本身重新声明成
   `var(--ot-ink-*)`,不是拨一下 `--ot-state-alpha`。
   同理:一枚 token 若在 X 元素上声明为 `var(--Y)`,只有在 **X 自己或它的祖先**上
   改 `--Y` 才推得动它 —— 这就是 E 级块里 `--app-popover-bg` / `--composer-extension-surface`
   **不用列**(声明在浮层自己身上,改上游即可,还保得住族色区分)而
   `--todo-popover-bg` / `--app-menu-bg` **必须列**(声明在浮层的祖先上)的分界。

3. **CSS 环坑:快照层必须夹在"主题定义层"和"覆写层"之间。**
   `--x: color-mix(…, var(--x) …)` 在同一元素上构成自引用循环,按规范整条作废
   (**静默失效,真机才看得见**)。主题 token(`--ui-*`)定义在 `:root` / `html` 上;
   所有 teleport 出去的浮层是 `body` 的子元素。于是 **`body` 是唯一同时满足两条的层**
   ——在 `:root` 之下(读得到主题原值),在每一张要治的面之上(含全部浮层)。
   所以:C / E 两级的旋钮 + `*-ink` 快照 + 派生值住在 `html.has-wallpaper body`,
   token 覆写一律住在 body 的**后代**选择器上。

   **S / B 两级已经不需要这一层了**:主题产出的原值直接以 `--ot-ink-*` 这个**异名**
   存在(`state-alpha.ts` / `state-alpha.css`),公式读墨、写成品,两个名字不同,
   环从结构上不存在。`wallpaper-state-coverage.test.ts` 有一条棘轮盯着旧快照层
   别借尸还魂。

   仍然生效的禁令:**不要把 `--ui-*` 覆写写到 `html.has-wallpaper` 上** —— 那些
   token 的定义就在同一个元素(`:root`),覆写即成环。放在那里的只能是 `--ot-*` 旋钮。

### 6.5 性能红线

`backdrop-filter` **只许上浮层**:数量少(同一时刻通常只有一层)、几何静态、
生命周期短。

- 禁止用于大面积常驻区域(侧栏 / 工作台 / 消息列表 / 背景层本身);
- 禁止 `transition` 它 —— 逐帧重算模糊就是掉帧本身(mac `transparent:true` 透明窗
  掉帧判例在案,见 `project_transparent_window_jank_2026_07`);
- E 级清单是**枚举制**,新面进表先问一句"它同时在屏的兄弟有几个"。

背景层本身同样纯静态:不做 rAF、不加 `transition`,`blur` 只在插件真的要了它的
时候才加(半径为 0 的 `filter` 仍然要付独立合成层那笔代价)。

**实测推论(2026-08-11,把 blur 内置进浮层壳的方案就是被这条否掉的)**:
`backdrop-filter: blur(0px)` **不等于** `none`。任何非 `none` 的值都会建立层叠
上下文,并让元素成为 fixed / absolute 后代的**包含块**(实测:壳内 fixed 子元素的
视口坐标从 `(0,0)` 变成壳的位置)。所以"缺省 0 = 无成本"的写法是错的 —— 要把磨砂
内置到浮层原语里,唯一安全形态是 `backdrop-filter: var(--ot-frost-filter, none)`,
缺省真的解析成 `none`。

### 6.6 区域面档位(G7-1,2026-08-11)

上面整套分级今天靠一张**类名白名单**认面 —— `.right-workbench` 是 panel 面、
`.media-panel` 是 chat 面……新面进树忘了来 `wallpaper.css` 登记,就是一条
"这块没被壁纸覆盖"的报障。根因是**区域底色没有组件端的声明位**:面色是各组件
scoped CSS 里的一句 `background: var(--ui-surface-xxx-bg)`,外面既读不到也认不出。

档位化把它变成一枚声明:

| 档 | 画的 token | 住户(2026-08-11) |
|---|---|---|
| `app` | `var(--ui-surface-app-bg)` | (待迁) |
| `panel` | `var(--ui-surface-panel-bg)` | `.right-workbench` |
| `chat` | `var(--ui-surface-chat-bg, var(--ui-surface-app-bg))` | `.media-panel` |
| `elevated` | `var(--ui-surface-elevated-bg)` | (待迁) |

- **表的唯一出处**:`packages/renderer/components/common/surface.ts`。
- **两个宿主**:`Surface.vue`(单根元素原语,给不是 Container 的区域根用)与
  `Container` 的同名 `surface` prop(`layout-container` 族)。两者都只做两件事 ——
  加画笔类 `.app-surface`、盖章 `data-surface="<tier>"`;**四条画底规则住在
  `styles/components.css`**(全局层),因为 Container 渲染的是自己的根元素、拿不到
  `Surface.vue` 的 scopeId,两个宿主要吃同一张表,表就只能在全局。
- **零破坏判据**:未声明档位 = 不加类、不加属性、不画底。Container 通篇没有
  `background`,这条缺省保证它继续没有。
- **`data-surface` 是章,`.app-surface` 才是画笔**:只盖章不加类 = 声明档位但自己
  画底(本期无住户,留给 sidebar 那一族并档时用)。画底规则一律带类名前缀,
  **不写裸 `[data-surface]`** —— 编辑器一族(`MarkdownDocumentEditor` /
  `ProseNoteEditor`)早就在用同名属性的别的取值(`document` / `todo-notes`)。
- **给 G7-2 的钩子**:章一盖,`wallpaper.css` 就能从类名枚举退化成
  `html.has-wallpaper .app-surface[data-surface='panel'] { … }` 这样的通用规则,
  新面**用了原语就自动在册**。本期 `wallpaper.css` 一个字不动。
- **Surface v2(2026-08-11)再走一步**:连那四条通用规则也从 `wallpaper.css` 删了 ——
  档位规则自己带公式(`color-mix(var(--ot-region-ink, 自己的墨) var(--ot-surface-alpha, 100%), transparent)`),
  壁纸只在根上拨两个数。公式落在**自定义属性**上再拿它画 `background`,不是只画
  `background`:区域根的整棵子树都在读同一枚面 token,只画底会让子树里的面留在
  实色 —— 那正是壁纸报障的原型。

**两处判了不接,理由记在这里**(不是漏网):

- `.session-header` 画的是 `var(--ui-tab-bar-surface-bg, var(--ui-surface-chat-bg))`
  —— 页签条族的**派生** token(`color-mix(panel 78%, elevated)`),不是四档区域面
  token。塞进 `chat` 档会**改掉它的实际颜色**(违反逐处零视觉变化);为它新立第五档
  则是给单一住户造一个分类。而且它在壁纸体系里已经由祖先 `.app-content` 的
  `--ui-tab-bar-surface-bg: transparent` 统管(A 级让位),区域根盖章没有增量。
- `.sidebar` 画的是区域别名 `--sidebar-bg: var(--ui-sidebar-surface-bg,
  var(--ui-surface-app-bg))`,而 `--ui-sidebar-surface-bg` 由主题在 `:root` 处定义
  (`REGION_OVERLAY_STEPS` 墨阶一族),fallback **永不触发**。借 `app` 档盖章的后果
  是:G7-2 的通用规则会在 sidebar 子树里把 `--ui-surface-app-bg` 稀释成纱,**误伤**
  所有读这枚 token 的后代面,而 sidebar 自己的底纹丝不动 —— 比不盖章更坏。

**G8 终稿:上面两处 + App.vue 四根,全部转正为"永远具名",档位表不再等它们。**

| 面 | 判决 | 一句话理由 |
|---|---|---|
| `.session-header` | 永不进档 | 画的是页签条族的派生 token,塞进 `chat` 档会改掉实际颜色;新立第五档是给单一住户造分类 |
| `.sidebar` | 永不进档(G8-b) | 新立 `sidebar` 档只换掉 wallpaper.css 侧栏块的**一行**(面 token),块里另外四行是**态** token(行 hover/选中、rail hover/当前项)—— 一档只映射一枚面 token,态换不掉。净结果是一行改名 + 档位表多一档,总行数不减 |
| App.vue 四根(`.app-shell` / `.app-content` / `.app-main-region` / `.workspace-view-stack`) | 永不进档(G8-c) | 壁纸下它们是 **A 级·让位**(整张透明),档位画的底到不了眼前;而盖章会把 `--ui-surface-app-bg`(renderer 里 **91 处**消费 / 约 45 文件,含焦点环的实色垫底与反色文字)就地稀释成纱 |

G8-c 同时否掉了"区域 ink 中介层"方案(再造一枚 `--ui-region-app-bg`,B 级只稀释中介、
不动原 token):四根本来就让位,中介稀释了也画不到眼前 —— 买不到壁纸参与度,却要为
四档各配一枚平行 token,再长期背一个"面 token 与中介 token 该引哪个"的新坑。

一句话钉死这条边界:**能被档位表收的是面,不是根,也不是态。**根级大区归 A 级·让位,
态 token 归 `styles/state-alpha.ts` 的归档表(Surface v2 之后只需登记一处;
`styles/__tests__/wallpaper-state-coverage.test.ts` 钉住"在册 / 自带公式 / 浮层回满"),
档位表只服务"有自己的面、且要被壁纸认出来"
的区域根。

### 6.7 壁纸认章不认类名(G7-2,2026-08-11)

G7-1 盖的章在这一刀兑现:`wallpaper.css` 的区域面从**类名枚举**退成四条通用规则。

```
html.has-wallpaper .right-workbench { --ui-surface-panel-bg: var(--wallpaper-veil); … }
html.has-wallpaper .media-panel     { --ui-surface-chat-bg:  var(--wallpaper-veil); }
        ↓
html.has-wallpaper .app-surface[data-surface='panel']    { --ui-surface-panel-bg:    var(--wallpaper-veil); }
html.has-wallpaper .app-surface[data-surface='chat']     { --ui-surface-chat-bg:     var(--wallpaper-veil); }
html.has-wallpaper .app-surface[data-surface='app']      { --ui-surface-app-bg:      var(--wallpaper-veil); }  ← 预写,零住户
html.has-wallpaper .app-surface[data-surface='elevated'] { --ui-surface-elevated-bg: var(--wallpaper-veil); }  ← 预写,零住户
```

**区域面这一档的枚举制就此终结** —— 新面声明 `surface="<tier>"` 就自动在册,不必再去
`wallpaper.css` 登记一行(那正是报障 3 / 5 的成因)。四条各覆写自己那一枚 token,一个
元素只声明一档,其余三条对它惰性;`app` / `elevated` 现无住户,规则是**预写**的(章不
存在时选择器不命中),这样"有章即在册"才是完整的,而不是留半张表。

三条硬约束(逐字落地):

- **必须带 `.app-surface` 前缀**,不写裸 `[data-surface]` —— 编辑器一族
  (`MarkdownDocumentEditor` / `ProseNoteEditor`)在用同名属性的别的取值
  (`document` / `todo-notes`),裸属性选择器会把它们一并稀释成纱。真机验过:
  `data-surface="document"` 的对照元素在壁纸态下仍是 `rgba(0,0,0,0)`。
- **`.right-workbench` 的台面专属补丁保持具名**:那三枚 token 覆写
  (`--ui-surface-elevated-bg` / `--ui-surface-app-bg` / `--workbench-tool-card-bg`)
  加一行 `:is(.browser-toolbar, .browser-panel)` 让位,治的不是台面自己的底色,是
  台面**里**读别枚 token 的内容面 —— 档位只管区域根那一枚,推不动它们。
- **`.sidebar` / `.session-header` 的具名条目原样保留**,理由在 §6.6(不是漏网)。

`wallpaper.css` 的 B 级块首因此改写成一张**例外清单**(具名条目仅剩 3 条,每条写明
为什么还具名),而不是原来的枚举白名单。A / S / C / E 各级的枚举制没被终结,它们各有
各的理由(E 级是性能红线,S 级是派生 token 不重算),块首注里点明了边界。

**验证(生产包对照法,G7-1 同款)**:`bun run web:build` 的单一 CSS 挂进真浏览器,按
真实模板抄 DOM 链,对照元素逐字重写迁移**前**的表达式,量 `getComputedStyle`——

| | 迁移后 | 对照(旧表达式) |
|---|---|---|
| panel(浅色,无壁纸)| `rgb(255, 252, 240)` | `rgb(255, 252, 240)` |
| chat(浅色,无壁纸)| `rgb(255, 252, 240)` | `rgb(255, 252, 240)` |
| panel / chat(壁纸态)| `color(srgb 1 0.988235 0.941177 / 0.18)` | 同 |

另跑一轮把四枚 token 给成**互不相同**的值(app `#fffcf0` / panel `#f0e8d8` /
chat `#e4f0ff` / elevated `#ffffff`),迁移后仍逐字读自己那一枚 —— 真主题下
`app == panel` 会掩盖串档,这一轮才排除得掉。`app` / `elevated` 两档的预写规则同轮
验过"盖章即 18% 纱";只盖章不加画笔类的元素在两态下都是 `rgba(0,0,0,0)`(声明档位
但自己画底的用法没被这一刀改掉)。
