/**
 * **内容种类的注册 barrel** —— import 它**就是**「这台上认得哪些种内容」。
 *
 * ── 加一种内容 = 两处 ────────────────────────────────────────────────────
 * ①它自己的模块(`./<kind>.tsx`,一次 `registerContentKind(..., import.meta.hot)`);
 * ②这张表加一行 import。
 * 树、区域、隐藏与关闭、文件树标记、持久化、叶檐 —— 一个字都不改。
 * 「终端实例按 cwd 各一个当 tab」那次陌生能力演练的答案就是这两行。
 *
 * ── HMR 退役 ────────────────────────────────────────────────────────────
 * **不在这里写 dispose**:每个种类把自己那份 `import.meta.hot` 递给
 * `registerContentKind`,退役那一段只写一遍(在注册表里),与
 * `content/blocks/registry.ts` 的 `registerBlock` 逐字同一个体例。
 * 想漏得先把那个参数删掉,而那是一眼看得见的。
 *
 * ── 谁来 import 它 ──────────────────────────────────────────────────────
 * `main.tsx`,在 `startWorkbench()` **之前**一行。不放在 `workbench/store` 里 ——
 * 那会造一条 import 环(store → 这张表 → panel → content/index → FilesPanel → store),
 * 病历与判据写在 `workbench/store.ts` 与 `workspace/layout-scope.ts` 两个文件头上。
 */
import './panel'
import './file'
import './session'
/* W3:项目行拖进区域时变成的那一种 —— 以某个目录为根的一棵文件树(设计 §3.1)。 */
import './files-root'
