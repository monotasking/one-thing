import { describe, expect, it } from 'vitest'
import {
  startOnethingFileWatchForIpc,
  stopOnethingFileWatchForIpc,
} from '../file-watch.js'

describe('file watch IPC operations', () => {
  it('requires a workspace root before starting a watch', () => {
    expect(startOnethingFileWatchForIpc({})).toEqual({
      success: false,
      error: 'Workspace root is required',
    })
  })

  it('keeps V1 watch start and stop responses stable', () => {
    expect(startOnethingFileWatchForIpc({ root: '/repo' })).toEqual({ success: true })
    expect(stopOnethingFileWatchForIpc({ root: '/repo' })).toEqual({ success: true })
  })
})
