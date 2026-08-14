/**
 * Files IPC Handlers
 * Provides file listing functionality for @ file search in chat input
 * and file rollback functionality for /files command
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import { registerElectronFilesIpcHandlers } from '@onething/electron-host/ipc/files'
import { revealElectronPath } from '@onething/electron-host/shell/operations'
import {
  createOnethingDirectory,
  createOnethingFile,
  deleteOnethingPath,
  listOnethingDirectoriesForCompletionForIpc,
  listOnethingDirectory,
  listOnethingFileSearchEntriesForIpc,
  readOnethingFileContent,
  renameOnethingPath,
  revealOnethingPath,
  rollbackOnethingFile,
  saveOnethingFileContent,
  startOnethingFileWatchForIpc,
  statOnethingPath,
  stopOnethingFileWatchForIpc,
  type OnethingFileSearchEntry,
  type OnethingFileSearchEntrySource,
  type OnethingFileSearchEntryType,
  type OnethingFileReadRequest,
  type OnethingFileReadResponse,
  type OnethingFileSaveRequest,
  type OnethingFileSaveResponse,
  type OnethingDirectoryEntry,
  type OnethingFileStatResponse,
  type OnethingListDirectoryResponse,
  type OnethingListDirsRequest,
  type OnethingListDirsResponse,
  type OnethingListFilesRequest,
  type OnethingListFilesResponse,
  type OnethingFileRollbackRequest,
  type OnethingFileRollbackResponse,
} from '@onething/runtime/files'
import { applyFileMutationUndo } from '@onething/runtime/tools'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { listFiles } from '@onething/app/utils/ripgrep.js'
import { getVariablesStore } from '@onething/app/variables/store/index.js'
import { getConnectedDirectoriesForSession } from '@onething/app/stores/connected-directories.js'
import { getDownloadsDirectory } from '@onething/app/tools/core/sandbox.js'

export interface ListFilesRequest extends OnethingListFilesRequest {}
export type FileSearchEntryType = OnethingFileSearchEntryType
export type FileSearchEntrySource = OnethingFileSearchEntrySource
export interface FileSearchEntry extends OnethingFileSearchEntry {}
export interface ListFilesResponse extends OnethingListFilesResponse {}

// Types for file rollback
export interface RollbackRequest extends OnethingFileRollbackRequest {}
export interface RollbackResponse extends OnethingFileRollbackResponse {}

// Types for directory listing (for /cd path completion)
export interface ListDirsRequest extends OnethingListDirsRequest {}

// Types for file content reading (for file preview)
export interface FileReadRequest extends OnethingFileReadRequest {}
export interface FileReadResponse extends OnethingFileReadResponse {}
export interface FileSaveRequest extends OnethingFileSaveRequest {}
export interface FileSaveResponse extends OnethingFileSaveResponse {}
export interface DirectoryEntry extends OnethingDirectoryEntry {}
export interface ListDirectoryResponse extends OnethingListDirectoryResponse {}
export interface FileStatResponse extends OnethingFileStatResponse {}

export interface ListDirsResponse extends OnethingListDirsResponse {}

/**
 * Register file-related IPC handlers
 */
