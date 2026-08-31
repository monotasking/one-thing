# React 壳无障碍(A11y)——三律、规格源与执法

2026-08-31 立法。落地范围 `apps/desktop-react`。
配套代码:`src/ui/a11y/`(地基三件)、`src/styles/global.css`(全局焦点环与
`.visually-hidden`)、`scripts/gate-a11y.mjs`(真机门)。

这份文档要回答的只有三个问题:**什么算做到了**(三律)、**照谁的规格做**(WAI-ARIA APG)、
**谁来判**(两道门)。别的都不在这里 —— 每一件组件自己怎么按的键,写在它自己的文件头上。

---

## 0. 一句话

**用不了鼠标的人,能把这台机器完整用一遍。** 三律是这句话的三个可验证切面,
两道门是它的执法面。做不到的地方要写在留账里,不许含糊过去。

---

## 1. 三律

### 第一律 · 键盘可达

**屏幕上任何做得到的事,不用鼠标也做得到。** 不是「大部分」,是任何。

判据是可机械化的两句:

1. 每一个可交互的东西,要么自己在 Tab 序里,要么属于某个在 Tab 序里的组
   (roving,见 §3.2);
2. 到达它之后,有明确的一下(Enter / Space / 方向键 / Delete)能触发它。

推论,也是最常被违反的那一条:**一组同类控件不该各占一个 Tab 位**。
八页的 tab 条按八下 Tab 才走得出去,十项的菜单按十下 —— 这不叫可达,这叫罚站。
一组占一个位子,组内用方向键,这就是 roving tabindex。

反面清单(这三样都是「看起来能用」的假可达):

- 只有 hover 才出现的控件,而键盘走不到它;
- `div` 上挂 `onClick` 而没有键盘路(除非它 `aria-hidden`,即根本不是控件);
- 打开一扇浮层但**焦点没有跟进去** —— 键盘用户按不到里面任何一样东西。

### 第二律 · 焦点可见,且永不丢失

三件事,缺一不可:

1. **看得见**:键盘落到哪里,那里有一圈我们的柔光环。不许出现浏览器默认的那圈
   (用户 08-31 报的「黄圈」正是它 —— 黄圈出现的地方,就是那个元素谁都没给它画环);
2. **关浮层必返还锚点**:Dialog / Menu / 下拉关掉之后,焦点回到**开它的那个元素**上。
   不还,焦点就落到 `<body>`,键盘用户当场失去位置感,要从头 Tab 一遍;
3. **永不落空**:任何一步操作之后,焦点都在一个具体的、有意义的元素上。
   元素被删掉时(关一条 tab),焦点要有明确的去处。

### 第三律 · 角色如实

**报出去的角色,必须是这个东西真正的样子。**

- 是按钮就用 `<button>`,是输入就用 `<input>` —— 原生语义白拿,不自造;
- 开关报 `switch` 不报 `checkbox`(读屏软件该念「开/关」,不是「已选中」);
- 排版用的壳不许留下隐式角色 —— 它不是任何东西,该 `role="presentation"`;
- **宁可不报,不许错报**。指一个自己都不知道在不在的 `aria-controls`,比不指更糟:
  一条断掉的引用会让读屏软件宣布一个不存在的关系。

---

## 2. 规格源:WAI-ARIA APG

**遇到「这个控件该怎么按键」的问题,答案去 APG 找,不在会上拍。**
APG(ARIA Authoring Practices Guide)对 dialog / menu / listbox / combobox /
tablist / radiogroup 每一种都给了完整的键盘表与角色表,这台照抄。

两条使用纪律:

1. **偏离要写理由**。APG 给的是通用解,这台上偶尔有更合适的做法
   (例:tab 条用**手动激活**而不是 APG 默认的自动激活 —— 理由是这台每张页
   切过去都要拉数据,方向键路过一条就装一遍是可见的副作用)。偏离没问题,
   偏离而不写理由才有问题;
2. **原生优先于 APG**。原生 radio 的一组行为(方向键切换、表单重置、输入法组合键、
   右到左布局)永远比自造的那套多几个边角。能用原生就别照着 APG 手写一遍
   —— 这也是 `Radio` 与 `Segmented` 的分工线:前者是真 radio,一行键盘代码都没有;
   后者是「长得像分段器的一组按钮」,才需要 roving。

---

## 3. 地基件:`src/ui/a11y/`(手写,运行时零依赖)

