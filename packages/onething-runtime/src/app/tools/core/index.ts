/**
 * 装配层保留下来的工具核心壳(R4b)。
 *
 * `app/tools/` 里除了这个 `core/` 目录之外的一切(registry 门面、三档 builtin
 * barrel、`types.ts`、`toolkit-guard.ts`)已随旧树删除。留下来的四个模块**不是**
 * 工具系统的一部分,而是**宿主注入端口**与纯工具函数,CLAUDE.md 的
 * `configure*Host` 表逐条指着它们的路径:
 *
 *  - `sandbox.ts` —— `configureSandboxHost`(downloads/home 面);
 *  - `bash-executor.ts` / `background-jobs.ts` —— 子进程与后台进程表的宿主实现;
 *  - `permission-policy.ts` —— `enforcePermissionPolicy`,新树的 `Authorizer`
 *    就是它的一层薄壳;
 *  - `replacers.ts` —— edit 引擎的替换器族(纯函数)。
 *
 * 就地保留而不是挪进 `app/toolkit/`:挪一次要改十几处 import 与一张写在
 * CLAUDE.md 里的端口表,而这四个文件与新旧哪一棵树都无关。
 */

export {
  replace,
  normalizeLineEndings,
  trimDiff,
  REPLACERS,
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
} from './replacers.js'
export type { Replacer } from './replacers.js'
