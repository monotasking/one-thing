import type { SerializedResourceSpec } from '@shared/ipc/resources'

/**
 * **`workbench:` 的自述**(原子 K2b-2b,正本 `docs/design/atom-2026-09.md`
 * §5 / §6 / §10.3)。
 *
 * 它是**纯数据**:零 import store、零 import React、零副作用。落点表在
 * `./shell-ops.ts`,连接生命周期在 `./shell-host.ts` —— 三只文件分别回答
 * 「有哪些做法」「怎么做」「什么时候在」,一只文件答一句。
 *
 * ── 这张表怎么筛出来的(§6,判据比表本身要紧)─────────────────────────────
 * §6 那句话:**「AI 应该能做、脚本应该能做、审计应该能看见的,才是『做』;
 * 其余是视图状态。」** 换一个 principal(AI / 脚本 / 命令面板)做同一件事说得通,
 * 才进这张表。
 *
 * 进表的七条:开一格 / 切过去 / 关掉 / 搬到某个区域 / 撕成浮窗 / 铺满 / 退出铺满
 * / 召唤一块瓦 —— 每一条换成「让 AI 替我做」都是一句完整的人话。
 *
 * **不进表**的,连同理由:
 *  · `setSplitRatio` / `setPairRatio` / `setShelfThickness` / `moveFloat` /
 *    `resizeFloat` —— 拖一根杆子的中间态。它们一秒钟发几十次,过管线就是
 *    §6 那句「每一帧一条命令,界面卡死」;而且「把这条杆拖到 37%」不是任何
 *    principal 会想要的一句话。
 *  · 滚动位置 / hover / 拖到一半的预览 / 输入框里打了一半的字 —— 同上,
 *    只有拿着鼠标的人才有这个动作。
 *  · `hideTab` / `restoreHidden` / `dropHidden` —— 隐藏是**位置记忆**这套机制的
 *    内部状态(「收回 Dock」那条路的树侧动作),不是一件独立的事。要它的时候
 *    该露面的是「收回 Dock」这件事本身,不是它的实现。
 *  · `splitLeaf` / `pairRefs` / `unpairAt` —— 版式手艺活。它们说得出口,但每一条
 *    都要一个「屏幕上这一片叶」的坐标(`leafId`),而 `leafId` 是壳的内部身份、
 *    重启就换、AI 手里从来没有过。开它们之前先要一套「叶的地址」,那是另一单。
 *  · `seed` / `reset` / `sweepRefs` / `setDragging` / `setFocusLeaf` —— 机制自己的
 *    活口,不是用户的动作。
 *
 * ── 地址(`ref`)是什么 ────────────────────────────────────────────────────
 * `workbench:<区域>` —— `workbench:center`、`workbench:edge:left`、
 * `workbench:float:3`。**地址说的是「这一下落在哪个区域」**,而 `move` 那条的
 * `region` 参数说的是「搬到哪个区域」:一个是发起坐标,一个是目的地,两个词
 * 撞在一起纯属巧合,不是一件事。落点表里只有一只 `regionOf()` 把这条次序说一遍
 * (显式参数 → 地址 → 交给 store 的缺省),没有第二处。
 *
 * ── 参数名为什么一个都不叫 `ref` / `op` / `read` ───────────────────────────
 * `ref` 是**地址那一格的键**(`RESOURCE_REF_KEY`):内核铸入参时会把真地址填进
 * 那个名字,一条做法的参数用它会被当场盖掉。`op` / `read` 同理是判别键
 * (`core/resource/validator.ts` 只校验这两个)。所以这里一律叫 `target` —— 而且
 * 那也确实是它的意思:**要作用在哪格内容上**,值是一条 refId(`session:<id>` /
 * `file:/a/b` / `dir:/x`),与壳内部那套地址逐字同一套语法(K2b-1 已经合流)。
 *
 * ── effects 一律 `ui_change`,`home` 一律 `shell` ───────────────────────────
 * `ui_change`(K2a' 加的那一类)的原话:「壳里开格 / 激活 / 移动 / 撕成浮窗的
 * 效果类,不是『无副作用』而是**副作用只在界面上、主体本来就拥有**」。`close`
 * 也在这一类里 —— 它不另立一个 `ui_destructive`,因为「有没有未保存的东西」
 * 这个事实只有壳知道,而壳侧的 `beforeClose`(`mayCloseContent`)已经在兜它。
 *
 * `home` 这一格交上去也会被后端盖成 `'shell'`(`wiring/resource/shell-provider.ts`
 * 的 `resourceSpecFromShell` 不读它)。这里照样写全,因为这份自述**也是给人读的**:
 * 一份说不出自己在哪儿跑的自述,读的人得去翻反序列化那一段才知道。
 */