三件,各解决三律里的一格。都不引库:这台的浮层只有三种、全在同一棵 DOM 树里,
现成库要处理的 iframe / shadow DOM / `inert` 那些边界一个都不存在。

### 3.1 `focus-trap.ts` — 第二律的 2 和 3

```ts
useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, options?): void
focusablesIn(container: HTMLElement): HTMLElement[]
```

开启时记锚点 → Tab / Shift+Tab 圈禁在容器内 → 关闭时把焦点还给锚点。
锚点已经不在文档里就什么都不做(强行 focus 一个游离节点 = 焦点落到 body,那不叫还)。

它**不**管 Esc(关不关是浮层自己的语义),**不**设 `aria-modal`(那是角色,归组件)。

### 3.2 `roving.ts` — 第一律的推论

```ts
nextRovingIndex(key, current, count, axis, loop): number | null   // 纯判据
useRoving(ref, { axis, loop, itemSelector, active }): void        // DOM 外衣
```

整组一个 Tab 位,组内方向键移动,Home / End 到端点。轴向可配(横 / 纵 / 双向)。
不认识的键返回 `null`,调用方不 preventDefault —— **吞掉不认识的键是「键盘可达」
最常见的反面教材**。

两条判据写在实现里,都值得记住:

- **当前项**按三档判:焦点已经落在组内某项 → 就是它;否则取 `aria-selected` /
  `aria-checked` 的那一项;都没有 → 第一项;
- 焦点还停在**容器**上时(浮层刚开出来那一刻),第一下方向键落到当前项**本身**,
  不是从它再走一步 —— 否则菜单一开按一下 ↓ 就跳过了首项。

**方向键只移焦点,不代替选中**。「移到就选中」(APG 的自动激活)是组件自己的语义,
要的话在自己的 onFocus 里做。

### 3.3 `live-region.ts` — 状态播报的唯一口

```ts
announce(text: string, { level?: 'polite' | 'assertive' }): void
liveRegionText(level): string      // 只给测试与门读
resetLiveRegions(): void           // 只给测试
```

module 级懒挂一块 `.visually-hidden` 的常驻区,两格:polite 与 assertive。

**为什么必须是单例**:live region 的语义是「这块地方变了就念出来」,它必须在**变之前**
就已经在无障碍树里。挂一个新节点、同一帧往里写字,读屏软件多半什么都不念
(它看到的是「一个新节点出现了」,不是「一块已知区域变了」)。常驻的东西就该只有一份。

**重复文案要能重播**:同一句话说两次,第二次写进去时文本没变、无障碍树没有差分、
读屏软件不念。所以 `announce` 是「先清空、下一个宏任务再写」。代价是它异步 ——
单测要 `await` 一个 0 延时才看得到落格。

---

## 4. live region 纪律

1. **状态播报与视觉一处产地**。屏幕上写什么就念什么。Toast 的做法是范本:
   一条 toast 出场时把**它自己渲染出来的 `textContent`** 送进播报口,而不是把
   title / body 再拼一份 —— 拼第二份就有第二个产地,两边迟早说不一样的话。
2. **一件事只念一遍**。行本身因此不许再挂 `role="status"` / `role="alert"`:
   那等于把它也变成一块 live region,一条 toast 会被念两次。
3. **礼貌档按级别**:success / info / warn → `polite`;error → `assertive`。
   assertive 会打断当前朗读,只给「必须马上处理」的事(这台上就是 error 那一档 ——
   它本来就不自动消失)。
4. **流式内容不逐条轰**。模型正在吐字的时候,每来一个 delta 就播一次等于让读屏软件
   一直在念半截句子。规矩是:**过程不播,收尾播一句**。
   本批只立规 —— 聊天流真正接上播报口是 A4 的事,这一批一行都没接。
5. 空话不播。播一句空字符串只会让读屏软件停顿一下。

---

## 5. 焦点样式纪律

### 5.1 只替换,永不裸删

**任何一处 `outline: none`,都必须在同一处配上替代品。** 一处都不例外。
「同一处」指同一个文件、同一个焦点态 —— 让审代码的人一眼看得见那个替代品,
而不是去别处猜有没有。

三种合法形态:

| 形态 | 用在哪 | 例 |
| --- | --- | --- |
| 全局兜底 | 没自己画环的一切元素 | `styles/global.css` 的 `:focus-visible` |
| 就地画环 | 需要不同 offset / 画在别的盒子上 | `Checkbox` 把环画在看得见的方框上(真 input 是视觉隐藏的) |
| 光标即指示 | **文本输入**(`<input>` / `<textarea>` / contenteditable) | 闪动的插入符本身就是 WCAG 2.4.7 认的焦点指示 |

