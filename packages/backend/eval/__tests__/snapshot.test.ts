/**
 * Tests for failure-scene snapshot writers: section truncation, context
 * total-size cap with omitted marker, request.json dedupe (no messages),
 * and promptVersion consistency with the authoritative hashSections.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	writePromptSnapshot,
	writeContextSnapshot,
	writeRequestSnapshot,
} from "../snapshot.js";
import { hashSections } from "../section-hash.js";

let tmpDir: string;
let storeOptions: { storePath: string };

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-snapshot-"));
	storeOptions = { storePath: tmpDir };
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCapture(sections: Array<{ name: string; content: string }>) {
	return {
		systemPrompt: sections.map((s) => s.content).join("\n\n"),
		sections,
		sectionHashes: hashSections(sections).sectionHashes,
	};
}

describe("writePromptSnapshot", () => {
	it("records promptVersion identical to hashSections joint hash", () => {
		const sections = [
			{ name: "system", content: "You are a bot." },
			{ name: "os", content: "You are on macOS." },
		];
		const filePath = writePromptSnapshot({
			sessionId: "s1",
			turnId: "t1",
			promptCapture: makeCapture(sections),
			storeOptions,
		});
		const snapshot = JSON.parse(fs.readFileSync(filePath!, "utf-8"));
		expect(snapshot.promptVersion).toBe(hashSections(sections).promptVersion);
		expect(snapshot.truncated).toEqual([]);
	});

	it("truncates oversized sections and lists them, keeping full-content hash", () => {
		const big = "x".repeat(40 * 1024);
		const sections = [
			{ name: "system", content: "small" },
			{ name: "agents-md", content: big },
		];
		const filePath = writePromptSnapshot({
			sessionId: "s1",
			turnId: "t1",
			promptCapture: makeCapture(sections),
			storeOptions,
		});
		const snapshot = JSON.parse(fs.readFileSync(filePath!, "utf-8"));

		expect(snapshot.truncated).toEqual(["agents-md"]);
		const agentsSection = snapshot.sections.find(
			(s: { name: string }) => s.name === "agents-md",
		);
		expect(agentsSection.content.length).toBeLessThan(big.length);
		expect(agentsSection.content).toContain("section truncated");
		// Hash still identifies the FULL original content
		expect(agentsSection.hash).toBe(
			hashSections(sections).sectionHashes["agents-md"],
		);
	});
});

describe("writeContextSnapshot", () => {
	const msg = (i: number, size = 10) => ({
		role: "user" as const,
		content: `msg-${i}-${"x".repeat(size)}`,
	});

	it("writes header plus one line per message when under the cap", () => {
		const filePath = writeContextSnapshot({
			sessionId: "s1",
			turnId: "t1",
			requestMessages: [msg(1), msg(2), msg(3)],
			storeOptions,
		});
		const lines = fs
			.readFileSync(filePath!, "utf-8")
			.split("\n")
			.filter(Boolean);
		expect(lines).toHaveLength(4);
		expect(JSON.parse(lines[0]).kind).toBe("evals-context");
		expect(JSON.parse(lines[1]).seq).toBe(1);
	});

	it("caps total size keeping first message + tail with omitted marker", () => {
		const messages = Array.from({ length: 50 }, (_, i) => msg(i + 1, 1000));
		const filePath = writeContextSnapshot({
			sessionId: "s1",
			turnId: "t1",
			requestMessages: messages,
			maxBytes: 10 * 1024, // force capping
			storeOptions,
		});
		const lines = fs
			.readFileSync(filePath!, "utf-8")
			.split("\n")
			.filter(Boolean);

		const first = JSON.parse(lines[1]);
		expect(first.seq).toBe(1);
		const marker = JSON.parse(lines[2]);
		expect(marker.omitted).toBeGreaterThan(0);
		const last = JSON.parse(lines[lines.length - 1]);
		expect(last.seq).toBe(50);
		// Total under the cap (header + slack allowed)
		expect(fs.statSync(filePath!).size).toBeLessThan(12 * 1024);
	});
});

describe("writeRequestSnapshot", () => {
	it("does not duplicate messages/systemPrompt (they live in sibling snapshots)", () => {
		const filePath = writeRequestSnapshot({
			sessionId: "s1",
			turnId: "t1",
			rawRequest: {
				model: "deepseek-v4-pro",
				systemPrompt: "long system prompt".repeat(100),
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "hi" },
				],
				temperature: 0.7,
			},
			storeOptions,
		});
		const snapshot = JSON.parse(fs.readFileSync(filePath!, "utf-8"));

		expect(snapshot.messages).toBeUndefined();
		expect(snapshot.systemPrompt).toBeUndefined();
		expect(snapshot.messageCount).toBe(2);
		expect(snapshot.model).toBe("deepseek-v4-pro");
		expect(snapshot.temperature).toBe(0.7);
	});
});
