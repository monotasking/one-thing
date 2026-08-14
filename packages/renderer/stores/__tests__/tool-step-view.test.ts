import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildToolStepView,
  buildSyntheticToolCall,
  clearStreamingContentCache,
  stepFromToolCall,
} from '../helpers/tool-step-view'
import type { Step, ToolCall } from '@/types'

function tc(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolId: 'write',
    toolName: 'write',
    arguments: {},
    status: 'pending',
    timestamp: 0,
    ...overrides,
  }
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 's1',
    type: 'tool-call',
    title: 'write',
    status: 'running',
    timestamp: 0,
    toolCallId: 'tc1',
    toolCall: tc(),
    ...overrides,
  }
}

beforeEach(() => {
  clearStreamingContentCache()
})

describe('buildToolStepView', () => {
  it('keeps write streaming details available but folded', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        status: 'input-streaming',
        streamingArgs: '{"path":"/Users/me/project/src/a.ts","content":"hello\\nworld"}',
      }),
    }))

    expect(view.status).toBe('streaming-input')
    expect(view.preview).toBe('a.ts')
    expect(view.filePath).toBe('/Users/me/project/src/a.ts')
    expect(view.fileName).toBe('a.ts')
    // While receiving, the settled preview must not exist — the draft view
    // owns the presentation and marks everything it knows as measured.
    expect(view.streamingContent).toBeNull()
    expect(view.streamingDraft?.kind).toBe('write')
    expect(view.streamingDraft?.content).toEqual({ text: 'hello\nworld', open: false })
    expect(view.streamingDraft?.complete).toBe(true)
    expect(view.hasDetails).toBe(true)
    // Nothing is being asked of the reader yet, so the row stays quiet.
    expect(view.defaultExpanded).toBe(false)
  })

  it('mounts the cursor on the open field and withholds a half-received path', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        toolId: 'edit',
        toolName: 'edit',
        status: 'input-streaming',
        streamingArgs: '{"edits": [{"oldText": "const a = 1',
      }),
    }))

    const draft = view.streamingDraft
    expect(draft?.kind).toBe('edit')
    expect(draft?.complete).toBe(false)
    expect(draft?.openPath).toBe('edits[0].oldText')
    expect(draft?.replacements).toEqual([
      { index: 0, find: { text: 'const a = 1', open: true }, replace: null },
    ])
    // The path has not even started — the title must not invent a file name.
    expect(draft?.pathPending).toBe(true)
    expect(view.filePath).toBe('')
    expect(view.fileName).toBe('')
  })

  it('never surfaces a path whose closing quote has not arrived', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        status: 'input-streaming',
        streamingArgs: '{"path":"/Users/me/proj',
      }),
    }))

    expect(view.streamingDraft?.filePath).toBe('')
    expect(view.streamingDraft?.pathPending).toBe(true)
    expect(view.filePath).toBe('')
  })

  it('can build a lightweight row without parsing heavy details', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        status: 'input-streaming',
        streamingArgs: '{"path":"/Users/me/project/src/a.ts","content":"hello\\nworld"}',
      }),
    }), { includeDetails: false })

    expect(view.status).toBe('streaming-input')
    expect(view.preview).toBe('a.ts')
    expect(view.filePath).toBe('/Users/me/project/src/a.ts')
    expect(view.streamingContent).toBeNull()
    expect(view.streamingPreviewLines).toEqual([])
    expect(view.argsJson).toBeNull()
    expect(view.resultText).toBeNull()
    expect(view.hasDetails).toBe(true)
    expect(view.defaultExpanded).toBe(false)
  })

  it('uses diff as the authoritative write detail once available', () => {
    const view = buildToolStepView(step({
      status: 'awaiting-confirmation',
      toolCall: tc({
        status: 'pending',
        requiresConfirmation: true,
        streamingArgs: '{"path":"src/a.ts","content":"stale"}',
        changes: {
          diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
          filePath: '/Users/me/project/src/a.ts',
          additions: 1,
          deletions: 1,
        },
      }),
    }))

    expect(view.status).toBe('awaiting-confirmation')
    expect(view.streamingContent).toBeNull()
    expect(view.diff?.filePath).toBe('/Users/me/project/src/a.ts')
    expect(view.filePath).toBe('/Users/me/project/src/a.ts')
    expect(view.fileName).toBe('a.ts')
    expect(view.isAwaitingConfirmation).toBe(true)
    // An edit waiting on approval is the one row that opens itself: the reader
    // is being asked to decide, so the change has to be in front of them.
    expect(view.defaultExpanded).toBe(true)
  })

  it('keeps bash rows reachable but not auto-expanded while running', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        toolId: 'bash',
        toolName: 'bash',
        status: 'executing',
        arguments: { command: 'git status' },
      }),
    }))

    expect(view.toolName).toBe('bash')
    // The single-line title truncates long commands; the expanded details
    // must always be available as the place to read the whole command.
    expect(view.hasDetails).toBe(true)
    // Bash no longer auto-expands on `executing` — a fast command popping
    // open and immediately re-collapsing read as jitter, not signal.
    expect(view.defaultExpanded).toBe(false)
  })

  it('hides read arguments because the row target already carries the file range', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        toolId: 'read',
        toolName: 'read',
        status: 'completed',
        arguments: {
          filePath: '/Users/me/project/src/app.ts',
          offset: 768,
          limit: 40,
        },
      }),
    }))

    expect(view.toolName).toBe('read')
    expect(view.argsJson).toBeNull()
    expect(view.hasDetails).toBe(false)
  })

  it('exposes running bash partial output as live output for details UI', () => {
    const view = buildToolStepView(step({
      result: 'fallback output\n',
      partialResult: {
        content: [{ type: 'text', text: 'line 1\nline 2\n' }],
        details: { elapsedMs: 10 },
      },
      partialResultIsPartial: true,
      toolCall: tc({
        toolId: 'bash',
        toolName: 'bash',
        status: 'executing',
        arguments: { command: 'printf "line 1\\nline 2\\n"' },
      }),
    }))

    expect(view.liveOutput).toBe('line 1\nline 2\n')
    expect(view.hasDetails).toBe(true)
  })

  it('renders permission rejection as rejected instead of failed error preview', () => {
    const view = buildToolStepView(step({
      status: 'failed',
      error: 'The user rejected permission for this tool.',
      rejected: true,
      toolCall: tc({
        toolId: 'bash',
        toolName: 'bash',
        status: 'failed',
        rejected: true,
        error: 'The user rejected permission for this tool.',
      }),
    }))

    expect(view.status).toBe('rejected')
    expect(view.errorPreview).toBe('Rejected')
    expect(view.defaultExpanded).toBe(false)
  })

  it('feeds the draft parser incrementally as streamingArgs grows', () => {
    const toolCall = tc({
      status: 'input-streaming',
      streamingArgs: '{"path":"src/a.ts","content":"par',
    })
    const streamingStep = step({ toolCall })

    const first = buildToolStepView(streamingStep)
    expect(first.streamingDraft?.content).toEqual({ text: 'par', open: true })
    expect(first.streamingDraft?.charsReceived).toBe(toolCall.streamingArgs!.length)

    toolCall.streamingArgs += 'tial"}'
    const second = buildToolStepView(streamingStep)
    expect(second.streamingDraft?.content).toEqual({ text: 'partial', open: false })
    expect(second.streamingDraft?.complete).toBe(true)
    expect(second.streamingDraft?.charsReceived).toBe(toolCall.streamingArgs!.length)
  })

  it('carries large streaming write content without a cap or invented counts', () => {
    const content = Array.from({ length: 220 }, (_, index) => `line ${index + 1}`).join('\n')
    const view = buildToolStepView(step({
      toolCall: tc({
        status: 'input-streaming',
        streamingArgs: JSON.stringify({ path: 'src/large.ts', content }),
      }),
    }))

    expect(view.streamingDraft?.content?.text).toBe(content)
    // No predicted +N/−N anywhere: counts are a measurement of the applied
    // change and do not exist before execution.
    expect(view.streamingContent).toBeNull()
    expect(view.streamingPreviewLines).toEqual([])
  })

  it('previews a streaming edit as its find/replace pair with settled state', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        toolId: 'edit',
        toolName: 'edit',
        status: 'input-streaming',
        streamingArgs: JSON.stringify({
          path: 'src/app.ts',
          edits: [{
            oldText: 'const a = 1\nconst b = 2\n',
            newText: 'const a = 1\nconst b = 3\n',
          }],
        }),
      }),
    }))

    expect(view.streamingDraft?.replacements).toEqual([
      {
        index: 0,
        find: { text: 'const a = 1\nconst b = 2\n', open: false },
        replace: { text: 'const a = 1\nconst b = 3\n', open: false },
      },
    ])
    expect(view.streamingDraft?.filePath).toBe('src/app.ts')
    expect(view.streamingDraft?.pathPending).toBe(false)
  })

  it('keeps deletion-only streaming edits visible in the draft', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        toolId: 'edit',
        toolName: 'edit',
        status: 'input-streaming',
        streamingArgs: JSON.stringify({
          path: 'src/app.ts',
          edits: [{ oldText: 'remove me\n', newText: '' }],
        }),
      }),
    }))

    expect(view.streamingDraft?.replacements).toEqual([
      {
        index: 0,
        find: { text: 'remove me\n', open: false },
        replace: { text: '', open: false },
      },
    ])
  })

  it('keeps every replacement of a multi-edit draft, in index order', () => {
    const view = buildToolStepView(step({
      toolCall: tc({
        toolId: 'edit',
        toolName: 'edit',
        status: 'input-streaming',
        streamingArgs: JSON.stringify({
          path: 'src/app.ts',
          edits: [
            { oldText: 'old one\n', newText: 'new one\n' },
            { oldText: 'old two\n', newText: 'new two\n' },
          ],
        }),
      }),
    }))

    expect(view.streamingDraft?.replacements.map(replacement => replacement.index)).toEqual([0, 1])
    expect(view.streamingDraft?.replacements[1].replace).toEqual({ text: 'new two\n', open: false })
  })

  it('extracts filePath from step.result payload if args.path is missing', () => {
    const view = buildToolStepView(step({
      result: JSON.stringify({ path: '/Users/me/project/src/resolved.ts', content: 'hello' }),
      toolCall: tc({
        toolName: 'read',
        arguments: {},
      }),
    }))

    expect(view.filePath).toBe('/Users/me/project/src/resolved.ts')
    expect(view.fileName).toBe('resolved.ts')
  })
})

