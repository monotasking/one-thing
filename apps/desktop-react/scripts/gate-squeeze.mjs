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
 * **两个场景,同一把尺**(08-30 补):总览是一屏,进组之后的会话列表(ListView)
 * 是另一屏 —— 它有自己的顶行(面包屑 + 组名 + 过滤框),那一行的挤压行为与
 * 总览的组头毫无关系。只扫总览的话,ListView 顶行的病对这条门是隐形的
 * (08-30 用户报的「钉边窄档里过滤框被长组名推出去裁掉」正是这么漏网的)。
 * 所以第二个场景 = 点进一个长名组,再把同样的五档、同样的重叠尺跑一遍。
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
 * 场景②进哪一组。取**没有任何断行机会**的那个 32 位十六进制目录名:它在 flex 行里
 * 拿的是 max-content 宽度,一个字符都没法折 —— 长名把同行别的件挤走的最坏一例。
 * 用户报障那一屏(钉边 ~300px、组名长)就是这一形。
 */
const LIST_SCENARIO_GROUP = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

/**
 * ── 工作目录怎么种(08-31 改:相对路径那一套已经过期)──────────────────────
 *
 * 从前这条门靠一个临时 workspaceRoot(`ONETHING_SERVER_WORKSPACE_ROOT`)+
 * **相对路径**来种:联网宿主把每条工作目录夹进 `<workspaceRoot>/<uid>/<wid>`,
 * 绝对路径会被沙箱当场拒掉。
 *
 * `d1fa07c0`(files 域 local-trust)之后不成立了:`sessions.updateWorkingDirectory`
 * 的 http 分支在**本机可信面**上改走 ipc 那条路 —— 沙箱不再夹持,于是路径被
 * 逐字当真,而这条门绑的正是回环口(本机可信)。结果是相对名 `3f2a9c7e-…`
 * 被当成相对 cwd 的真路径去解析,后端答 `Directory does not exist`,种子步整步挂掉。
 *
 * 所以现在照 gate-files 的起法:**mkdtemp 一个真临时根,组目录是它下面真实存在
 * 的子目录,递绝对路径**,退出时整根删掉。
 *
 * 组名形状(这条门的全部测试意图)一个字都没变:屏幕上的组名 = 路径**末段**
 * (expose/projection.projectNameOf),所以换成绝对路径之后,那四种名字形状
 * ——32 位无断点十六进制 / uuid / 长英文串 / 短名 —— 逐字照旧。
 */
const PROJECT_DIR_NAMES = SEED_GROUPS.flatMap((g) => (g.dir ? [g.dir] : []))

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
 * 点开一个**长名组**,进它的会话列表(ListView)。
 *
 * 组 id = 归一之后的工作目录(见 expose/projection.ts),而种子递的是一条临时根下的
 * **绝对路径** —— 所以 id 里带着一截每次都不同的 mkdtemp 名,写不出字面 testid。
 * 这里按**组头的文字**去找(组名 = 路径末段 = 种子目录名,见 projectNameOf),
 * 找到之后点它右端那枚常驻的「›」入口。
 *
 * 入口是 `flex: none` 的常驻项、只动 opacity(律三),所以不 hover 也点得到 ——
 * 和 clickTestId 一样走 `el.click()`,理由同样是「这条门要证的是排版,不是命中测试」。
 */
async function enterGroupNamed(page, fragment) {
  const result = await page.evaluate((frag) => {
    const heads = [...document.querySelectorAll('[data-testid^="group-head-"]')]
    const head = heads.find((el) => (el.textContent ?? '').includes(frag))
    if (!head) {
      return { ok: false, seen: heads.map((el) => (el.textContent ?? '').trim().slice(0, 48)) }
    }
    const enter = head.querySelector('[data-testid^="group-enter-"]')
    if (!enter) return { ok: false, seen: ['组头在,但里面没有 group-enter-*'] }
    enter.click()
    return { ok: true }
  }, fragment)
  if (!result.ok) {
    throw new Error(`进不去组「${fragment}」—— 现有组头:\n  ${result.seen.join('\n  ')}`)
  }
  await waitFor('ListView 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="expose-list"]'))),
  )
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
 * 律三的**第二处预留检查**:Dock 常显钉边时,主输入按不按得到(08-31 P0)。
 *
 * 前一条查的是「滚动坐标系里留没留」,这一条查的是「屏幕坐标系里留没留」——
 * 同一条律,两种覆盖形态。判据不是求盒子相交而是 **elementFromPoint**:
 * 「这一点按下去事件落在谁身上」才是用户真正遭遇的那件事,而两个盒子相交
 * 完全可能是无害的(Dock 是圆角条,四角那一块谁都碰不到)。
 *
 * 病历:修前底边常显档下 composer 四件控件盒在 843–871,而 Dock 占 826–888——
 * 100 个采样点只有 5 个按得到(附件 / 模型 / 输入区三件是 0/25)。修法是外壳按
 * `--dock-reserve-*` 让出那一条边(components/AppShell.module.css 的 .reserve*)。
 * 反证:把那几条 padding 注释掉 → 这一步当场红回 5/100。
 *
 * 自动隐藏档不查:那时 Dock 平时不在屏上,「盖住」这件事根本不发生。
 */
