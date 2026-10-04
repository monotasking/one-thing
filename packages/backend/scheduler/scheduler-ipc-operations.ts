type MaybePromise<T> = T | Promise<T>

export interface OnethingSchedulerIpcLogger {
  error?: (...args: unknown[]) => void
}

type SchedulerIpcOptions<TOptions> = TOptions & {
  logger?: OnethingSchedulerIpcLogger
}

export type OnethingSchedulerRunReason = 'startup' | 'scheduled' | 'manual'

export interface OnethingSchedulerRunOptions {
  reason?: OnethingSchedulerRunReason
  force?: boolean
}

export interface OnethingSchedulerRunRecordLike {
  runId?: string
  taskId: string
  result?: unknown
}

export interface OnethingSchedulerTaskStatusLike<
  TRunRecord extends OnethingSchedulerRunRecordLike = OnethingSchedulerRunRecordLike,
> {
  id: string
  recentRuns?: TRunRecord[]
}

export interface ListOnethingSchedulerTasksOptions<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> {
  listTasks(): MaybePromise<TTask[]>
}

export interface ListOnethingSchedulerTasksResult<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> {
  success: true
  tasks: TTask[]
}

export async function listOnethingSchedulerTasks<TTask extends OnethingSchedulerTaskStatusLike>(
  options: ListOnethingSchedulerTasksOptions<TTask>,
): Promise<ListOnethingSchedulerTasksResult<TTask>> {
  return {
    success: true,
    tasks: await options.listTasks(),
  }
}

export async function listOnethingSchedulerTasksForIpc<TTask extends OnethingSchedulerTaskStatusLike>(
  options: SchedulerIpcOptions<ListOnethingSchedulerTasksOptions<TTask>>,
): Promise<ListOnethingSchedulerTasksResult<TTask> | { success: false; error: string }> {
  try {
    return await listOnethingSchedulerTasks(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'list', error)
  }
}

export interface GetOnethingSchedulerTaskOptions<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> {
  id: string
  getTaskStatus(id: string): MaybePromise<TTask | undefined>
}

export type GetOnethingSchedulerTaskResult<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> =
  | { success: true; task: TTask }
  | { success: false; error: string }

export async function getOnethingSchedulerTask<TTask extends OnethingSchedulerTaskStatusLike>(
  options: GetOnethingSchedulerTaskOptions<TTask>,
): Promise<GetOnethingSchedulerTaskResult<TTask>> {
  const task = await options.getTaskStatus(options.id)
  if (!task) return { success: false, error: `Scheduled task not found: ${options.id}` }
  return { success: true, task }
}

export async function getOnethingSchedulerTaskForIpc<TTask extends OnethingSchedulerTaskStatusLike>(
  options: SchedulerIpcOptions<GetOnethingSchedulerTaskOptions<TTask>>,
): Promise<GetOnethingSchedulerTaskResult<TTask>> {
  try {
    return await getOnethingSchedulerTask(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'get', error)
  }
}

export interface RunOnethingSchedulerTaskNowOptions<
  TRecord extends OnethingSchedulerRunRecordLike = OnethingSchedulerRunRecordLike,
  TDetail = unknown,
> {
  id: string
  force?: boolean
  runNow(id: string, options: OnethingSchedulerRunOptions): MaybePromise<TRecord>
  isUserTask(id: string): boolean
  toRunDetail(record: TRecord): TDetail
  saveRunDetail(detail: TDetail): MaybePromise<TDetail>
}

export interface RunOnethingSchedulerTaskNowResult<TRecord extends OnethingSchedulerRunRecordLike = OnethingSchedulerRunRecordLike> {
  success: true
  record: TRecord
}

export async function runOnethingSchedulerTaskNow<TRecord extends OnethingSchedulerRunRecordLike, TDetail>(
  options: RunOnethingSchedulerTaskNowOptions<TRecord, TDetail>,
): Promise<RunOnethingSchedulerTaskNowResult<TRecord>> {
  const record = await options.runNow(options.id, {
    reason: 'manual',
    force: options.force ?? true,
  })

  if (!options.isUserTask(options.id)) {
    await options.saveRunDetail(options.toRunDetail(record))
  }

  return { success: true, record }
}

export async function runOnethingSchedulerTaskNowForIpc<
  TRecord extends OnethingSchedulerRunRecordLike,
  TDetail,
>(
  options: SchedulerIpcOptions<RunOnethingSchedulerTaskNowOptions<TRecord, TDetail>>,
): Promise<RunOnethingSchedulerTaskNowResult<TRecord> | { success: false; error: string }> {
  try {
    return await runOnethingSchedulerTaskNow(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'run-now', error)
  }
}

