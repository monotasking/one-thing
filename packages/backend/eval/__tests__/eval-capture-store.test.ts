/**
 * Disk capture ring tests (Route B): save/load round-trip, oversize
 * captures persisted WITHOUT requestMessages (Route A rebuilds those),
 * and ring pruning by recency.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	saveCaptureToDisk,
	loadCaptureFromDisk,
	getCapturesDir,
} from "../eval-capture-store.js";
import { hashSections } from "../eval-section-hash.js";
import type { CorePromptCapture } from "@onething/backend/agent-loop";

let tmpDir: string;
let storeOptions: { storePath: string };

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-capture-"));
	storeOptions = { storePath: tmpDir };
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCapture(historyChars = 100): CorePromptCapture {
	const sections = [{ name: "system", content: "You are a bot." }];
	return {
		systemPrompt: "You are a bot.",
		sections,
		sectionHashes: hashSections(sections).sectionHashes,
		requestMessages: [
			{ role: "user", content: "x".repeat(historyChars) },
		] as CorePromptCapture["requestMessages"],
		rawRequest: {
			model: "deepseek-v4-pro",
			systemPrompt: "You are a bot.",
			messages: [],
			temperature: 0.7,
		},
	};
}

describe("capture disk ring", () => {
	it("round-trips a capture across 'restarts' (pure disk read)", () => {
		saveCaptureToDisk("turn-1", makeCapture(), { storeOptions });
		const loaded = loadCaptureFromDisk("turn-1", storeOptions);
		expect(loaded?.systemPrompt).toBe("You are a bot.");
		expect(loaded?.sectionHashes.system).toBeDefined();
		expect(loaded?.requestMessages).toHaveLength(1);
		expect(loaded?.rawRequest?.temperature).toBe(0.7);
	});

	it("drops requestMessages (not prompt/tools/params) when oversized", () => {
		saveCaptureToDisk("turn-big", makeCapture(3 * 1024 * 1024), { storeOptions });
		const loaded = loadCaptureFromDisk("turn-big", storeOptions);
		// The reconstructible part is gone…
		expect(loaded?.requestMessages).toBeUndefined();
		// …but the jsonl-irreplaceable parts survive
		expect(loaded?.sections).toHaveLength(1);
		expect(loaded?.rawRequest?.model).toBe("deepseek-v4-pro");
	});

	it("prunes the ring to maxEntries keeping the newest", async () => {
		const { pruneCaptureRing } = await import("../eval-capture-store.js");
		// Write all first (large ring), give each a distinct ascending mtime,
		// then prune once — mirrors steady-state behavior deterministically.
		for (let i = 1; i <= 5; i++) {
			saveCaptureToDisk(`turn-${i}`, makeCapture(), {
				maxEntries: 100,
				storeOptions,
			});
			const file = path.join(getCapturesDir(storeOptions), `turn-${i}.json`);
			const t = new Date(Date.now() + i * 1000);
			fs.utimesSync(file, t, t);
		}
		pruneCaptureRing(3, storeOptions);

		const remaining = fs.readdirSync(getCapturesDir(storeOptions)).sort();
		expect(remaining).toHaveLength(3);
		expect(remaining).toEqual(["turn-3.json", "turn-4.json", "turn-5.json"]);
	});

	it("returns null for unknown turns", () => {
		expect(loadCaptureFromDisk("nope", storeOptions)).toBeNull();
	});
});
