/**
 * Serializes the point where tool executions perform side effects, while still
 * allowing earlier phases such as metadata generation and permission prompts to
 * run concurrently.
 */
export class OrderedSideEffectQueue {
  private tail: Promise<void> = Promise.resolve()

  createGate(): { beforeSideEffect: () => Promise<void>; release: () => void } {
    const waitForPrevious = this.tail.catch(() => undefined)
    let releaseCurrent!: () => void
    let released = false
    const currentDone = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })

    this.tail = waitForPrevious.then(() => currentDone)

    return {
      beforeSideEffect: async () => {
        await waitForPrevious
      },
      release: () => {
        if (released) return
        released = true
        releaseCurrent()
      },
    }
  }
}

export function needsOrderedSideEffectGate(toolName: string): boolean {
  const normalized = toolName.toLowerCase()
  return normalized === 'edit'
    || normalized === 'write'
    || normalized === 'bash'
    || normalized === 'variable'
    || normalized === 'tool_function'
    || normalized.startsWith('mcp:')
    || normalized.startsWith('mcp_')
}
