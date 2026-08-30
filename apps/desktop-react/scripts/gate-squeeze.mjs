#!/usr/bin/env node
/**
 * 抗挤压真机门 —— 「窄下来不许重叠」的机器化。
 *
 * 立法在 `docs/design/react-shell-squeeze-rules-2026-08.md`(四律)。这条门执的是
 * **律四**:每个组件在自己声明的最小宽度下零重叠 —— 变窄的次序是「先截断,
 * 再有序降元素」,永不重叠。
 *
 * 做法:把会话总览钉到右架子上,厚度依次拖到 240 / 300 / 360 / 420 / 560,
 * 每一档在**真机真排版**下扫一遍架子里画着东西的盒子,两两求交。任何一对相交
 * (容差 1px)= 红,并打印元素对与档位。五档全绿才算过。
 *
 * ── 为什么不是「可见兄弟元素两两求交」 ───────────────────────────────────
 * 立项时写的是兄弟两两。真机复现之后改了口径,理由是**兄弟检测抓不到报障那一例**:
 * 组头行里溢出的是 `.groupName`,它是 `.groupToggle` 的孩子;被它压住的 `.count`
 * 是 `.groupToggle` 的兄弟。两者是「叔侄」,不是兄弟 —— 只比兄弟的话,这条门
 * 在修前是绿的,而屏幕上字压着字。
 *
 * 所以口径改成:**所有「自己画内容的盒子」两两求交,祖孙对除外**。
 * 「自己画内容」= 直接挂着非空文本节点,或者是 svg / img / canvas / input。
 * 这是兄弟检测的超集,报障那一例正好落在超出来的那部分里。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 白名单(= 预期的覆盖,律三允许的那一族)写在 `ALLOWED_OVERLAP` 里,每条都要有
 * 理由。默认**不**整类豁免绝对定位:绝对定位恰恰是「覆盖」最常见的实现方式,
 * 整类放行等于把律三的执法面挖空。
 *
 * 跑法:`node scripts/gate-squeeze.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store + 全新的 --user-data-dir,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** 五档厚度。240 是架子下限(SHELF_MIN_THICKNESS),560 已经在宽档里 —— 一头一尾都要量。 */
const THICKNESSES = [240, 300, 360, 420, 560]

/**
 * 种子:**组名的形状**才是这条门的被试,不是会话条数。
 * 三种长名各一组,因为它们的断行行为完全不同:
 *  - 带连字符的 uuid:CSS 允许在连字符后断行 → 会**折行**(报障视频里那一例);
 *  - 不带连字符的 32 位十六进制:没有任何断行机会 → 会**整条溢出**;
 *  - 长 kebab 路径末段:连字符很多 → 折成三四行。
 * 外加一个普通短名组当对照(它在任何档位都不该红)。
 */
