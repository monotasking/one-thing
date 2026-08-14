/**
 * User prompt snippets IPC types.
 */
import { defineRouter } from './router.js'

export interface UserPrompt {
  id: string
  title: string
  body: string
  description?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
}

export interface PromptReferenceSnapshot {
  promptId: string
  title: string
  content: string
  description?: string
  bodyHash: string
}

export interface PromptListResponse {
  success: boolean
  prompts?: UserPrompt[]
  error?: string
}

export interface PromptGetRequest {
  id: string
}

export interface PromptGetResponse {
  success: boolean
  prompt?: UserPrompt
  error?: string
}

export interface PromptCreateRequest {
  title: string
  body: string
  description?: string
  tags?: string[]
}

export interface PromptCreateResponse {
  success: boolean
  prompt?: UserPrompt
  error?: string
}

export interface PromptUpdateRequest {
  id: string
  title?: string
  body?: string
  description?: string
  tags?: string[]
}

export interface PromptUpdateResponse {
  success: boolean
  prompt?: UserPrompt
  error?: string
}

export interface PromptDeleteRequest {
  id: string
}

export interface PromptDeleteResponse {
  success: boolean
  error?: string
}

/**
 * 用户提示词片段域（主线 T1 第一批）。
 *
 * 纯 CRUD、零流式、零事件推送、零宿主原生依赖——迁移的样板形状。旧的五条
 * `prompts:*` 通道、preload 五个暴露块、web.ts 五个 fetch 函数、http.ts 的
 * `/api/prompts*` 五条路由与 `RuntimePromptsAdapter` 的五个成员一并拔除，
 * 不留双轨。
 *
 * `list` 无入参：`RoutePayload` 是 `unknown`，`void` 会让 `RouteHandlers` 的
 * 参数变成 `void` 而调用点传不进东西，所以空入参写 `Record<string, never>`
 * ——调用方传 `{}`，语义上就是"没有参数"。
 */
export type PromptsRoutes = {
  list: { input: Record<string, never>; output: PromptListResponse }
  get: { input: PromptGetRequest; output: PromptGetResponse }
  create: { input: PromptCreateRequest; output: PromptCreateResponse }
  update: { input: PromptUpdateRequest; output: PromptUpdateResponse }
  delete: { input: PromptDeleteRequest; output: PromptDeleteResponse }
}

export const promptsRouter = defineRouter<PromptsRoutes>('prompts', [
  'list',
  'get',
  'create',
  'update',
  'delete',
])
