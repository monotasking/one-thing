/**
 * **引用种类的注册 barrel** —— import 它**就是**「这台上认得哪几种引用」。
 *
 * ── 加一种引用 = 两处 ────────────────────────────────────────────────────
 * ①它自己的模块(`./kinds/<id>.ts`,一次 `registerReferenceKind(..., import.meta.hot)`);
 * ②这张表加一行 import。
 * 抽屉、草稿出口、气泡、打开 —— 一个字都不改。正本 §3 那次「@ 一条会话」的陌生
 * 能力演练答的就是这两行,而 `__tests__/structure.test.ts` 里那一段把它真跑了一遍:
 * 测试文件里现登记一份假自述,**一个生产文件都不改**。
 *
 * ── HMR 退役 ────────────────────────────────────────────────────────────
 * **不在这里写 dispose**:每一种把自己那份 `import.meta.hot` 递给
 * `registerReferenceKind`,退役那一段只写一遍(在注册表里),与
 * `content/kinds/index.ts` / `content/blocks/registry.ts` 逐字同一个体例。
 * 想漏得先把那个参数删掉,而那是一眼看得见的。
 *
 * ── 谁来 import 它 ──────────────────────────────────────────────────────
 * 与 `workbench/CenterRegion` 对内容种类那一条逐字同判例:**谁要查表,谁负责
 * 保证表是装好的**。今天四处 —— `main.tsx`(第一帧)、`content/user-message.tsx`
 * (画气泡)、`composer/usePickDrawer.ts`(开抽屉)、`composer/components/
 * ComposerInput.tsx`(草稿出口要查 `expand`)。生产那条路由 `main.tsx` 先装好,
 * 后三行管的是「不经过 main.tsx 的宿主」(用例、将来的第二个壳)。
 *
 * ── 这张表的**顺序就是抽屉里从上到下的组序** ──────────────────────────────
 * `/` 那个字符下是 命令 → 技能 → 插件(与 09-12 之前 `groupCommands` 那张固定表
 * 逐字相同,只是今天它不再是一张表,而是这三行的先后)。
 */
import './kinds/file'
/* 目录:与文件同一次取数的两种结果,所以它**没有**自己那一列(判词在它文件头)。 */
import './kinds/dir'
import './kinds/command'
import './kinds/skill'
import './kinds/plugin'
/* 提示词:只从引擎那边来(`contentParts` 的 `prompt-ref`),壳里没有落稿口。 */
import './kinds/prompt'
/* 网页:只有落稿与呈现两半(它不从抽屉进,也不在正文里 —— 判词在它文件头)。 */
import './kinds/page'

export { registerReferenceKind, resetReferenceKinds, referenceKindOf, referenceKindList } from './registry'
export { parseToken } from './registry'
export type { TokenHit } from './registry'
export type { ReferenceKind, ReferenceTrigger } from './kind'