const SEED_GROUPS = [
  { dir: '3f2a9c7e-8b41-4d6a-9f02-7c1e5b8d4a63', names: ['dm 甲', 'dm 乙', 'dm 丙'] },
  { dir: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', names: ['room 甲', 'room 乙'] },
  {
    dir: 'onething-desktop-react-shell-squeeze-fixture',
    names: ['squeeze 甲', 'squeeze 乙', 'squeeze 丙'],
  },
  { dir: 'short', names: ['短组甲', '短组乙'] },
  { dir: null, names: ['独立甲', '独立乙'] },
]

/**
 * 联网宿主(standalone server)把每条工作目录夹进 `<workspaceRoot>/<uid>/<wid>`,
 * 而且要求目录**真的存在**。所以这条门自带一个临时 workspaceRoot(靠
 * `ONETHING_SERVER_WORKSPACE_ROOT` 指过去),把上面那几个组目录先 mkdir 出来,
 * 再用相对路径去写 —— 绝对路径会被沙箱当场拒掉(首跑就是这么把 12 条会话
 * 全塞进「独立会话」一组的:updateWorkingDirectory 静默失败,组名形状一个没测到)。
 */
const SERVER_OWNER_SEGMENTS = ['local-user', 'default']

/**
 * 允许的覆盖。每条 = 一对选择器片段(按 CSS 类名 / data 属性的子串匹配),
 * 命中即跳过这一对。**加一条就要写一句理由** —— 这张表是律三的例外表,
 * 不是「门太吵了就往里塞」的地方。
 */
const ALLOWED_OVERLAP = [
  // 卡右上角的 QuickLook 预览眼是**常驻占位**的浮层入口:.head 用 padding-right
  // 给它留了槽位(律三的布局预留),所以它不压文字;但它与卡自身的盒子必然相交。
  { a: 'SessionCard_peek', b: 'SessionCard_', why: 'QuickLook 幽灵眼:常驻占位、已在 .head 留槽,压的是卡的空白' },
]

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portConnects(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/** 点一个 testid(理由同 gate-data:这条门要证的是排版,不是命中测试)。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * 把默认打开档改成「钉栏」(= edge:right)再重载,顺带抹掉逐项记忆。
 * 一模一样的理由见 gate-perf.mjs 的同名函数:不清 memory 的话,点 Dock 上的
 * sessions 会按记忆开到浮窗里,这条门就不在架子上量了。
 */
async function switchDefaultOpenToPinned(page) {
  // persist 中间件只在**发生过一次 set** 之后才落盘。刚启动的应用一格没动,
  // localStorage 里就没有这个键 —— 先做一次真手势(开一块面板再收回 Dock),
  // 让它落一次盘,再来改档。不伪造整份状态的理由见函数顶部注释。
  const primed = await page.evaluate(() => Boolean(localStorage.getItem('onething.stage')))
  if (!primed) {
    await clickTestId(page, 'dock-tile-files')
    await delay(300)
    await clickTestId(page, 'dock-tile-files')
    await delay(300)
  }
  const ok = await page.evaluate(() => {
    const KEY = 'onething.stage'
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    parsed.state = { ...(parsed.state ?? {}), defaultOpen: 'pinned', memory: {} }
    localStorage.setItem(KEY, JSON.stringify(parsed))
    return true
  })
  if (!ok) throw new Error('localStorage 里没有 onething.stage —— 应用还没落过盘')
  await page.reload()
  await waitFor('重载后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
  )
}

/**
 * 把右架子拖到指定厚度 —— 走的是**生产那只手**(EdgeShelf 的 `onHandleDown` →
 * pointermove 逐帧写本地 state → pointerup 落 store),不是伪造一份持久化状态:
 * 伪造只能摆出「松手之后」,量不到拖的过程中那一串中间厚度。
 *
 * 事件是**朝把手元素直接派发**的合成 PointerEvent,不是 Playwright 的真鼠标。
 * 这一条是试出来的,理由写清楚免得后人又换回去:把手是贴着架子内缘的 6px 竖带,
 * 真鼠标要先过命中测试(面板里的粘性行会间歇性盖住它),按下之后还要靠
 * `setPointerCapture` 把后续 move 拽回来 —— 两件事都偶发失手,实测同一段代码
 * 三跑里一次到位 240、一次只走了 8px 就断。合成事件直接落在挂着监听器的那个
 * 元素上,把「手准不准」这一层噪声整个拿掉,而被驱动的仍是生产处理器一行不差。
 *
 * 右架子的外缘不动(贴着视口右边),所以 thicknessFromPointer 就是 outer - x:
 * 想要 T 的厚度,把指针放到 x = outer - T。每一步之间等一帧,让 React 真的把
 * 那一档厚度画出来 —— 这样「逐帧路径」不是嘴上说说。
 */
async function dragThicknessTo(page, target) {
  const got = await page.evaluate(async (want) => {
    const el = document.querySelector('[data-shelf="right"] [role="separator"]')
    const aside = document.querySelector('[data-shelf="right"]')
    if (!el || !aside) return -1
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    const from = r.left + r.width / 2
    const to = aside.getBoundingClientRect().right - want
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const mk = (type, x) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: x,
        clientY: y,
      })
    el.dispatchEvent(mk('pointerdown', from))
    for (let i = 1; i <= 12; i += 1) {
      el.dispatchEvent(mk('pointermove', from + ((to - from) * i) / 12))
      await frame()
    }
    el.dispatchEvent(mk('pointerup', to))
    await frame()
    await frame()
    return aside.getBoundingClientRect().width
  }, target)
  if (Math.abs(got - target) > 2) {
    throw new Error(`厚度没拖到位:想要 ${target}px,实际 ${got.toFixed(1)}px`)
  }
  await delay(150)
  return got
}

/**
 * 在页面里扫一遍架子,返回所有相交的盒子对。
 *
 * 「盒子」= 自己画内容的元素(直接文本 / svg / img / canvas / input),
 * 且与架子的可视矩形相交(滚出去的、content-visibility: hidden 跳过渲染的,
 * getBoundingClientRect 要么是 0 要么在外面,天然被滤掉)。
 * 祖孙对不比 —— 孩子画在爸爸身上是布局的定义,不是重叠。
 */
