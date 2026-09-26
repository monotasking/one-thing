/**
 * 自定义服务商的适配表(批 4 §7.1,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 「自动识别」产出的是**一张数据表**,不是代码:第三方转发站的偏差集中在 openai-chat
 * 一条线上的几个点(思考字段名、usage 字段名、工具调用、`finish_reason` 取值、`[DONE]`、
 * 模型列表形状),这张表把它们逐格写下来,由 runtime 的 `dialectFromSpec` 编译成方言的
 * 策略对象 —— 线的源码不读这张表。
 *
 * 放在 `@shared/contracts`:壳(对话框「应用」写进设置)与产品层(编译器、探测)都要认它,
 * 产品层不许 import `@shared/ipc`,契约层不许依赖产品层,两边都够得着的只有这里。
 *
 * 路径是点号 + 下标的简单表达式(`choices[0].delta.reasoning_content`),不是 JSONPath。
 */
import type { JsonObject } from '../json.js'

/** 思考档位(与 `@shared/ipc/providers` 的 `ThinkingEffort` 同一套词)。 */
export type AdapterThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 声明式思考映射 —— 今天 `ReasoningProfileOverride.custom` 的那一格(那边 `import type`
 * 这里,一份形状)。`effortPath` 是请求体里写档位的路径;开 / 关各一块额外请求体。
 */
export interface CustomReasoningMapping {
  effortPath: string
  effortValues?: Partial<Record<AdapterThinkingEffort, string | number>>
  disabledValue?: string | number | boolean | null
  enabledBody?: JsonObject
  disabledBody?: JsonObject
}

export type CustomAdapterWire =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-generateContent'

export type CustomAdapterFinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter'

/**
 * 工具调用的两种已知形状:`tool_calls` = 今天的 `delta.tool_calls[]`(带 index,可并行多个);
 * `function_call` = 老格式 `delta.function_call { name, arguments }`(一轮一个、无 index)。
 */
export type CustomAdapterToolCallsStyle = 'tool_calls' | 'function_call'

export interface CustomAdapterSpec {
  version: 1
  wire: CustomAdapterWire
  request?: {
    maxTokensField?: 'max_tokens' | 'max_completion_tokens'
    streamUsage?: 'include_usage' | 'always' | 'none'
    /** 复用今天就有的声明式思考映射。 */
    reasoning?: CustomReasoningMapping
    extraBody?: JsonObject
  }
  /** 只对 openai-chat 生效(批 4 范围)。 */
  response?: {
    /** 默认 `choices[0].delta.content`。 */
    textDeltaPath?: string
    /** 默认 `choices[0].delta.reasoning_content`。 */
    reasoningDeltaPath?: string
    /** 默认 `choices[0].delta.tool_calls`。数组 = 多调用(项里有 `index` 就用),对象 = 单调用。 */
    toolCallsPath?: string
    /**
     * 工具调用是哪种形状 —— 与 `toolCallsPath` 二选一,两格都写时**这一格优先**。
     * `function_call` = 老格式 `choices[0].delta.function_call`。
     */
    toolCallsStyle?: CustomAdapterToolCallsStyle
    /** 默认 `choices[0].finish_reason`。 */
    finishReasonPath?: string
    finishReasonMap?: Record<string, CustomAdapterFinishReason>
    /** 相对 usage 对象的路径。 */
    usage?: { input?: string; output?: string; cacheRead?: string; reasoning?: string }
    /** 默认 `'[DONE]'`;`null` = 这家不发结束标记。 */
    doneMarker?: string | null
  }
  modelsList?: { itemsPath: string; idField: string; nameField?: string; contextField?: string }
  probe?: { at: number; model: string; confidence: 'high' | 'medium' | 'low'; notes: string }
}

/** openai-chat 线上各格的默认路径 —— 规则判「是不是标准形状」与编译器判「要不要换」读同一张表。 */
export const CUSTOM_ADAPTER_DEFAULT_PATHS = {
  textDeltaPath: 'choices[0].delta.content',
  reasoningDeltaPath: 'choices[0].delta.reasoning_content',
  toolCallsPath: 'choices[0].delta.tool_calls',
  finishReasonPath: 'choices[0].finish_reason',
  doneMarker: '[DONE]',
} as const

/**
 * `CustomAdapterSpec` 的 JSON Schema(手写,与上面的类型逐格对照)。「自动识别」把它嵌进
 * 给分析模型的提示词 —— 模型只许答一张符合它的 JSON。改类型必须同步改这里。
 */
export const CUSTOM_ADAPTER_SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'wire'],
  properties: {
    version: { const: 1 },
    wire: { enum: ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generateContent'] },
    request: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxTokensField: { enum: ['max_tokens', 'max_completion_tokens'] },
        streamUsage: { enum: ['include_usage', 'always', 'none'] },
        reasoning: {
          type: 'object',
          required: ['effortPath'],
          properties: {
            effortPath: { type: 'string' },
            effortValues: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
            disabledValue: { type: ['string', 'number', 'boolean', 'null'] },
            enabledBody: { type: 'object' },
            disabledBody: { type: 'object' },
          },
        },
        extraBody: { type: 'object' },
      },
    },
    response: {
      type: 'object',
      additionalProperties: false,
      properties: {
        textDeltaPath: { type: 'string' },
        reasoningDeltaPath: { type: 'string' },
        toolCallsPath: { type: 'string' },
        toolCallsStyle: { enum: ['tool_calls', 'function_call'] },
        finishReasonPath: { type: 'string' },
        finishReasonMap: {
          type: 'object',
          additionalProperties: { enum: ['stop', 'length', 'tool-calls', 'content-filter'] },
        },
        usage: {
          type: 'object',
          additionalProperties: false,
          properties: {
            input: { type: 'string' },
            output: { type: 'string' },
            cacheRead: { type: 'string' },
            reasoning: { type: 'string' },
          },
        },
        doneMarker: { type: ['string', 'null'] },
      },
    },
    modelsList: {
      type: 'object',
      additionalProperties: false,
      required: ['itemsPath', 'idField'],
      properties: {
        itemsPath: { type: 'string' },
        idField: { type: 'string' },
        nameField: { type: 'string' },
        contextField: { type: 'string' },
      },
    },
    probe: {
      type: 'object',
      properties: {
        at: { type: 'number' },
        model: { type: 'string' },
        confidence: { enum: ['high', 'medium', 'low'] },
        notes: { type: 'string' },
      },
    },
  },
} as const
