export interface OnethingFileWatchStartRequest {
  root?: string
}

export type OnethingFileWatchStartResult =
  | { success: true }
  | { success: false; error: string }

export interface OnethingFileWatchStopRequest {
  root?: string
}

export interface OnethingFileWatchStopResult {
  success: true
}

export function startOnethingFileWatchForIpc(
  request: OnethingFileWatchStartRequest,
): OnethingFileWatchStartResult {
  if (!request.root) return { success: false, error: 'Workspace root is required' }
  return { success: true }
}

export function stopOnethingFileWatchForIpc(
  _request: OnethingFileWatchStopRequest,
): OnethingFileWatchStopResult {
  return { success: true }
}