function scanOverlaps(page, tolerance, allow) {
  return page.evaluate(
    ({ tol, allowList }) => {
      const shelf = document.querySelector('[data-shelf="right"]')
      if (!shelf) return { error: '右架子不在 DOM 里' }
      const clip = shelf.getBoundingClientRect()

      const PAINTS = new Set(['SVG', 'IMG', 'CANVAS', 'INPUT', 'TEXTAREA'])
      const hasOwnText = (el) => {
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) return true
        }
        return false
      }
      const describe = (el) => {
        const cls = typeof el.className === 'string' ? el.className : ''
        const testid = el.getAttribute?.('data-testid')
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
        return `${el.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`
          + `${testid ? `[${testid}]` : ''}${text ? ` «${text}»` : ''}`
      }

      /*
       * **看得见的那一块**才是被试,不是几何矩形。
       *
       * 一个滚上去的卡,它的 getBoundingClientRect 仍然停在滚动容器上缘之外 ——
       * 拿这个矩形去比,它会和顶栏的搜索条「相交」,而屏幕上那里什么都没有
       * (滚动容器把它裁掉了)。首跑就被这一族假红淹了(七八对里六对是它)。
       * 所以每个盒子都要**沿着祖先链逐层求交**:凡是 overflow 不为 visible 的
       * 祖先,都会把后代裁到自己的盒子里。裁完宽或高 ≤ 0 = 屏幕上根本没有它。
       */
      const visibleRect = (el) => {
        let box = el.getBoundingClientRect()
        let node = el.parentElement
        while (node) {
          const st = getComputedStyle(node)
          if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
            const r = node.getBoundingClientRect()
            const left = Math.max(box.left, r.left)
            const top = Math.max(box.top, r.top)
            const right = Math.min(box.right, r.right)
            const bottom = Math.min(box.bottom, r.bottom)
            if (right <= left || bottom <= top) return null
            box = { left, top, right, bottom, width: right - left, height: bottom - top }
          }
          if (node === shelf) break
          node = node.parentElement
        }
        const left = Math.max(box.left, clip.left)
        const top = Math.max(box.top, clip.top)
        const right = Math.min(box.right, clip.right)
        const bottom = Math.min(box.bottom, clip.bottom)
        if (right - left <= 0 || bottom - top <= 0) return null
        return { left, top, right, bottom }
      }

      /*
       * 粘性头是律三**预留过**的覆盖,不是违规覆盖。
       *
       * `position: sticky` 的语义就是「内容从我底下滚过去」—— 拿它和滚过去的
       * 那些卡求交,必然对对都红,而屏幕上那正是它该有的样子。真正的预留不在
       * 布局里,在**滚动坐标系**里:`scroll-padding-top` 告诉滚动容器上面这一条
       * 是被占着的,于是 scrollIntoView 永远不会把东西停在它底下。所以这条门
       * 单独有一步去查那个预留在不在(见 checkStickyReservation),
       * 查到了才允许在这里豁免。
       *
       * 豁免的边界钉死在「同一个粘性头之内仍然要查」:groupName 压住 count
       * 就是同一个粘性头里的两件,那是本批修的病灶,一格都不许放。
       * 所以判据是**两边的粘性宿主是不是同一个**,不是「有没有沾上粘性」。
       */
      const stickyHostOf = (el) => {
        let node = el
        while (node && node !== shelf) {
          if (getComputedStyle(node).position === 'sticky') return node
          node = node.parentElement
        }
        return null
      }

      const boxes = []
      const walk = (el) => {
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return
        if (Number(style.opacity) === 0) return
        const raw = el.getBoundingClientRect()
        if (raw.width <= 0 || raw.height <= 0) return
        if (hasOwnText(el) || PAINTS.has(el.tagName)) {
          const rect = visibleRect(el)
          // 全被裁掉 = 屏幕上没有它。这一支也顺手滤掉滚出视口的那几百张卡。
          if (rect) {
            boxes.push({
              el,
              rect,
              desc: describe(el),
              cls: el.className ?? '',
              sticky: stickyHostOf(el),
            })
          }
          return // 自己就是叶子,不再往下钻(mark / tspan 这类是它的一部分)
        }
        for (const child of el.children) walk(child)
      }
      for (const child of shelf.children) walk(child)

      const allowed = (a, b) =>
        allowList.some(
          (rule) =>
            (String(a.cls).includes(rule.a) && String(b.cls).includes(rule.b))
            || (String(b.cls).includes(rule.a) && String(a.cls).includes(rule.b)),
        )

      const hits = []
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]
          const b = boxes[j]
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue
          // 粘性宿主不同 = 一件在粘性头里、另一件从它底下滚过去(或分属两个头)。
          // 同一个宿主(含两边都不粘)照查不误。
          if (a.sticky !== b.sticky) continue
          const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
          const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
          if (ox <= tol || oy <= tol) continue
          if (allowed(a, b)) continue
          hits.push({
            a: a.desc,
            b: b.desc,
            overlap: `${ox.toFixed(1)}×${oy.toFixed(1)}px`,
          })
        }
      }
      return { boxes: boxes.length, hits, sample: boxes.map((b) => b.desc) }
    },
    { tol: tolerance, allowList: allow },
  )
}

