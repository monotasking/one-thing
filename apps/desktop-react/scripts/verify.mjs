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
 * gate:credentials 不在这里,理由与 gate:perf 不同:它**读的是这台机器上真实的
 * 生产 store**(要一份真的 safeStorage 密文才有得比),而 verify 必须在任何一台
 * checkout 上都能跑。它自己跑:`npm run gate:credentials`。
 */

process.stdout.write(
  '\n[verify] ok —— typecheck / lint(含 jsx-a11y)/ squeeze-gate / motion-gate / test / build'
    + ' / offline-fonts / 真机门(connect·data·theme·chat·files·search·monotone·squeeze·motion·a11y)全绿\n',
)
