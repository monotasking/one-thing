import { describe, expect, it, vi } from 'vitest'
import { createOnethingBranchSession } from '../branching.js'

describe('createOnethingBranchSession', () => {
  const parentSession = {
    id: 'parent-1',
    name: 'Parent Chat',
    messages: [
      { id: 'm1', role: 'user', content: 'hello' },
      { id: 'm2', role: 'assistant', content: 'hi' },
      { id: 'm3', role: 'user', content: 'next' },
    ],
  }

  it('creates a branch from the selected parent message', () => {
    const createBranchSession = vi.fn(input => ({
      id: input.branchId,
      name: input.branchName,
      parentSessionId: input.parentSessionId,
      branchFromMessageId: input.branchFromMessageId,
      messages: input.inheritedMessages,
    }))
    const ids = ['branch-1', 'branch-message-1', 'branch-message-2']

    const result = createOnethingBranchSession({
      parentSessionId: 'parent-1',
      branchFromMessageId: 'm2',
      adapters: {
        createId: () => ids.shift() ?? 'extra-id',
        getSession: () => parentSession,
        createBranchSession,
      },
    })

    expect(result).toEqual({
      success: true,
      session: {
        id: 'branch-1',
        name: 'Parent Chat (Branch)',
        parentSessionId: 'parent-1',
        branchFromMessageId: 'm2',
        messages: [
          { id: 'branch-message-1', role: 'user', content: 'hello' },
          { id: 'branch-message-2', role: 'assistant', content: 'hi' },
        ],
      },
    })
    expect(createBranchSession).toHaveBeenCalledWith({
      branchId: 'branch-1',
      branchName: 'Parent Chat (Branch)',
      parentSessionId: 'parent-1',
      branchFromMessageId: 'm2',
      inheritedMessages: [
        { id: 'branch-message-1', role: 'user', content: 'hello' },
        { id: 'branch-message-2', role: 'assistant', content: 'hi' },
      ],
    })
    expect(parentSession.messages).toHaveLength(3)
  })

  it('reports missing parent and missing branch point without touching adapters', () => {
    const createBranchSession = vi.fn()

    expect(createOnethingBranchSession({
      parentSessionId: 'missing',
      branchFromMessageId: 'm1',
      adapters: {
        createId: () => 'branch-1',
        getSession: () => null,
        createBranchSession,
      },
    })).toEqual({ success: false, error: 'Parent session not found' })

    expect(createOnethingBranchSession({
      parentSessionId: 'parent-1',
      branchFromMessageId: 'missing-message',
      adapters: {
        createId: () => 'branch-1',
        getSession: () => parentSession,
        createBranchSession,
      },
    })).toEqual({ success: false, error: 'Message not found' })

    expect(createBranchSession).not.toHaveBeenCalled()
  })
})
