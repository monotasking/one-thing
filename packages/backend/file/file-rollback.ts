type MaybePromise<T> = T | Promise<T>

export interface OnethingFileRollbackRequest {
  auditPath?: string
  filePath?: string
  originalContent?: string
  isNew?: boolean
}

export interface OnethingFileRollbackResponse {
  success: boolean
  error?: string
  auditId?: string
  filePath?: string
  restoredExists?: boolean
}

export interface OnethingFileAuditUndoResult {
  auditId: string
  filePath: string
  restoredExists: boolean
}

export interface RollbackOnethingFileOptions extends OnethingFileRollbackRequest {
  applyAuditUndo(auditPath: string): MaybePromise<OnethingFileAuditUndoResult>
  deleteFile(filePath: string): MaybePromise<void>
  writeFile(filePath: string, content: string): MaybePromise<void>
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export async function rollbackOnethingFile(
  options: RollbackOnethingFileOptions,
): Promise<OnethingFileRollbackResponse> {
  try {
    if (options.auditPath) {
      const result = await options.applyAuditUndo(options.auditPath)
      return {
        success: true,
        auditId: result.auditId,
        filePath: result.filePath,
        restoredExists: result.restoredExists,
      }
    }

    if (!options.filePath) {
      return { success: false, error: 'File path or audit path is required' }
    }

    if (options.isNew) {
      await options.deleteFile(options.filePath)
    } else {
      await options.writeFile(options.filePath, options.originalContent ?? '')
    }

    return {
      success: true,
      filePath: options.filePath,
      restoredExists: !options.isNew,
    }
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error, 'Failed to rollback file'),
    }
  }
}
