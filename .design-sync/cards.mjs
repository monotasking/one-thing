/**
 * 预览卡定义 —— claude.ai/design 的设计系统面板靠这些渲染。
 *
 * 面板不按文件列表显示，它显示**卡片**：app 自检时扫描每份预览 HTML 的首行
 * `<!-- @dsCard … -->` 标记，编成 _ds_manifest.json。没有卡片 = 面板空白，
 * 哪怕 token 文件全都传上去了。
 *
 * 卡片是纯 HTML/CSS，不需要 React —— 这正是非 React 仓库也能把设计系统
 * 「让人看得见」的那条路。每张卡是独立文档，link 回 ../styles.css，
 * 所以卡片本身就是 token 闭包的一次真实渲染验证。
 */

/** 卡片外壳。theme 缺省不写 data-theme，走 defaults.css 的产品默认档（dark）。 */
const shell = ({ group, name, subtitle, viewport, theme, css = '', body }) =>
  `<!-- @dsCard group="${group}" viewport="${viewport}" name="${name}" subtitle="${subtitle}" -->
<!DOCTYPE html>
<html lang="zh-CN"${theme ? ` data-theme="${theme}"` : ''}>
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="../styles.css" />
<style>
  body { margin:0; background:var(--ui-surface-app-bg); color:var(--ui-text-primary-fg);
         font-family:var(--font-body); font-size:13px; }
  .wrap { padding:18px 20px; }
  .cap { font-family:var(--font-mono); font-size:9.5px; letter-spacing:.08em;
         text-transform:uppercase; color:var(--ui-text-faint-fg); }
  .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
${css}
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>
`;

