/**
 * B0 spike ① —— 官方 Electron 上登谷歌的三阶实验(方案 §2.2-6 / §1.3-①)
 *
 * ⚠️ **这一支是给用户本人手跑的**:它会开一扇**前台**窗,由人在里面输自己的谷歌账号。
 * 代理不跑登录那一段(不是代理的账号),代理只跑 `--stage=3`(本地指纹页,不上网)自测。
 *
 * 三阶(登上即止,不必往下走):
 *   --stage=1  完整配方:`--disable-features=FedCm` + UA **只删** ` Electron/x.y.z` 这一个 token
 *              + 全新持久分区 `persist:browser-spike`。
 *              (07-26 的反直觉根因:把 UA 洗成「干净 Chrome」反而被判假 —— app token 与完整
 *               Chrome 构建号都必须原样留着。见 docs/design/browser-v2/castlabs-migration.md)
 *   --stage=2  ㈠ + CDP `Network.setUserAgentOverride` 带**完整** userAgentMetadata
 *              (brands 含 Chromium / Google Chrome / GREASE,fullVersionList 同,
 *               platform / platformVersion / architecture / bitness / model / mobile 取真值,
 *               版本号一律取 `process.versions.chrome`,不编造)。见 browser-auth-profiles.md §3.1。
 *   --stage=3  载入本目录的 fp.html 并把指纹 JSON 写到 --fp-out;拿它与 Flow 的那份做差分。
 *
 * 跑法(从仓根):
 *   ./node_modules/.bin/electron scripts/spike-browser/google-login.mjs --stage=1
 *   ./node_modules/.bin/electron scripts/spike-browser/google-login.mjs --stage=2
 *   ./node_modules/.bin/electron scripts/spike-browser/google-login.mjs --stage=3 \
 *        --fp-out=/tmp/fp-electron.json      # 跑完自动退出
 *
 * 判读(脚本每次导航后自己查一遍,也打在 stdout 上):
 *   页面正文里出现「此浏览器或应用可能不安全」/「This browser or app may not be secure」
 *     = 这一阶**没过**;
 *   能走到输密码 / 通行密钥那一屏 = 这一阶**过了**,不必再往下试。
 *   脚本还会 dump `navigator.userAgent` 与实际发出的 `Sec-CH-UA*` 请求头,便于核对
 *   「UA 字符串确实只少了 Electron 那个 token」「client hints 与 UA 一致」。
 *
 * 登录态留在 <repo>/.spike/google-login/(持久,复验用);要重来就删掉这个目录。
 * 它在 git 之外,不会进仓。
 */