### 5.2 全局兜底那条规则,以及它为什么画 outline

```css
:focus-visible {
  outline: var(--focus-ring-w) solid var(--accent-ring);
  outline-offset: 0;
}
```

`:focus-visible` 而不是 `:focus`:鼠标点一下按钮不该亮环(那是「我知道我点了谁」,
不是「我不知道焦点在哪」)。文本输入类是这条规矩的唯一例外,它用 `:focus-within`
自己画 —— 鼠标点进输入框也要亮环,因为「光标现在在这里」本来就该被看见。

**立项稿写的是 box-shadow 形 + `outline: none`,这里偏离了,理由是两个真坑:**

1. **层叠输不了**。全局规则的特异性是 (0,1,0),而组件自己的单类规则
   (`.segOn { box-shadow: var(--sh-1) }`、`.tile`、`.stackItem` …)同样是 (0,1,0)
   且**排在后面**(`global.css` 在 `main.tsx` 里第一个进,CSS Modules 随组件后到)。
   同分后来者胜 —— 分段器选中段、Dock 瓦这些自带投影的元素,环会被它们自己的投影
   直接顶掉,一格都画不出来。
2. **抬高特异性会赔掉真投影**。写成 `:root :focus-visible` 能赢层叠,但 box-shadow 是
   单属性,赢了就等于**盖掉**元素自己的投影 —— 选中的分段一拿到焦点就从「抬起」
   塌回平面。那是可见的视觉回归。

outline 没有这两个问题(全仓除了焦点上下文没人写 outline,不抢任何人的属性),
而且它**正是仓里既有 19 个文件已经在用的配方**。走 outline 是让全局兜底与存量说同一句话,
不是引入第二种环。

真机门两种载体都认,判据只有一条:**环的颜色 = `--accent-ring` 的计算值**。
门不该替谁规定用哪个 CSS 属性。

### 5.3 视觉隐藏

`.visually-hidden`(全局类,住在 `styles/global.css`)= 视觉上不占位、对读屏可见。
用 `clip-path: inset(50%)` 而不是 `display: none` / `visibility: hidden` ——
后两个连读屏软件一起隐藏,那是**藏起来**,不是「只说给听的人」。

消费者:live region 的宿主节点,和外壳那个只念不看的 `<h1>`。

---

## 6. 每件组件的键盘表写在它自己的文件头

**不在这份文档里列 15 张表。** 表要跟着代码走 —— 改了行为而文档没跟上的那一刻,
文档就开始骗人了。所以每件组件的文件头都有一节「键盘表(A11y 线 · A2)」,
逐行写清哪个键做什么、环画在哪、无障碍名从哪来。改行为就改那一节,它就在你手边。

这份文档只负责判据;`src/ui/*.tsx` 的文件头负责事实。

---

## 7. 两道门

### 7.1 静态:`eslint-plugin-jsx-a11y`(`npm run lint`)

已在本应用的 flat config 里(`eslint.config.js`,recommended 全集),
口径是 `--max-warnings 0`。**零违例,没有基线文件** —— 这棵树是新的,
不给它开一条「存量」的口子。

它查的是**写法**:没文字的按钮有没有名字、`aria-*` 有没有挂在支持它的角色上、
`div` 上的 `onClick` 有没有配键盘路。查不到的东西见下一道门。

### 7.2 真机:`npm run gate:a11y`(`scripts/gate-a11y.mjs`,已进 `verify` 链)

拉起真的 Electron + 真的 core,两屏各扫一遍:产品外壳,和 `?gallery` 那张组件规格页
(15 件 ui 组件一次全在场 —— 那是唯一能把每一件都摆上台的地方)。

**① axe 全页扫描**(`@axe-core/playwright`,标签 wcag2a / wcag2aa / wcag21a /
wcag21aa / best-practice)。基线 **0**,豁免表 `AXE_EXEMPT` **是空的**。
有违例就去修,不往表里塞。

一处实现细节记档:必须 `setLegacyMode(true)`。默认模式下 AxeBuilder 会
`browserContext.newPage()` 开一张空白页处理跨 frame 扫描,而 Electron 的 CDP 不支持
`Target.createTarget` —— 当场报 `Protocol error`。legacy 模式只在当前页里注入并跑,
正是这台需要的(单 frame,没有 iframe 要跨)。

