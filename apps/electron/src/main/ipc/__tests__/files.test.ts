import * as path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { getDownloadsDirectory } from '@onething/app/tools/core/sandbox.js'
import { createDefaultVariablesFile } from '@onething/runtime/variables/schema'
import { resetVariablesStoreForTests } from '@onething/runtime/variables/store-bound'
import { registerFilesHandlers } from '../files.js'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }),
    listFiles: vi.fn(),
    openPath: vi.fn(),
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
  },
  shell: {
    openPath: mocks.openPath,
  },
}))

vi.mock('@onething/app/utils/ripgrep.js', () => ({
  listFiles: mocks.listFiles,
}))

async function* files(items: string[]) {
  for (const item of items) {
    yield item
  }
}

function filesListHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.FILES_LIST)
  if (!handler) throw new Error('files:list handler was not registered')
  return handler
}

describe('files IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    resetVariablesStoreForTests().hydrateForTests({
      ...createDefaultVariablesFile(),
      user_note_dir: '',
      work_note_dir: '',
    })
    registerFilesHandlers()
  })

  it('returns note and downloads directory roots for bare @ without a workdir', async () => {
    const noteRoot = '/notes/personal'
    const downloadsRoot = getDownloadsDirectory()
    resetVariablesStoreForTests().hydrateForTests({
      ...createDefaultVariablesFile(),
      user_note_dir: noteRoot,
      work_note_dir: '',
    })
    mocks.listFiles.mockReturnValue(files([]))

    const result = await filesListHandler()({}, {
      cwd: '',
      query: '',
      limit: 50,
    })

    expect(result).toMatchObject({
      success: true,
      entries: expect.arrayContaining([
        {
          path: noteRoot,
          type: 'directory',
          source: 'note',
          label: 'Personal notes',
        },
        {
          path: downloadsRoot,
          type: 'directory',
          source: 'downloads',
          label: 'Downloads',
        },
      ]),
    })
  })

  it('searches files inside Downloads with a normal @ query and no workdir', async () => {
    const downloadsRoot = getDownloadsDirectory()
    const receiptPath = path.join(downloadsRoot, 'receipt.pdf')
    mocks.listFiles.mockImplementation(({ cwd }: { cwd: string }) => {
      if (cwd === downloadsRoot) return files(['receipt.pdf'])
      return files([])
    })

    const result = await filesListHandler()({}, {
      cwd: '',
      query: 'receipt',
      limit: 50,
    })

    expect(mocks.listFiles).toHaveBeenCalledWith({
      cwd: downloadsRoot,
      hidden: false,
      noIgnore: true,
    })
    expect(result).toMatchObject({
      success: true,
      files: [receiptPath],
      entries: [{
        path: receiptPath,
        type: 'file',
        source: 'downloads',
      }],
    })
  })
})
