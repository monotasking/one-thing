import type { CorePromptCapture } from "@onething/backend/runtime/agent-loop";

/**
 * LRU cache of prompt captures keyed by turnId.
 *
 * Used for the 👎 downvote path: the downvote happens after the turn ends,
 * when the promptCapture is no longer in memory. We keep the last N captures
 * in this cache so the downvote handler can write prompt/context snapshots.
 */
class PromptCaptureCache {
	private map = new Map<string, CorePromptCapture>();
	private maxSize: number;

	constructor(maxSize = 5) {
		this.maxSize = maxSize;
	}

	/** Store a prompt capture for a turn. Evicts oldest if at capacity. */
	set(turnId: string, capture: CorePromptCapture): void {
		// Delete existing entry to refresh LRU position
		this.map.delete(turnId);

		// Evict oldest if at capacity
		if (this.map.size >= this.maxSize) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) {
				this.map.delete(oldest);
			}
		}

		this.map.set(turnId, capture);
	}

	/** Retrieve and remove a prompt capture. */
	take(turnId: string): CorePromptCapture | undefined {
		const capture = this.map.get(turnId);
		if (capture) this.map.delete(turnId);
		return capture;
	}

	/** Peek without removing. */
	get(turnId: string): CorePromptCapture | undefined {
		return this.map.get(turnId);
	}

	/** Clear all entries. */
	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}

/**
 * Singleton instance shared across the evals system. 24 turns of headroom:
 * users routinely downvote messages several turns back, and 5 proved too
 * small in practice (captures evicted before the 👎 landed → degraded
 * scenes without prompt/context). Captures are JSON-cloned plain objects;
 * worst case ~1MB each for very long sessions, so the cap stays modest.
 */
export const promptCaptureCache = new PromptCaptureCache(24);
