import type { AppSettings } from '@shared/ipc/settings'
import { themePort } from './theme-port'
import { themeSnapshotStore } from './theme-snapshot'

/**
 * 新壳的**颜色来源**(D2,方案 §0「token 策略三段结构」的第 ② 段)。
 *
 * 三段结构里这个文件只管一段:**把色值从主题管道搬到 `:root` 上**。
 *  ① 命名归新壳 —— `styles/palette.css` 的六族 token,组件只认它们;
 *  ② 色值从主题管道来 —— **这里**:`themes` RPC 域的 `apply` 返回一张解析完的
 *     `cssVariables` 表(插件覆盖 / 皮肤档 / 表面旋钮已在域内合成,不分叉
 *     transport),整表贴上 `:root`,再由 `styles/theme-bridge.css` 把
 *     `--ui-*` 翻译成新壳自己的名字;
 *  ③ 结构值(圆角 / 间距 / 字号 / 影 / 层级)归新壳自有常量,与主题无关。
 *
 * 于是明暗、7 种 accent、自定义主题、插件覆盖全部**免费获得** —— 新壳一行主题
 * 计算都没有,共享主题层一个字也没改。
 *
 * ## 为什么是 `<style>` 而不是 `documentElement.style`(D2 裁量)
 *
 * 主题表今天是 654 个键,其中 **`--accent` 与 `--danger` 两个键与 palette.css
 * 的名字撞车**(主题层早就有这两个通用别名)。写进 `documentElement.style` 是
 * **行内样式**,优先级高于任何样式表规则 —— 那两个键就会绕过桥文件直接落地,
 * 而 `--danger` 在主题里是原始红(#AF3029),桥要的是过了对比度护栏的
 * `--ui-status-danger-fg`。所以整表落在一个 `<style>` 的 `:root{}` 里:
 * 桥的选择器是 `:root[data-theme-bridge]`,特异性比 `:root` 高一档,**桥永远赢**
 * ——「态强度只在桥里合成」这条治理才真的成立。
 *
 * `getComputedStyle(document.documentElement)` 上读得到的键与值不受影响(自定义
 * 属性来自样式表照样进计算样式),验收门照读不误。
 *
 * ## 没连上 core 会怎样 / 首帧是什么颜色
 *
 * **有快照就是上一次的主题,没快照才是 palette 的静态值。**
 *
 * 快照(`theme-snapshot.ts`)是「上一次 apply 成功的那张表」,由
 * `restoreThemeSnapshot()` 在 `createRoot` 之前**同步**贴上 —— 与
 * `reading/apply.ts`、`workspace/apply.ts` 同一条纪律:读 localStorage、不经过
 * core、首帧就是最终值。从前这里写的是「没连上 core 就什么都不做」,那句话今天
 * 只对**从没连上过 core 的那个 origin** 成立:快照只会由一次真的 apply 写下来,
 * 所以它在场就意味着这台壳连上过。
 *
 * 连不上的那一路仍然诚实:不重贴、不打新标记,屏幕上顶着的是上一次的真主题,
 * 而不是一份猜出来的颜色。这与 D1「不回退 mock」不矛盾 —— 快照不是 mock,
 * 是 core 自己上一次给的答案。
 *
 * 快照走的是**同一只** `applyThemeVariables`,所以那道「挡掉能破坏 CSS 语法的
 * 键值」的护栏一个字都绕不过去。
 *
 * ## 快照不动 `lastDecision`,所以连通后必定校正一次
 *
 * `lastDecision` 的语义是「**上一次真 apply 的判据**」,`applyIfChanged` 拿它做
 * 「变了才重贴」。快照贴的是上一次开机的表,这一次的设置、系统明暗、插件覆盖、
 * 自定义主题文件都可能已经不同了 —— 若让快照去记 `lastDecision`,连通后第一趟
 * `pull()` 固然照样无条件 apply(它本来就不看 `lastDecision`),但两条推送
 * (系统明暗 / 设置变更)若抢在 `pull()` 之前到达,就会被「和快照一样」短路掉,
 * 于是一张**陈旧的表**顶到下一次判据真变为止。所以快照只贴像素、不写判据:
 * 它是一层顶着的图,校正的账仍然由 core 的那一次真 apply 记。
 */