describe('stepFromToolCall', () => {
  it('wraps a streaming tool call as a renderable step', () => {
    const toolCall: ToolCall = {
      id: 'tc1',
      toolId: 'edit',
      toolName: 'edit',
      arguments: {},
      status: 'input-streaming',
      streamingArgs: '{"path": "/a.ts"',
      timestamp: 1,
    }

    const wrappedStep = stepFromToolCall(toolCall)

    expect(wrappedStep.id).toBe('tc1')
    expect(wrappedStep.toolCall).toBe(toolCall)
    expect(wrappedStep.status).toBe('running')
  })

  it('maps terminal tool call statuses to step statuses', () => {
    const done = stepFromToolCall({
      id: 'a',
      toolId: 'bash',
      toolName: 'bash',
      arguments: {},
      status: 'completed',
      timestamp: 1,
    })
    const failed = stepFromToolCall({
      id: 'b',
      toolId: 'bash',
      toolName: 'bash',
      arguments: {},
      status: 'failed',
      timestamp: 1,
    })

    expect(done.status).toBe('completed')
    expect(failed.status).toBe('failed')
  })
})

describe('buildSyntheticToolCall', () => {
  it('parses read with line ranges', () => {
    const call = buildSyntheticToolCall(step({
      title: 'read:src/main.ts:768-807',
      toolCall: undefined,
    }))
    expect(call.toolName).toBe('read')
    expect(call.arguments.path).toBe('src/main.ts')
    expect(call.arguments.offset).toBe(768)
    expect(call.arguments.limit).toBe(40)
  })

  it('parses Tool prefix', () => {
    const call = buildSyntheticToolCall(step({
      title: 'Tool: edit',
      toolCall: undefined,
    }))
    expect(call.toolName).toBe('edit')
  })

  it('parses Read human title', () => {
    const call = buildSyntheticToolCall(step({
      title: 'Read IVARouter.lua',
      toolCall: undefined,
    }))
    expect(call.toolName).toBe('read')
    expect(call.arguments.path).toBe('IVARouter.lua')
  })
})

