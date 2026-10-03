import { describe, expect, it } from 'vitest'
import {
  createOnethingTodoNoteForIpc,
  deleteOnethingTodoNoteForIpc,
  getOnethingTodoPlanForIpc,
  renameOnethingTodoNoteForIpc,
  revealOnethingTodoPlanDirectoryForIpc,
  runOnethingTodoPlanWindowActionForIpc,
  setOnethingTodoPlanWindowPinnedForIpc,
  updateOnethingTodoPlanDocumentForIpc,
} from '../ipc-operations.js'
import type { TodoPlanDocument } from '../store.js'

describe('todo-plan IPC operations', () => {
  const document: TodoPlanDocument = {
    id: 'note-1',
    scope: 'user-note',
    title: 'Note',
    role: 'user',
    filePath: '/tmp/note.md',
    content: '# Note',
    updatedAt: 1,
    totalTasks: 0,
  }

  it('formats todo-plan document operation responses', async () => {
    await expect(getOnethingTodoPlanForIpc({
      request: { sessionId: 's1' },
      readSnapshot: context => ({
        directory: '/tmp/todo',
        userNotes: [{ ...document, content: context.sessionId || '' }],
      }),
    })).resolves.toMatchObject({
      success: true,
      snapshot: { userNotes: [{ content: 's1' }] },
    })

    await expect(createOnethingTodoNoteForIpc({
      request: { title: 'Note', content: '# Note' },
      createUserNote: () => document,
    })).resolves.toEqual({ success: true, document })

    await expect(updateOnethingTodoPlanDocumentForIpc({
      request: { scope: 'user-note', id: 'note-1', content: '# Updated' },
      updateDocument: () => ({ ...document, content: '# Updated' }),
    })).resolves.toMatchObject({ success: true, document: { content: '# Updated' } })

    await expect(renameOnethingTodoNoteForIpc({
      request: { id: 'note-1', title: 'Renamed' },
      renameUserNote: () => ({ ...document, title: 'Renamed' }),
    })).resolves.toMatchObject({ success: true, document: { title: 'Renamed' } })

    await expect(deleteOnethingTodoNoteForIpc({
      request: { id: 'note-1' },
      deleteUserNote: () => {},
    })).resolves.toEqual({ success: true })
  })

  it('formats reveal and window action responses', async () => {
    await expect(revealOnethingTodoPlanDirectoryForIpc({
      revealDirectory: () => {},
    })).resolves.toEqual({ success: true })

    expect(runOnethingTodoPlanWindowActionForIpc({
      request: { activation: 'preserve-current-app' },
      action: () => {},
    })).toEqual({ success: true })

    expect(setOnethingTodoPlanWindowPinnedForIpc({
      pinned: true,
      setPinned: pinned => pinned,
    })).toEqual({ success: true, pinned: true })
  })

  it('normalizes operation failures', async () => {
    await expect(getOnethingTodoPlanForIpc({
      readSnapshot: () => {
        throw new Error('read failed')
      },
    })).resolves.toEqual({ success: false, error: 'read failed' })

    expect(runOnethingTodoPlanWindowActionForIpc({
      action: () => {
        throw new Error('window failed')
      },
    })).toEqual({ success: false, error: 'window failed' })
  })
})