/** 主题表落在这一个 style 元素里;重 apply 是整体换 textContent。 */
const STYLE_ELEMENT_ID = 'onething-theme-vars'
/** 桥的激活标记。它在场 = 色值来自主题管道;不在场 = palette 静态值。 */
const BRIDGE_ATTRIBUTE = 'data-theme-bridge'
/**
 * **「这页现在是暗的还是亮的」,写成 CSS 选得中的形**(T1,2026-09-12)。
 *
 * 这条事实本来就在往下面 `root.style.colorScheme` 上写 —— 那是给浏览器的原生
 * 绘制看的,选择器选不中它。终端那十六格 ANSI 色是全仓第一个真需要按明暗分档
 * 的 CSS 族(主题管道的 `--ui-*` 表里没有终端这件事实,所以它们没有产地,
 * 判词整段在 `styles/palette.css` 的 `--term-*` 那一节上)。于是同一句话多写
 * 一个属性,不多一次判断:没连上 core = 标记不在 = 亮档原样生效,与
 * `data-theme-bridge` 那条纪律逐字同源。
 */
const COLOR_MODE_ATTRIBUTE = 'data-color-mode'
/**
 * 与旧壳 themes store 同一个兜底 id(`DEFAULT_THEME_ID`)。
 *
 * **导出**是 2026-09-13 设置页「主题」那一节要的:那一节也得在
 * `general.{light,dark}ThemeId` 缺席时说出一个 id,而「兜底是哪一个」
 * 只该有一个产地 —— 两处各写一个 `'flexoki'` 字面量,改一处漏一处。
 */
export const DEFAULT_THEME_ID = 'flexoki'

export type ThemeDecision = { themeId: string; mode: 'dark' | 'light' }

export type ThemeProbe = {
  /** 变量表是否真的贴上了 `:root`(= 桥是否接管)。 */
  applied: boolean
  themeId?: string
  mode?: 'dark' | 'light'
  /** 贴上去的键数。 */
  count: number
  /**
   * 屏幕上这张表是**哪来的**:`'snapshot'` = localStorage 里上一次的表(启动那
   * 一瞬),`'core'` = 刚刚从 `themes.apply` 拿回来的。真机排障要的就是这一格 ——
   * 「闪没闪」与「顶着的是不是旧色」是两个不同的问题。
   */
  source?: 'snapshot' | 'core'
  error?: string
}

declare global {
  interface Window {
    __d2?: ThemeProbe
  }
}

const probe: ThemeProbe = { applied: false, count: 0 }
if (typeof window !== 'undefined') window.__d2 = probe

/** 上一次读到的设置偏好。系统明暗变化时靠它重判,免得每次都回问一趟 core。 */
let preference: Pick<AppSettings, 'theme'> & { general?: AppSettings['general'] } = {
  theme: 'system',
}

/**
 * 上一次读到的系统明暗。设置变更时判据要它,而设置那条推送里没有它 ——
 * 回问一趟 `getSystemTheme` 只是为了拿一个刚刚才推过来的值,不如记住。
 * 初值与 `pull()` 的兜底同为 'dark'(那是问不到系统色时的读法)。
 */
let systemTheme: 'light' | 'dark' = 'dark'

/**
 * 上一次**贴成功**的判定。推送面用它做「变了才重贴」的判据:
 * 一次 apply 是一趟 RPC + 一次整表重写,而设置页上改一个与主题无关的开关
 * 也会推一份整设置过来 —— 没变就不该动屏幕。
 *
 * 只在成功之后记,所以上一次失败的判定会被重试;而 `pull()`(开场 / 手动重判)
 * **不看它**:那两个口的语义就是「无条件重来一次」。
 */
let lastDecision: ThemeDecision | undefined

