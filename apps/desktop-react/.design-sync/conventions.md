# onething React UI — 设计约定

这是 onething React 桌面壳的**真组件库**(`apps/desktop-react/src/ui`),不是重绘。42 件组件全部从 `window.OnethingUI.*` 可导入可渲染;每件的 API 契约在 `<Name>.d.ts`,用法在 `<Name>.prompt.md`。**优先用这些组件搭界面,不要用裸元素重造轮子。**

## 设置

引入 `styles.css` 后零配置即产品默认档:**Notion 暖纸底 + Organic 暖圆角 + 紫 accent**,亮色单档(不带暗色开关;`--ui-*` 主题桥变量只在连上宿主 core 时注入,独立渲染时 palette 静态值兜底——这是设计内行为,不是缺失)。无需任何 provider:Dialog/Menu/Toast 自带 portal,i18n 有默认档。

## 两条铁律(仓里机械验证,设计稿也照办)

1. **零字面色值 / px 圆角 / ms 时长**——一切取 token:色 `var(--accent)` `var(--danger)`,几何 `var(--sp-N)` `var(--r-N)`,时长 `var(--dur)`。
2. **primary 实底按钮一屏只许一个**(`<Button variant="primary">`),其余全部 ghost。这是按钮族的第一约束。

## Token 词汇(palette.css + tokens.css)

| 类别 | token |
|---|---|
| 面 | `--surface-0..3`(app 底→浮层,逐级抬亮) `--glass` `--scrim` |
| 字 | `--text-1..4`(主→最淡) `--on-accent`(实底上的白) |
| 线 | `--line-1`(默认) `--line-2`(重) |
| 强调/状态 | `--accent` `--accent-deep` `--accent-soft` `--ok` `--warn` `--danger` |
| 交互态 | `--st-hover` `--st-active` `--st-sel` `--st-sel-hover` |
| 间距 | `--sp-1`(4) 到 `--sp-8`,4px 阶梯 |
| 圆角 | `--r-1`(控件) `--r-2`(卡) `--r-3`(浮层) `--r-full`(丸) |
| 字号 | `--fs-display/headline/title/chat/body/label/meta/micro/card/hint/nano` |
| 字体 | `--font-ui`(Noto Sans SC 系) `--font-mono`(JetBrains Mono)——woff2 已随包,离线可用 |
| 动效 | `--dur`/`--ease` 基准,`--dur-enter`/`--dur-exit` 进出场 |
| 层级 | `--z-sticky < --z-float < --z-dropdown < --z-overlay < --z-modal < --z-dock < --z-tooltip < --z-toast`,禁写字面 z-index |
| 阴影 | `--sh-1..3`(仅浮层可投影;**内容面不投影**) |

## 组合规则(常错点)

- `MenuItem` / `MenuSection` / `MenuSeparator` 只在 `<Menu x= y= onClose=>` 里用;Menu 是 portal+fixed 定位的上下文菜单。
- `Radio` 只在 `<RadioGroup value onChange label>` 里用。
- Toast:唯一入口 `pushToast({level,title,body?,lifeMs})`,页面挂一个 `<ToastHost/>`;error 用 `lifeMs: null` 驻留,其余自动消失。
- 确认框:`useConfirm()` 返回 promise,页面挂 `<ConfirmHost/>`;普通对话框用受控 `<Dialog open onClose title footer>`。
- `Tabs` 的 `items[].icon` 是字符串图标名(lucide 名,如 `'FolderTree'`),不是元素。
- `Spinner` 只出现在状态栏或按钮内加载态,不做整页 loading。
- `Fold` / `FoldTrigger` / `FoldBody` / `FoldFoot` 是一组:三个叶子必须放在 `<Fold>` 里;它们**一个像素都不画**(只管 role/aria-expanded/键盘),开合两态的皮肤整份由你写在 `style`/`className` 上。`Submenu` 只在 `<Menu>` 里用。
- `Field` 不 cloneElement:控件自己 `const f = useFieldControlProps()` 再 `{...f}` 摊上去,`label` 必填(可 `labelHidden`),`hint`/`error` 是文字不是节点。
- `IconButton` 的 `icon` 收一个组件(LucideIcon 形:`(props) => <svg …{...props}/>`),`label` 必填且同时是 aria-label 与 Tooltip;`Submenu`/`FilterChip` 的 `icon` 同形。
- `ButtonBase` 是无样式基座(只清 UA):瓦 / 行 / 选项丸 / 行内微型文字动作这类结构性交互件用它,皮肤自己给;文字动作钮用 `Button` / `AsyncButton`,图标钮用 `IconButton`。`AsyncButton` 的 `action` 是 `{ subscribe, isPending(key?) }`,忙态从它读,不自己记 useState。
- 视觉词汇件 `StatusDot`(六档 tone)/ `Dots`(流式等待)/ `OpenDot`(行尾「开着」三态)只画一颗点,颜色只上点不换底;旁边已有文字就别给 `label`。
- `Slider` 自己 `flex:1`、`Splitter` 是 `align-self:stretch` 的一条界:两件都必须住在有尺寸的 flex 容器里,单放会塌成零宽。
- `FilterChip` 的 `value` 是 `options[].value` 的键不是文案;`Reveal` 的现身态靠 `[data-reveal-scope]:hover / :focus-within`,把它挂在**行**上。

## 禁令(全部有既有拍板)

- **tab / 列表行 / 分组头一律不带计数徽**(Badge 不用于此;未读圆点另论)。
- 悬浮层之外不投影;内容卡靠 `--surface-N` 分层,不靠阴影。
- 禁原生 `<select>`/`confirm()`/`title=` 提示——用 Select / Dialog / Tooltip。
- 文本容器必须能被挤:flex 子项配 `min-width: 0`,溢出用省略截断,禁元素重叠。
- 焦点态是柔光环(`box-shadow` 环),不是描边突变。

## 状态与交互规范(08-31 立法,设计稿必须自带)

给用 onething React UI 出设计的代理:以下不是实现细节,是**设计稿必须画出来的内容**——缺了会在实现侧被第四轴打回。

1. **每个交互件画全状态**:rest / hover / focus / pending / success / error / empty / **超量**(数据 10×/100× 时长什么样:削量方式、粘性表头、回到顶部)。
2. **异步动作必有进行中形**:按钮以自身文字变化表达 pending(「正在拉取…」+禁用),不用悬浮 Spinner;Spinner 只允许出现在按钮内或状态栏。
3. **写操作就地更新**:勾选/删除/改名的稿要画「立即翻转」的形,不画「转圈后刷新」的形;重新拉取时旧内容保留在屏,骨架只用于首次加载。
4. **反馈就地**:复制类动作按钮自身短暂变「已复制」;不设计 Toast/通知承载操作反馈。
5. **提示一律 Tooltip 组件**,不用原生 title;界面词禁无上下文缩写(能力类=图标+Tooltip 全名)。
6. **状态色只上图标/点,不整行染色**;焦点态=统一柔光环;计数徽禁(文字读数可)。
7. **列表/抽屉画最大高度与内滚**;表头与行同一套列模板;窄容器给挤压形(名字列不弯,次要列让位)。
8. 危险动作=描边 danger 文字键+两段就地确认;实底只留给推荐路径。
