/**
 * Distribution sampling of NORMAL turns: negative-signal capture only sees
 * failures the user noticed; the random sample is the only channel for
 * silent failures. Sampling must never fire on negative-signal turns
 * (those already export) and must be off by default.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recordTurn } from "../turn-evaluator.js";
import { loadMergedRecords } from "../records.js";

let tmpDir: string;
let storeOptions: { storePath: string };

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-sampling-"));
	storeOptions = { storePath: tmpDir };
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseTurn(turnId: string) {
	return {
		turnId,
		sessionId: "sess-1",
		promptVersion: "4b2f4b28",
		providerId: "deepseek",
		model: "deepseek-v4-pro",
		skills: [],
		hasTools: true,
		userMessage: "hello",
		storeOptions,
	};
}

describe("recordTurn random sampling", () => {
	it("exports a fixture and marks the record when the sample hits", () => {
		recordTurn({
			...baseTurn("msg-hit"),
			signals: {},
			randomSampleRate: 0.02,
			sampleRng: () => 0.01,
		});
		const [record] = loadMergedRecords({ storePathOptions: storeOptions });
		expect(record.sampled).toBe(true);
		expect(record.fixtureRef).toBeTruthy();
		const fixture = JSON.parse(fs.readFileSync(record.fixtureRef!, "utf-8"));
		expect(fixture.userMessage).toBe("hello");
	});

	it("does nothing extra when the sample misses", () => {
		recordTurn({
			...baseTurn("msg-miss"),
			signals: {},
			randomSampleRate: 0.02,
			sampleRng: () => 0.5,
		});
		const [record] = loadMergedRecords({ storePathOptions: storeOptions });
		expect(record.sampled).toBeUndefined();
		expect(record.fixtureRef).toBeNull();
	});

	it("is off by default", () => {
		recordTurn({
			...baseTurn("msg-default"),
			signals: {},
			sampleRng: () => 0,
		});
		const [record] = loadMergedRecords({ storePathOptions: storeOptions });
		expect(record.sampled).toBeUndefined();
		expect(record.fixtureRef).toBeNull();
	});

	it("never marks negative-signal turns as sampled", () => {
		recordTurn({
			...baseTurn("msg-negative"),
			signals: { toolErrors: 2 },
			randomSampleRate: 1,
			sampleRng: () => 0,
		});
		const [record] = loadMergedRecords({ storePathOptions: storeOptions });
		// Fixture exported via the negative path, not the sampler.
		expect(record.sampled).toBeUndefined();
		expect(record.fixtureRef).toBeTruthy();
	});
});
