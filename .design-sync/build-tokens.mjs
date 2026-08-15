#!/usr/bin/env node
/**
 * onething → claude.ai/design  「样式面」构建器
 *
 * ── 为什么是这个脚本，而不是 design-sync 的转换器 ──────────────────────
 * design-sync 的 package 转换器要求 **React 设计系统**（子技能 SKILL.md:262：
 * "a non-React DS has nothing for the claude.ai/design agent to build with"）。
 * onething 是 Vue 3，且五个 package 都没有 dist/ 产物，renderer 是 private 包，
 * common/ 也没有 barrel 导出 —— 三条都接不上转换器。
 *
 * 所以本次是**部分同步**：只出「样子」（token / 字体 / 规范 / 预览卡），不出组件
 * bundle、不出 .d.ts。设计 agent 用它自己的通用 React 件搭界面，但配色、排版、
 * 间距、圆角、动效会是 onething 的。
 *
 * 预览卡（guidelines/*.html）**必须有**：面板不按文件列表显示，它靠每份 HTML
 * 首行的 `@dsCard` 标记建索引。没有卡片 = 面板空白，哪怕 token 全传上去了。
 *
 * ── 唯一的一处非拷贝改造 ──────────────────────────────────────────────
 * onething 的颜色变量**只挂在 `[data-theme="dark"|"light"]` 上**，强调色挂在
 * `[data-color-theme="…"]` 上，裸 `:root` 上一枚颜色都没有。设计 agent 渲染的
 * 页面不会带这两个属性 —— 直接搬过去的话，所有颜色都解析不出来。
 *
 * 于是生成一份 `tokens/defaults.css`，把产品默认档（flexoki · dark · blue）
 * 重发一遍到 `:root:not([data-theme])` / `:root:not([data-color-theme])`。
 * 这是本脚本对源码做的**唯一**语义改动。
 *
 * 选择器的选取是被实测逼出来的，不是随手挑的：
 *   · `:where(:root)`（特异性 0）**不行** —— flexoki-colors.css 把**亮色**墨阶
 *     写在真 `:root`（0,1,0）上，会稳稳压过 :where。实测裸页面解析出的是亮色。
 *   · `:root`（0,1,0）也不行 —— 与 `[data-theme="light"]` 同特异性，靠源序决胜，
 *     排在后面就会把亮色主题顶掉。
 *   · `:root:not([data-theme])`（0,2,0）才对：没设属性时压得过 flexoki 的 `:root`；
 *     一旦设了 data-theme，这条选择器**根本不匹配**，真主题块原样生效。
 *
 * 还有一层间接要注意：variables.css 的 dark 块里写的是 `var(--fx-base-100)`
 * 这类引用，值本身来自 flexoki 墨阶。所以兜底必须**连墨阶一起**重发，
 * 只搬语义层会解析到亮色的原色板上去。
 */

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CARDS, renderCard } from './cards.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'packages/renderer/styles');
const NM = join(ROOT, 'node_modules');
const OUT = join(ROOT, 'ds-bundle');

const log = (...a) => console.error('[ds]', ...a);

// ── 0. 清空输出 ────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
for (const d of ['tokens', 'fonts', 'guidelines']) mkdirSync(join(OUT, d), { recursive: true });

// ── 1. 原样搬运的样式文件 ──────────────────────────────────────────────
// 顺序即层次：色板 → 语义字典 → 行为层 → 共享构件层。
// variables.css 自己第 7 行 @import './flexoki-colors.css'，同目录下自然解析。
const COPY = [
  'flexoki-colors.css',   // ① 原色板（13 档墨阶 × 明暗两套 + 8 色相）
  'variables.css',        // ② 语义字典 + ③ --ui-* 语义层静态兜底
  'state-alpha.css',      // ④ 行为层（墨 × alpha 旋钮）
  'components.css',       // 共享构件层：.app-surface / .u-focus-ring / .text-action
];
for (const f of COPY) {
  copyFileSync(join(SRC, f), join(OUT, 'tokens', f));
  log('copied tokens/' + f);
}