/**
 * 律三的**预留检查** —— 上面那条粘性豁免的代价。
 *
 * 允许粘性头盖住滚过去的内容,前提是它在滚动坐标系里真的把那一条留出来了:
 * 它所在的滚动容器必须声明 `scroll-padding-top`,并且不小于粘性头的高度。
 * 少了这一句,键盘 `scrollIntoView` 会把卡停在粘性头**底下** —— 焦点环在,
 * 卡看不见,那正是「覆盖没有预留」的活样本。
 *
 * 查不到粘性头 = 这一批没有粘性覆盖,直接过(不强迫谁必须做粘性头)。
 */
async function checkStickyReservation(page) {
  return page.evaluate(() => {
    const shelf = document.querySelector('[data-shelf="right"]')
    if (!shelf) return { error: '右架子不在 DOM 里' }
    const sticky = [...shelf.querySelectorAll('*')].filter(
      (el) => getComputedStyle(el).position === 'sticky' && el.getBoundingClientRect().height > 0,
    )
    if (sticky.length === 0) return { checked: 0, problems: [] }
    const problems = []
    const seen = new Set()
    for (const head of sticky) {
      let node = head.parentElement
      while (node && node !== shelf) {
        const st = getComputedStyle(node)
        if (st.overflowY === 'auto' || st.overflowY === 'scroll') break
        node = node.parentElement
      }
      if (!node || node === shelf) {
        problems.push(`粘性元素找不到滚动容器:${head.className}`)
        continue
      }
      if (seen.has(node)) continue
      seen.add(node)
      const declared = getComputedStyle(node).scrollPaddingTop
      const px = Number.parseFloat(declared)
      const need = head.getBoundingClientRect().height
      if (!Number.isFinite(px)) {
        problems.push(`滚动容器没有 scroll-padding-top(读到 "${declared}"),粘性头 ${need.toFixed(0)}px 没有预留`)
      } else if (px + 0.5 < need) {
        problems.push(`scroll-padding-top ${px}px < 粘性头 ${need.toFixed(0)}px —— 预留不够`)
      }
    }
    return { checked: sticky.length, problems }
  })
}

/**
 * 一档厚度 = **滚一遍**,每屏扫一次,取并集。
 *
 * 只扫首屏是不够的:报障那一组(uuid 组头)在 240px 档要滚两屏才露面,
 * 首屏绿不代表这一档绿。滚动步长取可视高度的 80%,留一成重叠免得跨屏的那一对
 * 两边都只露半截。
 */
