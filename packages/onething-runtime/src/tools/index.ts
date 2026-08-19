/**
 * `@onething/runtime/tools` —— R4b 之后这里只剩**纯逻辑模块**。
 *
 * 工具系统本身(注册表、`Tool.define`、二十只内置工具对象、直调管线)已随 R4b
 * 删除,现行的工具系统是 `packages/core/toolkit` + `runtime/src/toolkit` +
 * `app/toolkit`。留在这个目录里的是两类东西,它们都不认识"工具"这个概念:
 *
 *  1. **被新树 import 的纯模块** —— 沙箱、bash 执行器与分类器、edit 引擎与
 *     replacers、diff hunks、文件快照 / 变更队列 / 变更账本、输出累加与截断、
 *     敏感文件判定、后台进程表、权限效果、`builtin/time-runtime.ts`、
 *     `builtin/web-search/{page-fetch,providers/*}`、`builtin/prompts/*.md`;
 *  2. **IPC 形状层** —— `tool-list-presentation` / `tool-execution-context` /
 *     `tool-call-state` / `ipc-operations`:四个纯投影模块,全部靠注入的函数
 *     工作,一行都不问注册表。宿主(electron IPC / server HTTP)照旧用它们把
 *     结果摆成宿主契约要的形状。
 */

export * from "./tool-call-state.js";
export * from "./tool-execution-context.js";
export * from "./tool-list-presentation.js";
export * from "./ipc-operations.js";
export * from "./sensitive-files.js";
export * from "./background-jobs.js";
export * from "./bash-executor.js";
export * from "./output-accumulator.js";
export * from "./text-truncation.js";
export * from "./file-mutation-queue.js";
export * from "./file-snapshot.js";
export * from "./file-mutation-audit.js";
export * from "./sandbox.js";
export * from "./sandbox-runtime.js";
export * from "./edit-engine.js";
export * from "./replacers.js";
export * from "./bash-classifier.js";
export * from "./permission-effects.js";
export * from "./diff-hunks.js";
export * from "./builtin/time-runtime.js";
export * from "./builtin/web-search/page-fetch.js";
export * from "./builtin/web-search/providers/brave.js";
export * from "./builtin/web-search/providers/types.js";
