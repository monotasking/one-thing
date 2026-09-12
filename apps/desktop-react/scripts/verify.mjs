#!/usr/bin/env node
/**
 * `npm run verify` —— 这个应用的**总口**。一处红即非零退出,后面的步骤不再跑。
 *
 * 顺序不是随手排的,是**从便宜到贵**:
 *   typecheck → lint → test        几秒级,不需要构建产物,先把低级错拦掉;
 *   build(app:build = vite build + electron:build)  产出四道门要用的东西;
 *   offline-fonts                  构建产物的离线性检查(见下);
 *   gate:connect → data → theme → chat   真机门,每条都要拉起 Electron + core,最贵。
 *
 * ── offline-fonts 这一步在验什么 ─────────────────────────────────────────
 * 字体本地化(工程卫生批 ④)的验收标准是「构建产物离线可用」。光看 index.html
 * 没有 <link> 是不够的 —— CSS 里一条 @import、某个组件里一句 new FontFace(url)
 * 都会把外网请求带回来。所以这里 grep 的是**整棵 dist/**:只要出现
 * fonts.googleapis / fonts.gstatic 就红。这是「产物里不许有外部字体请求」的机器化。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 为什么 gate:perf 仍然不在这里(08-30 复议过一次) ─────────────────────
 * 场景②(架子 tab 切换)这一批已经从记录模式转成断言并且是绿的,所以「有一格没断言」
 * 这条旧理由没了。不并进来的是另外两条,都还站得住:
 *
 *  1. **余量太薄**:场景② 修完实测 p95 72–80ms,预算 100ms —— 只剩两三成余量。
 *     verify 会在装着构建、跑着别的门的机器上跑,这点余量扛不住负载抖动。
 *     一条会随机器状况随机变红的门,进了 verify 只会被人加 `|| true`。
 *  2. **场景① 现在是红的**:种子从 120 抬到 400 之后,冷开总览要一次画 400 张卡,
 *     那一段主线程任务 53–61ms > 50ms 的长帧线。这是被新种子量**暴露**出来的旧病
 *     (与 tab 切换同源:400 张卡一次全画),修法牵动卡片的 containment,
 *     而那会剪掉焦点柔光环 —— 是一次要拍板的改动,不在本批。
 *
 * 它照旧单独跑:`npm run gate:perf`。上面两条各消一条,再谈并进来。
 * ──────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const distDir = path.join(appRoot, 'dist')

/** 外部字体主机。产物里出现任何一个都算「还在问网要字体」。 */
const FORBIDDEN_FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