// ── 2. 字体：只带拉丁两族 ──────────────────────────────────────────────
// Public Sans（正文）+ Lora（标题衬线）= 20 个 woff2 / 0.4MB。
// 中文 Noto Sans SC / Noto Serif SC 是 101 个分片子集 × 2 = 10.4MB，
// 体积不成比例，跳过 —— 字体栈里保留名字，落到系统的 PingFang SC 等。
const FONT_PKGS = [
  ['@fontsource-variable/public-sans', ['index.css', 'wght-italic.css']],
  ['@fontsource-variable/lora', ['index.css', 'wght-italic.css']],
];
let fontCss = `/* onething 字体面 —— 由 .design-sync/build-tokens.mjs 生成，勿手改。
 *
 * 只内嵌拉丁两族：Public Sans Variable（正文）与 Lora Variable（标题）。
 * 中文族（Noto Sans SC / Noto Serif SC）在 onething 本体里是 fontsource 分片
 * 子集，共 202 个 woff2 / 10.4MB，不随本次同步分发；字体栈里保留其名字，
 * 未安装时落到系统中文字体（PingFang SC / 苹方 / 微软雅黑）。
 */\n\n`;

let fontFiles = 0;
for (const [pkg, cssFiles] of FONT_PKGS) {
  const dir = join(NM, pkg);
  for (const f of readdirSync(join(dir, 'files'))) {
    if (f.endsWith('.woff2')) {
      copyFileSync(join(dir, 'files', f), join(OUT, 'fonts', f));
      fontFiles++;
    }
  }
  for (const cf of cssFiles) {
    let css = readFileSync(join(dir, cf), 'utf8');
    // fontsource 的 url 形如 ./files/xxx.woff2 —— 改指向同级 fonts/ 目录
    css = css.replace(/url\(\.\/files\//g, 'url(../fonts/');
    fontCss += `/* ── ${pkg}/${cf} ── */\n${css.trim()}\n\n`;
  }
}
writeFileSync(join(OUT, 'tokens', 'fonts.css'), fontCss);
log(`fonts: ${fontFiles} woff2 + tokens/fonts.css`);

// ── 3. 生成 defaults.css（本脚本唯一的语义改造，见文件头注）────────────
const vars = readFileSync(join(SRC, 'variables.css'), 'utf8');

/**
 * 按大括号配对抽出某个顶层选择器的块体（不含选择器与外层括号）。
 * 引号不敏感：flexoki-colors.css 用单引号写 [data-theme='dark']，
 * variables.css 用双引号 —— 同一个属性选择器，两种写法都要认。
 */
function blockBody(css, attr, value) {
  const re = new RegExp(`\\[${attr}=["']${value}["']\\]\\s*\\{`);
  const m = re.exec(css);
  if (!m) throw new Error(`未找到选择器：[${attr}="${value}"]`);
  let i = m.index + m[0].length - 1, depth = 0, start = i + 1;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`选择器未闭合：[${attr}="${value}"]`);
}

const flexokiSrc = readFileSync(join(SRC, 'flexoki-colors.css'), 'utf8');
const rampBody = blockBody(flexokiSrc, 'data-theme', 'dark'); // ← 墨阶翻转，必须先发
const darkBody = blockBody(vars, 'data-theme', 'dark');
const blueBody = blockBody(vars, 'data-color-theme', 'blue');

const countVars = (s) => (s.match(/^\s*--[a-z0-9-]+\s*:/gim) || []).length;

const defaults = `/* onething 默认调色兜底 —— 由 .design-sync/build-tokens.mjs 生成，勿手改。
 *
 * ── 这份文件为什么存在 ────────────────────────────────────────────────
 * onething 本体把颜色全部挂在 \`[data-theme="dark"|"light"]\` 上，强调色挂在
 * \`[data-color-theme="…"]\` 上 —— 裸 \`:root\` 上一枚**语义**颜色都没有。宿主
 * (packages/renderer/main.ts) 启动时会往 <html> 写这两个属性，所以在产品里
 * 永远解析得出来。
 *
 * 但 claude.ai/design 渲染的页面不会带这两个属性。直接搬源码过去的结果是
 * 页面渲染成无样式（或更阴险：解析到**亮色**原色板上，因为 flexoki-colors.css
 * 把亮色墨阶写在真 \`:root\` 上）。这份文件把产品默认档（flexoki · dark · blue）
 * 重发一遍兜底。
 *
 * ── 选择器为什么是 :root:not([data-theme]) ───────────────────────────
 * 实测逼出来的，三选一：
 *   · \`:where(:root)\`（0,0,0）压不过 flexoki 的 \`:root\`（0,1,0）→ 裸页面出亮色。
 *   · \`:root\`（0,1,0）与 \`[data-theme="light"]\` 同级靠源序决胜 → 会顶掉亮色主题。
 *   · \`:root:not([data-theme])\`（0,2,0）：没设属性时压得过 flexoki 的 \`:root\`；
 *     一旦设了属性**根本不匹配**，真主题块原样生效。← 采用这条
 *
 * 所以明暗切换与 7 色强调色**完全照常工作**，兜底只在属性缺席时出现。
 *
 * 切换方式（页面根元素上）：
 *   <html data-theme="light">                            → 亮色
 *   <html data-theme="dark" data-color-theme="purple">   → 暗色 + 紫强调
 *
 * 注：\`--accent\` 在源系统里不随 data-theme 变（亮色档只改 --accent-main/-sub），
 * 这里如实保留该行为，未做任何"修正"。
 */

/* ── ① Flexoki 墨阶翻转（${countVars(rampBody)} 枚，源：flexoki-colors.css [data-theme='dark']）
 *    必须先发：variables.css 的 dark 块写的是 var(--fx-base-*) 引用，
 *    不翻墨阶的话那些引用会落到亮色原色板上。 */
:root:not([data-theme]) {${rampBody}}

/* ── ② 语义字典 · dark（${countVars(darkBody)} 枚，源：variables.css [data-theme="dark"]）── */
:root:not([data-theme]) {${darkBody}}

/* ── ③ 强调色 · blue（${countVars(blueBody)} 枚，源：variables.css [data-color-theme="blue"]）── */
:root:not([data-color-theme]) {${blueBody}}
`;
writeFileSync(join(OUT, 'tokens', 'defaults.css'), defaults);
log(`defaults.css: ramp ${countVars(rampBody)} + dark ${countVars(darkBody)} + blue ${countVars(blueBody)} 枚`);

// ── 4. styles.css —— 设计页面拿到的唯一入口 ────────────────────────────
// claude.ai/design 渲染的页面只收 styles.css 的 @import 传递闭包，
// 所以要用的东西必须从这里够得着。
writeFileSync(join(OUT, 'styles.css'), `/* onething design tokens —— 入口。
 *
 * claude.ai/design 渲染的页面只收本文件的 @import 传递闭包，所以样式面要用的
 * 一切都必须从这里够得着。层次自上而下，后者可盖前者：
 *
 *   fonts       字体面（Public Sans / Lora 内嵌；中文走系统回退）
 *   variables   语义字典 + --ui-* 语义层（自带 @import ./flexoki-colors.css 原色板）
 *   state-alpha 态 token 的行为层（墨 × alpha 旋钮），必须排在字典之后
 *   components  共享构件层：.app-surface / .u-focus-ring / .text-action
 *   defaults    默认调色兜底（:root:not([data-theme])，设了属性即不匹配，不干扰主题切换）
 *
 * 完整规范见 guidelines/style-reference.md。
 */
@import './tokens/fonts.css';
@import './tokens/variables.css';
@import './tokens/state-alpha.css';
@import './tokens/components.css';
@import './tokens/defaults.css';
`);
log('styles.css');

// ── 5. 规范文档 ────────────────────────────────────────────────────────
copyFileSync(
  join(ROOT, 'docs/design/onething-style-reference.md'),
  join(OUT, 'guidelines', 'style-reference.md'),
);
log('guidelines/style-reference.md');

// ── 5b. 预览卡 ─────────────────────────────────────────────────────────
// 面板不按文件列表显示，它显示**卡片** —— app 自检扫描每份 HTML 首行的
// `<!-- @dsCard … -->` 标记编成 _ds_manifest.json。没有卡片 = 面板空白，
// 哪怕 token 全都传上去了（2026-08-15 首次同步就踩了这个坑）。
// 卡片是纯 HTML/CSS，link 回 ../styles.css —— 所以它同时也是 token 闭包的
// 一次真实渲染验证。清单不用我们生成，app 自检会从标记里编。
for (const c of CARDS) {
  writeFileSync(join(OUT, 'guidelines', c.file), renderCard(c));
}
log(`${CARDS.length} 张预览卡 → guidelines/`);

// ── 6. README = 规范头 + 生成正文 ──────────────────────────────────────
const header = readFileSync(join(ROOT, '.design-sync/conventions.md'), 'utf8');
const allCss = COPY.concat(['fonts.css', 'defaults.css'])
  .map((f) => readFileSync(join(OUT, 'tokens', f), 'utf8'))
  .join('\n');
const definedVars = new Set([...allCss.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
const definedClasses = new Set([...allCss.matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]));

writeFileSync(join(OUT, 'README.md'), `${header}
---

# 本项目包含什么（自动生成）

| 路径 | 内容 |
|---|---|
| \`styles.css\` | 入口。渲染出的设计只收本文件的 @import 传递闭包 |
| \`tokens/flexoki-colors.css\` | Flexoki 原色板：13 档墨阶 × 明暗 + 8 色相 |
| \`tokens/variables.css\` | 语义字典 + \`--ui-*\` 语义层（**${definedVars.size} 枚变量**） |
| \`tokens/state-alpha.css\` | 态 token 行为层（墨 × alpha 旋钮） |
| \`tokens/components.css\` | 共享构件层：\`.app-surface\` / \`.u-focus-ring\` / \`.btn\` / \`.text-action\` / \`.ledger-*\` |
| \`tokens/defaults.css\` | 默认调色兜底（\`:root:not([data-theme])\`），**本次同步唯一的语义改造** |
| \`tokens/fonts.css\` + \`fonts/\` | Public Sans Variable + Lora Variable（${fontFiles} 个 woff2） |
| \`guidelines/*.html\` | **${CARDS.length} 张预览卡** —— 面板显示的就是这些（靠首行 \`@dsCard\` 标记建索引） |
| \`guidelines/style-reference.md\` | 完整设计规范 |

**不包含**：组件 bundle、\`.d.ts\`（无法从 Vue 源码产出 React 组件）。原因见顶部说明。

## 来源与再生成

由 \`.design-sync/build-tokens.mjs\` 从 onething 仓库 \`packages/renderer/styles/\` 直接构建，
除 \`defaults.css\` 外全部原样搬运。重新生成：\`node .design-sync/build-tokens.mjs\`。

中文字体（Noto Sans SC / Noto Serif SC）在本体里是 202 个分片子集 / 10.4MB，
未随本次同步分发；字体栈保留其名字，落到系统中文字体。
`);
log('README.md (规范头 + 生成正文)');

// ── 7. 校验规范头：点名的每个 token / 类名都必须真实存在 ────────────────
// 规范头会被塞进设计 agent 的系统提示。写一个不存在的名字，agent 会照写不误，
// 然后静默产出无样式的界面 —— 比不写更糟。所以这里硬校验，不通过就中止。
// 提取时排除两类噪声：
//   · 尾部带连字符的 —— 那是通配符族名（`--ui-sidebar-*`）或 markdown 的 `---`，
//     不是具体 token，无从校验。
//   · 打了 ⛔ 的行 —— 那是**反例**（"不要发明 .card 这种名字"），它们不存在正是本意。
const verifiable = header
  .split('\n')
  .filter((l) => !l.includes('⛔'))
  .join('\n');
const headerVars = [...new Set([...verifiable.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0]))].filter(
  (v) => !v.endsWith('-'),
);
const headerClasses = [...new Set([...verifiable.matchAll(/`\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]))];
const missVars = headerVars.filter((v) => !definedVars.has(v));
const missClasses = headerClasses.filter((c) => !definedClasses.has(c));

if (missVars.length || missClasses.length) {
  console.error('\n[ds] ✗ 规范头校验失败 —— 以下名字在产物里不存在：');
  for (const v of missVars) console.error(`      token  ${v}`);
  for (const c of missClasses) console.error(`      class  .${c}`);
  console.error('    改掉名字或删掉该条，再重新构建。\n');
  process.exit(1);
}
log(`规范头校验通过：${headerVars.length} 枚 token + ${headerClasses.length} 个类名全部存在`);

// ── 8. 让 app 重建清单的哨兵 ───────────────────────────────────────────
writeFileSync(join(OUT, '_ds_needs_recompile'), '');
log(`done → ds-bundle/  (${definedVars.size} 枚变量, ${fontFiles} 个字体文件)`);
