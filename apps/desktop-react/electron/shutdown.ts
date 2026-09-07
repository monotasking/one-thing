export interface DesktopShutdownOptions {
  shutdown(reason: string): void | Promise<void>
  exit(code: number): void
  onFailure(reason: string, error: unknown): void
}

/**
 * Window close and duplicated process-group signals own one shutdown operation.
 * A second signal is another request, not permission to bypass pending saves.
 * Forced process termination remains an explicit supervisor action.
 */
export function createDesktopShutdownRequest(options: DesktopShutdownOptions): (reason: string) => Promise<void> {
  let pending: Promise<void> | undefined
  return reason => {
    if (pending) return pending
    // Register before invoking shutdown: it can itself emit another quit event.
    pending = Promise.resolve().then(() => options.shutdown(reason)).then(
      () => { options.exit(0) },
      error => {
        // Logging or an exit observer must not replace the real cleanup error.
        try { options.onFailure(reason, error) } finally {
          // eslint-disable-next-line no-unsafe-finally -- 正是这条规则担心的事:退出观察器不许顶掉真正的清理错误,所以这里必须把原错误抛回去
          try { options.exit(1) } finally { throw error }
        }
      },
    )
    // Native event handlers cannot await. Owners that do await still receive the
    // original rejection; observing it here does not turn a failed exit into success.
    void pending.catch(() => {})
    return pending
  }
}
