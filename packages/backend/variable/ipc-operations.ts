import {
  VariableError,
  type ContextVariable,
  type SetInput,
  type VariableScope,
} from './types.js'

export interface VariablesListRequest {
  sessionId: string
}

export interface VariablesSetRequest extends SetInput {
  sessionId: string
}

export interface VariablesDeleteRequest {
  sessionId: string
  name: string
  scope?: VariableScope
}

export interface OnethingVariableIpcError {
  success: false
  error: string
  code: string
}

export type OnethingVariableIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | OnethingVariableIpcError

export async function listOnethingVariablesForIpc<TVariable = ContextVariable>(
  options: {
    request: VariablesListRequest
    listVariables(context: { sessionId: string }): Promise<TVariable[]> | TVariable[]
  },
): Promise<OnethingVariableIpcResult<{ variables: TVariable[] }>> {
  try {
    const variables = await options.listVariables({ sessionId: options.request.sessionId })
    return { success: true, variables }
  } catch (error) {
    return variableIpcError(error)
  }
}

export async function setOnethingVariableForIpc<TVariable = ContextVariable>(
  options: {
    request: VariablesSetRequest
    setVariable(
      context: { sessionId: string },
      input: SetInput,
    ): Promise<TVariable> | TVariable
  },
): Promise<OnethingVariableIpcResult<{ variable: TVariable }>> {
  try {
    const variable = await options.setVariable(
      { sessionId: options.request.sessionId },
      {
        name: options.request.name,
        value: options.request.value,
        scope: options.request.scope,
        type: options.request.type,
        description: options.request.description,
        state: options.request.state,
      },
    )
    return { success: true, variable }
  } catch (error) {
    return variableIpcError(error)
  }
}

export async function deleteOnethingVariableForIpc(
  options: {
    request: VariablesDeleteRequest
    deleteVariable(
      context: { sessionId: string },
      name: string,
      scope?: VariableScope,
    ): Promise<void> | void
  },
): Promise<OnethingVariableIpcResult> {
  try {
    await options.deleteVariable(
      { sessionId: options.request.sessionId },
      options.request.name,
      options.request.scope,
    )
    return { success: true }
  } catch (error) {
    return variableIpcError(error)
  }
}

export function variableIpcError(error: unknown): OnethingVariableIpcError {
  if (error instanceof VariableError) {
    return { success: false, error: error.message, code: error.code }
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown variable error',
    code: 'INTERNAL',
  }
}