export const CARDS = [
  // ── Colors ───────────────────────────────────────────────────────────
  {
    file: 'colors-surfaces.html', group: 'Colors', viewport: '700x210',
    name: '面 Surfaces', subtitle: '四层实色梯 —— 侧栏/会话/面板同值，靠墨线分区',
    css: `.stack{display:flex;gap:0}
  .layer{flex:1;height:96px;display:flex;flex-direction:column;justify-content:flex-end;
         padding:8px 10px;border:1px solid var(--ui-border-subtle-border);margin-left:-1px}
  .layer b{font-size:11px;font-weight:600}
  .layer span{font-family:var(--font-mono);font-size:9.5px;color:var(--ui-text-muted-fg)}
  .note{margin-top:12px;font-size:11.5px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="stack">
  <div class="layer" style="background:var(--bg-app)"><b>app</b><span>#282726</span></div>
  <div class="layer" style="background:var(--bg-sidebar)"><b>sidebar</b><span>#343331</span></div>
  <div class="layer" style="background:var(--bg-chat)"><b>chat</b><span>#343331</span></div>
  <div class="layer" style="background:var(--bg-panel)"><b>panel</b><span>#343331</span></div>
  <div class="layer" style="background:var(--bg-elevated)"><b>elevated</b><span>#403E3C</span></div>
  <div class="layer" style="background:var(--bg-floating)"><b>floating</b><span>#575653</span></div>
</div>
<div class="note">sidebar / chat / panel <b>三者同值</b> —— 区域之间从不靠底色区分，只靠 1px 墨线。</div>`,
  },
  {
    file: 'colors-text.html', group: 'Colors', viewport: '700x190',
    name: '字 Text', subtitle: '四档明度不同的墨色，不是同色不同 alpha',
    css: `.col{display:flex;flex-direction:column;gap:9px}
  .t{font-size:14px;display:flex;align-items:baseline;gap:12px}
  .t code{font-family:var(--font-mono);font-size:10px;color:var(--ui-text-faint-fg)}`,
    body: `<div class="col">
  <span class="t" style="color:var(--ui-text-primary-fg)">纸白 Paper — 正文、标题、主要内容 <code>--ui-text-primary-fg · #F2F0E5</code></span>
  <span class="t" style="color:var(--ui-text-secondary-fg)">纸灰 Paper Dim — 次要正文、说明行 <code>--ui-text-secondary-fg · #E6E4D9</code></span>
  <span class="t" style="color:var(--ui-text-muted-fg)">灰烬 Ash — 标签、元信息、未选中导航 <code>--ui-text-muted-fg · #B7B5AC</code></span>
  <span class="t" style="color:var(--ui-text-faint-fg)">淡烟 Smoke — 时间戳、占位符、描述行 <code>--ui-text-faint-fg · #9F9D96</code></span>
</div>`,
  },
  {
    file: 'colors-accent.html', group: 'Colors', viewport: '700x180',
    name: '色 Accent & Status', subtitle: '灯蓝是全系统唯一的主行动色',
    css: `.row{display:flex;gap:10px;flex-wrap:wrap}
  .sw{flex:1;min-width:110px;border-radius:var(--radius-xs);overflow:hidden;
      border:1px solid var(--ui-border-subtle-border)}
  .chip{height:44px}
  .lab{padding:6px 8px}
  .lab b{display:block;font-size:11px;font-weight:600}
  .lab span{font-family:var(--font-mono);font-size:9.5px;color:var(--ui-text-muted-fg)}
  .note{margin-top:12px;font-size:11.5px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="row">
  <div class="sw"><div class="chip" style="background:var(--accent)"></div><div class="lab"><b>灯蓝 Accent</b><span>#4385BE</span></div></div>
  <div class="sw"><div class="chip" style="background:var(--color-danger)"></div><div class="lab"><b>朱砂 Danger</b><span>#D14D41</span></div></div>
  <div class="sw"><div class="chip" style="background:var(--color-warning)"></div><div class="lab"><b>琥珀 Warning</b><span>#DA702C</span></div></div>
  <div class="sw"><div class="chip" style="background:var(--color-success)"></div><div class="lab"><b>苔绿 Success</b><span>#879A39</span></div></div>
  <div class="sw"><div class="chip" style="background:var(--color-info)"></div><div class="lab"><b>铜绿 Info</b><span>#3AA99F</span></div></div>
</div>
<div class="note">强调色可整体换 7 种（<span class="mono">data-color-theme</span>），换的是同一枚 <span class="mono">--accent</span> —— 不给单个组件上色。</div>`,
  },
  {
    file: 'colors-borders-states.html', group: 'Colors', viewport: '700x210',
    name: '线与态 Borders & States', subtitle: '墨线是分隔内容的唯一手段；hover 与 selected 两条正交通道',
    css: `.g{display:flex;gap:26px}
  .b{flex:1}
  .ln{height:1px;margin:7px 0 3px}
  .s{margin-top:4px;border:1px solid var(--ui-border-subtle-border);border-radius:var(--radius-xs);overflow:hidden}
  .r{padding:7px 10px;font-size:12px;border-bottom:1px solid var(--ui-border-subtle-border)}
  .r:last-child{border-bottom:none}
  .sel{box-shadow:inset 2px 0 0 var(--ui-accent-primary-fg);color:var(--ui-accent-primary-fg)}`,
    body: `<div class="g">
  <div class="b"><div class="cap">墨线 Borders</div>
    <div class="ln" style="background:var(--ui-border-default-border)"></div><span class="mono" style="font-size:10px;color:var(--ui-text-muted-fg)">default · #575653</span>
    <div class="ln" style="background:var(--ui-border-subtle-border)"></div><span class="mono" style="font-size:10px;color:var(--ui-text-muted-fg)">subtle · #403E3C</span>
    <div class="ln" style="background:var(--ui-border-strong-border)"></div><span class="mono" style="font-size:10px;color:var(--ui-text-muted-fg)">strong · #6F6E69</span>
  </div>
  <div class="b"><div class="cap">态 States</div>
    <div class="s">
      <div class="r">静息 rest</div>
      <div class="r" style="background:var(--ui-state-hover-bg)">hover — 底色加深一档</div>
      <div class="r sel">selected — 左缘墨线 + 主色字</div>
      <div class="r sel" style="background:var(--ui-state-hover-bg)">selected + hover — 两条通道叠加</div>
    </div>
  </div>
</div>`,
  },
  {
    file: 'colors-flexoki-ramp.html', group: 'Colors', viewport: '700x150',
    name: 'Flexoki 墨阶', subtitle: '13 档原色板 —— 明暗两套互为倒序，组件永不直接消费',
    css: `.ramp{display:flex}
  .c{flex:1;height:52px;position:relative}
  .c span{position:absolute;bottom:-15px;left:0;right:0;text-align:center;
          font-family:var(--font-mono);font-size:8px;color:var(--ui-text-faint-fg)}
  .note{margin-top:26px;font-size:11.5px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="ramp">
  ${['50', '100', '150', '200', '300', '400', '500', '600', '700', '800', '850', '900', '950']
    .map((n) => `<div class="c" style="background:var(--fx-base-${n})"><span>${n}</span></div>`)
    .join('\n  ')}
</div>
<div class="note">暗色档下整条墨阶翻转：<span class="mono">--fx-base-50</span> 从 #F2F0E5 变成 #1C1B1A。语义层只引用它，不写死色值。</div>`,
  },

  // ── Type ─────────────────────────────────────────────────────────────
  {
    file: 'type-display.html', group: 'Type', viewport: '700x200',
    name: '标题 — Lora 衬线', subtitle: '衬线做标题是本系统最强的排版签名',
    css: `.d{font-family:var(--font-display);font-weight:500;line-height:1.15;margin:0 0 6px}
  .note{margin-top:14px;font-size:11.5px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="cap">--font-display → Lora Variable + 思源宋体</div>
<p class="d" style="font-size:22px">墨稿 · The quiet ledger</p>
<p class="d" style="font-size:18px">会话存储改造 · Session storage</p>
<p class="d" style="font-size:16px">工具调用时间线 · Tool trace</p>
<div class="note">中英配对固定成组（Lora ↔ 思源宋），<b>不允许单独换掉一半</b>。</div>`,
  },
  {
    file: 'type-body.html', group: 'Type', viewport: '700x200',
    name: '正文 — Public Sans', subtitle: 'UI 主力：body / label / meta / caption',
    css: `.l{margin:0 0 8px}
  .k{font-family:var(--font-mono);font-size:9.5px;color:var(--ui-text-faint-fg);margin-left:10px}`,
    body: `<div class="cap">--font-body → Public Sans Variable + 思源黑体</div>
<p class="l" style="font-size:14px;line-height:1.5">body 14/1.5 — 每会话一个 JSONL 目录，流式写入时追加。<span class="k">--type-body-size</span></p>
<p class="l" style="font-size:13px;line-height:1.3077;font-weight:500">label 13/1.31 · 500 — 控件与导航<span class="k">--type-label-size</span></p>
<p class="l" style="font-size:12px;line-height:1.4167;color:var(--ui-text-muted-fg)">meta 12/1.42 — 元信息与说明<span class="k">--type-meta-size</span></p>
<p class="l" style="font-size:11px;line-height:1.3636;color:var(--ui-text-faint-fg)">caption 11/1.36 — 时间戳与最弱一档<span class="k">--type-caption-size</span></p>`,
  },
  {
    file: 'type-scale.html', group: 'Type', viewport: '700x260',
    name: '字号阶梯', subtitle: '10 档 10→22px —— 注意：封顶 22px，系统内没有 display 层级',
    css: `.r{display:flex;align-items:baseline;gap:14px;padding:5px 0;
      border-bottom:1px solid var(--ui-border-subtle-border)}
  .r:last-of-type{border-bottom:none}
  .k{font-family:var(--font-mono);font-size:9.5px;color:var(--ui-text-faint-fg);width:74px;flex:none}
  .warn{margin-top:10px;font-size:11px;color:var(--color-warning)}`,
    body: `${[
      [1000, 22], [900, 20], [800, 18], [700, 16], [600, 15],
      [500, 14], [400, 13], [300, 12], [200, 11], [100, 10],
    ].map(([k, px]) => `<div class="r"><span class="k">${k} · ${px}px</span><span style="font-size:${px}px">墨稿 The quiet ledger</span></div>`).join('\n')}
<div class="warn">⚠ 阶梯封顶 22px —— 空态、引导、区块大标题物理上做不出层级。这是已知的结构性限制。</div>`,
  },
  {
    file: 'type-mono.html', group: 'Type', viewport: '700x170',
    name: '等宽 — Mono', subtitle: '代码、文件名、数值、全大写小标签',
    css: `.m{font-family:var(--font-mono);margin:0 0 7px}
  .tag{font-family:var(--font-mono);font-size:9.5px;font-weight:650;letter-spacing:.18em;
       text-transform:uppercase;color:var(--ui-text-faint-fg)}`,
    body: `<div class="cap">--font-mono → SF Mono / Fira Code / JetBrains Mono</div>
<p class="m" style="font-size:12px;font-weight:620">read <span style="font-weight:450;color:var(--ui-text-muted-fg)">packages/renderer/styles/variables.css</span></p>
<p class="m" style="font-size:12px;color:var(--ui-text-secondary-fg)">567 KB · 14.6 MB → 567 KB</p>
<p class="m" style="font-size:11px;color:var(--ui-text-faint-fg)">01 02 03 · decimal-leading-zero 编号列</p>
<p class="tag">Write · Trace · Ledger</p>`,
  },

  // ── Shape & Space ────────────────────────────────────────────────────
  {
    file: 'space-scale.html', group: 'Shape', viewport: '700x190',
    name: '间距阶梯', subtitle: '基数 4px，9 档（跳过 7/9/11）',
    css: `.r{display:flex;align-items:center;gap:12px;padding:3px 0}
  .k{font-family:var(--font-mono);font-size:10px;color:var(--ui-text-muted-fg);width:76px;flex:none}
  .v{font-family:var(--font-mono);font-size:10px;color:var(--ui-text-faint-fg);width:38px;flex:none;text-align:right}
  .bar{height:9px;background:var(--ui-accent-primary-fg);opacity:.62;border-radius:1px}`,
    body: `${[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => {
      const px = n * 4;
      return `<div class="r"><span class="k">--space-${n}</span><span class="v">${px}px</span><div class="bar" style="width:${px}px"></div></div>`;
    }).join('\n')}`,
  },
  {
    file: 'shape-radius-shadow.html', group: 'Shape', viewport: '700x200',
    name: '圆角与深度', subtitle: '实际只用三档圆角；内容面不投影，阴影只给浮层',
    css: `.g{display:flex;gap:26px}
  .b{flex:1}
  .row{display:flex;gap:12px;margin-top:8px;flex-wrap:wrap}
  .r{width:56px;height:56px;border:1px solid var(--ui-border-strong-border);
     background:var(--ui-surface-panel-bg);display:grid;place-items:center;
     font-family:var(--font-mono);font-size:9px;color:var(--ui-text-muted-fg)}
  .s{width:88px;height:56px;background:var(--ui-surface-elevated-bg);
     border:1px solid var(--ui-border-subtle-border);border-radius:var(--radius-xs);
     display:grid;place-items:center;font-family:var(--font-mono);font-size:9px;
     color:var(--ui-text-muted-fg)}
  .dead{opacity:.4}
  .note{margin-top:12px;font-size:11px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="g">
  <div class="b"><div class="cap">圆角 Radius</div><div class="row">
    <div class="r" style="border-radius:3px">xs 3</div>
    <div class="r" style="border-radius:6px">sm 6</div>
    <div class="r dead" style="border-radius:10px">md 10</div>
    <div class="r dead" style="border-radius:16px">lg 16</div>
    <div class="r" style="border-radius:999px">full</div>
  </div></div>
  <div class="b"><div class="cap">深度 Elevation</div><div class="row">
    <div class="s">none · 内容面</div>
    <div class="s" style="box-shadow:var(--shadow-elevated)">elevated</div>
    <div class="s" style="box-shadow:var(--shadow-floating)">floating</div>
  </div></div>
</div>
<div class="note">md / lg / xl 全库合计 11 次引用，<b>视为死档</b>。分隔内容用 1px 墨线，不用阴影。</div>`,
  },
  {
    file: 'motion-layers.html', group: 'Shape', viewport: '700x220',
    name: '动效与层级', subtitle: '系统只有一种手势：120ms + ease-default',
    css: `.g{display:flex;gap:26px}
  .b{flex:1}
  .r{display:flex;justify-content:space-between;padding:4px 0;font-size:11.5px;
     border-bottom:1px solid var(--ui-border-subtle-border)}
  .r:last-child{border-bottom:none}
  .r b{font-family:var(--font-mono);font-size:10px;font-weight:400;color:var(--ui-text-muted-fg)}
  .hot{color:var(--ui-accent-primary-fg)}`,
    body: `<div class="g">
  <div class="b"><div class="cap">动效 Motion</div>
    <div class="r hot"><span>--duration-fast</span><b>120ms · 405 处</b></div>
    <div class="r"><span>--duration-normal</span><b>200ms · 245 处</b></div>
    <div class="r"><span>--duration-slow</span><b>300ms · 28 处</b></div>
    <div class="r hot"><span>--ease-default</span><b>647 处</b></div>
    <div class="r"><span>--ease-spring</span><b>5 处 · 只给"出现"</b></div>
  </div>
  <div class="b"><div class="cap">层级 z-index</div>
    <div class="r"><span>--z-sticky</span><b>10</b></div>
    <div class="r"><span>--z-dropdown</span><b>100</b></div>
    <div class="r"><span>--z-sidebar</span><b>200</b></div>
    <div class="r"><span>--z-overlay</span><b>500</b></div>
    <div class="r"><span>--z-modal</span><b>600</b></div>
    <div class="r"><span>--z-tooltip</span><b>700</b></div>
    <div class="r"><span>--z-toast</span><b>800</b></div>
  </div>
</div>`,
  },

  // ── Recipes ──────────────────────────────────────────────────────────
  {
    file: 'recipe-buttons.html', group: 'Recipes', viewport: '700x180',
    name: '按钮配方', subtitle: 'default 32px · 一屏只有一个填充色块',
    css: `.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  .b{height:32px;min-width:72px;padding:0 13px;border-radius:7px;border:1px solid transparent;
     font-family:var(--font-body);font-size:13px;font-weight:650;line-height:1;cursor:default}
  .def{background:var(--ui-state-hover-bg);color:var(--ui-text-primary-fg);border-color:var(--ui-border-default-border)}
  .pri{background:var(--ui-accent-primary-fg);color:#100F0F}
  .dgr{background:var(--color-danger);color:#100F0F}
  .pln{background:color-mix(in srgb,var(--ui-accent-primary-fg) 10%,transparent);
       border-color:color-mix(in srgb,var(--ui-accent-primary-fg) 42%,transparent);color:var(--ui-accent-primary-fg)}
  .dsh{background:transparent;border-style:dashed;
       border-color:color-mix(in srgb,var(--ui-accent-primary-fg) 58%,transparent);color:var(--ui-accent-primary-fg)}
  .txt{background:transparent;border:none;min-width:0;padding:0 7px;color:var(--ui-accent-primary-fg)}
  .sm{height:28px;min-width:60px;padding:0 10px;border-radius:6px;font-size:12px}
  .lg{height:38px;min-width:84px;padding:0 16px;border-radius:8px;font-size:14px}
  .note{font-size:11px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="row">
  <button class="b def">Default</button><button class="b pri">Primary</button>
  <button class="b dgr">Danger</button><button class="b pln">Plain</button>
  <button class="b dsh">Dashed</button><button class="b txt">Text</button>
</div>
<div class="row">
  <button class="b def sm">Small 28</button><button class="b def">Default 32</button>
  <button class="b def lg">Large 38</button>
  <button class="b pri" style="border-radius:999px">Round</button>
</div>
<div class="note">共通 <span class="mono">font-weight:650</span> · <span class="mono">line-height:1</span>；hover 走 <span class="mono">color-mix(tone 82–86%, text-primary)</span> —— <b>加白而不是换色</b>。</div>`,
  },
  {
    file: 'recipe-marks.html', group: 'Recipes', viewport: '700x180',
    name: '标记配方', subtitle: 'Badge 填充 / Chip 空心 / Pill 丸',
    css: `.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:13px}
  .bd{display:inline-flex;align-items:center;min-height:17px;padding:0 5px;
      border:1px solid transparent;border-radius:5px;font-size:9.5px;font-weight:750;
      line-height:1;text-transform:uppercase;letter-spacing:.03em}
  .chip{display:inline-flex;align-items:center;height:24px;padding:0 9px;
        border:1px solid var(--ui-border-default-border);border-radius:var(--radius-xs);
        background:transparent;color:var(--ui-text-secondary-fg);font-size:12px;line-height:1}
  .file{height:28px;font-family:var(--font-mono);font-size:11px;
        border-color:color-mix(in srgb,var(--ui-border-strong-border) 45%,transparent)}
  .seg{display:inline-flex;padding:2px;border:1px solid var(--ui-border-subtle-border);
       border-radius:999px;background:var(--ui-surface-input-bg)}
  .seg i{height:22px;padding:0 11px;border-radius:999px;font-style:normal;font-size:11.5px;
         display:inline-flex;align-items:center;color:var(--ui-text-muted-fg)}
  .seg i.on{background:var(--ui-surface-panel-bg);color:var(--ui-text-primary-fg);font-weight:600}
  .note{font-size:11px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="row">
  <span class="bd" style="background:color-mix(in srgb,var(--ui-text-muted-fg) 10%,transparent);border-color:color-mix(in srgb,var(--ui-text-muted-fg) 16%,transparent);color:var(--ui-text-secondary-fg)">Draft</span>
  <span class="bd" style="background:color-mix(in srgb,var(--ui-accent-primary-fg) 11%,transparent);border-color:color-mix(in srgb,var(--ui-accent-primary-fg) 18%,transparent);color:var(--ui-accent-primary-fg)">Active</span>
  <span class="bd" style="background:color-mix(in srgb,var(--color-success) 12%,transparent);border-color:color-mix(in srgb,var(--color-success) 28%,transparent);color:var(--color-success)">Passed</span>
  <span class="bd" style="background:color-mix(in srgb,var(--color-warning) 12%,transparent);border-color:color-mix(in srgb,var(--color-warning) 28%,transparent);color:var(--color-warning)">Stale</span>
  <span class="bd" style="background:color-mix(in srgb,var(--color-danger) 12%,transparent);border-color:color-mix(in srgb,var(--color-danger) 28%,transparent);color:var(--color-danger)">Failed</span>
</div>
<div class="row">
  <span class="chip">flexoki · dark</span>
  <span class="chip file">variables.css</span>
  <span class="seg"><i class="on">紧凑</i><i>舒适</i><i>宽松</i></span>
</div>
<div class="note">Chip 一律<b>空心</b> —— 填充留给 Badge 和主按钮。分段丸选中<b>只换面底与字重，不涂 accent 底</b>。</div>`,
  },
  {
    file: 'recipe-ledger.html', group: 'Recipes', viewport: '700x230',
    name: '账目行 Ledger', subtitle: '尺规线分组头 + 44px 行 · hover 与 selected 正交',
    css: `.h{display:flex;align-items:baseline;gap:8px;padding:10px 0 6px}
  .lab{font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--ui-text-faint-fg)}
  .rule{flex:1;height:1px;background:var(--ui-border-subtle-border)}
  .cnt{font-family:var(--font-mono);font-size:10px;color:var(--ui-text-faint-fg)}
  .r{display:flex;align-items:center;gap:10px;height:44px;padding:0 6px;
     border-bottom:1px solid var(--ui-border-subtle-border)}
  .t{font-size:12.5px}
  .m{margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--ui-text-faint-fg)}
  .hov{background:var(--ui-state-hover-bg)}
  .sel{box-shadow:inset 2px 0 0 var(--ui-accent-primary-fg)}
  .sel .t{color:var(--ui-accent-primary-fg)}`,
    body: `<div class="h"><span class="lab">Sessions</span><span class="rule"></span><span class="cnt">12</span></div>
<div class="r sel"><span class="t">重构会话存储驱动</span><span class="m">14:02</span></div>
<div class="r hov"><span class="t">壁纸六级分档实现</span><span class="m">11:48</span></div>
<div class="r"><span class="t">插件 UI 锚点审计</span><span class="m">09:31</span></div>
<div class="r sel hov"><span class="t">selected + hover 叠加</span><span class="m">08:15</span></div>`,
  },
  {
    file: 'recipe-signature.html', group: 'Recipes', viewport: '700x250',
    name: '签名手法 Signature', subtitle: '图签 / 编号列 —— 它们是信息装置，不是装饰',
    css: `.spec{position:relative;border:1px solid var(--ui-border-default-border);
        border-radius:0;padding:16px 14px 12px;margin:14px 0 18px}
  .tag{position:absolute;top:-8px;left:12px;background:var(--ui-surface-app-bg);padding:0 7px;
       font-family:var(--font-mono);font-size:9.5px;font-weight:650;letter-spacing:.18em;
       text-transform:uppercase;color:var(--ui-text-faint-fg)}
  .nc{counter-reset:nc}
  .nr{display:grid;grid-template-columns:26px 1fr;gap:8px;align-items:center;min-height:26px;
      padding:4px 8px 4px 4px;border-bottom:1px solid color-mix(in srgb,var(--ui-border-subtle-border) 60%,transparent)}
  .nr:last-child{border-bottom:none}
  .nr::before{counter-increment:nc;content:counter(nc,decimal-leading-zero);
              font-family:var(--font-mono);font-size:11px;color:var(--ui-text-faint-fg)}
  .a{font-family:var(--font-mono);font-size:12px;font-weight:620;min-width:46px;display:inline-block}
  .tg{font-family:var(--font-mono);font-size:12px;font-weight:450;color:var(--ui-text-muted-fg);margin-left:10px}
  .note{font-size:11px;color:var(--ui-text-muted-fg)}`,
    body: `<div class="cap">图签 Frame Label —— 标签骑在边框上，用所在面的底色把线打断</div>
<div class="spec"><span class="tag">Write</span>
<div class="nc">
  <div class="nr"><span><span class="a">read</span><span class="tg">variables.css</span></span></div>
  <div class="nr"><span><span class="a">edit</span><span class="tg">state-alpha.css</span></span></div>
  <div class="nr"><span><span class="a">bash</span><span class="tg">bun run ui:gate</span></span></div>
</div>
</div>
<div class="note">编号列用 <span class="mono">counter</span> + <span class="mono">decimal-leading-zero</span>，静息 opacity 0、鼠标进入整条时间线才淡入。工具调用<b>没有卡片</b> —— radius 0 的行，hover 走纯墨通道，全程无背景带。</div>`,
  },

  // ── Themes ───────────────────────────────────────────────────────────
  {
    file: 'themes-light-dark.html', group: 'Themes', viewport: '700x230',
    name: '明暗与强调色', subtitle: '默认 dark；data-theme / data-color-theme 两个维度正交',
    css: `.g{display:flex;gap:14px}
  .p{flex:1;border:1px solid var(--ui-border-subtle-border);border-radius:var(--radius-xs);overflow:hidden}
  .p .hd{padding:6px 10px;font-family:var(--font-mono);font-size:9.5px;letter-spacing:.06em}
  .p .bd{padding:12px 10px}
  .p .ttl{font-family:var(--font-display);font-size:15px;font-weight:500;margin:0 0 6px}
  .p .tx{font-size:11.5px;margin:0 0 9px}
  .p .btn{display:inline-block;height:26px;line-height:26px;padding:0 11px;border-radius:6px;
          font-size:12px;font-weight:650}
  .code{margin-top:14px;font-family:var(--font-mono);font-size:10.5px;color:var(--ui-text-muted-fg);line-height:1.7}`,
    body: `<div class="g">
  <div class="p" style="background:#282726">
    <div class="hd" style="background:#343331;color:#9F9D96">data-theme="dark" · 默认</div>
    <div class="bd"><p class="ttl" style="color:#F2F0E5">会话存储</p>
      <p class="tx" style="color:#B7B5AC">每会话一个 JSONL 目录</p>
      <span class="btn" style="background:#4385BE;color:#100F0F">应用</span></div>
  </div>
  <div class="p" style="background:#e6e4d9">
    <div class="hd" style="background:#f2f0e5;color:#878580">data-theme="light"</div>
    <div class="bd" style="background:#fffcf0"><p class="ttl" style="color:#575653">会话存储</p>
      <p class="tx" style="color:#6f6e69">每会话一个 JSONL 目录</p>
      <span class="btn" style="background:#4385BE;color:#fffcf0">应用</span></div>
  </div>
  <div class="p" style="background:#282726">
    <div class="hd" style="background:#343331;color:#9F9D96">+ color-theme="purple"</div>
    <div class="bd"><p class="ttl" style="color:#F2F0E5">会话存储</p>
      <p class="tx" style="color:#B7B5AC">每会话一个 JSONL 目录</p>
      <span class="btn" style="background:#8B7EC8;color:#100F0F">应用</span></div>
  </div>
</div>
<div class="code">&lt;html&gt;                                        → 暗色 + 蓝（产品默认）<br>
&lt;html data-theme="light"&gt;                     → 亮色<br>
&lt;html data-theme="dark" data-color-theme="purple"&gt; → 暗色 + 紫</div>`,
  },
];

export const renderCard = (c) => shell(c);
