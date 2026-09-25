/**
 * 内存预算表的读 / 松手(2026-09-25)。机制在 `@onething/core/memory`,
 * 装配在 `@onething/backend/wiring/memory`。
 *
 * 一个 RPC 域,不是一条新通道:桌面、浏览器壳、`bun run memory:report` 走的都是
 * 同一个 `POST /api/rpc`。
 */
import type { MemoryPressure, MemoryReport, MemoryTrimReport } from "@onething/core/memory";
import { defineRouter } from "./router.js";

export type {
	MemoryHolderReport,
	MemoryPressure,
	MemoryProcessSample,
	MemoryReport,
	MemoryTrimReport,
} from "@onething/core/memory";

export interface MemoryReportResponse extends MemoryReport {
	/** 调度器的预算(字节)。 */
	budget: { softBytes: number; hardBytes: number };
	/** core 进程自己的 V8 堆(字节)—— `rss` 之外最常要看的两格。 */
	heap: { usedBytes: number; totalBytes: number; externalBytes: number; arrayBuffersBytes: number };
}

export type MemoryRoutes = {
	report: { input: Record<string, never>; output: MemoryReportResponse };
	/** 手动叫一次松手。**只有本机可信的调用方可以**(见处理者)。 */
	trim: { input: { pressure?: MemoryPressure }; output: MemoryTrimReport };
};

export const memoryRouter = defineRouter<MemoryRoutes>("memory", ["report", "trim"]);
