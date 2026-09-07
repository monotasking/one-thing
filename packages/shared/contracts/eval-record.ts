/** Serializable evaluation record shared by persistence and transport adapters. */
/**
 * Turn evaluation signals (collected during and after a turn).
 */
export interface TurnSignals {
	retried: boolean;
	editResent: boolean;
	permissionDenied: boolean;
	toolErrors: number;
	streamAborted: boolean;
}

/**
 * A turn evaluation record written to records.jsonl.
 * Judge field is populated later by Phase 3.
 */
export interface TurnEvalRecord {
	ts: string;
	sessionId: string;
	turnId: string;
	/** Session-level promptVersion from actual sections (hash of all section hashes). */
	promptVersion: string;
	/** Coarse skeleton version (4-constant hash) for cross-session grouping. */
	skeletonVersion?: string;
	/** Per-section hashes for attribution analysis. */
	sectionHashes?: Record<string, string>;
	provider: string;
	model: string;
	signals: TurnSignals;
	explicit: "up" | "down" | null;
	judge: { score: number; category: string; reason: string } | null;
	/**
	 * True when this NORMAL turn was picked by random sampling. Negative-
	 * signal capture only sees failures the user noticed; sampled normal
	 * turns are the only channel through which silent failures (and the
	 * real task distribution) enter the eval funnel.
	 */
	sampled?: boolean;
	fixtureRef: string | null;
	/** Incident bundle id (workbench W1+; the human-facing failure object). */
	incidentRef?: string | null;
	/** Reference to the .prompt.json snapshot (sectioned system prompt). */
	promptSnapshotRef?: string | null;
	/** Reference to the .context.jsonl snapshot (request-view messages). */
	contextSnapshotRef?: string | null;
	/** Reference to the .request.json snapshot (full API request body). */
	requestSnapshotRef?: string | null;
	/** Reference to the .response.json snapshot (full API response body). */
	responseSnapshotRef?: string | null;
}
