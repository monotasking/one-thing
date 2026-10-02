/**
 * 收尾修复写在没结局的调用上的那句话(§10.14 第 7 类)。
 *
 * 两个常量都**导出**:投影必须说出与引擎逐字相同的那一句 —— 它是"引擎派生
 * 字段",按 §10.10 的规矩不许在别处手抄字面量。
 *
 * 它们从前定义在引擎的 `packages/backend/core/engine/agent-loop-executor.ts` 里;会话投影在客户端
 * 也要跑,而引擎不该进客户端,所以 2026-10(server / client 拆分第①步 ①c)把这两句话拆出来
 * 放在 shared,引擎与投影都从这里取。
 */
export const CORE_LINGERING_TOOL_ERROR =
	"Tool did not report completion before the stream ended.";
/** 用户按下停止时,收尾修复写在没结局的调用上的那句话。 */
export const CORE_ABORTED_TOOL_ERROR = "User cancelled";
