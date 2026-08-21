/**
 * Tests for VariablesStore (scalar store: built-in note dirs).
 *
 * Project directories now live in their own module — see
 * `src/main/project-dirs/__tests__/store.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVariablesStoreForTests } from "../store-bound.js";
import { createDefaultVariablesFile } from "../schema.js";

const persistence = vi.hoisted(() => ({
	saved: undefined as unknown,
}));

vi.mock("../store-persistence.js", () => ({
	loadFromDisk: () =>
		persistence.saved ?? {
			user_note_dir: "",
			work_note_dir: "",
			global_variables: [],
		},
	saveToDisk: vi.fn((state: unknown) => {
		persistence.saved = JSON.parse(JSON.stringify(state));
	}),
}));

let store = resetVariablesStoreForTests();

beforeEach(() => {
	persistence.saved = undefined;
	store = resetVariablesStoreForTests();
	store.hydrateForTests(createDefaultVariablesFile());
});

describe("note directories", () => {
	it("default user_note_dir is empty", () => {
		expect(store.getUserNoteDir()).toBe("");
	});

	it("default work_note_dir is empty", () => {
		expect(store.getWorkNoteDir()).toBe("");
	});

	it("writes and reads back user_note_dir", () => {
		store.setUserNoteDir("/notes");
		expect(store.getUserNoteDir()).toBe("/notes");
	});

	it("writes and reads back work_note_dir", () => {
		store.setWorkNoteDir("/work-notes");
		expect(store.getWorkNoteDir()).toBe("/work-notes");
	});
});

describe("subscribe", () => {
	it("fires after every mutation", () => {
		let count = 0;
		const off = store.subscribe(() => count++);
		store.setUserNoteDir("/x");
		store.setUserNoteDir("/y");
		store.setWorkNoteDir("/w");
		expect(count).toBe(3);
		off();
		store.setUserNoteDir("/z");
		expect(count).toBe(3); // unsubscribed
	});

	it("continues notifying when one listener throws", () => {
		const calls: string[] = [];
		store.subscribe(() => {
			throw new Error("boom");
		});
		store.subscribe(() => calls.push("ok"));
		const origErr = console.error;
		console.error = () => undefined;
		try {
			store.setUserNoteDir("/x");
		} finally {
			console.error = origErr;
		}
		expect(calls).toEqual(["ok"]);
	});
});
