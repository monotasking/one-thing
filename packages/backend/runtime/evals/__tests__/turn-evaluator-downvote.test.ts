/**
 * Regression test: a 👎 downvote must amend the turn's existing record,
 * not create a second full record. A second record would double-count the
 * turn in Records/triage and split its data across two rows (sectionHashes
 * on the turn-end row, fixture/snapshots on the downvote row).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recordTurn, recordExplicitDown } from "../turn-evaluator.js";
import { loadMergedRecords, recordHasNegative } from "../records.js";

let tmpDir: string;
let storeOptions: { storePath: string };

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-downvote-"));
	storeOptions = { storePath: tmpDir };
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordExplicitDown", () => {
	it("amends the turn-end record instead of duplicating it", () => {
		// 1) Normal turn end: trigger writes the record (no negative signals)
		recordTurn({
			turnId: "msg-abc",
			sessionId: "sess-1",
			promptVersion: "4b2f4b28",
			skeletonVersion: "9d555ca3",
			sectionHashes: { system: "c25934c0", os: "6cf2ba5b" },
			providerId: "deepseek",
			model: "deepseek-v4-pro",
			signals: {},
			skills: [],
			hasTools: true,
			userMessage: "帮我改配置",
			storeOptions,
		});

		// 2) User clicks 👎 later
		const fixturePath = recordExplicitDown({
			turnId: "msg-abc",
			sessionId: "sess-1",
			providerId: "deepseek",
			model: "deepseek-v4-pro",
			userMessage: "帮我改配置",
			skills: [],
			hasTools: true,
			promptSnapshotRef: "/fake/x.prompt.json",
			contextSnapshotRef: "/fake/x.context.jsonl",
			storeOptions,
		});

		// 3) Merged view: exactly ONE record carrying everything
		const merged = loadMergedRecords({ storePathOptions: storeOptions });
		expect(merged).toHaveLength(1);

		const record = merged[0];
		expect(record.turnId).toBe("msg-abc");
		// Downvote signal applied
		expect(record.explicit).toBe("down");
		expect(recordHasNegative(record)).toBe(true);
		// Turn-end attribution data preserved on the same row
		expect(record.promptVersion).toBe("4b2f4b28");
		expect(record.sectionHashes).toEqual({
			system: "c25934c0",
			os: "6cf2ba5b",
		});
		// Late-materialized artifacts merged onto the same row
		expect(record.fixtureRef).toBe(fixturePath);
		expect(record.promptSnapshotRef).toBe("/fake/x.prompt.json");
		expect(record.contextSnapshotRef).toBe("/fake/x.context.jsonl");
	});

	it("still exports a usable fixture", () => {
		recordTurn({
			turnId: "msg-x",
			sessionId: "sess-2",
			promptVersion: "aaaa1111",
			providerId: "deepseek",
			model: "deepseek-v4-pro",
			signals: {},
			skills: [],
			hasTools: true,
			userMessage: "hello",
			storeOptions,
		});
		const fixturePath = recordExplicitDown({
			turnId: "msg-x",
			sessionId: "sess-2",
			providerId: "deepseek",
			model: "deepseek-v4-pro",
			userMessage: "hello",
			workingDirectory: "/repo",
			skills: [],
			hasTools: true,
			storeOptions,
		});

		const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
		expect(fixture.userMessage).toBe("hello");
		expect(fixture.provider).toBe("deepseek");
		expect(fixture.context.workingDirectory).toBe("/repo");
		expect(fixture.sessionRef).toEqual({
			sessionId: "sess-2",
			turnId: "msg-x",
		});
	});
});