function run(label, command, args) {
  process.stdout.write(`\n── ${label} ──\n`)
  const result = spawnSync(command, args, { cwd: appRoot, stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    process.stdout.write(`\n[verify] FAILED at: ${label}\n`)
    process.exit(result.status ?? 1)
  }
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 文本类产物才扫 —— woff2 是二进制,拿它当 utf-8 读只会读出噪音。 */
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.map'])

function checkOfflineFonts() {
  process.stdout.write('\n── offline-fonts(产物里不许有外部字体请求)──\n')
  if (!existsSync(distDir)) {
    process.stdout.write('[verify] FAILED: 没有 dist/ —— build 那一步应该产出它\n')
    process.exit(1)
  }
  const hits = []
  for (const file of walk(distDir)) {
    if (!TEXT_EXT.has(path.extname(file))) continue
    const text = readFileSync(file, 'utf-8')
    for (const host of FORBIDDEN_FONT_HOSTS) {
      if (text.includes(host)) hits.push(`${path.relative(appRoot, file)} → ${host}`)
    }
  }
  if (hits.length) {
    process.stdout.write(`[verify] FAILED: 产物里还有外部字体请求\n  ${hits.join('\n  ')}\n`)
    process.exit(1)
  }
  // 反向也要断言:woff2 真的进了产物。只查「没有远程」的话,把 fonts.css 整个删掉
  // 同样能过 —— 那是「离线可用」的反面。
  const woff2 = walk(distDir).filter((f) => f.endsWith('.woff2'))
  if (woff2.length === 0) {
    process.stdout.write('[verify] FAILED: 产物里一个 woff2 都没有 —— 字体没被打进去\n')
    process.exit(1)
  }
  const mb = woff2.reduce((sum, f) => sum + statSync(f).size, 0) / 1048576
  process.stdout.write(`  ✓ 零外部字体请求;本地 woff2 ${woff2.length} 个,共 ${mb.toFixed(2)} MB\n`)
}

/**
 * ── buttonbase-css 这一步在验什么(09-02 立,批 3.6)────────────────────────
 * `ui/ButtonBase` 是全仓每一个结构性交互件(瓦 / 卡 / 行 / 琴键 / 选项,以及
 * `ui/IconButton` 的底座)的 UA 清除层。它的规则**整份没进过生产产物**:那时它
 * 叫 `ButtonBase.module.css`、零本地类名、只被「为副作用」import 一次,于是
 * `vite build` 把那个没有任何导出被消费的模块摇掉,CSS 跟着一起消失。
 *
 * 这个病的可怕之处在于**它只在生产里存在**:dev 不做 tree-shaking,屏幕上一切
 * 正常;typecheck / lint / 单测 / 真机门(都跑在装了 global.css 兜底的页面上)
 * 一个都看不见它 —— 只有拿构建产物本身去问,才问得出来。
 * 所以它与 offline-fonts 同一个体例:**grep 整棵 dist/**,三个探针缺一即红。
 *
 * 探针挑的是「只有基座给、global.css 的 `button {}` 兜不住」的那几条:
 *  · `data-ui-base`   —— 选择器本身在不在(整份文件在不在的直接判据);
 *  · `appearance`     —— UA 外观清除,兜底那条一个字都没说;
 *  · `text-align:inherit` —— UA 的 `text-align: center` 清除,同上。
 * 反证:把 ButtonBase.tsx 里那句 import 改回 `.module.css` 形态(或删掉),
 * 这一步当场红。
 */
const BUTTON_BASE_PROBES = ['data-ui-base', 'appearance', 'text-align:inherit']

function checkButtonBaseCss() {
  process.stdout.write('\n── buttonbase-css(基座的 UA 清除必须真的在产物里)──\n')
  if (!existsSync(distDir)) {
    process.stdout.write('[verify] FAILED: 没有 dist/ —— build 那一步应该产出它\n')
    process.exit(1)
  }
  const css = walk(distDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(f, 'utf-8'))
    .join('\n')
  const missing = BUTTON_BASE_PROBES.filter((probe) => !css.includes(probe))
  if (missing.length) {
    process.stdout.write(
      '[verify] FAILED: 产物 CSS 里找不到 ui/ButtonBase 的 UA 清除规则\n'
        + `  缺的探针:${missing.join(' / ')}\n`
        + '  多半是那份样式表又变回了「只为副作用 import 的 .module.css」——\n'
        + '  那种模块没有任何导出被消费,vite build 会连同它的 CSS 一起摇掉。\n'
        + '  病历与修法写在 src/ui/ButtonBase.css 文件头。\n',
    )
    process.exit(1)
  }
  process.stdout.write(`  ✓ 三个探针都在产物里:${BUTTON_BASE_PROBES.join(' / ')}\n`)
}

/*
 * `node scripts/verify.mjs --only <name>` —— 只跑那一步产物检查,不碰整条链。
 * 立这个口子只有一个理由:**反证纪律**要求每条守卫断言至少真跑一次「拆掉即红」,
 * 而这两步是内联在 verify 里的,没有这口子就只能陪跑十分钟的全链才验得到它们。
 * 它只接受这两个名字,不是通用的分步执行器。
 */
const ONLY_CHECKS = { 'offline-fonts': checkOfflineFonts, 'buttonbase-css': checkButtonBaseCss }
const onlyIndex = process.argv.indexOf('--only')
if (onlyIndex !== -1) {
  const name = process.argv[onlyIndex + 1]
  const check = ONLY_CHECKS[name]
  if (!check) {
    process.stdout.write(`[verify] --only 只认:${Object.keys(ONLY_CHECKS).join(' / ')}\n`)
    process.exit(2)
  }
  check()
  process.exit(0)
}

const serverEntry = path.join(repoRoot, 'dist/server/main.js')
if (!existsSync(serverEntry)) {
  process.stdout.write(
    `[verify] 找不到 ${path.relative(repoRoot, serverEntry)}\n`
      + '  四道真机门都要一台 core。先在仓根跑 `bun run server:build`。\n',
  )
  process.exit(1)
}

run('typecheck', 'npm', ['run', '--silent', 'typecheck'])
run('lint', 'npm', ['run', '--silent', 'lint'])
// squeeze-gate / motion-gate 都是纯静态棘轮(扫 CSS 文本,不起进程、不要构建
// 产物),与 lint 同一个价位,所以排在这里而不是和真机门作伴。
run('squeeze-gate', 'npm', ['run', '--silent', 'squeeze-gate'])
run('motion-gate', 'npm', ['run', '--silent', 'motion-gate'])
run('test', 'npm', ['run', '--silent', 'test'])
run('build', 'npm', ['run', '--silent', 'app:build'])
checkOfflineFonts()
checkButtonBaseCss()
/*
 * 构建链冒烟(A1-a):壳的 main 侧现在 inline 着整棵 core/runtime/backend,而那棵树
 * 里有四处东西 esbuild 默认处理不了(`?raw` / `import.meta.url` / 三个原生模块 /
 * `@shared`)。任何一处配漏都是**模块求值期**炸,而 typecheck 与单测都看不见它 ——
 * 只有真跑一遍产物看得见。排在真机门**之前**:它 3 秒、不开窗,坏了要一眼看出是
 * 构建链坏了,而不是在一条要拉起 Electron 窗口的门里去猜。
 */
run('smoke:core', 'npm', ['run', '--silent', 'smoke:core'])
run('gate:connect', 'npm', ['run', '--silent', 'gate:connect'])
run('gate:data', 'npm', ['run', '--silent', 'gate:data'])
run('gate:theme', 'npm', ['run', '--silent', 'gate:theme'])
run('gate:chat', 'npm', ['run', '--silent', 'gate:chat'])
run('gate:files', 'npm', ['run', '--silent', 'gate:files'])
/*
 * gate:search 与 gate:files 同一个价位、同一条理由进得来:它断言的是**排版与条数**
 * (空词浏览态的行数 / 读数字面 / 徽的几何),同一份代码同一个视口跑一百遍是同一个
 * 答案,没有余量一说,不看机器状况。
 */
run('gate:search', 'npm', ['run', '--silent', 'gate:search'])
/*
 * gate:workspace 同一条理由进得来:它断言的是**盘上那几个文件与屏幕上那几行字
 * 对不对得上**(会话按空间过滤 / 新会话的归属 / 两套 provider 设置与凭证互不串 /
 * 换世界时列表容器是同一个 DOM 节点),全是确定的答案,不看机器状况、没有余量。
 * 它是「切换是假的」那条报障的机器化 —— 拆掉哪一格都当场红。
 */
run('gate:workspace', 'npm', ['run', '--silent', 'gate:workspace'])
// 流式正文单调门:假慢流跨过 2s 打包闸,rAF 逐帧断言正文 textContent 不回缩
// (真机病「打包行一到正文整段消失」的机器化,见 gate-stream-monotone.mjs 文件头)。
run('gate:monotone', 'npm', ['run', '--silent', 'gate:monotone'])
/*
 * 流式**块结构**门:同一条假慢流,素材换成推理↔正文交替 + 一张逐行长出来的表,
 * 逐帧断言「思考块只增不减 / 不搬家 / 表格成形后不降级」。
 *
 * 它与上面那条单调门是两件事,两条都要跑:单调门量的是正文**总长**,而 09-01
 * 那条报障(「think、table 出现再消失再出现」)恰恰在它盖不到的地方 —— 一整块
 * 思考消失时后面的正文还在长,总长曲线可以是单调的。判据同样是确定的:同一份
 * 素材同一条流跑一百遍是同一个答案,不看机器状况。
 */
run('gate:stream-structure', 'npm', ['run', '--silent', 'gate:stream-structure'])
/*
 * gate:squeeze 进 verify,gate:perf 仍然不进(理由见文件顶部那一节)。
 * 两者的差别就在**读数会不会随机器状况抖**:squeeze 门断言的是「有没有两个盒子
 * 压在一起」—— 排版是确定的,同一份 CSS 同一个视口跑一百遍是同一个答案,
 * 没有余量一说;perf 门断言的是毫秒,余量只剩两三成。
 */
run('gate:squeeze', 'npm', ['run', '--silent', 'gate:squeeze'])
/*
 * gate:providers-squeeze 紧跟着它(09-11):同一条律四,另一块面。
 * `gate:squeeze` 量的是会话总览钉在右架子上的那一形,量不到模型服务面 ——
 * 那块面有自己的两栏骨架、自己的七列表和自己的四级列退场,一把尺够不着两块地。
 * 判据同样是排版(六档各自的列数、左栏宽、零溢出、动作钮在不在),不是毫秒读数,
 * 所以它与 squeeze / motion 同一个价位进得来。
 */
run('gate:providers-squeeze', 'npm', ['run', '--silent', 'gate:providers-squeeze'])
/*
 * gate:motion 与 gate:squeeze 同一个理由进得来:它断言的是**计算样式**
 * (切到「无」档之后 transition/animation 的时长是不是 0),不是毫秒读数 ——
 * 同一份 CSS 同一个档跑一百遍是同一个答案,没有余量一说。
 */
run('gate:motion', 'npm', ['run', '--silent', 'gate:motion'])
/*
 * gate:a11y 与上面两条同一个理由进得来:它断言的是**无障碍树与焦点落点**——
 * 同一份代码同一个视口跑一百遍是同一个答案,没有余量、不看机器状况
 * (axe 是静态分析一棵已经排好的树;键盘走查是逐下按键读 document.activeElement,
 * 两样都不是毫秒读数)。它比另外两条贵一点:要拉两屏(外壳 + ?gallery)。
 */
run('gate:a11y', 'npm', ['run', '--silent', 'gate:a11y'])
/*
 * gate:focus 与 gate:a11y **同一条理由、同一个价位**进得来(响应链 R3,09-03)。
 * 它断言的是**焦点落点与 Esc 归属**:每一步按完键去问 `document.activeElement`
 * 在哪个 `data-focus-scope` 里、那扇浮层收没收掉 —— 同一份代码同一个视口跑一百遍
 * 是同一个答案,没有余量一说,不看机器状况(与 gate:perf 那种毫秒读数正相反)。
 * gate:a11y 的键盘走查本来就是这一形(逐下按键读 activeElement),这道门只是把
 * 同一种读法铺到十二个场景上。
 *
 * 它比 gate:a11y 贵一点:要在真 store 上建一条会话、摆一棵工作目录树,并且中途
 * 整页重载好几次。这是**排在最后**的理由,不是不进来的理由 —— 用户报的
 * 「⌘F → Esc → ⌘F 失灵」正是这道门场景 1 量的那条,而那条病 typecheck / lint /
 * 单测**一个都看不见**(jsdom 的绿不算数,08-30 判例)。
 */
run('gate:focus', 'npm', ['run', '--silent', 'gate:focus'])
/*
 * gate:layout 与 gate:focus **同一条理由、同一个价位**进得来(W7-p,09-06)。
 * 它断言的是**排版与落盘**:关窗再起之后那三块家具还在不在、四条边与中央区分完地
 * 之后中央区还剩多少、三档窗口尺寸下有没有元素出视口、四扇浮窗的矩形两两同不同 ——
 * 同一份代码同一个视口跑一百遍是同一个答案,没有余量一说,不看机器状况
 * (与 gate:perf 那种毫秒读数正相反)。
 *
 * 它守的病 typecheck / lint / 单测**一个都看不见**:A1 那条(重启丢布局)的病根是
 * 模块图的求值次序,jsdom 里一个文件一份模块图,单测能证「水合那一遍不问种类」,
 * 证不了「关窗再起之后屏幕上还是那三块」;A3/A4/A6 那三条要真排版才量得到
 * (jsdom 的 `getBoundingClientRect` 一律答零)。
 *
 * 它比 gate:focus 贵一点:要起五次窗(其中两次是同 store 同 user-data-dir 的接力,
 * 那正是 A1 的判据)。这是**排在最后**的理由,不是不进来的理由。
 */
run('gate:layout', 'npm', ['run', '--silent', 'gate:layout'])
/*
 * ── 会话加载体验那三道门(第 6 单,09-10)────────────────────────────────────
 *
 * 它们进得来的理由与 `gate:perf` 进不来的理由**不冲突**,判据仍旧是那一条:
 * 「余量够不够,会不会随机器状况随机变红」。
 *
 *  · `gate:chat-follow` / `gate:continuity` 压根不是毫秒读数 —— 前者判丸的三张
 *    脸、贴底跟不跟、上翻动不动(位移与文字,同一份代码跑一百遍同一个答案),
 *    后者判**请求次数**、锚点行与焦点落点。它们与 gate:focus / gate:layout 同族。
 *  · `gate:chat-layout` 是**这里唯一一条毫秒门**,而它进得来是因为第五轴把那五个
 *    数立成了法(壳 `CLAUDE.md` 验收第五轴,09-10 用户令:「不重载 / 不卡 / 已治」
 *    类结论必须附端到端毫秒数)。余量够不够这个问题没有被绕过,而是被**分档**
 *    回答了:prod 走第五轴原数(实测 ①14/16、③176/300,余量充足),dev 上今天
 *    达不到的那两格走 `DEV_TRANSITIONAL` 的过渡值(实测上限 + 余量,退场判据写
 *    在那张表旁边)。**唯独没有走的那条路是把它红着放进来** —— 一条恒红的门只会
 *    被人加 `|| true`,那时它连红都不会再红一次(这正是本文件顶部对 gate:perf
 *    那两条理由里的第二条)。
 *
 * **两档都跑**:第五轴写死了「dev 与 prod 两种渲染层都要出数 —— 用户跑的是
 * `electron:dev`,生产构建上量出的数对它不成立」。prod 那一趟复用 `dist/`(上面
 * 那步 build 已经产出),所以它比 dev 那一趟便宜,排在后面。
 */
run('gate:chat-follow', 'npm', ['run', '--silent', 'gate:chat-follow'])
run('gate:continuity', 'npm', ['run', '--silent', 'gate:continuity'])
/*
 * ── 终端与浏览器那两道门(T2,2026-09-12)────────────────────────────────────
 *
 * 进得来的理由与上面那几条同源,判据仍旧是「余量够不够、会不会随机器状况随机
 * 变红」:
 *  · 两道门的绝大多数断言**不是毫秒读数** —— 能力位真不真、召唤键开不开得出叶、
 *    `printf` 的输出到没到屏幕上、查找读数写的是不是「第几 / 共几」、`resources`
 *    自述列不列得出 `browser`、遮挡时占位格换没换图、`/json/list` 列不列得出
 *    tab 页、axe 零违例:同一份代码跑一百遍是同一个答案。
 *  · 真是毫秒的那三格余量都在一个数量级上:终端 `seq 1 20000` 期间的 ≥50ms 长帧
 *    实测**恒 0**;浏览器热轮 activate 实测 1–6ms 对 50ms;遮挡回路实测 148–239ms
 *    对过渡值 300 / 320ms(那一行连同退场判据写在 `gate-browser.mjs` 的
 *    `TRANSITIONAL` 上)。
 *
 * **两档都跑**(第 5 轴写死的那一句:用户跑的是 `electron:dev`,生产构建上量出来
 * 的数对它不成立)。prod 那一趟复用上面 build 出来的 `dist/`,所以它比 dev 便宜。
 * 两道门都自己起窗、自己收尸,不连 5175、不碰 `~/.onething`。
 */
run('gate:terminal(dev)', 'npm', ['run', '--silent', 'gate:terminal'])
run('gate:terminal(prod)', 'npm', ['run', '--silent', 'gate:terminal', '--', '--prod'])
run('gate:browser(dev)', 'npm', ['run', '--silent', 'gate:browser'])
run('gate:browser(prod)', 'npm', ['run', '--silent', 'gate:browser', '--', '--prod'])
run('gate:chat-layout(dev)', 'npm', ['run', '--silent', 'gate:chat-layout'])
run('gate:chat-layout(prod)', 'npm', ['run', '--silent', 'gate:chat-layout', '--', '--prod'])
/*
 * gate:credentials 不在这里,理由与 gate:perf 不同:它**读的是这台机器上真实的
 * 生产 store**(要一份真的 safeStorage 密文才有得比),而 verify 必须在任何一台
 * checkout 上都能跑。它自己跑:`npm run gate:credentials`。
 */

process.stdout.write(
  '\n[verify] ok —— typecheck / lint(含 jsx-a11y)/ squeeze-gate / motion-gate / test / build'
    + ' / offline-fonts / buttonbase-css'
    + ' / 真机门(connect·data·theme·chat·files·search·monotone·squeeze·motion·a11y·focus·layout'
    + '·chat-follow·continuity·terminal[dev+prod]·browser[dev+prod]·chat-layout[dev+prod])全绿\n',
)