/**
 * 「当前是哪套主题 + 哪个明暗」的判据 —— **与旧 Vue 壳逐字同源**:
 *  - 明暗:`settings.theme` 为 `'system'` 时取系统色(`settingsApi.getSystemTheme`,
 *    web 上就是看的人那台机器的 `prefers-color-scheme`),否则就是它自己
 *    (`stores/settings.ts` 的 `effectiveTheme`);
 *  - 主题 id:按明暗分别取 `general.darkThemeId` / `general.lightThemeId`,
 *    空则兜底 `flexoki`(`stores/themes.ts` 的 `currentThemeId` + 两个 ref 的初值)。
 *
 * 纯函数,系统色作为**参数**递进来 —— 判据可测,取数在外面。
 */
export function decideTheme(
  settings: Pick<AppSettings, 'theme'> & { general?: AppSettings['general'] },
  systemTheme: 'light' | 'dark',
): ThemeDecision {
  const mode = settings.theme === 'system' ? systemTheme : settings.theme
  const themeId =
    (mode === 'dark' ? settings.general?.darkThemeId : settings.general?.lightThemeId) ||
    DEFAULT_THEME_ID
  return { themeId, mode }
}

/**
 * 一条最小的卫生闸。域那边发出来的值已经过白名单(插件颜色覆盖有色值白名单、
 * 皮肤是枚举档位),这里只再挡一次**能破坏 CSS 语法的字符** —— 贴的是一段
 * 拼出来的样式文本,`}` 或 `<` 混进来就不是「一个坏色值」而是「一段坏样式」。
 */
function isSafeEntry(name: string, value: string): boolean {
  if (!/^--[A-Za-z0-9_-]+$/.test(name)) return false
  return !/[<>{}]/.test(value) && !value.includes('</')
}

/** 把变量表贴上 `:root`,并打上桥的激活标记。返回真的贴上去的键数。 */
export function applyThemeVariables(
  cssVariables: Record<string, string>,
  mode: 'dark' | 'light',
): number {
  if (typeof document === 'undefined') return 0
  const lines: string[] = []
  for (const [name, value] of Object.entries(cssVariables)) {
    if (typeof value !== 'string' || !isSafeEntry(name, value)) continue
    lines.push(`  ${name}: ${value};`)
  }
  if (lines.length === 0) return 0

  let element = document.getElementById(STYLE_ELEMENT_ID)
  if (!element) {
    element = document.createElement('style')
    element.id = STYLE_ELEMENT_ID
    document.head.appendChild(element)
  }
  element.textContent = `:root {\n${lines.join('\n')}\n}\n`

  const root = document.documentElement
  root.setAttribute(BRIDGE_ATTRIBUTE, '')
  // 明暗也告诉浏览器一声:原生表单控件、默认滚动条、`color-scheme` 相关的
  // 系统绘制跟着走。这不是主题色值,是「这页现在是暗的还是亮的」这一条事实。
  root.style.colorScheme = mode
  // 同一条事实的 CSS 选得中的形(判词在 `COLOR_MODE_ATTRIBUTE` 上)。
  root.setAttribute(COLOR_MODE_ATTRIBUTE, mode)
  return lines.length
}

/**
 * **开机第一句颜色:把上一次的表同步贴上**(启动闪色的治法,判词在文件头)。
 *
 * 在 `main.tsx` 里排在 `createRoot` 之前、`startThemeSource()` 之前 —— 它一个
 * 字节的网都不碰,是纯粹的「读 localStorage → 贴 `:root`」,与
 * `startReadingAxes()` / `startWorkspaceApply()` 同一格纪律。
 *
 * 没快照 = 什么都不做,与从前逐字一样(palette 静态值顶着)。
 * **不设 `lastDecision`** —— 理由整段写在文件头「快照不动 lastDecision」那一节。
 */
