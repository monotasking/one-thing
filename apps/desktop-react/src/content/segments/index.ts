/**
 * **唯一的段注册 barrel**(G 线 P3,正本 `docs/stream-geometry-2026-09.md` §20)。
 *
 * 每个 kind 文件在被 import 时把自己注册进表里,这个文件负责逐个 import 它们。所以
 * 「加一种段」的代价是:`kinds/` 下新建一个文件 + 在这里加一行 —— 注册表、
 * `SegmentView`、`assemble/index.ts`、`ChatStream` 一个都不动(演练见正本 §20.4)。
 *
 * 为什么是 barrel 而不是各自在用到的地方 import:注册是**副作用**,副作用散在各处就没人
 * 说得清「这台上到底注册了哪些段」。一个文件,一眼看全。
 *
 * **顺序有一处是政策**:认领整条消息的型(今天只有 `compact`)按注册序被问、第一个认领
 * 的赢。今天只有一个认领者,顺序还不是问题;第二个认领者进来时,它排在哪一行就是一次
 * 拍板,不是随手。节点消费型之间顺序无关(一种节点只许一个 def,查表不问先后)。
 */
import './kinds/compact'
import './kinds/thinking'
import './kinds/rich-text'
import './kinds/tool-group'
import './kinds/research'
import './kinds/image'