export interface SetOnethingSchedulerTaskEnabledOptions<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> {
  id: string
  enabled: boolean
  isUserTask(id: string): boolean
  setUserTaskEnabled(id: string, enabled: boolean): MaybePromise<TTask | undefined>
  setSchedulerTaskEnabled(id: string, enabled: boolean): MaybePromise<TTask | undefined>
}

export type SetOnethingSchedulerTaskEnabledResult<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> =
  | { success: true; task: TTask }
  | { success: false; error: string }

export async function setOnethingSchedulerTaskEnabled<TTask extends OnethingSchedulerTaskStatusLike>(
  options: SetOnethingSchedulerTaskEnabledOptions<TTask>,
): Promise<SetOnethingSchedulerTaskEnabledResult<TTask>> {
  const task = options.isUserTask(options.id)
    ? await options.setUserTaskEnabled(options.id, options.enabled)
    : await options.setSchedulerTaskEnabled(options.id, options.enabled)
  if (!task) return { success: false, error: `Scheduled task not found: ${options.id}` }
  return { success: true, task }
}

export async function setOnethingSchedulerTaskEnabledForIpc<TTask extends OnethingSchedulerTaskStatusLike>(
  options: SchedulerIpcOptions<SetOnethingSchedulerTaskEnabledOptions<TTask>>,
): Promise<SetOnethingSchedulerTaskEnabledResult<TTask>> {
  try {
    return await setOnethingSchedulerTaskEnabled(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'set-enabled', error)
  }
}

export interface CreateOnethingUserSchedulerTaskOptions<TRequest, TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> {
  request: TRequest
  createUserTask(request: TRequest): MaybePromise<TTask>
}

export interface CreateOnethingUserSchedulerTaskResult<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> {
  success: true
  task: TTask
}

export async function createOnethingUserSchedulerTask<TRequest, TTask extends OnethingSchedulerTaskStatusLike>(
  options: CreateOnethingUserSchedulerTaskOptions<TRequest, TTask>,
): Promise<CreateOnethingUserSchedulerTaskResult<TTask>> {
  return {
    success: true,
    task: await options.createUserTask(options.request),
  }
}

export async function createOnethingUserSchedulerTaskForIpc<
  TRequest,
  TTask extends OnethingSchedulerTaskStatusLike,
>(
  options: SchedulerIpcOptions<CreateOnethingUserSchedulerTaskOptions<TRequest, TTask>>,
): Promise<CreateOnethingUserSchedulerTaskResult<TTask> | { success: false; error: string }> {
  try {
    return await createOnethingUserSchedulerTask(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'create-task', error)
  }
}

export interface UpdateOnethingUserSchedulerTaskOptions<TRequest extends { id: string }, TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> {
  request: TRequest
  isUserTask(id: string): boolean
  updateUserTask(request: TRequest): MaybePromise<TTask>
}

export type UpdateOnethingUserSchedulerTaskResult<TTask extends OnethingSchedulerTaskStatusLike = OnethingSchedulerTaskStatusLike> =
  | { success: true; task: TTask }
  | { success: false; error: string }

export async function updateOnethingUserSchedulerTask<TRequest extends { id: string }, TTask extends OnethingSchedulerTaskStatusLike>(
  options: UpdateOnethingUserSchedulerTaskOptions<TRequest, TTask>,
): Promise<UpdateOnethingUserSchedulerTaskResult<TTask>> {
  if (!options.isUserTask(options.request.id)) {
    return { success: false, error: 'Plugin scheduled tasks cannot be edited.' }
  }
  return {
    success: true,
    task: await options.updateUserTask(options.request),
  }
}

export async function updateOnethingUserSchedulerTaskForIpc<
  TRequest extends { id: string },
  TTask extends OnethingSchedulerTaskStatusLike,
>(
  options: SchedulerIpcOptions<UpdateOnethingUserSchedulerTaskOptions<TRequest, TTask>>,
): Promise<UpdateOnethingUserSchedulerTaskResult<TTask>> {
  try {
    return await updateOnethingUserSchedulerTask(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'update-task', error)
  }
}

export interface DeleteOnethingUserSchedulerTaskOptions {
  id: string
  isUserTask(id: string): boolean
  deleteUserTask(id: string): MaybePromise<void>
}

export type DeleteOnethingUserSchedulerTaskResult =
  | { success: true }
  | { success: false; error: string }

export async function deleteOnethingUserSchedulerTask(
  options: DeleteOnethingUserSchedulerTaskOptions,
): Promise<DeleteOnethingUserSchedulerTaskResult> {
  if (!options.isUserTask(options.id)) {
    return { success: false, error: 'Plugin scheduled tasks cannot be deleted.' }
  }
  await options.deleteUserTask(options.id)
  return { success: true }
}

export async function deleteOnethingUserSchedulerTaskForIpc(
  options: SchedulerIpcOptions<DeleteOnethingUserSchedulerTaskOptions>,
): Promise<DeleteOnethingUserSchedulerTaskResult> {
  try {
    return await deleteOnethingUserSchedulerTask(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'delete-task', error)
  }
}