export function restoreThemeSnapshot(): ThemeProbe {
  const snapshot = themeSnapshotStore.read()
  if (!snapshot) return probe
  const count = applyThemeVariables(snapshot.cssVariables, snapshot.mode)
  if (count === 0) return probe
  probe.applied = true
  probe.count = count
  probe.themeId = snapshot.themeId
  probe.mode = snapshot.mode
  probe.source = 'snapshot'
  return probe
}

/** 拿一次设置 + 系统色 → 判 → apply → 贴。失败就什么都不动(见文件头)。 */
async function pull(): Promise<ThemeProbe> {
  const port = await themePort()
  const [settingsResponse, systemResponse] = await Promise.all([
    port.getSettings(),
    port.getSystemTheme(),
  ])
  if (settingsResponse.success && settingsResponse.settings) {
    preference = {
      theme: settingsResponse.settings.theme,
      general: settingsResponse.settings.general,
    }
  }
  systemTheme = systemResponse.success && systemResponse.theme ? systemResponse.theme : 'dark'
  return applyDecision(decideTheme(preference, systemTheme))
}

/**
 * **「变量表刚刚换过一次」的订阅口**(T1,2026-09-12)。
 *
 * ── 谁需要它、为什么 DOM 那条路不够 ─────────────────────────────────────
 * 绝大多数消费者不需要:它们是 CSS,`:root` 上的值一换就跟着变。需要它的是
 * **那些把 CSS 变量读成 JS 值、自己画像素的东西** —— 今天只有一个:xterm
 * (canvas / WebGL 渲染器,颜色必须以 `ITheme` 交给它,`getComputedStyle`
 * 读过一次就定死在那台渲染器里)。
 *
 * 不做成 MutationObserver:那是**猜**(观察一个属性的变化去推断另一件事已经
 * 完成),而这里有一句确定的「刚刚贴完」。也不做成 zustand store:它没有
 * 「当下值」这回事 —— 当下值在 `:root` 上,这只是一声通知。
 *
 * 通知**只在真的贴上去之后**发(`applyDecision` 成功那一路);
 * `applyIfChanged` 判据没变时一声都不发(见那只函数)。
 */
const themeAppliedListeners = new Set<(decision: ThemeDecision) => void>()

/** 订「变量表换过了」。返回退订;订阅方自己负责在卸载/HMR 时调它。 */
export function onThemeApplied(listener: (decision: ThemeDecision) => void): () => void {
  themeAppliedListeners.add(listener)
  return () => {
    themeAppliedListeners.delete(listener)
  }
}

async function applyDecision(decision: ThemeDecision): Promise<ThemeProbe> {
  const port = await themePort()
  const response = await port.applyTheme(decision.themeId, decision.mode)
  if (!response.success || !response.cssVariables) {
    probe.error = response.error || 'themes.apply 未成功'
    return probe
  }
  const count = applyThemeVariables(response.cssVariables, decision.mode)
  probe.applied = count > 0
  probe.count = count
  probe.themeId = decision.themeId
  probe.mode = decision.mode
  probe.source = 'core'
  probe.error = undefined
  lastDecision = decision
  // 存一份给下次开机(判词在文件头)。**贴成了才存** —— 一张贴不上去的表
  // (空表 / 整表都被护栏挡掉)存下来只会让下一次开机白读一趟。
  // 存的是 core 给的原表,不是过滤后的行:护栏在 `applyThemeVariables` 里,
  // 快照走的是同一只函数,所以下次读回来照样过一遍同一道闸。
  if (count > 0) {
    themeSnapshotStore.write({
      themeId: decision.themeId,
      mode: decision.mode,
      cssVariables: response.cssVariables,
    })
  }
  // 一声通知,给「把 CSS 变量读成 JS 值」的那一族(见 `onThemeApplied`)。
  // 一个监听炸了不许拦住别的 —— 这是通知,不是一条链。
  for (const listener of [...themeAppliedListeners]) {
    try {
      listener(decision)
    } catch {
      /* 订阅方自己的事 */
    }
  }
  return probe
}

