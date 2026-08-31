import { registerKeymap } from './registry'

/**
 * **键位档表**。一条纪律统领全表:键位**只把手势映射到已注册的能力**,
 * 不新增能力 —— 一个键位档不该能做出一件用鼠标做不到的事。所以 `bindings`
 * 的值域是那五个动词的封闭联合(registry.ts 的 `ViewerCommand`),加一格是拍板件。
 *
 * 换档**即时生效且不重挂查看器**:档只是一张表,壳每次按键现查
 * (`commandFor`)—— 滚动位、当前行、草稿一件都不会因为换档而丢。
 */

/**
 * 默认档。三条,都是屏幕上本来就有的钮:存盘、跳转、检索。
 *
 * ── 它们是**面域局部键**,不是全局命令(09-01 三层立法)──────────────────
 * 三条都只在焦点落在查看器面域里时才响 —— 声明在 `keymap/scopes.ts` 的
 * `SCOPED_KEYS`,落点在 `FileViewer` 挂在自己根元素上的那个监听。两处会不会
 * 分叉由 `keymap/__tests__/keymap-scopes.test.ts` 逐条比对钉着。
 *
 * `mod+f` 是 F2 新加的一条:它开的仍然是那条跳转条(把 `/` 前缀先打上),
 * 不是第二套检索 UI —— 理由写在 registry.ts 的 ViewerCommand 上。
 */
registerKeymap({
  id: 'default',
  nameKey: 'viewer.keymapDefault',
  bindings: {
    'mod+s': 'save',
    'mod+l': 'jump',
    'mod+f': 'find',
  },
  implemented: true,
})

/**
 * ── Vim 档:**本批只立表形与状态栏开关位** ────────────────────────────────
 *
 * 定稿给的子集是 `hjkl` · `gg/G` · `:42` · `/搜索` · `:w`(超出这个范围不做)。
 * 其中两件今天已经真有落点:`:42` 就是行号 navigator(它连冒号都吃),
 * `:w` / `:wq` 就是既有的存盘通道 —— 也就是说 Vim 档需要的**能力**一件都不缺,
 * 缺的是「模式机 + 命令行」那台状态机(NORMAL/INSERT 的进出、`hjkl` 的按键流、
 * `/` 搜索要先有检索 navigator)。
 *
 * **F2 更新一格**:`/搜索` 的那半个前提已经不缺了 —— 检索 navigator 在 F2 从留表位
 * 接了真(navigators.ts),⌘F 走的就是它。Vim 档还欠的只剩「模式机 + 命令行」
 * 本身(NORMAL 里裸按一个 `/` 要能进命令行),那仍然是下面说的那件独立的活。
 *
 * 那台状态机是一件独立的活,硬塞进 F1 只会得到一个半个模式的 Vim —— 比没有更糟
 * (用户按 `j` 没反应,却看见状态栏写着 NORMAL)。所以本批的兑现是:
 *  · 档在表里、状态栏有开关、模式标画得出来(NORMAL 紫 / INSERT 绿 tint);
 *  · `bindings` 只继承默认那两条 —— 按 `j` 就是打了一个 j,不假装;
 *  · `implemented:false` 让状态栏如实说一句「表形已立,绑定还没接」。
 * **留账:hjkl / gg / G / `/搜索` 的绑定实现留后批。**
 */
registerKeymap({
  id: 'vim',
  nameKey: 'viewer.keymapVim',
  modes: ['normal', 'insert'],
  bindings: {
    'mod+s': 'save',
    'mod+l': 'jump',
    'mod+f': 'find',
  },
  commandLine: true,
  implemented: false,
})