/** 这扇壳交上来的那一个命名空间。全仓只有这一处写出这个字符串。 */
export const WORKBENCH_SCHEME = 'workbench'

/** 一格内容的地址。值是一条 refId,与壳内部那套地址同一套语法(K2b-1)。 */
const TARGET = {
  type: 'string',
  description: 'The content address to act on, e.g. "session:<id>" or "file:/abs/path".',
} as const

const REGION = {
  type: 'string',
  description: 'A workbench region: "center", "edge:<side>" or "float:<id>".',
} as const

/**
 * `workbench:` 的自述。**导出的是一个函数不是一个常量**,理由是这份对象要过
 * `JSON.stringify` 做续命指纹(`ShellMountRegistry` 按字面判「自述变没变」),
 * 而一个被外面改过一格的模块级常量会让那个指纹静默地跟着变。每次现造一份,
 * 谁都改不到别人的。
 */
export function workbenchResourceSpec(): SerializedResourceSpec {
  return {
    scheme: WORKBENCH_SCHEME,
    title: 'Workbench',
    reads: {
      /** 整棵树:区域 → 叶 → 每格的 refId 与哪一格是活动的。 */
      layout: {
        title: 'The whole workbench layout: every region, leaf and tab',
        query: { type: 'object', properties: {}, additionalProperties: false },
        result: { type: 'object' },
      },
      /** 一个区域里的标签。`region` 缺席 = 地址里那个区域。 */
      tabs: {
        title: 'The tabs of one region',
        query: { type: 'object', properties: { region: REGION }, additionalProperties: false },
        result: { type: 'object' },
      },
      /** 此刻焦点落在哪片叶、那片叶露着哪一格。 */
      focus: {
        title: 'Which leaf has focus and which content it is showing',
        query: { type: 'object', properties: {}, additionalProperties: false },
        result: { type: 'object' },
      },
    },
    ops: {
      open: {
        title: 'Open a piece of content in the workbench',
        params: {
          type: 'object',
          properties: { target: TARGET, region: REGION },
          required: ['target'],
        },
        effects: ['ui_change'],
        home: 'shell',
      },
      activate: {
        title: 'Bring an already-open piece of content to the front of its tab strip',
        params: { type: 'object', properties: { target: TARGET }, required: ['target'] },
        effects: ['ui_change'],
        home: 'shell',
      },
      close: {
        title: 'Close an open piece of content',
        params: { type: 'object', properties: { target: TARGET }, required: ['target'] },
        effects: ['ui_change'],
        home: 'shell',
      },
      move: {
        title: 'Move an open piece of content to another region',
        params: {
          type: 'object',
          properties: {
            target: TARGET,
            region: REGION,
            at: { type: 'number', description: 'Index inside the destination tab strip.' },
          },
          required: ['target', 'region'],
        },
        effects: ['ui_change'],
        home: 'shell',
      },
      float: {
        title: 'Tear a piece of content off into its own floating window',
        params: { type: 'object', properties: { target: TARGET }, required: ['target'] },
        effects: ['ui_change'],
        home: 'shell',
      },
      full: {
        title: 'Make a piece of content fill the window',
        params: { type: 'object', properties: { target: TARGET }, required: ['target'] },
        effects: ['ui_change'],
        home: 'shell',
      },
      exitFull: {
        title: 'Leave full-window mode',
        params: { type: 'object', properties: {}, additionalProperties: false },
        effects: ['ui_change'],
        home: 'shell',
      },
      summon: {
        title: 'Summon a Dock tile: open it if closed, reveal it if covered, focus it',
        params: {
          type: 'object',
          properties: { item: { type: 'string', description: 'The Dock tile id, e.g. "sessions".' } },
          required: ['item'],
        },
        effects: ['ui_change'],
        home: 'shell',
      },
    },
    /**
     * §10.3 那三条通用名里的两条。`deleted` 不在这里 —— 拼贴台不拥有任何东西的
     * 存亡(一条会话被删掉是 `session:` 的事实),它只知道自己摆着什么。
     * 一个 scheme 发它答不出来的事实,就是在替别人说话。
     */
    events: {
      opened: {
        title: 'A piece of content now has a place in the workbench',
        payload: { type: 'object', properties: { ref: TARGET }, required: ['ref'] },
      },
      closed: {
        title: 'A piece of content no longer has a place in the workbench',
        payload: { type: 'object', properties: { ref: TARGET }, required: ['ref'] },
      },
    },
  }
}