/**
 * 推送面专用:判据变了才重贴。
 *
 * 两条推送(系统明暗 / 设置变更)都走这里 —— 它们的共同点是「有人递来一个新事实,
 * 但新事实未必换得出一套新主题」:改一个与主题无关的设置开关、系统色推来一个
 * 和现在一样的值,都不该换来一趟 apply RPC 与一次整表重写。
 * 开场(`pull`)与手动重判(`refreshThemeFromSettings`)**不走这里**:
 * 那两个口的语义就是无条件重来一次。
 */
function applyIfChanged(decision: ThemeDecision): Promise<ThemeProbe> {
  if (
    lastDecision &&
    lastDecision.themeId === decision.themeId &&
    lastDecision.mode === decision.mode
  ) {
    return Promise.resolve(probe)
  }
  return applyDecision(decision)
}

let started: Promise<ThemeProbe> | undefined
let unsubscribe: (() => void) | undefined
let unsubscribeSettings: (() => void) | undefined

/**
 * 启动主题源:等传输面就绪 → 拉一次 → 订**两条**推送。幂等。
 *
 * 两条推送各管一半判据,合起来正好是 `decideTheme` 的两个入参:
 *  - `onSystemThemeChanged` —— 系统明暗(web 实现 = `prefers-color-scheme`
 *    监听,在新壳里真的工作);
 *  - `onSettingsChanged` —— 设置偏好(共享层读侧补齐 E 批把 web 的空桩换成了
 *    真订阅,H 批接上)。载荷就是脱敏过的整份设置,直接喂判据 ——
 *    **不再回问一趟 `getSettings`**:回问拿到的还是这一份,却多一趟 RPC,
 *    而且两份之间还能插进第三次变更。
 *
 * 两条都经 `applyIfChanged`:判据没变就不重贴(见那个函数的注释)。
 */
export function startThemeSource(): Promise<ThemeProbe> {
  started ??= (async () => {
    const port = await themePort()
    await port.ready()
    unsubscribe?.()
    unsubscribe = port.onSystemThemeChanged((next) => {
      systemTheme = next
      // 只有跟随系统时才需要重判;但重判本身是纯函数,无条件跑更省一个分支。
      void applyIfChanged(decideTheme(preference, systemTheme))
    })
    unsubscribeSettings?.()
    unsubscribeSettings = port.onSettingsChanged((settings) => {
      if (!settings) return
      preference = { theme: settings.theme, general: settings.general }
      void applyIfChanged(decideTheme(preference, systemTheme))
    })
    return pull()
  })().catch((error) => {
    probe.error = error instanceof Error ? error.message : String(error)
    return probe
  })
  return started
}

/**
 * 重新读一次设置并**无条件**重贴。
 *
 * 设置变更从 H 批起有推送面(见上),所以这不再是「听不见时的补救」而是一个
 * 手动口:新壳自己的设置页改完可以直接调它,不必等一趟推送绕回来。
 */
export function refreshThemeFromSettings(): Promise<ThemeProbe> {
  return pull().catch((error) => {
    probe.error = error instanceof Error ? error.message : String(error)
    return probe
  })
}

export function themeProbe(): ThemeProbe {
  return probe
}

/** 测试用:把模块级的一次性状态清干净。 */
export function resetThemeSourceForTest(): void {
  unsubscribe?.()
  unsubscribe = undefined
  unsubscribeSettings?.()
  unsubscribeSettings = undefined
  started = undefined
  preference = { theme: 'system' }
  systemTheme = 'dark'
  lastDecision = undefined
  probe.applied = false
  probe.count = 0
  probe.themeId = undefined
  probe.mode = undefined
  probe.source = undefined
  probe.error = undefined
  if (typeof document !== 'undefined') {
    document.getElementById(STYLE_ELEMENT_ID)?.remove()
    document.documentElement.removeAttribute(BRIDGE_ATTRIBUTE)
    document.documentElement.removeAttribute(COLOR_MODE_ATTRIBUTE)
    document.documentElement.style.colorScheme = ''
  }
  themeAppliedListeners.clear()
}
