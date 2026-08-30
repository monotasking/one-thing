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
 */
import './kinds/paragraph'
import './kinds/source-fallback'
