# onething React UI — 设计约定

这是 onething React 桌面壳的**真组件库**(`apps/desktop-react/src/ui`),不是重绘。20 件组件全部从 `window.OnethingUI.*` 可导入可渲染;每件的 API 契约在 `<Name>.d.ts`,用法在 `<Name>.prompt.md`。**优先用这些组件搭界面,不要用裸元素重造轮子。**

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

## 禁令(全部有既有拍板)

- **tab / 列表行 / 分组头一律不带计数徽**(Badge 不用于此;未读圆点另论)。
- 悬浮层之外不投影;内容卡靠 `--surface-N` 分层,不靠阴影。
- 禁原生 `<select>`/`confirm()`/`title=` 提示——用 Select / Dialog / Tooltip。
- 文本容器必须能被挤:flex 子项配 `min-width: 0`,溢出用省略截断,禁元素重叠。
- 焦点态是柔光环(`box-shadow` 环),不是描边突变。
