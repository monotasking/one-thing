/**
 * 「关掉发起这次调用的那扇窗」的**宿主壳路由**(结构债 P4 终态批 A1-a,
 * 2026-08-23)。
 *
 * 主窗用它做「最后一个标签页上的 Cmd+W」:标签树在渲染层,只有渲染层知道什么时候
 * 已经没得退了。
 *
 * **入参是空的,这是设计而不是遗漏** —— 要关哪扇窗由宿主从
 * `ShellDispatchContext.callerId`(`event.sender.id`)认。同 `RpcDispatchContext`
 * 的规矩:身份由宿主在自己那道认证之后**盖章**,永远不从信封里读;信封上压根
 * 没有这个字段可填。这是壳 context 带 callerId 的第一个用例。
 */
import { defineRouter } from "./router.js";

export interface CloseWindowResponse {
	success: boolean;
}

export type WindowRoutes = {
	close: { input: Record<string, never>; output: CloseWindowResponse };
};

export const windowRouter = defineRouter<WindowRoutes>("window", ["close"]);
