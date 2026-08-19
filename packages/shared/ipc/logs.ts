/**
 * 渲染进程日志上行的契约(logging L3,docs/design/logging-system-2026-08.md §2.5)。
 *
 * **它是一个 RPC 域,不是一条新手写通道。** 设计文本里写的是
 * `ipc 'log:append'` + `POST /api/logs`;落地时改走通用信封
 * (desktop `rpc:invoke`,web `POST /api/rpc`),理由与 E1 判例一样:
 * 手写通道要同时改 `channels.ts` / preload / `@main` handler / `web.ts` 四枚壳,
 * 而那四枚正是 `transport:gate` 的计量面;RPC 域则是
 * **一个 router 文件 + 一个 handler 文件 + 装配层一行,四壳零改动**,
 * 顺带白拿 web 端平价(server 的 `/api/rpc` 与其它路由共用同一道 Bearer 闸)。
 */
import type { LogLevel } from "@onething/core/logging";
import { defineRouter } from "./router.js";

export type { LogLevel } from "@onething/core/logging";

/**
 * 上行的一条记录。形状是 `LogRecord` 的**可序列化子集**:
 * `time/level/ns/msg/fields/err`,`src` 不由渲染侧决定 —— 谁收谁盖章。
 */
export interface AppendLogRecord {
	/** epoch ms;缺失或非法由收方盖上到达时刻。 */
	time?: number;
	level: LogLevel;
	/** 点分命名空间,收方会加 `renderer.` 前缀。 */
	ns: string;
	msg: string;
	fields?: Record<string, unknown>;
	err?: { name?: string; message?: string; stack?: string };
}

export interface AppendLogsRequest {
	records: AppendLogRecord[];
	/** 渲染侧因背压丢掉的条数(如实上报,收方记成一条 warn)。 */
	dropped?: number;
}

export interface AppendLogsResponse {
	/** 实际写进根 logger 的条数。 */
	accepted: number;
	/** 被收方拒掉的条数(超批量上限 / 形状不合法)。 */
	rejected: number;
}

/** 一次调用最多带多少条 —— 超出的尾巴被拒,并如实回在 `rejected` 里。 */
export const MAX_LOG_RECORDS_PER_APPEND = 200;

/** 单条 `msg` 的长度上限,超出截断(尾部标注)。 */
export const MAX_LOG_MSG_LENGTH = 4000;

/**
 * hub 在 dev 下回显到 console 的行**必须**带这个前缀。
 *
 * Electron 的 `console-message` 兜底(拍板 C)只抓 warn+,而 hub 自己的 warn/error
 * 回显同样是 warn+ —— 不做标记就会一条记录落两遍。零宽空格是最小侵入的标记:
 * 人眼看不见,`startsWith` 一行就能滤掉。
 */
export const RENDERER_LOG_ECHO_MARK = "\u200B";

export type LogsRoutes = {
	append: { input: AppendLogsRequest; output: AppendLogsResponse };
};

export const logsRouter = defineRouter<LogsRoutes>("logs", ["append"]);