async function sweep(page) {
  const scroller = await page.evaluate(() => {
    const body = document.querySelector('[data-shelf-body="right"]')
    const el = body && [...body.querySelectorAll('*')].find((x) => x.scrollHeight > x.clientHeight + 8)
    if (!el) return null
    el.scrollTop = 0
    return { height: el.clientHeight, total: el.scrollHeight }
  })
  const seen = new Map()
  const boxes = new Set()
  const step = scroller ? Math.max(120, Math.floor(scroller.height * 0.8)) : 0
  const stops = scroller ? Math.ceil((scroller.total - scroller.height) / step) + 1 : 1
  for (let i = 0; i < stops; i += 1) {
    if (scroller && i > 0) {
      await page.evaluate((top) => {
        const body = document.querySelector('[data-shelf-body="right"]')
        const el = body && [...body.querySelectorAll('*')].find((x) => x.scrollHeight > x.clientHeight + 8)
        if (el) el.scrollTop = top
      }, i * step)
      await delay(80)
    }
    const result = await scanOverlaps(page, 1, ALLOWED_OVERLAP)
    if (result.error) throw new Error(result.error)
    for (const desc of result.sample) boxes.add(desc)
    for (const hit of result.hits) seen.set(`${hit.a}|${hit.b}`, hit)
  }
  return { hits: [...seen.values()], boxes: [...boxes], steps: stops }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[squeeze-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[squeeze-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'squeeze-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'squeeze-gate-userdata-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'squeeze-gate-ws-'))
  const ownerRoot = path.join(workspaceRoot, ...SERVER_OWNER_SEGMENTS)
  for (const group of SEED_GROUPS) {
    if (group.dir) await mkdir(path.join(ownerRoot, group.dir), { recursive: true })
  }
  let server
  let app
  const failures = []
  try {
    console.log('\n[1/5] 起一台 core,种下四种组名形状')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_SERVER_WORKSPACE_ROOT: workspaceRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))

    const rec = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(rec.host, rec.port))) throw new Error('core 端口连不上')

    let seeded = 0
    for (const group of SEED_GROUPS) {
      for (const name of group.names) {
        const result = await rpc(rec, 'sessions', 'create', { name })
        const id = result?.session?.id
        if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(result)}`)
        if (group.dir) {
          const wrote = await rpc(rec, 'sessions', 'updateWorkingDirectory', {
            sessionId: id,
            workingDirectory: group.dir,
          })
          // 这条 RPC 的失败是**返回值里的 success:false**,不是 HTTP 错误 ——
          // 不检查它,种子就会静默退化成「全都没有工作目录」。
          if (wrote?.success !== true) {
            throw new Error(`工作目录没写进去(${group.dir}):${JSON.stringify(wrote)}`)
          }
        }
        await rpc(rec, 'sessions', 'addSystemMessage', {
          sessionId: id,
          message: {
            id: `squeeze-${id}`,
            role: 'user',
            content: `${name}:一段够长的预览正文,长到窄档里必须靠钳行而不是靠换行来收场。`,
            timestamp: Date.now(),
          },
        })
        seeded += 1
      }
    }
    console.log(`  ✓ 种了 ${seeded} 条会话 / ${SEED_GROUPS.length} 组`)

    console.log('\n[2/5] 拉起应用(独立 --user-data-dir),把会话总览钉到右架子')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await switchDefaultOpenToPinned(page)
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('架子上出现会话总览', () =>
      page.evaluate(
        () => document.querySelector('[data-shelf-body="right"]')?.dataset.panel === 'sessions',
      ),
    )
    await waitFor('总览画出会话卡', () =>
      page.evaluate(() => document.querySelectorAll('[data-session-id]').length > 0),
    )
    console.log('  ✓ 钉上了,卡也画出来了')

    console.log('\n[3/5] 律三的预留检查(粘性覆盖的代价)')
    const reservation = await checkStickyReservation(page)
    if (reservation.error) throw new Error(reservation.error)
    if (reservation.problems.length) {
      for (const problem of reservation.problems) console.log(`  ✗ ${problem}`)
      failures.push(`粘性覆盖没有布局预留:${reservation.problems.length} 条`)
    } else {
      console.log(`  ✓ ${reservation.checked} 个粘性元素,滚动坐标系里都留够了位置`)
    }

    console.log('\n[4/5] 五档厚度,逐档滚一遍扫重叠')
    for (const target of THICKNESSES) {
      const width = await dragThicknessTo(page, target)
      const { hits, boxes, steps } = await sweep(page)
      if (process.env.SQUEEZE_DUMP) console.log(`    [dump ${target}px]\n      ${boxes.join('\n      ')}`)
      if (hits.length === 0) {
        console.log(
          `  ✓ ${target}px(实测 ${width.toFixed(0)})—— 滚 ${steps} 屏,${boxes.length} 个盒子,零相交`,
        )
      } else {
        console.log(
          `  ✗ ${target}px(实测 ${width.toFixed(0)})—— 滚 ${steps} 屏,${hits.length} 对相交:`,
        )
        for (const hit of hits.slice(0, 12)) {
          console.log(`      ${hit.overlap}\n        A ${hit.a}\n        B ${hit.b}`)
        }
        if (hits.length > 12) console.log(`      …还有 ${hits.length - 12} 对`)
        failures.push(`${target}px:${hits.length} 对相交`)
      }
    }

    console.log('\n[5/5] 收工')
    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n[squeeze-gate] FAILED(${failures.length} 档):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[squeeze-gate] ok —— 五档全绿,零重叠')
}

main().catch((error) => {
  console.error('\n[squeeze-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
