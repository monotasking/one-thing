/**
 * **唯一的注册 barrel**(§3.1 纪律 3)。
 *
 * 每个 kind 的 `index.ts` 在被 import 时把自己注册进表里,这个文件负责逐个 import
 * 它们。所以「加一个块」的代价是:新建一个目录 + 在这里加一行 —— 注册表、壳、
 * ChatStream、别的块,一个都不动。这就是扩展三问里那句「答案不含改别的东西」的
 * 兑现处。
 *
 * 为什么是 barrel 而不是各自在用到的地方 import:注册是**副作用**,副作用散在
 * 各处就没人说得清「这台上到底注册了哪些块」。一个文件,一眼看全。
 *
 * P3 补齐了最后两件:`figure`(它自带**第二张表** —— 图种注册表,mermaid 是今天
 * 唯一的一行)与 `diff`(两个产地同批接:markdown 的 ```diff 围栏和 edit/write
 * 工具的 detail,同一个块、同一个组件)。这台上于是没有「模型有、渲染器没有」的
 * 块了;source-fallback 从此只接**真的**未知(版本错位、将来的新语法)。
 */
import './kinds/paragraph'
import './kinds/heading'
import './kinds/list'
import './kinds/quote'
import './kinds/divider'
import './kinds/code'
import './kinds/table'
import './kinds/figure'
import './kinds/diff'
import './kinds/source-fallback'
