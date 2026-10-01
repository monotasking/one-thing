import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { JsonObject } from '@shared/json'
import { withFileMutationQueue } from './file-mutation-queue.js'

function hasErrorCode(error: Error | object | string | number | boolean | null | undefined, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

export type FileMutationOperation = 'edit' | 'write_create' | 'write_overwrite'

export interface FileMutationAuditRecord {
  id: string
  timestamp: string
  sessionId: string
  messageId: string
  toolCallId?: string
  operation: FileMutationOperation
  filePath: string
  beforeExists: boolean
  afterExists: boolean
  beforeHash: string
  afterHash: string
  beforeContent: string
  afterContent: string
  diff: string
  metadata?: JsonObject
}

export interface RecordFileMutationAuditInput {
  auditDir: string
  sessionId: string
  messageId: string
  toolCallId?: string
  operation: FileMutationOperation
  path: string
  beforeExists: boolean
  afterExists?: boolean
  beforeContent: string
  afterContent: string
  diff: string
  metadata?: JsonObject
}

export interface RecordFileMutationAuditResult {
  id: string
  path: string
  beforeHash: string
  afterHash: string
}

export interface ApplyFileMutationUndoResult {
  auditId: string
  filePath: string
  restoredExists: boolean
  beforeHash: string
  previousCurrentHash: string
}

interface CurrentFileSnapshot {
  exists: boolean
  content: string
  hash: string
}

async function readCurrentFileSnapshot(filePath: string): Promise<CurrentFileSnapshot> {
  try {
    const stats = await fs.stat(filePath)
    if (stats.isDirectory()) {
      throw new Error(`Cannot undo file mutation because target is a directory: ${filePath}`)
    }
    const content = await fs.readFile(filePath, 'utf-8')
    return { exists: true, content, hash: hashAuditContent(true, content) }
  } catch (error) {
    const caught = error instanceof Error || (error && typeof error === 'object') ? error : String(error)
    if (!hasErrorCode(caught, 'ENOENT')) throw error
    return { exists: false, content: '', hash: hashAuditContent(false, '') }
  }
}

export function hashAuditContent(exists: boolean, content: string): string {
  return crypto
    .createHash('sha256')
    .update(exists ? 'file\0' : 'missing\0')
    .update(content)
    .digest('hex')
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file'
}

function getAuditTargetPath(input: RecordFileMutationAuditInput): string {
  return input.path
}

function makeAuditId(input: RecordFileMutationAuditInput): string {
  const random = crypto.randomBytes(6).toString('hex')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const call = safeFilePart(input.toolCallId || input.messageId || input.sessionId)
  return `${timestamp}_${call}_${random}`
}

/**
 * Persist an undo/audit snapshot for a successful file mutation.
 *
 * The record intentionally stores both before and after content. This is not a
 * public UX yet, but gives us enough data to build rollback and audit UI later.
 */
export async function recordFileMutationAudit(
  input: RecordFileMutationAuditInput,
): Promise<RecordFileMutationAuditResult> {
  const id = makeAuditId(input)
  const dateDir = new Date().toISOString().slice(0, 10)
  const dir = path.join(input.auditDir, dateDir)
  await fs.mkdir(dir, { recursive: true })

  const recordPath = path.join(dir, `${id}.json`)
  const beforeHash = hashAuditContent(input.beforeExists, input.beforeContent)
  const afterExists = input.afterExists ?? true
  const afterHash = hashAuditContent(afterExists, input.afterContent)

  const targetPath = getAuditTargetPath(input)
  const record: FileMutationAuditRecord = {
    id,
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    operation: input.operation,
    filePath: targetPath,
    beforeExists: input.beforeExists,
    afterExists,
    beforeHash,
    afterHash,
    beforeContent: input.beforeContent,
    afterContent: input.afterContent,
    diff: input.diff,
    metadata: input.metadata,
  }

  const tmpPath = `${recordPath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf-8')
  await fs.rename(tmpPath, recordPath)

  return {
    id,
    path: recordPath,
    beforeHash,
    afterHash,
  }
}

export async function readFileMutationAudit(recordPath: string): Promise<FileMutationAuditRecord> {
  const raw = await fs.readFile(recordPath, 'utf-8')
  return JSON.parse(raw) as FileMutationAuditRecord
}

/**
 * Undo a previously recorded file mutation.
 *
 * The undo is deliberately conservative: it only applies when the current file
 * state still matches the audit record's afterHash. If the file changed after
 * the recorded mutation, callers must ask the user/model to re-read and decide.
 */
export async function applyFileMutationUndo(recordPath: string): Promise<ApplyFileMutationUndoResult> {
  const record = await readFileMutationAudit(recordPath)

  return await withFileMutationQueue(record.filePath, async () => {
    const current = await readCurrentFileSnapshot(record.filePath)
    if (current.hash !== record.afterHash) {
      throw new Error(
        `Cannot undo mutation ${record.id}: ${record.filePath} has changed since the recorded mutation. ` +
        `Expected current hash ${record.afterHash}, found ${current.hash}.`,
      )
    }

    if (record.beforeExists) {
      await fs.mkdir(path.dirname(record.filePath), { recursive: true })
      await fs.writeFile(record.filePath, record.beforeContent, 'utf-8')
    } else if (current.exists) {
      await fs.rm(record.filePath, { force: true })
    }

    return {
      auditId: record.id,
      filePath: record.filePath,
      restoredExists: record.beforeExists,
      beforeHash: record.beforeHash,
      previousCurrentHash: current.hash,
    }
  })
}