export function registerFilesHandlers() {
  registerElectronFilesIpcHandlers({
    channels: {
      listFiles: IPC_CHANNELS.FILES_LIST,
      rollback: IPC_CHANNELS.FILE_ROLLBACK,
      listDirs: IPC_CHANNELS.DIRS_LIST,
      readContent: IPC_CHANNELS.FILE_READ_CONTENT,
      saveContent: IPC_CHANNELS.FILE_SAVE_CONTENT,
      listDirectory: IPC_CHANNELS.FILE_LIST_DIRECTORY,
      stat: IPC_CHANNELS.FILE_STAT,
      create: IPC_CHANNELS.FILE_CREATE,
      createDirectory: IPC_CHANNELS.FILE_CREATE_DIRECTORY,
      rename: IPC_CHANNELS.FILE_RENAME,
      delete: IPC_CHANNELS.FILE_DELETE,
      reveal: IPC_CHANNELS.FILE_REVEAL,
      watchStart: IPC_CHANNELS.FILE_WATCH_START,
      watchStop: IPC_CHANNELS.FILE_WATCH_STOP,
    },
    listFiles: async (request: unknown): Promise<ListFilesResponse> => {
      const typedRequest = request as ListFilesRequest
      return await listOnethingFileSearchEntriesForIpc({
        cwd: typedRequest.cwd,
        query: typedRequest.query,
        limit: typedRequest.limit,
        homeDir: os.homedir(),
        downloadsDir: getDownloadsDirectory(),
        getNoteRoots: () => {
          const variablesStore = getVariablesStore()
          return {
            userNoteDir: variablesStore.getUserNoteDir(),
            workNoteDir: variablesStore.getWorkNoteDir(),
          }
        },
        // per-space:按请求携带的**会话归属**取(批 B2 / 设计盲点 1)。
        getConnectedDirs: () => getConnectedDirectoriesForSession(typedRequest.sessionId),
        listFiles: root => listFiles({ cwd: root.path, hidden: false, noIgnore: true }),
        logger: console,
      })
    },
    rollback: async (request: unknown): Promise<RollbackResponse> => {
      return await rollbackOnethingFile({
        ...(request as RollbackRequest),
        applyAuditUndo: applyFileMutationUndo,
        deleteFile: filePath => fs.unlink(filePath),
        writeFile: (filePath, content) => fs.writeFile(filePath, content, 'utf-8'),
      })
    },
    listDirs: async (request: unknown): Promise<ListDirsResponse> => {
      const typedRequest = request as ListDirsRequest
      return await listOnethingDirectoriesForCompletionForIpc({
        basePath: typedRequest.basePath,
        query: typedRequest.query,
        limit: typedRequest.limit,
        homeDir: os.homedir(),
        stat: targetPath => fs.stat(targetPath).catch(() => null),
        readDir: targetPath => fs.readdir(targetPath, { withFileTypes: true }),
        logger: console,
      })
    },
    readContent: async (request: unknown): Promise<FileReadResponse> => {
      return await readOnethingFileContent({
        ...(request as FileReadRequest),
        stat: filePath => fs.stat(filePath),
        async readBytes(filePath, byteLength) {
          const fileHandle = await fs.open(filePath, 'r')
          try {
            const buf = Buffer.alloc(byteLength)
            const { bytesRead } = await fileHandle.read(buf, 0, buf.length, 0)
            return buf.subarray(0, bytesRead)
          } finally {
            await fileHandle.close()
          }
        },
      })
    },
    saveContent: async (request: unknown): Promise<FileSaveResponse> => {
      return await saveOnethingFileContent({
        ...(request as FileSaveRequest),
        stat: filePath => fs.stat(filePath),
        writeFile: (filePath, content) => fs.writeFile(filePath, content, 'utf-8'),
      })
    },
    listDirectory: async (request: unknown): Promise<ListDirectoryResponse> => {
      const typedRequest = request as { path: string }
      return await listOnethingDirectory({
        path: typedRequest.path,
        readDir: dirPath => fs.readdir(dirPath, { withFileTypes: true }),
        stat: entryPath => fs.stat(entryPath).catch(() => null),
      })
    },
    stat: async (request: unknown): Promise<FileStatResponse> => {
      const typedRequest = request as { path: string }
      return await statOnethingPath({
        path: typedRequest.path,
        stat: targetPath => fs.stat(targetPath),
      })
    },
    create: async (request: unknown): Promise<{ success: boolean; error?: string }> => {
      const typedRequest = request as { path: string; content?: string }
      return await createOnethingFile({
        path: typedRequest.path,
        content: typedRequest.content,
        createFile: (filePath, content) => fs.writeFile(filePath, content, { flag: 'wx' }),
      })
    },
    createDirectory: async (request: unknown): Promise<{ success: boolean; error?: string }> => {
      const typedRequest = request as { path: string }
      return await createOnethingDirectory({
        path: typedRequest.path,
        createDirectory: dirPath => fs.mkdir(dirPath, { recursive: false }).then(() => undefined),
      })
    },
    rename: async (request: unknown): Promise<{ success: boolean; error?: string }> => {
      const typedRequest = request as { oldPath: string; newPath: string }
      return await renameOnethingPath({
        oldPath: typedRequest.oldPath,
        newPath: typedRequest.newPath,
        renamePath: fs.rename,
      })
    },
    delete: async (request: unknown): Promise<{ success: boolean; error?: string }> => {
      const typedRequest = request as { path: string }
      return await deleteOnethingPath({
        path: typedRequest.path,
        deletePath: targetPath => fs.rm(targetPath, { recursive: true, force: false }),
      })
    },
    reveal: async (request: unknown): Promise<{ success: boolean; error?: string }> => {
      const typedRequest = request as { path: string }
      return await revealOnethingPath({
        path: typedRequest.path,
        stat: targetPath => fs.stat(targetPath),
        revealPath: targetPath => revealElectronPath(targetPath),
      })
    },
    watchStart: async (request: unknown): Promise<{ success: boolean; error?: string }> => {
      return startOnethingFileWatchForIpc(request as { root: string })
    },
    watchStop: async (request: unknown): Promise<{ success: boolean }> => {
      return stopOnethingFileWatchForIpc(request as { root: string })
    },
  })
}
