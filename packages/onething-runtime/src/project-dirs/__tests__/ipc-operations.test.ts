import { describe, expect, it } from 'vitest'
import {
  addOnethingProjectDirForIpc,
  getOnethingProjectDirForIpc,
  listOnethingProjectDirsForIpc,
  removeOnethingProjectDirForIpc,
  updateOnethingProjectDirForIpc,
} from '../ipc-operations.js'
import type { Project } from '../types.js'

describe('project-dirs IPC operations', () => {
  const project: Project = {
    id: 'p1',
    path: '/workspace/app',
    paths: ['/workspace/app', '/workspace/shared'],
    description: 'Main app',
    addedAt: 1,
    lastUsedAt: 2,
  }

  it('projects project records and summaries for IPC callers', () => {
    expect(listOnethingProjectDirsForIpc({
      listEntries: () => [{ id: 'p1', path: '/workspace/app', paths: ['/workspace/app', '/workspace/shared'], lastUsedAt: 2 }],
      getProject: () => project,
    })).toEqual({
      success: true,
      entries: [{
        path: '/workspace/app',
        paths: ['/workspace/app', '/workspace/shared'],
        description: 'Main app',
        lastUsedAt: 2,
      }],
    })

    expect(getOnethingProjectDirForIpc({
      request: { path: '/workspace/app' },
      getProject: () => project,
    })).toEqual({
      success: true,
      project: {
        path: '/workspace/app',
        paths: ['/workspace/app', '/workspace/shared'],
        description: 'Main app',
        addedAt: 1,
        lastUsedAt: 2,
      },
    })

    expect(addOnethingProjectDirForIpc({
      request: { path: '/workspace/app', description: 'Main app' },
      addProject: () => project,
    })).toMatchObject({ success: true, project: { path: '/workspace/app' } })
  })

  it('owns project not-found and adapter error presentation', () => {
    expect(updateOnethingProjectDirForIpc({
      request: { path: '/missing', description: 'Missing' },
      updateProject: () => null,
    })).toEqual({
      success: false,
      error: 'No project for path "/missing"',
      code: 'NOT_FOUND',
    })

    expect(updateOnethingProjectDirForIpc({
      request: { path: '/workspace/app' },
      updateProject: () => project,
    })).toEqual({
      success: false,
      error: 'update requires a description and/or paths patch',
      code: 'BAD_REQUEST',
    })

    expect(updateOnethingProjectDirForIpc({
      request: { path: '/workspace/app', paths: ['/workspace/app', '/workspace/extra'] },
      updateProject: (_path, patch) => ({ ...project, paths: patch.paths ?? project.paths }),
    })).toMatchObject({
      success: true,
      project: { paths: ['/workspace/app', '/workspace/extra'] },
    })

    expect(removeOnethingProjectDirForIpc({
      request: { path: '/missing' },
      removeProject: () => false,
    })).toEqual({
      success: false,
      error: 'No project for path "/missing"',
      code: 'NOT_FOUND',
    })

    expect(listOnethingProjectDirsForIpc({
      listEntries: () => {
        throw new Error('disk failed')
      },
      getProject: () => null,
    })).toEqual({
      success: false,
      error: 'disk failed',
      code: 'INTERNAL',
    })
  })
})
