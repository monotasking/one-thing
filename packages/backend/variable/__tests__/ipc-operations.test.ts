import { describe, expect, it } from 'vitest'
import {
  deleteOnethingVariableForIpc,
  listOnethingVariablesForIpc,
  setOnethingVariableForIpc,
  variableIpcError,
} from '../ipc-operations.js'
import { VariableError } from '../types.js'

describe('variable IPC operations', () => {
  it('formats list, set, and delete responses through adapters', async () => {
    await expect(listOnethingVariablesForIpc({
      request: { sessionId: 's1' },
      listVariables: context => [{ name: 'topic', value: context.sessionId }],
    })).resolves.toEqual({
      success: true,
      variables: [{ name: 'topic', value: 's1' }],
    })

    await expect(setOnethingVariableForIpc({
      request: { sessionId: 's1', name: 'topic', value: 'runtime', scope: 'session' },
      setVariable: (context, input) => ({
        name: input.name,
        value: `${context.sessionId}:${input.value}`,
        scope: input.scope,
      }),
    })).resolves.toEqual({
      success: true,
      variable: { name: 'topic', value: 's1:runtime', scope: 'session' },
    })

    await expect(deleteOnethingVariableForIpc({
      request: { sessionId: 's1', name: 'topic', scope: 'session' },
      deleteVariable: () => {},
    })).resolves.toEqual({ success: true })
  })

  it('normalizes variable errors with stable codes', async () => {
    await expect(listOnethingVariablesForIpc({
      request: { sessionId: 's1' },
      listVariables: () => {
        throw new VariableError('INVALID_NAME', 'Invalid variable name')
      },
    })).resolves.toEqual({
      success: false,
      error: 'Invalid variable name',
      code: 'INVALID_NAME',
    })

    expect(variableIpcError(new Error('boom'))).toEqual({
      success: false,
      error: 'boom',
      code: 'INTERNAL',
    })
  })
})
