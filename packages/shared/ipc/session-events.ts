import type {
  SessionEventRecord,
  SessionToolCallInspection,
} from "@onething/runtime/sessions/session-events";
import type { SessionLogEventRecord } from "@onething/core/session/events";
import type {
  SessionTrace,
  SessionTraceCompaction,
  SessionTraceRequest,
  SessionTraceRequestError,
  SessionTraceResponsePart,
  SessionTraceResponseText,
  SessionTraceRun,
  SessionTraceToolAudit,
  SessionTraceToolCall,
  SessionTracePermission,
} from "@onething/core/session";
import { defineRouter } from "./router.js";

/**
 * 类型从产品层原样再导出(与 `usage.ts` 同一手法)。
 *
 * 全部是 `export type` —— 编译期擦除,所以 renderer 引这个模块不会把
 * `sessions/session-events.ts`(它 import 了 `node:crypto`)拽进浏览器包。
 */
export type {
  SessionAssistantFirstTokenEvent,
  SessionEventRecord,
  SessionEventToolSchema,
  SessionEventType,
  SessionRequestEndEvent,
  SessionRequestEndUsage,
  SessionRequestHeaderEvent,
  SessionRequestStartEvent,
  SessionRequestToolsEvent,
  SessionRequestToolsEventData,
  SessionToolCallEvent,
  SessionToolCallInspection,
  SessionToolResultEvent,
} from "@onething/runtime/sessions/session-events";

/**
 * 轨迹树的形状住在 core(`packages/core/session/trace/`),这里同样只是
 * `export type` 的再导出 —— core 是零依赖的,但走同一条纪律让契约面保持
 * 「一个形状一个出处」。
 */
export type {
  SessionLogEventRecord,
  SessionTrace,
  SessionTraceCompaction,
  SessionTracePermission,
  SessionTraceRequest,
  SessionTraceRequestError,
  SessionTraceResponsePart,
  SessionTraceResponseText,
  SessionTraceRun,
  SessionTraceToolAudit,
  SessionTraceToolCall,
};

export interface ListSessionEventsRequest {
  sessionId: string;
}

export interface ListSessionEventsResponse {
  /** 按 seq 升序。会话没有事件日志时是空数组 —— 那不是错误。 */
  events: SessionEventRecord[];
}

export interface ListRawSessionEventsRequest {
  sessionId: string;
}

export interface ListRawSessionEventsResponse {
  /**
   * **全集原词汇**,按 seq 升序;没有日志时是空数组。
   *
   * 与 `list` 的区别是词汇不是范围:`list` 交付的是**老七类**(轨迹面板的词汇,
   * `parseSessionEventLog` 在出口按 `SESSION_EVENT_TYPES` 再筛一道),这里交付的是
   * 账本上真正写着的每一条(`session/created` / `user/message` / `run/*` /
   * `assistant/*` / `message/patched` / … )。**投影消费者必须走这一条** ——
   * 折叠器要的开张事件全在老七类之外,喂 `list` 折出来的是空树。
   */
  events: SessionLogEventRecord[];
}

export interface InspectSessionToolCallRequest {
  sessionId: string;
  callId: string;
}

export interface InspectSessionToolCallResponse {
  /** 没有这一笔账就是 `null`。绝不回填、绝不用今天的 schema 冒充当时那份。 */
  inspection: SessionToolCallInspection | null;
}

export interface GetSessionTraceRequest {
  sessionId: string;
  /** 只要这一组(`SessionTraceRun.key`,真 runId 也认)。 */
  run?: string;
  /** 只要最后 N 组;`true` = 1。与 `run` 同时给时 `run` 优先。 */
  last?: number | boolean;
}

export interface GetSessionTraceResponse {
  /** 会话不存在 / id 不合法时是 `null`;没有事件是一棵空树,不是 `null`。 */
  trace: SessionTrace | null;
}

export interface GetSessionTraceResponseTextRequest {
  sessionId: string;
  /** run 的地址(真 runId;合成组没有正文,折出来必然是空)。 */
  run: string;
  /** 缺席 = 整个 run 的正文。 */
  request?: number;
}

export interface GetSessionTraceResponseTextResponse {
  /** 正文是**按需**折出来的:轨迹树上永远没有它(S3 纪律 2)。 */
  response: SessionTraceResponseText | null;
}

/**
 * 会话事件日志的读取域(主线 E1 —— 轨迹面板的唯一数据来源)。
 *
 * 只读:事件日志的写入口在 agent-loop 的采集器上,这条通道**没有**写方法。
 * 加这个域没有动任何一个壳文件:router 定义 + handler 文件 + `app/rpc/index.ts`
 * 一行,desktop 走 `rpc:invoke`、web 走 `POST /api/rpc`,两边都是既有的通用适配器。
 */
export type SessionEventsRoutes = {
  list: { input: ListSessionEventsRequest; output: ListSessionEventsResponse };
  /**
   * 全集原词汇。`list` 是轨迹面板的老七类词汇,两者**语义不同不是范围不同**,
   * 所以是独立方法而不是 `list` 的一个开关。
   */
  listRaw: {
    input: ListRawSessionEventsRequest;
    output: ListRawSessionEventsResponse;
  };
  inspectCall: {
    input: InspectSessionToolCallRequest;
    output: InspectSessionToolCallResponse;
  };
  /** S3 查询面:同一份日志装配成 run → request → toolCall 的树。 */
  getTrace: {
    input: GetSessionTraceRequest;
    output: GetSessionTraceResponse;
  };
  /** S3 查询面:一次请求的响应正文(`assistant/chunks` 的 fold)。 */
  getResponseText: {
    input: GetSessionTraceResponseTextRequest;
    output: GetSessionTraceResponseTextResponse;
  };
};

export const sessionEventsRouter = defineRouter<SessionEventsRoutes>(
  "sessionEvents",
  ["list", "listRaw", "inspectCall", "getTrace", "getResponseText"],
);