async function checkDockReservation(page) {
  return page.evaluate(() => {
    const strip = document.querySelector('[data-dock="strip"]')
    if (!strip) return { error: 'Dock 条不在 DOM 里' }
    const holder = strip.parentElement
    if (holder && /hidden/i.test(holder.className)) return { skipped: '自动隐藏档,不查' }

    const buttons = [...document.querySelectorAll('button')]
    const byLabel = (re) => buttons.find((b) => re.test(b.getAttribute('aria-label') ?? ''))
    const targets = [
      ['输入区', document.querySelector('[contenteditable]') ?? document.querySelector('textarea')],
      ['附件钮', byLabel(/添加附件|Add attachment/)],
      ['模型钮', byLabel(/选择模型|Pick a model/)],
      ['发送键', byLabel(/^发送$|^Send$|停止生成|Stop generating/)],
    ]

    const problems = []
    const readings = []
    for (const [label, el] of targets) {
      if (!el) {
        problems.push(`${label}:不在场(选择器对不上就等于这条断言在陪跑)`)
        continue
      }
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) {
        problems.push(`${label}:盒子是 0×0`)
        continue
      }
      // 控件盒里均匀取 5×5 个点,逐点问「这一下落在谁身上」。
      let blocked = 0
      const total = 25
      for (let i = 1; i <= 5; i += 1) {
        for (let j = 1; j <= 5; j += 1) {
          const hit = document.elementFromPoint(r.left + (r.width * i) / 6, r.top + (r.height * j) / 6)
          if (hit?.closest('[data-dock="strip"]')) blocked += 1
        }
      }
      readings.push(`${label} ${total - blocked}/${total}`)
      if (blocked > 0) problems.push(`${label}:${blocked}/${total} 个采样点被 Dock 挡住`)
    }
    return { problems, readings }
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

/**
 * ListView 顶行的**在场检查** —— 律一/律四在「行溢出」这一形上的判据。
 *
 * ── 为什么这一条不能靠上面那把重叠尺 ────────────────────────────────────
 * 08-30 报障是「长组名把过滤框推出容器右缘,过滤框被裁掉」。flex 行里的项**永不
 * 互相重叠**:挤不下的时候它们是一个接一个地溢出到容器外面去,然后被祖先的
 * overflow 裁掉。于是 scanOverlaps 在修前修后都是零相交 —— 真机实测过,那一档的
 * 盒子清单里干脆没有 input(它整个被裁没了,连相交的资格都没有)。
 * 一把只会说「有没有压着」的尺,对「有没有被挤没」这一形是结构性失明的。
 *
 * 所以这个场景带自己的判据:**结构行里的每一件都必须完整落在容器可视区内**。
 * 这正是律四那句「变窄的次序永远是先截断 → 再有序降元素」的机器化 —— 被挤出
 * 边界不在「有序降元素」的名单里,没有谁声明过过滤框可以消失。
 * ──────────────────────────────────────────────────────────────────────
 */
async function checkListTopRow(page) {
  return page.evaluate(() => {
    const shelf = document.querySelector('[data-shelf="right"]')
    const list = document.querySelector('[data-testid="expose-list"]')
    if (!shelf || !list) return { error: 'ListView 或右架子不在 DOM 里' }
    const header = list.querySelector('header')
    if (!header) return { error: 'ListView 顶行(header)不在 DOM 里' }
    const clip = shelf.getBoundingClientRect()
    const problems = []
    const seen = []
    for (const el of header.children) {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      const cls = (typeof el.className === 'string' ? el.className : el.getAttribute('class')) ?? ''
      const desc = `${el.tagName.toLowerCase()}${cls ? `.${String(cls).trim().split(/\s+/).join('.')}` : ''}`
      const outRight = r.right - clip.right
      const outLeft = clip.left - r.left
      seen.push(`${desc} w=${r.width.toFixed(0)} 右缘余量=${(-outRight).toFixed(0)}`)
      // 1px 容差与重叠尺同一口径(亚像素排版)。
      if (outRight > 1) problems.push(`${desc} 右缘冲出容器 ${outRight.toFixed(1)}px(宽 ${r.width.toFixed(0)})`)
      if (outLeft > 1) problems.push(`${desc} 左缘冲出容器 ${outLeft.toFixed(1)}px(宽 ${r.width.toFixed(0)})`)
    }
    return { problems, seen }
  })
}

/**
 * 崩溃现场那条长 URL —— toast 挤压检查的被试。
 *
 * 形状是真机报障那一条逐字照抄:带 `?t=` 时间戳的模块 URL。它的要害是
 * **没有空格**,默认的 `overflow-wrap: normal` 在里面找不到几个断点。
 */
const CRASH_URL = 'http://localhost:5199/src/components/DockTile.tsx?t=1756612345678&import&v=0f3a9c2e'

/**
 * 挤压纪律的 **toast 版**(09-01 报障:崩溃弹框「右半边没了」)。
 *
 * ── 为什么是独立的一步,而不是让上面那把重叠尺去扫 ─────────────────────────
 * 三条理由,每条都能单独把它挡在那把尺之外:
 *   · toast 画在 `document.body` 上的 portal 里,根本不在右架子那棵树下;
 *   · 它的病是**墨溢出自己的盒子**,不是两个盒子相交 —— 盒子从头到尾是声明的
 *     320px,`getBoundingClientRect` 一个像素都没变(修前实测 320/320),
 *     一把只会说「有没有压着」的尺对这一形结构性失明;
 *   · 它被 `.toast { overflow: hidden }` 齐着边框剪掉,剪掉的那一截连盒子都没有。
 *
 * 所以判据换成**墨**:`rect.left + el.scrollWidth` 才是这段文字真正画到哪儿。
 * 两条断言,对应报障当天被怀疑过的两种病根(先量后修,量出来是第二种):
 *   ① 盒子没被撑宽:toast 盒宽 ≤ 宿主可用宽(视口减两侧固定偏移),且整只落在视口内;
 *   ② 墨没顶穿 padding:每一件内容的墨右缘 ≤ 容器 padding 内缘 —— 换句话说
 *      「墨到边框的距离 ≥ padding token」,这正是「任何内容不得触边」的机器化。
 *
 * 反证:把 `ui/Toast.module.css` 里 `.message` 那条 `overflow-wrap: anywhere`
 * 注释掉再跑 → ② 当场红(修前实测:墨画到 1290,容器 padding 内缘 1251,
 * 顶穿 39px;盒宽 320 = 声明值,① 修前修后都绿 —— 这正是它必须两条都在的理由)。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 触发走的是**生产那条路**:朝 window 派发一个真的 ErrorEvent,由
 * `services/crash.ts` 的 window.onerror 监听接住 → notify → toast。
 * 不去戳 toast hub —— 那样量的就不是崩溃弹框,是一个被摆拍的组件。
 */
async function checkToastSqueeze(page) {
  await page.evaluate((url) => {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'TypeError: Cannot read properties of undefined (reading tile)',
        filename: url,
        lineno: 42,
        colno: 17,
        error: new TypeError('Cannot read properties of undefined (reading tile)'),
      }),
    )
  }, CRASH_URL)
  await waitFor('崩溃 toast 出场', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="toast-row"]'))),
  )
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="toast-row"]')]
    if (rows.length === 0) return { error: 'toast 不在 DOM 里' }
    const problems = []
    const seen = []
    for (const row of rows) {
      const stack = row.parentElement
      const cs = getComputedStyle(row)
      const rb = row.getBoundingClientRect()
      const padR = Number.parseFloat(cs.paddingRight)
      const padL = Number.parseFloat(cs.paddingLeft)
      const bwR = Number.parseFloat(cs.borderRightWidth)
      const bwL = Number.parseFloat(cs.borderLeftWidth)
      const innerRight = rb.right - bwR - padR
      const innerLeft = rb.left + bwL + padL

      // ① 盒子本身:没被撑宽,整只在视口里。
      const offset = Number.parseFloat(getComputedStyle(stack).right)
      const available = window.innerWidth - (Number.isFinite(offset) ? offset * 2 : 0)
      seen.push(`盒宽 ${rb.width.toFixed(0)} / 可用 ${available.toFixed(0)}`)
      if (rb.width > available + 1) {
        problems.push(`toast 盒宽 ${rb.width.toFixed(1)} > 宿主可用宽 ${available.toFixed(1)}`)
      }
      if (rb.right > window.innerWidth + 1 || rb.left < -1) {
        problems.push(`toast 盒子出视口:left=${rb.left.toFixed(1)} right=${rb.right.toFixed(1)} 视口宽 ${window.innerWidth}`)
      }

      // ② 墨:每一件内容都不许顶穿 padding 内缘。
      const PAINTS = new Set(['SVG', 'IMG', 'CANVAS'])
      const walk = (el) => {
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue?.trim())
        if (hasText || PAINTS.has(el.tagName)) {
          const r = el.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) return
          const inkRight = r.left + el.scrollWidth
          const name = `${el.tagName.toLowerCase()}.${String(el.className || '').trim().split(/\s+/).join('.')}`
          seen.push(`${name} 墨→padding内缘 ${(innerRight - inkRight).toFixed(1)}`)
          if (inkRight > innerRight + 1) {
            problems.push(
              `${name}:墨画到 ${inkRight.toFixed(1)},容器 padding 内缘在 ${innerRight.toFixed(1)}`
              + ` —— 顶穿 ${(inkRight - innerRight).toFixed(1)}px(padding token ${padR}px 视觉上不存在)`,
            )
          }
          if (r.left < innerLeft - 1) {
            problems.push(`${name}:左缘 ${r.left.toFixed(1)} 越过容器 padding 内缘 ${innerLeft.toFixed(1)}`)
          }
          return
        }
        for (const child of el.children) walk(child)
      }
      for (const child of row.children) walk(child)
    }
    return { problems, seen, rows: rows.length }
  })
}

