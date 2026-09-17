/** Host-local diagnostics. All byte values are bytes, never Electron's KiB. */
export const HOST_MEMORY_CHANNEL = 'host:memory'

export type MemoryProcessKind = 'main' | 'renderer' | 'browser' | 'gpu' | 'network' | 'terminal' | 'tool' | 'other'

export interface MemoryProcessRow {
  pid: number
  kind: MemoryProcessKind
  /** Page title or executable basename only; never process arguments or credentials. */
  name: string
  bytes: number | null
  residentBytes: number | null
  compressedBytes: number | null
}

export interface SessionMemorySummary {
  cached: number
  idle: number
  protected: number
  estimatedBytes: number
  budgetBytes: number
  maxIdleEntries: number
}

export interface HostMemorySnapshot {
  capturedAt: number
  basis: 'physical-footprint' | 'resident'
  /** Null if a complete, consistently measured total is unavailable. */
  totalBytes: number | null
  measuredBytes: number
  partial: boolean
  processes: MemoryProcessRow[]
  mainHeapUsedBytes: number
  mainExternalBytes: number
  browserPages: number
  sessionCache: SessionMemorySummary | null
}

export interface HostMemoryReleaseResult {
  releasedSessions: number
  releasedEstimatedBytes: number
  sessionCacheAvailable: boolean
}

export type HostMemoryRequest =
  | { action: 'snapshot' }
  | { action: 'release-idle'; protectedSessionIds?: readonly string[] }

export interface MemoryBridge {
  snapshot(): Promise<HostMemorySnapshot>
  releaseIdle(protectedSessionIds?: readonly string[]): Promise<HostMemoryReleaseResult>
}