export interface ListOnethingSchedulerRunsOptions<
  TRecord extends OnethingSchedulerRunRecordLike = OnethingSchedulerRunRecordLike,
  TTask extends OnethingSchedulerTaskStatusLike<TRecord> = OnethingSchedulerTaskStatusLike<TRecord>,
  TDetail = unknown,
> {
  taskId: string
  limit?: number
  maxRecentRuns?: number
  listSavedRuns(taskId: string, limit?: number): MaybePromise<TDetail[]>
  getTaskStatus(taskId: string): MaybePromise<TTask | undefined>
  toRunDetail(record: TRecord): TDetail
}

export interface ListOnethingSchedulerRunsResult<TDetail = unknown> {
  success: true
  runs: TDetail[]
}

function clampRecentRunLimit(limit: number | undefined, maxRecentRuns: number): number {
  return Math.max(1, Math.min(maxRecentRuns, Math.floor(limit || maxRecentRuns)))
}

export async function listOnethingSchedulerRuns<
  TRecord extends OnethingSchedulerRunRecordLike,
  TTask extends OnethingSchedulerTaskStatusLike<TRecord>,
  TDetail,
>(
  options: ListOnethingSchedulerRunsOptions<TRecord, TTask, TDetail>,
): Promise<ListOnethingSchedulerRunsResult<TDetail>> {
  const savedRuns = await options.listSavedRuns(options.taskId, options.limit)
  if (savedRuns.length > 0) {
    return { success: true, runs: savedRuns }
  }

  const task = await options.getTaskStatus(options.taskId)
  const limit = clampRecentRunLimit(options.limit, options.maxRecentRuns ?? 50)
  const runs = (task?.recentRuns || [])
    .slice(0, limit)
    .map(record => options.toRunDetail(record))
  return { success: true, runs }
}

export async function listOnethingSchedulerRunsForIpc<
  TRecord extends OnethingSchedulerRunRecordLike,
  TTask extends OnethingSchedulerTaskStatusLike<TRecord>,
  TDetail,
>(
  options: SchedulerIpcOptions<ListOnethingSchedulerRunsOptions<TRecord, TTask, TDetail>>,
): Promise<ListOnethingSchedulerRunsResult<TDetail> | { success: false; error: string }> {
  try {
    return await listOnethingSchedulerRuns(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'list-runs', error)
  }
}

export interface GetOnethingSchedulerRunOptions<
  TRecord extends OnethingSchedulerRunRecordLike = OnethingSchedulerRunRecordLike,
  TTask extends OnethingSchedulerTaskStatusLike<TRecord> = OnethingSchedulerTaskStatusLike<TRecord>,
  TDetail extends { runId?: string } = { runId?: string },
> {
  taskId: string
  runId: string
  getSavedRun(taskId: string, runId: string): MaybePromise<TDetail | undefined>
  getTaskStatus(taskId: string): MaybePromise<TTask | undefined>
  toRunDetail(record: TRecord): TDetail
}

export type GetOnethingSchedulerRunResult<TDetail = unknown> =
  | { success: true; run: TDetail }
  | { success: false; error: string }

export async function getOnethingSchedulerRun<
  TRecord extends OnethingSchedulerRunRecordLike,
  TTask extends OnethingSchedulerTaskStatusLike<TRecord>,
  TDetail extends { runId?: string },
>(
  options: GetOnethingSchedulerRunOptions<TRecord, TTask, TDetail>,
): Promise<GetOnethingSchedulerRunResult<TDetail>> {
  const saved = await options.getSavedRun(options.taskId, options.runId)
  if (saved) return { success: true, run: saved }

  const task = await options.getTaskStatus(options.taskId)
  const recent = task?.recentRuns?.find(record => record.runId === options.runId)
  if (!recent) return { success: false, error: `Scheduled run not found: ${options.runId}` }
  return { success: true, run: options.toRunDetail(recent) }
}

export async function getOnethingSchedulerRunForIpc<
  TRecord extends OnethingSchedulerRunRecordLike,
  TTask extends OnethingSchedulerTaskStatusLike<TRecord>,
  TDetail extends { runId?: string },
>(
  options: SchedulerIpcOptions<GetOnethingSchedulerRunOptions<TRecord, TTask, TDetail>>,
): Promise<GetOnethingSchedulerRunResult<TDetail>> {
  try {
    return await getOnethingSchedulerRun(options)
  } catch (error) {
    return schedulerIpcError(options.logger, 'get-run', error)
  }
}

function schedulerIpcError(
  logger: OnethingSchedulerIpcLogger | undefined,
  label: string,
  error: unknown,
): { success: false; error: string } {
  logger?.error?.(`[SchedulerIPC] ${label} error:`, error)
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }
}