/**
 * 一个场景 = 五档厚度,逐档滚一遍扫重叠。
 * 场景名只进日志与失败行 —— 尺一把,场景两个,判据一个字都不许分岔。
 * `extra` 是场景自带的附加判据(见 checkListTopRow 顶部为什么需要它)。
 */
async function sweepThicknesses(page, scenario, failures, extra) {
  for (const target of THICKNESSES) {
    const width = await dragThicknessTo(page, target)
    if (extra) {
      const { error, problems, seen } = await extra(page)
      if (error) throw new Error(error)
      if (process.env.SQUEEZE_DUMP) console.log(`    [row ${target}px] ${seen.join(' | ')}`)
      if (problems.length) {
        console.log(`  ✗ ${scenario} ${target}px —— 结构行被挤出容器:`)
        for (const problem of problems) console.log(`      ${problem}`)
        failures.push(`${scenario} ${target}px:${problems.length} 件被挤出容器`)
      }
    }
    const { hits, boxes, steps } = await sweep(page)
    if (process.env.SQUEEZE_DUMP) {
      console.log(`    [dump ${scenario} ${target}px]\n      ${boxes.join('\n      ')}`)
    }
    if (hits.length === 0) {
      console.log(
        `  ✓ ${scenario} ${target}px(实测 ${width.toFixed(0)})—— 滚 ${steps} 屏,${boxes.length} 个盒子,零相交`,
      )
    } else {
      console.log(
        `  ✗ ${scenario} ${target}px(实测 ${width.toFixed(0)})—— 滚 ${steps} 屏,${hits.length} 对相交:`,
      )
      for (const hit of hits.slice(0, 12)) {
        console.log(`      ${hit.overlap}\n        A ${hit.a}\n        B ${hit.b}`)
      }
      if (hits.length > 12) console.log(`      …还有 ${hits.length - 12} 对`)
      failures.push(`${scenario} ${target}px:${hits.length} 对相交`)
    }
  }
}