describe('edit replaceAll', () => {
  const editStep = (overrides: Partial<ToolCall>) => step({
    title: 'edit',
    toolCall: tc({ toolId: 'edit', toolName: 'edit', ...overrides }),
  })

  it('carries the flag through the streaming draft', () => {
    const view = buildToolStepView(editStep({
      status: 'input-streaming',
      streamingArgs: '{"path":"/p/a.sql","edits":[{"oldText":"x","newText":"y","replaceAll":true}]}',
    }))

    expect(view.streamingDraft?.replacements[0]?.replaceAll).toBe(true)
  })

  it('leaves the flag off when it is absent or false', () => {
    for (const tail of ['', ',"replaceAll":false']) {
      const view = buildToolStepView(editStep({
        status: 'input-streaming',
        streamingArgs: `{"path":"/p/a.sql","edits":[{"oldText":"x","newText":"y"${tail}}]}`,
      }))

      expect(view.streamingDraft?.replacements[0]?.replaceAll).toBeFalsy()
    }
  })

  it('labels all-occurrence edits in the settled preview', () => {
    const view = buildToolStepView(editStep({
      status: 'executing',
      arguments: {
        path: '/p/a.sql',
        edits: [
          { oldText: 'x', newText: 'y', replaceAll: true },
          { oldText: 'k', newText: 'v' },
        ],
      },
    }))

    const labels = view.streamingPreviewLines
      .filter(line => line.kind === 'label')
      .map(line => line.text)

    expect(labels).toContain('Find 1 (all occurrences)')
    expect(labels).toContain('Find 2')
  })
})

