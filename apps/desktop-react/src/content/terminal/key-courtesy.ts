import { platformOf } from '../../keymap/platform'
import type { Combo, KeymapPlatform } from '../../keymap/types'

/**
 * **键盘认领表**(T1 叫「礼让表」;方案 §2.1-7,T1-fix 改成按平台的形;
 * **K0 把它从「伪装成局部键」改回它本来的样子**:一张 `claims`)。
 *
 * ── 一句话 ──────────────────────────────────────────────────────────────
 * 一张**纯数据表**:哪几个组合键在终端里属于 PTY,不属于这台应用。它的消费方
 * 是 `focus/scopes.ts` 的 `FOCUS_SCOPES.terminal.claims` —— 派发器沿活动路径由深
 * 到浅走,命中 claim 就**不 `preventDefault`、不再往外问**,事件原样落到 xterm
 * 手里,由 xterm 自己把 `^P` 写成 `\x10` 发下去。所以「在终端里 Ctrl+W 是删词、
 * 不是关标签」由**树的深度**成立,不靠 xterm 那一侧跟谁抢相位(9-1:xterm 是
 * DOM,唯一那个派发器在捕获相位先于它跑)。
 *
 * ── K0 为什么要改这个形 ─────────────────────────────────────────────────
 * T1 把它实现成「局部键 + 一个把控制字节写回 PTY 的 action」:壳先把这一下截下
 * 来(`preventDefault`),再自己往 PTY 写一遍 xterm 本来就会写的那个字节。
 * 它与「查找」根本不是一类东西 —— 一个是**认领并放行**,一个是**接住并执行**;
 * 模型里说不出这两类,下一个「Esc 归页面」之类的声明就又要找地方塞。
 * 于是 `pty:` 前缀、`terminalPtyKeyAction`、`controlByteOf` 与 `sendCourtesyKey`
 * 一起退役:**少了一次翻译,也少了一份「哪个字母对哪个字节」的第二真相**。
 *
 * ── mac 上这张表是**空的**,而那不是偷懒 ────────────────────────────────
 * 方案 §2.1-7 的原话:「mac 上 ⌘ 一族放给应用,Ctrl 进 PTY」。它成立的前提是
 * 键位层能分清这两枚键 —— T1 第一版交卷时**分不清**(`matchCombo` 用
 * `e.metaKey || e.ctrlKey` 当「按下了主修饰键」,于是 Ctrl+W 会触发 ⌘W),
 * 所以那一版把五行三平台都声明了,代价是 mac 上 ⌘P/⌘E/⌘J/⌘N/⌘W 也进 PTY。
 * **T1-fix 去修了病根**(`keymap/transitions.matchCombo` 现在按平台认那一枚
 * 物理键),于是 mac 上:
 *  · `Ctrl+W` 不再命中任何一条绑定 → 派发器不 `preventDefault` → xterm 照常
 *    把 `^W` 发给 PTY(**不需要任何一行声明**);
 *  · `⌘W` 照旧是「关当前 tab」,`⌘P` 照旧开检索面。
 * 两边都对,而且这张表在 mac 上一行都不用写 —— 那正是「⌘ 一族天然归应用、
 * Ctrl 天然进 PTY」这句话的字面意思。
 *
 * ── Win / Linux 上为什么还要这几行 ──────────────────────────────────────
 * 那两台机器上主修饰键**就是** Ctrl —— 应用的 `Ctrl+P` 与 shell 的 `^P` 抢的是
 * 同一枚键,分不开(这不是实现问题,是键盘本身只有一枚)。所以必须裁:
 * **焦点在终端里时,这几个归 PTY**。
 *
 * 挑哪几个,判据是**撞车**,不是「终端喜欢哪些键」。没被全局表占着的组合
 * (Ctrl+C / Ctrl+D / Ctrl+A / Ctrl+R / Ctrl+U / Ctrl+L …)**本来就到得了 PTY**:
 * 派发器在 `routeKey` 里问不到人就不 `preventDefault`,xterm 照常收。给它们各写
 * 一行只会让设置页的「谁答」列长出一串永远不会撞的行。
 *
 * 出厂命令表里占着「主修饰键 + 单个字母」的,一共五条(`keymap/commands.ts`
 * 的 `DEFAULT_COMBOS`,K0 之后 `tab.close` 也在同一张表里):
 *
 *   ⌘P `toggle:search` · ⌘E `toggle:sessions` · ⌘J `agent.menu` ·
 *   ⌘N `session.new` · ⌘W `tab.close`
 *
 * 而这五个字母在 readline / emacs 键位下全是每天都在按的:
 * `^P` 上一条历史、`^E` 行尾、`^J` 换行、`^N` 下一条历史、`^W` 删一个词。
 * 于是这张表恰好就是那五行。用户把别的命令改绑到别的 Ctrl+字母上时会撞 ——
 * 那条撞车由设置页的「谁答」列说出来(撞车不是错误,但不许静默)。
 *
 * ── 三条例外:`Ctrl+Tab` 族 / `Ctrl+\`` / `Ctrl+,`,一个都不在表上 ────────
 * 方案 §2.1-7 点名它们要留给应用。这里**结构上就进不来**:这张表只收字母,
 * 而 Tab 是结构键(§4.3 的封闭裁定:结构键不进任何表)、反引号与逗号不是字母。
 * `Ctrl+\`` 尤其要紧 —— 它是召唤终端那条全局命令,进了这张表就**再也收不起来**。
 * 这一段写在这里,是为了让下一个想「把表扩成 a–z」的人先看见代价。
 *
 * ── 平台在**模块加载时**量一次 ──────────────────────────────────────────
 * `FOCUS_SCOPES` 是一张静态封闭表(它自己的头注释:「没有『运行时注册一个新
 * 作用域种类』这条路」),所以这几行必须在模块加载时就定下来。判据仍旧是那只
 * 纯函数 `platformOf(ua)`,量它的是**这只文件**(与 `content/FileActionsMenu.tsx`
 * 那一处逐字同一手:纯函数不读 navigator,调用方量一次递进去)。
 * 按平台分档的那一只 `terminalClaims(platform)` 是导出的纯函数 —— 测试因此
 * 能把两台机器都走一遍,不必去改 UA。
 */

