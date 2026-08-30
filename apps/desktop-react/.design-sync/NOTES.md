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
