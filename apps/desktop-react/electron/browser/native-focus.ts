/** Serialize renderer focus intents without treating a native focus event as an intent. */
export class NativeFocus {
  revision = 0
  private generation = 0
  private suspended = false

  constructor(private readonly focus: (viewId: string | null) => void,
    private readonly schedule: (run: () => void) => void = run => { setImmediate(run) }) {}

  request(viewId: string | null, revision = this.revision): void {
    if (revision < this.revision) return
    this.revision = revision
    const generation = ++this.generation
    if (this.suspended && viewId !== null) return
    this.schedule(() => {
      if (generation === this.generation && !this.suspended) this.focus(viewId)
    })
  }

  suspend(value: boolean): void {
    this.suspended = value
    this.generation += 1
  }

  dispose(): void { this.suspend(true) }
}
