/**
 * `memory` RPC 域的契约:内存报告与手动释放缓存。
 * 实现见 `@onething/core/memory` 与 `@onething/backend/wiring/memory`。
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
	/** 内存预算(字节)。 */
	budget: { softBytes: number; hardBytes: number };
	/** 主进程的 V8 堆用量(字节)。 */
	heap: { usedBytes: number; totalBytes: number; externalBytes: number; arrayBuffersBytes: number };
}

export type MemoryRoutes = {
	report: { input: Record<string, never>; output: MemoryReportResponse };
	/** 手动释放缓存。仅限本机可信的调用方。 */
	trim: { input: { pressure?: MemoryPressure }; output: MemoryTrimReport };
};

export const memoryRouter = defineRouter<MemoryRoutes>("memory", ["report", "trim"]);
