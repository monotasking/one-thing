/**
 * **唯一的注册 barrel**(与 `content/blocks/index.ts` 逐条同款纪律)。
 *
 * 每个型的模块在被 import 时把自己注册进表里,这个文件负责逐个 import 它们。
 * 所以「加一种型」的代价是:新建一个文件 + 在这里加一行 —— 注册表、查看器壳、
 * 头、脚、跳转条,一个都不动。
 *
 * 为什么是 barrel 而不是各自在用到的地方 import:注册是**副作用**,副作用散在
 * 各处就没人说得清「这台上到底认得哪几种文件」。一个文件,一眼看全。
 *
 * **次序即优先级**:`resolveViewer` 取第一个认领的。兜底(unsupported)放最后,
 * 而且它是唯一带 `fallback` 标的那一个 —— 查不到时落它。
 *
 * 今天六格里的分工:
 *   code        源码 + 认不出后缀但读得动的纯文本(lang=null 就是后者)
 *   markdown    渲染 ⇄ 源码
 *   image       位图 + svg(svg 另有源码面)
 *   media       视频 / 音频 —— **示例档**
 *   unsupported 二进制 / 超阈值 / 读失败(兜底)
 * 留表位(PDF / CSV)写在 `data/viewer-kinds.ts` 的 DEFERRED_VIEWER_TYPES 里。
 */
import './code'
import './markdown'
import './image'
import './media'
import './unsupported'