**② 键盘走查**(手写断言 —— axe 是静态分析一棵树,它看不见「按 Tab 会走到哪」):

| 断言 | 拆掉什么会红 |
| --- | --- |
| Tab 序覆盖 composer 主控件(输入区 + 发送键) | composer 的 Tab 序 |
| 每个落焦元素身上是 `--accent-ring` 的环,不是 UA 默认 outline | `global.css` 的 `:focus-visible` |
| 开 Dialog:焦点进圈;Tab 连按 12 下出不去 | `Dialog` 的 `useFocusTrap` |
| Esc 关 Dialog:焦点还给锚点 | 同上 |
| Menu:整组一个 Tab 位;↓ 按 n+1 下绕回首项 | `Menu` 的 `useRoving` |
| Esc 关 Menu:焦点还给锚点 | `Menu` 的 `useFocusTrap` |

**反证纪律**(照 `gate:motion`):每条断言都要能被「把实现拆掉」反证成红,否则它只是在陪跑。
2026-08-31 真验过三处,读数记在门的文件头里;改了任何一条断言,请重跑它的反证。

---

## 8. 一处 ARIA 死角的裁定:可关闭的 tab

这一格值得单独记,因为它是**两边都撞过墙**才落地的,后人容易照着直觉改回去。

需求:一条 tab,右边一个 × 关掉它。ARIA 对这件事没有干净答案:

- × 摆在 tab **外面**(壳 div 里,与 tab 按钮做兄弟)→ 无障碍树里它是 tablist 的直接
  子成员,而 tablist **只许**装 tab。axe 判 `aria-required-children` **critical**,
  而它判得对:读屏软件按「第几个 tab」数下去会数错;
- × 摆在 tab **里面**且可聚焦 → `tab` 是「子元素呈现性」的角色,
  axe 判 `nested-interactive` **serious**。加负 `tabindex` 和 `aria-hidden` 也不行,
  axe 的原话是「这挡不住辅助技术聚焦到它」——只要它是个 `<button>` 就算数。

**裁定(第三条路,两边都过)**:`role="tab"` 提到外层那一层,× 退成 tab **内部**
一个 `aria-hidden` 的 `<span>`(不是控件,只接鼠标),关闭的**键盘路**由 tab 自己承担:
`Delete` / `Backspace`。这正是 APG 可删除 tab 的做法。

代价照记:

- 外层不再是原生 `<button>`,`Enter` / `Space` 要自己接一下 —— 这是全批**唯一**
  自造的一格键盘行为;
- 读屏软件不再念得到那颗 ×(它本来也只念得出「关闭 files」这句我们编的话),
  键盘用户少按一下 Tab、多知道一个 `Delete`;
- 字典键 `common.closeTab` 因此没有了消费者(孤儿键,按仓惯例保留)。

---

## 9. 留账

| # | 事 | 归谁 |
| --- | --- | --- |
| 1 | **聊天流接播报口**:流式过程不播、收尾播一句(§4.5 只立了规,没接线) | A4 |
| 2 | **composer 的三处输入裸 `outline: none`**(`.input` / `.askFree` / `.modelSearchInput`,无任何替代品)。真机门按「光标即焦点指示」放行(§5.1 第三行),但同一台上 `ui/Input` 是**画环**的 —— 两者要不要统一,是拍板题 | composer 批 |
| 3 | **`useConfirm` 在产品外壳里没有宿主**:`ConfirmHost` 只挂在 `?gallery` 上,`AppShell` 没挂。今天没有产品代码调 `useConfirm`,所以不是活 bug;真要用之前得先挂 | 用到它的那一批 |
| 4 | **Esc 链没有登记处**。今天 Esc 的消费者至少四家(Dialog / Menu / Tooltip / 舞台),各自 `addEventListener` 各自判。Tooltip 那一条已经按 APG 做了自律(只在提示在场时挂、消掉之后不拦别人),但这只是自律,不是机制 —— 浮层再多两层就会出现「按一下 Esc 关掉了两层」。是否要一个集中的 Esc 栈,建议单开一批勘察后再拍 | 待拍 |
| 5 | **`Tabs` 没有 `aria-controls`**:内容面板由宿主画在别处,Tabs 不认识它。要补的话得让宿主把面板 id 递进来,是接口改动 | 待拍 |
| 6 | **对比度没有进门**。axe 的 `color-contrast` 规则在这台上因为大量半透明叠色而无法判定(它会跳过),所以「文字够不够清楚」目前**没有**机器判据 | 待拍 |
