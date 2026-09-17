# design-sync 笔记 —— React 壳组件库(apps/desktop-react)

## 2026-08-30 · 首次导入

- 与仓库根 `.design-sync/`(onething Tokens,Vue 侧样式面同步)**是两条独立同步**:
  这份的 config home 在 `apps/desktop-react/`,目标项目 = onething React UI(全量组件导入)。
  两边互不读写对方的 config/输出。
- 无构建产物:纯 vite 应用,`src/ui` 直接吃源码 → 转换器走 synth-entry 模式,不跑任何 build。
- 组件铁律(src/ui/Button.tsx 头注释):组件内零字面色值/px/ms(全 var())、零字面文案
  (全 useT())。预览里给 UI 文案属正常——那是调用方传入的内容,不违反铁律。
- `useT` 消费者:Dialog / Tabs / Toast——i18n store 默认 locale 即可独立渲染,预览无需 provider。
- 字体:`src/assets/fonts/fonts.css` + 本地 woff2(JetBrains Mono + Noto Sans SC 分片),
  离线铁律(index.html 注释):产物不得出现外部字体主机。
- 样式入口 `src/styles/global.css` → tokens.css + palette.css + theme-bridge.css。
  theme-bridge 挂在 `:root[data-theme-bridge]` 上,独立渲染时不匹配,palette 静态值生效——正合适。
- 现成用例来源:`src/dev/Gallery.tsx`(236 行规格页,15 件组件的真实组合)。

### 首建踩坑与裁定(2026-08-30)

- **自链接是硬前提**:转换器拿 `node_modules/<pkg>` 当包根,自仓不自装 →
  `mkdir -p node_modules/@onething && ln -sfn ../.. node_modules/@onething/desktop-react`。
  gitignore 内,重装 node_modules 后需重建(等价 fresh-clone 步骤)。
- **cssEntry 是逐字附加、不解析 @import** —— global.css 的三个相对 import 全悬空
  ([CSS_IMPORT_MISSING]×3)。正解:`tokensPkg` 指自己 + `tokensGlob: "src/styles/*.css"`,
  四个文件平铺进 tokens/,相对 import 变兄弟引用自然解析。cssEntry 保持不设。
- **Known render warns**:`[TOKENS_MISSING] 19 个 --ui-*` = theme-bridge 变量,连上 core
  才由主题管道注入,独立渲染时 bridge 选择器不匹配、palette 静态值兜底 —— 合法,勿修。
  底线卡的 `[RENDER_BLANK]`(PNG ~4.5KB)= 排版性底线卡本来就轻,非故障。
- **预览文件名=组件导出名**:是 `ToastHost.tsx` 不是 `Toast.tsx`(错名报 stale preview)。
- **不分组裁定**:docsMap stub 只换组名但会顶掉合成 prompt.md 的 ## Examples(emit.mjs
  只在 docBody 缺 Props 时补 Props,不补 Examples)。20 卡一组可接受,用法参考更要紧。
- 浮层件 override(config 里):Menu 320x280 / ToastHost 420x320 / Dialog 560x400 /
  ConfirmHost 560x360,全 cardMode single。Tooltip open 态与 Select open 态无法静态渲,
  预览只给锚点/closed 态(Tooltip 靠 mouseenter/focus+setTimeout 才 setPos,capture 拿不到;
  Select 面板只在 onClick 挂载,均无受控 open prop——要覆盖须改组件,预览批不动源码)。

### 波次学习并档(2026-08-30,两批预览)

- **表单族 `label` 是无障碍名不是可见文字**(Checkbox/Switch/Select/RadioGroup/Segmented
  只落 aria-label):预览须自排可见文案在旁(文字左控件右,即产品设置行排法)。
- **预览里禁写 `React.` 命名空间**(合成入口不保证存在):复用布局抽 `as const` 样式对象,
  不抽带 children 类型的小组件。
- **`Radio` 单渲运行时抛错**(须在 RadioGroup 内)——叶子预览一律写完整父组合。
- **图标名传错静默兜底成 FolderTree**(`resolveIcon` 的 `?? FolderTree`):传名前先 grep
  `src/components/icons.ts` 的 REGISTRY。
- **ConfirmHost 静态开的写法**:ConfirmHub 是 zustand 单槽、`ask()` 先 set 后 resolve,
  模块顶层 `void useConfirmHub.getState().ask({...})` 即可让框停在打开态。
