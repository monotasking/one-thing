import { describe, expect, it } from 'vitest'
import {
  createOnethingSchedulerRunDetailFromRecord,
  createOnethingSchedulerTimelineEntry,
  finishOnethingSchedulerRunDetail,
  previewOnethingSchedulerRunValue,
  toOnethingSchedulerRunStep,
  toOnethingSchedulerRunToolCall,
} from '../run-detail.js'

describe('scheduler run detail helpers', () => {
  it('creates deterministic timeline entries from injected id and clock providers', () => {
    expect(createOnethingSchedulerTimelineEntry({
      type: 'stream:start',
      title: 'Started',
      detail: 'model',
      toolCallId: 'tool-1',
      metadata: { usage: { totalTokens: 10 } },
    }, {
      createId: () => 'entry-1',
      now: () => 100,
    })).toEqual({
      id: 'entry-1',
      timestamp: 100,
      type: 'stream:start',
      title: 'Started',
      detail: 'model',
      toolCallId: 'tool-1',
      metadata: { usage: { totalTokens: 10 } },
    })
  })

  it('projects message steps and tool calls into run DTO fragments', () => {
    expect(toOnethingSchedulerRunStep({
      id: 'step-1',
      title: 'Read file',
      status: 'done',
      timestamp: 10,
      toolCallId: 'tool-1',
      result: { ok: true },
      toolCall: { startTime: 12, endTime: 20 },
    })).toEqual({
      id: 'step-1',
      title: 'Read file',
      status: 'done',
      timestamp: 10,
      finishedAt: 20,
      durationMs: 8,
      toolCallId: 'tool-1',
      resultPreview: '{"ok":true}',
    })

    expect(toOnethingSchedulerRunToolCall({
      id: 'tool-1',
      toolName: 'read',
      status: 'succeeded',
      startTime: 5,
      endTime: 9,
      arguments: { file: 'README.md' },
      result: 'done',
    })).toEqual({
      id: 'tool-1',
      toolName: 'read',
      status: 'succeeded',
      startedAt: 5,
      finishedAt: 9,
      durationMs: 4,
      argumentsPreview: '{"file":"README.md"}',
      resultPreview: 'done',
    })
  })

  it('finishes and derives run details from scheduler records', () => {
    expect(finishOnethingSchedulerRunDetail({
      runId: 'run-1',
      taskId: 'task-1',
      reason: 'manual',
      scheduledFor: 10,
      startedAt: 10,
      finishedAt: 0,
      durationMs: 0,
      ok: true,
      status: 'running',
    }, { now: () => 35 })).toMatchObject({
      finishedAt: 35,
      durationMs: 25,
    })

    expect(createOnethingSchedulerRunDetailFromRecord({
      runId: 'run-2',
      taskId: 'plugin-task',
      reason: 'manual',
      scheduledFor: 100,
      startedAt: 100,
      finishedAt: 120,
      durationMs: 20,
      ok: false,
      error: 'failed',
      result: { report: 'Report text' },
    }, { createId: () => 'entry-2' })).toMatchObject({
      runId: 'run-2',
      taskId: 'plugin-task',
      status: 'failed',
      resultPreview: 'Report text',
      timeline: [{
        id: 'entry-2',
        timestamp: 120,
        type: 'run:finish',
        title: 'Run failed',
        detail: 'failed',
        durationMs: 20,
      }],
    })
  })

  it('builds compact value previews', () => {
    expect(previewOnethingSchedulerRunValue({ ok: true })).toBe('{"ok":true}')
    expect(previewOnethingSchedulerRunValue('x'.repeat(20), 8)).toBe('xxxxx...')
  })
})
