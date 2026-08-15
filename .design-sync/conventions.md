# onething — 设计约定

## ⚠️ 这是一次「样式面」同步：没有组件库

onething 的界面是 **Vue 3** 写的，它的组件无法在 React 运行时里渲染，所以本项目**不含任何可导入的组件**——没有 `_ds_bundle.js`，没有 `components/`。

**你要做的是：用普通 HTML/React 元素自己搭结构，然后用下面的 token 上色排版。** 只要 token 用对，产出的界面就是 onething 的样子。不要去 import 不存在的组件，也不要因为找不到组件就退回默认灰底蓝按钮。

## 设置

**默认即可用，无需任何 provider 或包裹层。** 引入 `styles.css` 之后，页面在**不设任何属性**时就是产品默认档：`flexoki · dark · blue`（暖墨灰底 `#282726` + 纸白字 `#F2F0E5` + 灯蓝 `#4385BE`）。

切换主题在根元素上加属性即可，两个维度正交：

```html
<html data-theme="light">                            <!-- 亮色（纸白底 #fffcf0） -->
<html data-theme="dark" data-color-theme="purple">   <!-- 暗色 + 紫强调 -->
```

`data-theme` 取 `dark` | `light`；`data-color-theme` 取 `blue` | `purple` | `green` | `orange` | `cyan` | `red` | `pink`。

> 别在页面里硬写 `#282726` 这类色值——那样主题一切换就穿帮。永远走 token。

## 样式惯用法：CSS 变量，没有工具类框架

**onething 不是 Tailwind 系，也不是 props 系。它的全部设计语言都在 `var(--*)` 自定义属性里。** 你自己的布局胶水想用什么写法都行（inline style、CSS Modules、styled-components 皆可），但**每一个颜色、字号、间距、圆角、时长都必须取自 token**。

### 语义层 `--ui-*`（首选，永远优先用这一层）

命名规则 `--ui-<族>-<角色>-<字段>`，字段是 `fg` | `bg` | `border` | `ring` | `shadow`。

| 族 | 常用 token |
|---|---|
| 面 | `--ui-surface-app-bg` `--ui-surface-panel-bg` `--ui-surface-elevated-bg` `--ui-surface-floating-bg` |
| 字 | `--ui-text-primary-fg` `--ui-text-secondary-fg` `--ui-text-muted-fg` `--ui-text-faint-fg` |
| 线 | `--ui-border-default-border` `--ui-border-subtle-border` `--ui-border-strong-border` |
| 强调 | `--ui-accent-primary-fg` |
| 行动 | `--ui-action-primary-bg` `--ui-action-primary-fg` |
| 态 | `--ui-state-hover-bg` `--ui-state-selected-bg` `--ui-state-active-bg` |
| 状态 | `--ui-status-danger-fg` `--ui-status-warning-fg` `--ui-status-success-fg` `--ui-status-info-fg` |
| 焦点 | `--ui-focus-ring-shadow` |

另有 `--ui-sidebar-*` `--ui-tab-*` `--ui-message-*` `--ui-tool-*` 等场景族，需要时到 `tokens/variables.css` 里查。

### 结构层

| 类别 | token |
|---|---|
| 圆角 | `--radius-xs`(3px 默认) `--radius-sm`(6px 控件) `--radius-full`(丸)。**不要用 md/lg/xl——本系统实际不用** |
| 间距 | `--space-1`(4) `--space-2`(8) `--space-3`(12) `--space-4`(16) `--space-5`(20) `--space-6`(24) `--space-8`(32) `--space-10`(40) `--space-12`(48) |
| 字号 | `--type-body-size`(14) `--type-label-size`(13) `--type-meta-size`(12) `--type-caption-size`(11)，配套 `--type-*-line-height` |
| 字体 | `--font-body`(无衬线正文) `--font-display`(**衬线标题**) `--font-mono`(代码/文件名/数值) |
| 动效 | `--duration-fast`(120ms 默认) `--duration-normal`(200ms)，缓动一律 `--ease-default` |
| 层级 | `--z-dropdown`(100) `--z-modal`(600) `--z-tooltip`(700) `--z-toast`(800)。**禁止写字面 z-index** |

### 真实存在的全局类（可直接用）

- `.app-surface[data-surface="app"|"panel"|"chat"|"elevated"]` —— 四档面底
- `.u-focus-ring` / `.u-focus-ring-input` —— 焦点环（**只在 `:focus-visible` 生效**，别用裸 `:focus`）
- `.btn` + `.primary` / `.secondary` / `.danger` / `.danger-ghost`
- `.text-action` + `.is-primary` / `.is-danger` —— 无壳文字按钮（mono 11px，hover 出下划线）
- `.ledger-card` `.ledger-row` `.ledger-rule` `.ledger-label` `.ledger-figure` `.ledger-empty` —— 账页画线风
- `.form-group` `.form-label` `.form-input` `.form-hint` `.toast` `.error-message` `.success-message`

⛔ **这些就是全部。** 没有列出来的类名不存在——不要发明 `.card`、`.badge-primary` 这类名字，它们不会有任何样式。需要卡片就用面 token + 1px 墨线自己搭。

## 五条硬规矩

1. **内容面不投影。** 分隔内容用 `1px solid var(--ui-border-subtle-border)`；阴影只给浮层（`--shadow-floating`）。
2. **一屏只有一个填充色块。** `--ui-accent-primary-fg` 是唯一的填充行动色，其余按钮走描边或无壳。
3. **hover 与 selected 是两条正交通道。** 底色归 hover，选中用左缘墨线（`box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg)`）或字色/字重，不要用"更深的底色"同时表达两者。
4. **状态色只上边框和图标，不上底。**
5. **不要用渐变。** 系统是平涂 + 墨阶。

## 真相在哪

- `styles.css` → `tokens/{fonts,variables,state-alpha,components,defaults}.css` —— 变量的唯一出处，写样式前先读
- `guidelines/style-reference.md` —— 完整规范：色板逐条、排版阶梯、组件实测配方、Do & Don't

## 一个惯用写法示例

```jsx
<div style={{ background: 'var(--ui-surface-app-bg)', padding: 'var(--space-6)',
              fontFamily: 'var(--font-body)', color: 'var(--ui-text-primary-fg)' }}>
  <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500,
               margin: `0 0 var(--space-3)` }}>
    会话存储
  </h2>

  <div style={{ background: 'var(--ui-surface-panel-bg)',
                border: '1px solid var(--ui-border-subtle-border)',
                borderRadius: 'var(--radius-xs)', padding: 'var(--space-4)' }}>
    <p style={{ margin: `0 0 var(--space-2)`, fontSize: 'var(--type-body-size)',
                color: 'var(--ui-text-secondary-fg)' }}>
      每会话一个 JSONL 目录，流式写入时追加。
    </p>
    <button className="btn primary">应用</button>
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11,
                   color: 'var(--ui-text-faint-fg)', marginLeft: 'var(--space-2)' }}>
      567 KB
    </span>
  </div>
</div>
```

注意其中三处 onething 的签名：**标题用衬线**、卡片**只有 1px 墨线没有阴影**、**mono 用于数值**。