- **改 config 的 override 后必须由编排者跑一次全量 package-build 盖章**,否则受影响组件的
  preview-rebuild 报 `[CONFIG_STALE]` 拒跑(设计如此,防并行批吃到旧 config)。
- Badge 的 danger/unread 静态几乎不可辨(同红系,只差尺寸字重)——组件既定配方,预览如实;
  下游若要靠颜色分语义撑不住,**待用户拍板**,未改组件。
- Menu 三叶子(MenuItem/MenuSection/MenuSeparator)在默认 900×700 grid 视口下渲染正常
  无溢出,只占左上一角属全体默认视口组件通病,未配 viewport override(可选收紧)。

## Re-sync 风险(下次同步先看这节)

- **自链接会被 npm install 清掉**:跑同步前先确认
  `node_modules/@onething/desktop-react` 还指向 `../..`,没了就重建(命令见上)。
- **预览与 Gallery 是两份手抄**:组件 API 变了(prop 改名/新变体)预览不会自动跟,
  重同步时 capture 会因 .tsx 未变而 carried forward——API 变更后要主动过一眼对应预览。
- **conventions.md 的 token 表是手抄快照**(palette/tokens.css 2026-08-30 版):token
  改名/增删后表会说谎,重同步时 diff 一下两个 css 再决定要不要更新。
- **overrides 的 viewport 数值绑着组件 CSS**:Dialog/Toast/Menu 的尺寸 token 变了,
  卡可能裁切或留白,联络表过一眼即可发现。
- **首同步项目**:onething React UI `76d62ee9-58dc-4a7d-857e-d249cb6959b5`(2026-08-30,
  139 文件,20 组件全精作全 good)。同名近亲「React 壳 Design System」(82915e70…)是
  **用户手作的规范画布,永远不要往里同步**。仓根 `.design-sync/`(onething Tokens)是
  另一条独立同步,且其 pinned 项目在 2026-08-30 的登录下不可见——那条线重跑时先
  list_projects 核对。
- 渲染检查唯一常驻警告 = `[TOKENS_MISSING] --ui-*` 19 枚(见上,合法);出现**别的**警告
  就是新东西,要看。

### 2026-08-31 · 重同步事故记档

- **漏传 tokens/motion.css**(用户抓到:远端 styles.css 悬空 import):根因=上传清单手抄
  上一次的记忆而非现场枚举。**规矩:每次 write_files 前必须 `ls ds-bundle/tokens` 等
  现场重列**,tokensGlob 是通配,src/styles 加文件它就多收——记忆必然过期。
- 同一天第二坑:会话 cwd 会被重置,`ls ds-bundle` 在仓根会看到 **Vue 侧旧 bundle**
  (repoRoot/ds-bundle,08-15 产物)——两条同步共存,涉 bundle 的命令一律用绝对路径。
- claude design 报「tokens 0 / 无 styles.css」一次:远端文件实际俱在,疑其自检吃了
  半途态;哨兵重武装后应自愈,若复发则考虑把 token 文件摊平进 styles.css(降级但立效)。

### 2026-08-31 · 规范上行 + 组件缓发
- conventions.md 新增「状态与交互规范」八条(设计稿必须画全状态/异步进行中形/就地更新等)——README 已随本次上行,claude design 出稿代理从此读得到。
- **锚点未更新(有意)**:本次只传 bundle/styling/aux;新增件 AsyncButton(K1 在飞半成品)与 Popover/Kbd 的组件卡**缓发**,待 K1 落库后跑一次完整 resync(会重新列为 added/changed,补预览与评格再上)。remote-sync.json 保持旧值即此意,勿手动对齐。
- 自链接再次被 npm install 清掉(a11y 批 devDeps),已重建——这坑第二次踩,重申:凡本目录跑过 npm install,resync 前必查链接。

### 2026-09-16 · 重同步:22 件新件预览 + 真 props 契约

- **`.d.ts` 从首建起就是空契约**:这仓没有 dist,转换器合成入口时抽不到类型,42 件全部
  `[key: string]: unknown`(远端 08-30 的 Button.d.ts 就是这样)。治法:`.design-sync/build-dts.mjs`
  (`config.buildCmd`)跑 `tsc -p .design-sync/tsconfig.dts.json --emitDeclarationOnly` 到 `build/ts`
  (仓根 .gitignore 已加),只留 `src/ui/*.d.ts` + `src/components/icons.d.ts`(IconButton 的 LucideIcon 型);
  转换器 `findTypesRoot` 候选表第一项就是 `build/ts`,自动接上。**每次同步前先跑它**(1.8s),不跑
  就回到空契约。不写 rootDir(ui 的 import 会拖进 packages/shared,钉 rootDir 就 TS6059)。