import { app, BrowserWindow, WebContentsView, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

const argv = process.argv.slice(1)
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const STAGE = Number(arg('stage', '1'))
const FP_OUT = arg('fp-out')
const PARTITION = arg('partition', 'persist:browser-spike')
/** `--no-cdp`:阶㈡ 那层 UA-CH override 不加(用来 dump 阶㈠ 的指纹,与阶㈡ 的做差分) */
const NO_CDP = argv.includes('--no-cdp')
/** `--headless`:窗子不上屏(阶㈠㈡ 自测「脚本不崩 / UA 与请求头对不对」时用,不抢用户的屏) */
const HEADLESS = argv.includes('--headless')
const START_URL = arg('url', STAGE === 3 ? `file://${path.join(here, 'fp.html')}` : 'https://accounts.google.com/')

// 持久 user-data-dir:登录态要留着复验
const USER_DATA = arg('user-data-dir', path.join(repoRoot, '.spike/google-login'))
fs.mkdirSync(USER_DATA, { recursive: true })
app.setPath('userData', USER_DATA)

// ── 阶㈠ 的第一件:FedCm 关掉(必须在 ready 之前)──────────────────────────────
app.commandLine.appendSwitch('disable-features', 'FedCm')

/**
 * UA **只删** ` Electron/<版本>` 这一个 token,其余一个字不动。
 * 留下的包括:`onething/x.y.z` 这类 app token(若有)与完整的 `Chrome/<完整构建号>`。
 * 07-26 实测:洗成教科书式的干净 Chrome UA 反而登不上。
 */
function stripElectronToken(ua) {
  return ua.replace(/ Electron\/\S+/, '')
}

/**
 * 真 Chrome 的 UA-CH 元数据。
 *
 * **做法是「只补缺的那一格」,不是「另造一份」** —— 2026-09-12 B0 自测时,第一版是照
 * `browser-auth-profiles.md` §3.1 的字面照单全填(platform / platformVersion /
 * acceptLanguage 都自己算),`fp-diff` 当场照出三条自伤:
 *   · 顶层 `platform` 一传,`navigator.platform` 就从 `MacIntel` 变成 `macOS` —— 真 Chrome 上
 *     这两个值本来就不一样(`navigator.platform` = MacIntel,`userAgentData.platform` = macOS),
 *     传了反而**造出一条真 Chrome 没有的矛盾**;
 *   · `app.getSystemVersion()` 给 `15.5`(兼容版本号),Chromium 自己报的是 `26.5.0` —— 算出来的
 *     platformVersion 比真值**差了一个大版本**;
 *   · 硬写 `acceptLanguage` 会顺手改掉 `navigator.languages`,与系统语言对不上。
 * 这三条都是 07-26「洗得太干净反而被判假」那条根因的同族。
 *
 * 所以现在:先问这张页面**它自己**的高熵值,原样端回去,只往 brands / fullVersionList 里
 * **插一条 `Google Chrome`**(Electron 缺的就是这一格),其余一个字不改。
 */
async function buildUserAgentMetadata(webContents, cleanUa) {
  const live = await webContents.executeJavaScript(`(async () => {
    const d = navigator.userAgentData
    if (!d) return { missing: true, brands: [], mobile: false, platform: '', he: {} }
    const he = d ? await d.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList','wow64']) : {}
    return { brands: d ? d.brands : [], mobile: d ? d.mobile : false, platform: d ? d.platform : '', he }
  })()`, true)

  const full = process.versions.chrome
  const major = full.split('.')[0]
  const hasChrome = (list) => list.some((b) => b.brand === 'Google Chrome')
  const brands = live.brands.slice()
  if (!hasChrome(brands)) brands.push({ brand: 'Google Chrome', version: major })
  const fullList = (live.he.fullVersionList || []).slice()
  if (!hasChrome(fullList)) fullList.push({ brand: 'Google Chrome', version: full })

  return {
    // 顶层不给 platform / acceptLanguage:见上面的判词
    userAgentMetadata: {
      brands,
      fullVersionList: fullList,
      platform: live.platform,
      platformVersion: live.he.platformVersion ?? '',
      architecture: live.he.architecture ?? '',
      model: live.he.model ?? '',
      mobile: !!live.mobile,
      bitness: live.he.bitness ?? '',
      wow64: !!live.he.wow64,
    },
    userAgent: cleanUa,
    _live: live,
  }
}

const BLOCK_PHRASES = ['此浏览器或应用可能不安全', 'This browser or app may not be secure', '浏览器或应用可能不安全']

process.on('unhandledRejection', (e) => { console.log('[spike1] !! unhandledRejection:', e?.stack || e) })
process.on('uncaughtException', (e) => { console.log('[spike1] !! uncaughtException:', e?.stack || e) })

app.whenReady().then(async () => {
  const cleanUa = stripElectronToken(app.userAgentFallback)
  console.log('[spike1] stage           =', STAGE)
  console.log('[spike1] electron/chrome =', process.versions.electron, '/', process.versions.chrome)
  console.log('[spike1] userData        =', USER_DATA)
  console.log('[spike1] UA before       =', app.userAgentFallback)
  console.log('[spike1] UA after strip  =', cleanUa)
  console.log('[spike1] removed token   =', (app.userAgentFallback.match(/ Electron\/\S+/) || ['(none)'])[0].trim())

  console.log('[spike1] step: session.fromPartition', PARTITION)

  const ses = session.fromPartition(PARTITION)
  // 字符串层兜底:即便 CDP 那一层没生效,UA 也不自曝 Electron
  ses.setUserAgent(cleanUa)

  /*
   * 把主文档那几发的 `User-Agent` / `Sec-CH-UA*` 请求头 dump 出来(每个 host 只打一次)。
   *
   * ⚠️ 2026-09-12 实测的口径:对 `https://accounts.google.com` 这里也**一个 `Sec-CH-UA*`
   *    都看不到**,只有 `User-Agent`。真 Chrome 对谷歌一定是发 client hints 的,所以这大概率
   *    是 **Electron 的 `onBeforeSendHeaders` 看不到网络服务后加的那批头**,不是「没发」。
   *    结论:**这份 dump 不能当 client hints 的证据**;要核 UA-CH,看下面打的
   *    `navigator.userAgentData`(那一格是真的),或者拿一个会回显请求头的公网站点去照。
   */
  const dumped = new Set()
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    if (details.resourceType === 'mainFrame') {
      const host = (() => { try { return new URL(details.url).host } catch { return details.url } })()
      if (!dumped.has(host)) {
        dumped.add(host)
        const h = details.requestHeaders
        const picked = Object.fromEntries(Object.entries(h).filter(([k]) => /^(User-Agent|Sec-CH-UA)/i.test(k)))
        console.log(`[spike1] request headers @ ${host}:`, JSON.stringify(picked, null, 2))
      }
    }
    cb({ requestHeaders: details.requestHeaders })
  })

  console.log('[spike1] step: creating window')
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    // 阶㈠㈡ 是人手跑的,**允许**上前台(脚本头已写明);
    // 阶㈢ 只是把本地指纹页 dump 成 JSON,没有人要看,所以不上屏(纪律:门不抢用户的机器)
    show: STAGE !== 3 && !HEADLESS,
    title: `spike google-login stage ${STAGE}`,
  })

  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
    },
  })
  win.contentView.addChildView(view)
  const layout = () => {
    const b = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  }
  layout()
  win.on('resize', layout)

  // ── 阶㈡:常驻 CDP + 完整 userAgentMetadata ────────────────────────────────
  //
  // ⚠️ 2026-09-12 B0 实测踩到的坑,写在这里免得下一个人再踩:**对一张从没导航过的
  //    `WebContentsView` 调 `debugger.sendCommand('Network.setUserAgentOverride')`,
  //    那个 promise 永不 resolve**(命令其实生效了,只是回不来)。所以先 `about:blank`
  //    把渲染器起起来再 attach;并且一律加超时护栏,任何情况下都不许把脚本挂死。
  if (STAGE >= 2 && !NO_CDP) {
    try {
      /*
       * 热身页必须是 `file://`,不能是 `about:blank` / `data:` —— 后两者是**非安全上下文**,
       * `navigator.userAgentData` 在那里**根本不存在**(2026-09-12 实测:has=false),
       * 拿它读「本机真值」会读回一片空,然后把空的元数据发出去,指纹当场比不改还假。
       * 顺带,它也满足「sendCommand 之前必须先导航过一次」那条(见下)。
       */
      await view.webContents.loadURL(`file://${path.join(here, 'fp.html')}`)
      const built = await buildUserAgentMetadata(view.webContents, cleanUa)
      view.webContents.debugger.attach('1.3')
      const sent = await Promise.race([
        view.webContents.debugger
          .sendCommand('Network.setUserAgentOverride', {
            userAgent: built.userAgent,
            userAgentMetadata: built.userAgentMetadata,
          })
          .then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('timeout-5s(命令通常已生效,只是没回执)'), 5000)),
      ])
      console.log('[spike1] CDP setUserAgentOverride', sent)
      console.log('[spike1]   live brands  =', JSON.stringify(built._live.brands))
      console.log('[spike1]   sent brands  =', JSON.stringify(built.userAgentMetadata.brands))
      console.log('[spike1]   platform/ver =', built.userAgentMetadata.platform, built.userAgentMetadata.platformVersion, built.userAgentMetadata.architecture)
      // override 随 detach 失效,所以必须常驻;掉了就喊一声
      view.webContents.debugger.on('detach', (_e, reason) => {
        console.log('[spike1] !! debugger detached:', reason, '(UA-CH override 从这一刻起失效)')
      })
    } catch (err) {
      console.log('[spike1] !! CDP attach/override failed:', err?.message || err)
    }
  }

  // ── 判读:每次导航后查一遍那两句话 ────────────────────────────────────────
  const check = async (why) => {
    try {
      const text = await view.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true)
      const hit = BLOCK_PHRASES.find((p) => text.includes(p))
      const ua = await view.webContents.executeJavaScript('navigator.userAgent', true)
      const uaData = await view.webContents.executeJavaScript(
        'navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : "(no userAgentData)"', true)
      console.log(`[spike1] --- ${why} @ ${view.webContents.getURL().slice(0, 110)}`)
      console.log('[spike1]     navigator.userAgent      =', ua)
      console.log('[spike1]     navigator.userAgentData  =', uaData)
      console.log(hit
        ? `[spike1]     判读:**这一阶没过** —— 页面上出现「${hit}」`
        : '[spike1]     判读:未见拒绝语;若已到密码 / 通行密钥屏即为**通过**')
    } catch (err) {
      console.log('[spike1] check failed:', err?.message || err)
    }
  }

  view.webContents.on('did-finish-load', () => { void check('did-finish-load') })
  view.webContents.on('did-navigate', (_e, url) => console.log('[spike1] navigate →', url.slice(0, 140)))
  view.webContents.on('did-navigate-in-page', (_e, url) => { void check('in-page → ' + url.slice(0, 90)) })

  console.log('[spike1] step: loadURL', START_URL)
  await view.webContents.loadURL(START_URL)
  console.log('[spike1] step: loadURL resolved')

  // ── 阶㈢:把指纹 JSON 写盘,然后退出 ──────────────────────────────────────
  if (STAGE === 3) {
    await new Promise((r) => setTimeout(r, 1200))
    const fp = await view.webContents.executeJavaScript('window.__fp ? window.__fp() : null', true)
    if (!fp) {
      console.log('[spike1] !! fp.html 没有交出 __fp(),页面可能还没跑完')
    } else {
      const out = FP_OUT || path.join(os.tmpdir(), 'fp-electron.json')
      fs.writeFileSync(out, JSON.stringify(fp, null, 2))
      console.log('[spike1] 指纹已写到', out)
      console.log('[spike1] 接下来:在 Flow Browser(~/data/code/flow-browser)里打开')
      console.log('[spike1]   file://' + path.join(here, 'fp.html'))
      console.log('[spike1] 点「下载 JSON」存成 flow.json,再跑:')
      console.log(`[spike1]   node ${path.join(here, 'fp-diff.mjs')} ${out} <flow.json>`)
    }
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
