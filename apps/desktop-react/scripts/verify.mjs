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
run('gate:connect', 'npm', ['run', '--silent', 'gate:connect'])
run('gate:data', 'npm', ['run', '--silent', 'gate:data'])
run('gate:theme', 'npm', ['run', '--silent', 'gate:theme'])
run('gate:chat', 'npm', ['run', '--silent', 'gate:chat'])
run('gate:files', 'npm', ['run', '--silent', 'gate:files'])
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

process.stdout.write(
  '\n[verify] ok —— typecheck / lint / squeeze-gate / motion-gate / test / build / offline-fonts / 真机门全绿\n',
)