/**
 * 竖排 Dock 的预留检查(09-01 用户报障带截图:竖排 Dock 盖住右架子里查看器的正文)。
 *
 * 与 [3.5/7] 是同一条律三、同一把尺,只是换了一条边:那条量的是底边 Dock 压 composer,
 * 这条量的是**左右边 Dock 压侧架子**。判据也是同一句——把该侧架子里「自己画内容」
 * 的盒子逐个取右缘,问一次 elementFromPoint:命中 Dock 就是被盖。
 *
 * 病历:内衬第一版打在 [data-shelf-body] 上,padding 量到了(88)却没用——
 * 面板那一层是 `position:absolute; inset:0`,而**绝对定位的 inset 量的是包含块的
 * padding box**,整个把 padding 跨了过去:真机 17/19 个盒子越界、13 个采样落在 Dock 下。
 * 内衬移到 [data-panel-layer] 之后归零。
 */
async function checkSideShelfReach(page, edge) {
  await page.evaluate((e) => {
    const raw = localStorage.getItem('onething.stage')
    if (!raw) return
    const p = JSON.parse(raw)
    p.state = { ...(p.state ?? {}), dockDisplay: 'always', dockEdge: e }
    localStorage.setItem('onething.stage', JSON.stringify(p))
  }, edge)
  await page.reload()
  await waitFor('重载后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
  )
  /* 前面几步已经把总览钉在右架子上了,重载会照原样恢复 —— 这时候再点一下 Dock 图标
   * 是「收起来」,不是「打开」(clickDockIcon 的第二下语义)。所以先问再点。 */
  const already = await page.evaluate(
    () => document.querySelector('[data-shelf-body="right"]')?.dataset.panel === 'sessions',
  )
  if (!already) await clickTestId(page, 'dock-tile-sessions')
  await waitFor('架子上出现会话总览', () =>
    page.evaluate(() => document.querySelector('[data-shelf-body="right"]')?.dataset.panel === 'sessions'),
  )
  await waitFor('总览画出会话卡', () =>
    page.evaluate(() => document.querySelectorAll('[data-session-id]').length > 0),
  )
  await delay(400)
  return await page.evaluate(() => {
    const body = document.querySelector('[data-shelf-body="right"]')
    const strip = document.querySelector('[data-dock="strip"]')
    if (!body || !strip) return { error: '侧架子或 Dock 条不在 DOM 里' }
    const sb = strip.getBoundingClientRect()
    const inDock = (el) => {
      while (el) {
        if (el.dataset && el.dataset.dock === 'strip') return true
        el = el.parentElement
      }
      return false
    }
    const draws = (el) => {
      if (['svg', 'img', 'canvas', 'input', 'textarea'].includes(el.tagName.toLowerCase())) return true
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true
      return false
    }
    const boxes = [...body.querySelectorAll('*')]
      .filter(draws)
      .map((el) => ({ el, b: el.getBoundingClientRect() }))
      .filter((x) => x.b.width > 0 && x.b.height > 0)
    let covered = 0
    let sampled = 0
    const examples = []
    for (const { el, b } of boxes) {
      const x = b.right - 2
      const y = b.top + b.height / 2
      if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue
      sampled += 1
      if (inDock(document.elementFromPoint(x, y))) {
        covered += 1
        if (examples.length < 4) examples.push(`${el.tagName.toLowerCase()} @ ${Math.round(x)},${Math.round(y)}`)
      }
    }
    return {
      covered,
      sampled,
      examples,
      rightMost: boxes.length ? Math.round(Math.max(...boxes.map((x) => x.b.right))) : null,
      stripLeft: Math.round(sb.left),
    }
  })
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
  /*
   * 组目录的真根。**真建出来**,并且递绝对路径 —— 理由见 PROJECT_DIR_NAMES
   * 上面那段(local-trust 之后沙箱不再夹持,路径被逐字当真)。
   */
  const projectsRoot = await mkdtemp(path.join(tmpdir(), 'squeeze-gate-projects-'))
  /** 组名(= 路径末段)→ 它的绝对路径。种子步只问这张表,不再自己拼路径。 */
  const projectDirs = new Map()
  for (const name of PROJECT_DIR_NAMES) {
    const full = path.join(projectsRoot, name)
    await mkdir(full, { recursive: true })
    projectDirs.set(name, full)
  }
  let server
  let app
  const failures = []
  try {
    console.log('\n[1/7] 起一台 core,种下四种组名形状')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        // `ONETHING_SERVER_WORKSPACE_ROOT` 已退役:local-trust 之后工作目录不再被
        // 夹进 workspaceRoot,种子递的是真实绝对路径(见 PROJECT_DIR_NAMES 那段)。
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
          const full = projectDirs.get(group.dir)
          const wrote = await rpc(rec, 'sessions', 'updateWorkingDirectory', {
            sessionId: id,
            workingDirectory: full,
          })
          // 这条 RPC 的失败是**返回值里的 success:false**,不是 HTTP 错误 ——
          // 不检查它,种子就会静默退化成「全都没有工作目录」(这条检查本身
          // 正是 08-31 抓到 local-trust 那次行为变化的那只手,别拆)。
          if (wrote?.success !== true) {
            throw new Error(`工作目录没写进去(${full}):${JSON.stringify(wrote)}`)
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

    console.log('\n[2/7] 拉起应用(独立 --user-data-dir),把会话总览钉到右架子')
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

    console.log('\n[3/7] 律三的预留检查(粘性覆盖的代价)')
    const reservation = await checkStickyReservation(page)
    if (reservation.error) throw new Error(reservation.error)
    if (reservation.problems.length) {
      for (const problem of reservation.problems) console.log(`  ✗ ${problem}`)
      failures.push(`粘性覆盖没有布局预留:${reservation.problems.length} 条`)
    } else {
      console.log(`  ✓ ${reservation.checked} 个粘性元素,滚动坐标系里都留够了位置`)
    }

    /*
     * 同一条律的第二处预留:Dock 常显钉边时,主输入按不按得到。
     * 与上一步分开报,是因为它们是**两个坐标系**里的同一件事(滚动 / 屏幕),
     * 红起来该修的地方也不同 —— 一条门该指得出该谁修。
     */
    console.log('\n[3.5/7] 律三的预留检查(Dock 常显覆盖的代价:主输入可达性)')
    const dockReserve = await checkDockReservation(page)
    if (dockReserve.error) throw new Error(dockReserve.error)
    if (dockReserve.skipped) {
      console.log(`  · ${dockReserve.skipped}`)
    } else if (dockReserve.problems.length) {
      for (const problem of dockReserve.problems) console.log(`  ✗ ${problem}`)
      failures.push(`Dock 覆盖没有布局预留:${dockReserve.problems.length} 条`)
    } else {
      console.log(`  ✓ composer 四件全可达(${dockReserve.readings.join(' · ')})`)
    }

    console.log('\n[3.6/7] 律三的预留检查(竖排 Dock:侧架子内容可达性)')
    for (const edge of ['right', 'left']) {
      const side = await checkSideShelfReach(page, edge)
      if (side.error) throw new Error(side.error)
      if (side.covered) {
        console.log(`  ✗ Dock 钉${edge}:侧架子里 ${side.covered}/${side.sampled} 个内容采样落在 Dock 底下(最右内容盒 ${side.rightMost},条左缘 ${side.stripLeft})`)
        for (const e of side.examples) console.log(`      ${e}`)
        failures.push(`Dock 钉${edge}:侧架子内容被盖 ${side.covered} 处`)
      } else {
        console.log(`  ✓ Dock 钉${edge}:侧架子 ${side.sampled} 个内容采样零被盖(最右内容盒 ${side.rightMost} vs 条左缘 ${side.stripLeft})`)
      }
    }
    /* 这一步换过 Dock 的边,**必须换回来**:后面两场景量的是架子厚度下的排版,
     * 竖排 Dock 会把主区宽度整个改掉,不还原就是拿另一套布局去判它们(试过,红一档)。 */
    await checkSideShelfReach(page, 'bottom')

    console.log('\n[4/7] 场景①总览:五档厚度,逐档滚一遍扫重叠')
    await sweepThicknesses(page, '总览', failures)

    console.log(`\n[5/7] 场景②进组后 ListView(长名组「${LIST_SCENARIO_GROUP}」):同样五档`)
    // 在宽档(五档的最后一档 560)上点进去,窄档只负责被量 —— 这条门量的是排版,
    // 不是「窄到 240 还点不点得中」。
    await enterGroupNamed(page, LIST_SCENARIO_GROUP)
    await sweepThicknesses(page, 'ListView', failures, checkListTopRow)

    console.log('\n[6/7] 挤压纪律的 toast 版(崩溃弹框里那条无断点长 URL)')
    const toast = await checkToastSqueeze(page)
    if (toast.error) throw new Error(toast.error)
    if (process.env.SQUEEZE_DUMP) console.log(`    [toast] ${toast.seen.join(' | ')}`)
    if (toast.problems.length) {
      for (const problem of toast.problems) console.log(`  ✗ ${problem}`)
      failures.push(`toast 挤压:${toast.problems.length} 条`)
    } else {
      console.log(`  ✓ ${toast.rows} 条 toast:盒子没被撑宽,墨一件都没顶穿 padding`)
    }

    console.log('\n[7/7] 收工')
    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(projectsRoot, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n[squeeze-gate] FAILED(${failures.length} 档):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[squeeze-gate] ok —— 两场景 × 五档全绿,零重叠')
}

main().catch((error) => {
  console.error('\n[squeeze-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