- 排除项 `componentSrcMap`:DragGhost / DragLayer / DropOverlay(拖拽层内部件,要活的 drag session)、
  NativeMenu(走主进程原生弹菜单,DOM 上零渲染)。
- override 新增:Popover single 420x320、Submenu single 420x300(两件都是浮层)。
- 22 件全部作了预览(与首建同档),评分全 good。四组并行 + 我先手作 StatusDot / Fold 族 / PathText 校准。
- **打回一处**:Reveal 的现身态曾用 `<style>` 注入预览专用覆盖画出来 —— `.prompt.md` 会把预览原样喂给
  设计代理,代理照抄就会往设计里塞覆盖组件 CSS 的样式;规矩是「静态渲不出的态跳过、记档」。已改回休止态。
- 静态渲不出、且**有意不改源码**的态:Slider 的钮(平时 scale(0))、SecretInput 的 revealed(自持无受控口)、
  Submenu 子面板与 FilterChip 多值菜单(点击才挂载)、Reveal 的 hover / focus-within、IconButton 的
  size 轴静止态几乎不可见(命中区在变,底透明;预览并排一颗 pressed 才看得出)。
- 预览写法新增判例:视觉词汇件(Dots/OpenDot/StatusDot)必须进真语境行;grid 容器会把 inline-flex 药丸
  拉通栏(`justifyItems:'start'`);要演截断/挤压的容器写 `gridTemplateColumns:'minmax(0,1fr)'`;
  网格子项的 `min-width:auto` 会让长 mono 路径撑出浮层(Popover 真踩);`ui/Input` 的 rest 落里层
  `<input>`、根是 inline-flex 固有宽,预览里撑不开(产品靠 className 给 flex:1);AsyncButton 忙态用字面量
  `{subscribe:()=>()=>{}, isPending:()=>true}` 定格;Splitter 传 `containerRef={{current:null}}` 免 import react。
- **Known render warns** 更新:`[TOKENS_MISSING] --ui-*` 现在 **20** 枚(theme-bridge 多了一格),仍合法。
- 另一条并行会话在同一工作树上改 src(git status 里 src/ 的 M 不是本次同步的);同步读的是工作树,
  bundle 里带着那些未提交改动 —— 与首建一样,同步不是「HEAD 的快照」。
- **`guidelinesGlob: []`(有意)**:缺省通配 `docs/*.md` 会把 `apps/desktop-react/docs/` 里 24 份施工正本
  (send-flow / dock-scope / keymap-responder…,带「已被推翻」记档的工程记录)当设计准则整份上传给设计代理。
  它们不是给出稿代理读的东西,所以关掉;真要给,挑几份写成给设计代理的准则再指回来。

### Re-sync 风险(2026-09-16 增补,下次先看)

- **`build/ts` 不是产物就是空契约**:同步前必须 `node .design-sync/build-dts.mjs`(config `buildCmd`),
  没跑 / 跑失败,42 件 `.d.ts` 会静默退回 `[key: string]: unknown`,validate 不会红。判据:
  `grep -l 'key: string' ds-bundle/components/general/*/*.d.ts` 只该剩 ConfirmHost / MenuSeparator(真无 props)。
- **内联参数类型的组件靠 build-dts.mjs 补的 `Parameters<typeof X>[0]` 别名抽 props**:新写的组件若还是
  内联 `({…}: {…})` 形,自动覆盖;但无参函数不补(会得假契约)。
- **自链接**(`node_modules/@onething/desktop-react -> ../..`)这次又是丢的(第三次),`npm install` 会清掉;
  resync 前必查。
- **另一条会话可能同时在改 src/**:同步读工作树不读 HEAD,交卷时看一眼 `git status src/ui`,
  bundle 带进去的未提交改动要写进报告。
- **Node**:这次在 v22.18 下跑(nvm 无 24),与 .nvmrc 不一致但 tsc / esbuild 无差别。
- 预览与 Gallery 仍是两份手抄;22 件新件的 API 若改名,capture 会因 .tsx 未变而 carried forward,要主动过一眼。
- conventions.md 的 token 表与「42 件」计数是手抄快照;组件增删后要改数。
