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
 * 这台上没有的:`figure`(P3 的二级表 + mermaid)、`diff`(P3,两个产地同批接)。
 * 它们的**模型**已经在词汇表里,解析器也确实会产出 figure —— 查不到渲染器时
 * `resolveBlock` 兜到 source-fallback,屏幕上是那段图源码。这就是「渐进」的样子。
 */
import './kinds/paragraph'
import './kinds/heading'
import './kinds/list'
import './kinds/quote'
import './kinds/code'
import './kinds/table'
import './kinds/source-fallback'
