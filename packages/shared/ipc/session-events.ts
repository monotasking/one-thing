import type {
  SessionEventRecord,
  SessionToolCallInspection,
} from "@onething/runtime/sessions/session-events";
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

export interface ListSessionEventsRequest {
  sessionId: string;
}

export interface ListSessionEventsResponse {
  /** 按 seq 升序。会话没有事件日志时是空数组 —— 那不是错误。 */
  events: SessionEventRecord[];
}

export interface InspectSessionToolCallRequest {
  sessionId: string;
  callId: string;
}

export interface InspectSessionToolCallResponse {
  /** 没有这一笔账就是 `null`。绝不回填、绝不用今天的 schema 冒充当时那份。 */
  inspection: SessionToolCallInspection | null;
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
  inspectCall: {
    input: InspectSessionToolCallRequest;
    output: InspectSessionToolCallResponse;
  };
};

export const sessionEventsRouter = defineRouter<SessionEventsRoutes>(
  "sessionEvents",
  ["list", "inspectCall"],
);
