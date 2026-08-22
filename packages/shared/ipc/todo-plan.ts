import { defineRouter } from './router.js'

export type TodoPlanScope = 'user-note' | 'session-ai-todo'

export type TodoPlanActivationMode = 'preserve-current-app' | 'focus-if-app-active'

export type TodoPlanAutonomyMode = 'off' | 'conservative' | 'active' | 'aggressive'

export interface TodoPlanWindowActionRequest {
  activation?: TodoPlanActivationMode
  preserveMainWindowVisibility?: boolean
}

/**
 * 手动拖窗的三个时刻。`start` 只是让主进程把**拖起那一刻的窗位**记下来;之后每帧
 * 的 `move` 都带**从拖起点算起的累计位移**(不是帧间增量)—— 累计量对丢帧免疫,
 * 也不会像帧间增量那样把舍入误差一路攒成漂移。
 */
export type TodoPlanWindowDragPhase = 'start' | 'move' | 'end'

export interface TodoPlanWindowDragRequest {
  phase: TodoPlanWindowDragPhase
  /** 相对拖起点的累计位移(CSS/屏幕像素)。`start` / `end` 不带。 */
  dx?: number
  dy?: number
}

export interface TodoPlanDocument {
  id: string
  scope: TodoPlanScope
  title: string
  role: 'user' | 'assistant' | 'plan'
  filePath: string
  content: string
  updatedAt: number
  totalTasks: number
}

export interface TodoPlanContext {
  sessionId?: string
}

export interface TodoPlanSnapshot {
  directory: string
  userNotes: TodoPlanDocument[]
  sessionAiTodo?: TodoPlanDocument
  /** The session this snapshot was read for, after the host resolved it. */
  sessionId?: string
}

export interface TodoPlanSettings {
  enabled?: boolean
  directory?: string
  cardHeight?: number
  pinned?: boolean
  docked?: boolean
  autonomy?: TodoPlanAutonomyMode
}

export interface TodoPlanGetRequest extends TodoPlanContext {}

export interface TodoPlanGetResponse {
  success: boolean
  snapshot?: TodoPlanSnapshot
  error?: string
}

export interface TodoPlanCreateRequest {
  title: string
  content?: string
}

export interface TodoPlanCreateResponse {
  success: boolean
  document?: TodoPlanDocument
  error?: string
}

export interface TodoPlanUpdateRequest extends TodoPlanContext {
  scope: TodoPlanScope
  id?: string
  content: string
}

export interface TodoPlanUpdateResponse {
  success: boolean
  document?: TodoPlanDocument
  error?: string
}

export interface TodoPlanRenameRequest {
  id: string
  title: string
}

export interface TodoPlanRenameResponse {
  success: boolean
  document?: TodoPlanDocument
  error?: string
}

export interface TodoPlanDeleteRequest {
  id: string
}

export interface TodoPlanDeleteResponse {
  success: boolean
  error?: string
}

export interface TodoPlanChangedPayload extends TodoPlanContext {
  scope: TodoPlanScope | 'global-user' | 'all'
  document?: TodoPlanDocument
}

export interface TodoPlanRevealDirectoryResponse {
  success: boolean
  error?: string
}

/**
 * Todo / plan 域（主线 T1 第一批）——**部分迁移**，这是刻意的。
 *
 * 数据面（读快照、增删改重命名、在文件管理器里显示目录）是纯请求/响应，走这里；
 * 窗口面（open / hide / toggle / setPinned）与 `todo-plan:changed` 推送是宿主原生的
 * （BrowserWindow / webContents.send），继续留在 `@main`。分界线就一条：**碰窗口的
 * 不迁，碰数据的迁。**
 *
 * `revealDirectory` 看着像宿主原生，其实不是：它早已经过
 * `configureTodoPlanHost({ revealDirectory })` 端口注入，未注入的宿主（server / CLI）
 * 自然降级成 no-op。所以它可以安全地走通用通道。
 */
export type TodoPlanRoutes = {
  get: { input: TodoPlanGetRequest; output: TodoPlanGetResponse }
  create: { input: TodoPlanCreateRequest; output: TodoPlanCreateResponse }
  update: { input: TodoPlanUpdateRequest; output: TodoPlanUpdateResponse }
  rename: { input: TodoPlanRenameRequest; output: TodoPlanRenameResponse }
  delete: { input: TodoPlanDeleteRequest; output: TodoPlanDeleteResponse }
  revealDirectory: {
    input: Record<string, never>
    output: TodoPlanRevealDirectoryResponse
  }
}

export const todoPlanRouter = defineRouter<TodoPlanRoutes>('todo-plan', [
  'get',
  'create',
  'update',
  'rename',
  'delete',
  'revealDirectory',
])

/**
 * Todo / plan 的**窗口面**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 七条动窗口的通道从 `IPC_CHANNELS` 搬到**宿主壳路由**(`shell:invoke`):契约在
 * 这里,处理者在 `apps/electron/src/ipc/shell/todo-plan-window.ts`(宿主侧)与
 * `packages/renderer/platform/shell-web/todo-plan-window.ts`(web 侧)。它们和上面
 * 那个 `todoPlanRouter` 的分界线一字未改 —— **碰窗口的走壳路由,碰数据的走
 * `rpc:invoke`**;变的只是「碰窗口的」不再一条一条手写通道。
 *
 * `drag` 也在这张表上。它是拖拽期间每帧一条的高频通道,从前刻意留在手写通道上
 * 以避开「通用 RPC 的重封装」;A1-a 复核后仍然搬:壳路由的每次调用只多一个
 * `{domain, method, payload}` 字面量 + 一次 Map 查找 + 一次 `{ok,data}` 包装,
 * 与 IPC 的结构化克隆和一次 `setBounds` 相比不在一个量级,而「窗口系全部迁入」
 * 换来的是拖窗这条路也能从调用点 F12 走到处理者。
 */
export interface TodoPlanWindowResponse {
  success: boolean
  error?: string
}

export interface TodoPlanWindowPinnedRequest {
  pinned: boolean
}

export interface TodoPlanWindowPinnedResponse extends TodoPlanWindowResponse {
  pinned?: boolean
}

export type TodoPlanWindowRoutes = {
  open: { input: TodoPlanWindowActionRequest; output: TodoPlanWindowResponse }
  hide: { input: TodoPlanWindowActionRequest; output: TodoPlanWindowResponse }
  toggle: { input: TodoPlanWindowActionRequest; output: TodoPlanWindowResponse }
  setPinned: { input: TodoPlanWindowPinnedRequest; output: TodoPlanWindowPinnedResponse }
  minimize: { input: Record<string, never>; output: TodoPlanWindowResponse }
  zoom: { input: Record<string, never>; output: TodoPlanWindowResponse }
  drag: { input: TodoPlanWindowDragRequest; output: TodoPlanWindowResponse }
}

export const todoPlanWindowRouter = defineRouter<TodoPlanWindowRoutes>('todo-plan-window', [
  'open',
  'hide',
  'toggle',
  'setPinned',
  'minimize',
  'zoom',
  'drag',
])