/**
 * 被认领的那几个字母。**只有字母** —— 判词见文件头「三条例外」。
 * 次序 = 出厂全局表里那五条命令的声明序,好让设置页的「谁答」列读起来与键位页同序。
 */
export const TERMINAL_COURTESY_LETTERS: readonly string[] = ['p', 'e', 'j', 'n', 'w']

/**
 * 这台机器上要认领的那几个组合。**mac 是空的**,判词整段在文件头。
 *
 * **一个组合一格**(与 `files.detail` 的 ⌘I / ⌘↵ 是同一条判例的两面:那两个键面
 * 是同一件事所以合成一条命令,这五个键各归各的字节所以各是一格)。它们不带
 * labelKey —— 认领不是命令,设置页在「谁答」那一列用终端自己的名字加一句
 * `terminal.keyToPty`(「交给终端」)把它说出来。
 */
export function terminalClaims(platform: KeymapPlatform): readonly Combo[] {
  if (platform === 'mac') return []
  return TERMINAL_COURTESY_LETTERS.map((letter) => ({ ctrl: true, key: letter }))
}

/** 这台机器的那一份(模块加载时量一次,判词在文件头末段)。 */
export const TERMINAL_CLAIMS: readonly Combo[] = terminalClaims(
  platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent),
)

/**
 * **xterm 侧那唯一一行**(9-1 末段):应用已经拿走的键不再进 PTY。
 *
 * 它住在这只文件而不是 `screen.ts`,是因为它**是认领法的另一半**:上面那张表
 * 说「这几个键归 PTY」,这一句说「除此之外,凡应用真的接住了的就别再重复一遍」。
 * 两半写在一处,下一个人改其中一半时看得见另一半;顺带它也就不必为了被测到而
 * 把 xterm 拖进 jsdom。
 *
 * 判据只有 `defaultPrevented` 一格,**不抄第二张键表**:唯一那个派发器住在
 * window 的捕获相位(整条传播路径的第一站),所以它认领过的每一下在到达 xterm
 * 时都已经 `preventDefault` 过;它没认领的(被 claims 放行的那五个、Ctrl+C /
 * Ctrl+D / Esc / Tab / 方向键 / 所有无修饰键)一个字都没动,照常进 PTY。
 */
export function appAlreadyTookKey(event: { defaultPrevented: boolean }): boolean {
  return event.defaultPrevented
}
