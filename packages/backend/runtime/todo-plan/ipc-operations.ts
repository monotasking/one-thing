import type {
  TodoPlanContext,
  TodoPlanDocument,
  TodoPlanSnapshot,
  TodoPlanUpdateRequest,
} from './store.js'

export interface TodoPlanCreateRequest {
  title: string
  content?: string
}

export interface TodoPlanRenameRequest {
  id: string
  title: string
}

export interface TodoPlanDeleteRequest {
  id: string
}

export interface TodoPlanWindowActionRequest {
  activation?: string
  preserveMainWindowVisibility?: boolean
}

export type OnethingTodoPlanIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

type MaybePromise<T> = T | Promise<T>

export async function getOnethingTodoPlanForIpc(
  options: {
    request?: TodoPlanContext
    readSnapshot(context: TodoPlanContext): MaybePromise<TodoPlanSnapshot>
  },
): Promise<OnethingTodoPlanIpcResult<{ snapshot: TodoPlanSnapshot }>> {
  try {
    return { success: true, snapshot: await options.readSnapshot(options.request || {}) }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to read todo/plan files')
  }
}

export async function createOnethingTodoNoteForIpc(
  options: {
    request: TodoPlanCreateRequest
    createUserNote(title: string, content?: string): MaybePromise<TodoPlanDocument>
  },
): Promise<OnethingTodoPlanIpcResult<{ document: TodoPlanDocument }>> {
  try {
    return {
      success: true,
      document: await options.createUserNote(options.request.title, options.request.content),
    }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to create todo note')
  }
}

export async function updateOnethingTodoPlanDocumentForIpc(
  options: {
    request: TodoPlanUpdateRequest
    updateDocument(request: TodoPlanUpdateRequest): MaybePromise<TodoPlanDocument>
  },
): Promise<OnethingTodoPlanIpcResult<{ document: TodoPlanDocument }>> {
  try {
    return { success: true, document: await options.updateDocument(options.request) }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to update todo/plan file')
  }
}

export async function renameOnethingTodoNoteForIpc(
  options: {
    request: TodoPlanRenameRequest
    renameUserNote(id: string, title: string): MaybePromise<TodoPlanDocument>
  },
): Promise<OnethingTodoPlanIpcResult<{ document: TodoPlanDocument }>> {
  try {
    return {
      success: true,
      document: await options.renameUserNote(options.request.id, options.request.title),
    }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to rename todo note')
  }
}

export async function deleteOnethingTodoNoteForIpc(
  options: {
    request: TodoPlanDeleteRequest
    deleteUserNote(id: string): MaybePromise<void>
  },
): Promise<OnethingTodoPlanIpcResult> {
  try {
    await options.deleteUserNote(options.request.id)
    return { success: true }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to delete todo note')
  }
}

export async function revealOnethingTodoPlanDirectoryForIpc(
  options: {
    revealDirectory(): MaybePromise<void>
  },
): Promise<OnethingTodoPlanIpcResult> {
  try {
    await options.revealDirectory()
    return { success: true }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to open todo/plan directory')
  }
}

export function runOnethingTodoPlanWindowActionForIpc<TRequest = TodoPlanWindowActionRequest | undefined>(
  options: {
    request?: TRequest
    action(request?: TRequest): unknown
  },
): OnethingTodoPlanIpcResult {
  try {
    options.action(options.request)
    return { success: true }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to update todo/plan window')
  }
}

export function setOnethingTodoPlanWindowPinnedForIpc(
  options: {
    pinned: boolean
    setPinned(pinned: boolean): boolean
  },
): OnethingTodoPlanIpcResult<{ pinned: boolean }> {
  try {
    return { success: true, pinned: options.setPinned(options.pinned) }
  } catch (error) {
    return todoPlanIpcError(error, 'Failed to update todo/plan window')
  }
}

function todoPlanIpcError(error: unknown, fallback: string): { success: false; error: string } {
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
